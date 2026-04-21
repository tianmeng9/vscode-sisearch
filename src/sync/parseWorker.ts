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

        // Phase 5C-H:per-file flush —— 不再跨文件累积。每个文件处理完立即
        // postMessage 'fileChunk' 给主线程,然后清空本地数组让 GC 回收。
        // 最后发一条 'batchResult' 作为批次完成信号(symbols/metadata/errors 都为空)。
        // 这样 worker 堆永不持有超过"当前这个文件"的符号数据。
        let symbols: ParseBatchResult['symbols'] = [];
        let metadata: ParseBatchResult['metadata'] = [];
        let errors: string[] = [];

        // 超过这个大小就立即 flush,防止单个超大文件内部产物过多也堆积
        // (虽然每文件处理完也会 flush,但大文件 emit 过程中内存还是峰值)
        const flush = (): void => {
            if (symbols.length === 0 && metadata.length === 0 && errors.length === 0) { return; }
            parentPort?.postMessage({
                type: 'fileChunk',
                requestId: message.requestId,
                symbols,
                metadata,
                errors,
            });
            // 关键:新建空数组,而不是 .length = 0 —— postMessage 的结构化克隆
            // 已经把内容 copy 到了主线程,我们这里丢掉引用让 V8 立刻回收旧数组。
            symbols = [];
            metadata = [];
            errors = [];
        };

        for (const file of message.files) {
            appendDiag(DIAG_LOG_PATH, 'file:entered', { relativePath: file.relativePath });
            try {
                // Phase 5B 关键:先 statSync 拿 size。若 size >= maxBytes 就走流式路径,
                // 完全跳过 fs.readFileSync —— 对 14 MB AMD GPU 寄存器头,整读会在 Node
                // Buffer/external memory 层打爆,Phase 4 的闸门在整读之后来不及。
                const stat = fs.statSync(file.absPath);
                let parsed;
                if (maxBytes > 0 && stat.size >= maxBytes) {
                    // 超巨文件(>= 10 MB)启用 macrosOnly —— AMD GPU 寄存器 header 级别。
                    const HUGE_FILE_THRESHOLD = 10 * 1024 * 1024;
                    const macrosOnly = stat.size >= HUGE_FILE_THRESHOLD;
                    appendDiag(DIAG_LOG_PATH, 'file:readDone', {
                        relativePath: file.relativePath,
                        contentLength: stat.size,
                        stream: true,
                        macrosOnly,
                    });
                    // Phase 5D:符号级流式 —— 不等 stream 结束,每 N 个符号就 flush。
                    // 单文件 15 万符号不会瞬时 buffer + postMessage 克隆 double 持有。
                    const FLUSH_EVERY = 2000;
                    let streamedCount = 0;
                    let metadataPushed = false;
                    await extractSymbolsByRegexStream(file.absPath, file.relativePath, {
                        lineContentMode: 'empty',
                        macrosOnly,
                        onSymbol: (entry) => {
                            symbols.push(entry);
                            streamedCount++;
                            // 首个符号出现时,把这个文件的 metadata 预先登记,避免
                            // 大文件的 metadata 跟 symbols 分离(主线程按 fileChunk 合并没问题)
                            if (!metadataPushed) {
                                metadata.push({
                                    relativePath: file.relativePath,
                                    mtime: stat.mtimeMs,
                                    size: stat.size,
                                    symbolCount: 0, // 暂填 0,最后更新 —— 但 flush 中已发走
                                });
                                metadataPushed = true;
                            }
                            if (symbols.length >= FLUSH_EVERY) { flush(); }
                        },
                    });
                    // 伪装 parsed = stream 产出数量(后续 parseDone 日志用)
                    parsed = { length: streamedCount } as ParseBatchResult['symbols'];
                    // stream 模式下 metadata 已经在 onSymbol 首次被推;symbols 由 onSymbol 推。
                    // 如果 streamedCount=0(文件没命中任何规则),仍要补一条 metadata。
                    if (streamedCount === 0) {
                        metadata.push({
                            relativePath: file.relativePath,
                            mtime: stat.mtimeMs,
                            size: stat.size,
                            symbolCount: 0,
                        });
                    }
                    appendDiag(DIAG_LOG_PATH, 'file:parseDone', {
                        relativePath: file.relativePath,
                        symbolCount: streamedCount,
                    });
                    flush();
                    continue; // 跳过下面的非-stream 收尾路径
                } else {
                    const content = fs.readFileSync(file.absPath, 'utf-8');
                    appendDiag(DIAG_LOG_PATH, 'file:readDone', {
                        relativePath: file.relativePath,
                        contentLength: content.length,
                    });
                    parsed = parseSymbols(file.absPath, file.relativePath, content, { maxBytes });
                }
                appendDiag(DIAG_LOG_PATH, 'file:parseDone', {
                    relativePath: file.relativePath,
                    symbolCount: parsed.length,
                });
                symbols.push(...parsed);
                metadata.push({
                    relativePath: file.relativePath,
                    mtime: stat.mtimeMs,
                    size: stat.size,
                    symbolCount: parsed.length,
                });
                // 每文件 flush —— worker 堆立即释放本文件符号
                flush();
            } catch (err) {
                appendDiag(DIAG_LOG_PATH, 'file:error', {
                    relativePath: file.relativePath,
                    err: err instanceof Error ? err.message : String(err),
                });
                errors.push(`${file.relativePath}: ${err instanceof Error ? err.message : String(err)}`);
                // 错误也立即 flush
                flush();
            }
        }

        // 批次收尾 —— 任何未 flush 的残留 + 批次结束信号
        flush();
        parentPort?.postMessage({
            type: 'batchResult',
            requestId: message.requestId,
            symbols: [],
            metadata: [],
            errors: [],
        });
    });
}

void main();
