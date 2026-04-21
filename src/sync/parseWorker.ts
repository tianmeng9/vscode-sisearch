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

        const symbols: ParseBatchResult['symbols'] = [];
        const metadata: ParseBatchResult['metadata'] = [];
        const errors: string[] = [];

        for (const file of message.files) {
            appendDiag(DIAG_LOG_PATH, 'file:entered', { relativePath: file.relativePath });
            try {
                // Phase 5B 关键:先 statSync 拿 size。若 size >= maxBytes 就走流式路径,
                // 完全跳过 fs.readFileSync —— 对 14 MB AMD GPU 寄存器头,整读会在 Node
                // Buffer/external memory 层打爆,Phase 4 的闸门在整读之后来不及。
                const stat = fs.statSync(file.absPath);
                let parsed;
                if (maxBytes > 0 && stat.size >= maxBytes) {
                    appendDiag(DIAG_LOG_PATH, 'file:readDone', {
                        relativePath: file.relativePath,
                        contentLength: stat.size,
                        stream: true,
                    });
                    parsed = await extractSymbolsByRegexStream(file.absPath, file.relativePath);
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
