// src/sync/parseWorker.ts
// Worker 线程入口 — 初始化 tree-sitter 并批量解析文件
// 通过 worker_threads 消息协议与主线程通信

import * as fs from 'fs';
import { parentPort, workerData } from 'worker_threads';
import { createReusableParser } from '../symbolParser';
import type { ParseBatchResult } from './workerPool';

interface ParseBatchRequest {
    type: 'parseBatch';
    requestId: number;
    files: Array<{ absPath: string; relativePath: string }>;
}

async function main(): Promise<void> {
    const parser = await createReusableParser(workerData.extensionPath as string);

    // Worker 主线程退出前释放 parser 持有的 WASM native 句柄。
    // 在 Node 事件循环退出前触发,避免 native 资源由 GC 兜底。
    const cleanup = (): void => {
        try { parser.dispose(); } catch { /* ignore */ }
    };
    process.on('exit', cleanup);
    process.on('beforeExit', cleanup);

    parentPort?.on('message', async (message: ParseBatchRequest) => {
        if (message.type !== 'parseBatch') {
            return;
        }

        const symbols: ParseBatchResult['symbols'] = [];
        const metadata: ParseBatchResult['metadata'] = [];
        const errors: string[] = [];

        for (const file of message.files) {
            try {
                const content = fs.readFileSync(file.absPath, 'utf-8');
                const parsed = parser.parse(file.absPath, file.relativePath, content);
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
