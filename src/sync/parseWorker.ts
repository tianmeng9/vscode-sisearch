// src/sync/parseWorker.ts
// Worker 线程入口 — 初始化 tree-sitter 并批量解析文件
// 通过 worker_threads 消息协议与主线程通信

import * as fs from 'fs';
import { parentPort, workerData } from 'worker_threads';
import { initParser, parseSymbols } from '../symbolParser';
import { extractSymbolsByRegexStream } from '../largeFileParserStream';
import type { ParseBatchResult } from './workerPool';
import { appendDiag, resolveDiagLogPath } from './workerDiag';

// 诊断日志:exit 134 根因不明时打开。per-file 粒度保证崩溃时最后一行能指向具体文件。
// 同步 IO 会加约 0.5 ms/file 开销(33k 文件 ≈ 额外 50 s),崩因定位到单文件后关掉即可。
const DIAG_LOG_PATH = resolveDiagLogPath();
appendDiag(DIAG_LOG_PATH, 'worker:start', {
    extensionPath: workerData?.extensionPath,
    maxBytes: workerData?.maxBytes,
    nodeVersion: process.version,
});
process.on('uncaughtException', (err: Error) => {
    appendDiag(DIAG_LOG_PATH, 'worker:uncaughtException', {
        name: err.name,
        message: err.message,
        stack: err.stack,
    });
});
process.on('unhandledRejection', (reason: unknown) => {
    appendDiag(DIAG_LOG_PATH, 'worker:unhandledRejection', {
        reason: reason instanceof Error ? reason.stack : String(reason),
    });
});
process.on('exit', (code: number) => {
    appendDiag(DIAG_LOG_PATH, 'worker:exit', { code });
});

interface ParseBatchRequest {
    type: 'parseBatch';
    requestId: number;
    files: Array<{ absPath: string; relativePath: string }>;
}

async function main(): Promise<void> {
    await initParser(workerData.extensionPath as string);
    // maxBytes 由主线程从 VS Code 配置读取并通过 workerData 透传;0 = 禁用(始终
    // 走 tree-sitter,承担 WASM 爆堆风险),正整数 = 超阈值走 largeFileParser 正则回退。
    const maxBytes = typeof workerData.maxBytes === 'number' ? (workerData.maxBytes as number) : 0;

    parentPort?.on('message', async (message: ParseBatchRequest) => {
        if (message.type !== 'parseBatch') { return; }

        // Phase 5E:回到 batch 级 postMessage —— workerLoop 的 await onBatchResult
        // 提供天然背压,防止主线程被 worker 消息淹没(5C-H 的 fileChunk 流没背压,
        // 2.8 GB 主线程堆 OOM)。5D 的 onSymbol 仍保留在大文件 stream 路径上,
        // 让 stream 内部不 buffer,单文件瞬时内存最小化。
        const symbols: ParseBatchResult['symbols'] = [];
        const metadata: ParseBatchResult['metadata'] = [];
        const errors: string[] = [];

        for (const file of message.files) {
            appendDiag(DIAG_LOG_PATH, 'file:entered', { relativePath: file.relativePath });
            try {
                // Phase 5B:先 statSync。size >= maxBytes 就走 stream,跳过 readFileSync。
                const stat = fs.statSync(file.absPath);
                let symbolCount: number;
                if (maxBytes > 0 && stat.size >= maxBytes) {
                    // 超巨文件(>= 10 MB)启用 macrosOnly
                    const HUGE_FILE_THRESHOLD = 10 * 1024 * 1024;
                    const macrosOnly = stat.size >= HUGE_FILE_THRESHOLD;
                    appendDiag(DIAG_LOG_PATH, 'file:readDone', {
                        relativePath: file.relativePath,
                        contentLength: stat.size,
                        stream: true,
                        macrosOnly,
                    });
                    // Phase 5D + SQLite 后端(M3 Task 3.1,回滚 Phase 5H):stream 路径的符号
                    // 通过 onSymbol 流式推入 batch 级 symbols 数组,随 batchResult 回到主线程,
                    // 最终由 DbBackend.writeBatch 落盘到 SQLite(FTS5 索引)。
                    // 主线程不再累积 InMemorySymbolIndex,瓶颈已从 JS 堆移到 SQLite 写事务;
                    // 内存安全由 workerLoop 背压 + WAL 事务保证,不再需要"只计数不入库"保护。
                    // AMD GPU 寄存器宏等 1+ MB 机器生成文件的 stream 产物现在进入 FTS5 索引,
                    // 搜索可命中。
                    //
                    // 保留的 Phase 5C/5D/5G 优化:lineContentMode='empty'(不持有原行文本)、
                    // macrosOnly(超大文件仅抽宏定义)、stream 内部不保留 seen Set、
                    // 1 MB 阈值(maxBytes)之上才走 stream 路径。
                    let streamedCount = 0;
                    await extractSymbolsByRegexStream(file.absPath, file.relativePath, {
                        lineContentMode: 'empty',
                        macrosOnly,
                        onSymbol: (entry) => {
                            symbols.push(entry);
                            streamedCount++;
                        },
                    });
                    symbolCount = streamedCount;
                } else {
                    const content = fs.readFileSync(file.absPath, 'utf-8');
                    appendDiag(DIAG_LOG_PATH, 'file:readDone', {
                        relativePath: file.relativePath,
                        contentLength: content.length,
                    });
                    const parsed = parseSymbols(file.absPath, file.relativePath, content, { maxBytes });
                    for (const s of parsed) { symbols.push(s); }
                    symbolCount = parsed.length;
                }
                appendDiag(DIAG_LOG_PATH, 'file:parseDone', {
                    relativePath: file.relativePath,
                    symbolCount,
                });
                metadata.push({
                    relativePath: file.relativePath,
                    mtime: stat.mtimeMs,
                    size: stat.size,
                    symbolCount,
                });
            } catch (err) {
                appendDiag(DIAG_LOG_PATH, 'file:error', {
                    relativePath: file.relativePath,
                    err: err instanceof Error ? err.message : String(err),
                });
                errors.push(`${file.relativePath}: ${err instanceof Error ? err.message : String(err)}`);
            }
        }

        parentPort?.postMessage({
            type: 'batchResult',
            requestId: message.requestId,
            symbols,
            metadata,
            errors,
        });
    });
}

void main();
