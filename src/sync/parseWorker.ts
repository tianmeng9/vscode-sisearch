// src/sync/parseWorker.ts
// Worker 线程入口 — 初始化 tree-sitter 并批量解析文件
// 通过 worker_threads 消息协议与主线程通信

import * as fs from 'fs';
import { parentPort, workerData } from 'worker_threads';
import { initParser, parseSymbols } from '../symbolParser';
import type { ParseBatchResult } from './workerPool';

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
            try {
                const content = fs.readFileSync(file.absPath, 'utf-8');
                const parsed = parseSymbols(file.absPath, file.relativePath, content, { maxBytes });
                symbols.push(...parsed);
                const stat = fs.statSync(file.absPath);
                metadata.push({
                    relativePath: file.relativePath,
                    mtime: stat.mtimeMs,
                    size: stat.size,
                    symbolCount: parsed.length,
                });
            } catch (err) {
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
