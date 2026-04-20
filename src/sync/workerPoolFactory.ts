// src/sync/workerPoolFactory.ts
// 用 worker_threads 构造真实的 PoolWorker — 每个 worker 持有独立的
// tree-sitter 解析器实例,主线程通过消息协议派发批次并聚合结果。

import * as path from 'path';
import { Worker } from 'worker_threads';
import type { PoolWorker, ParseBatchResult } from './workerPool';

interface BatchResultMessage {
    type: 'batchResult';
    requestId: number;
    symbols: ParseBatchResult['symbols'];
    metadata: ParseBatchResult['metadata'];
    errors: string[];
}

interface PendingBatch {
    resolve(result: ParseBatchResult): void;
    reject(err: Error): void;
}

/**
 * 创建一个基于 worker_threads 的 PoolWorker。workerScriptPath 必须是已编译的
 * parseWorker.js 的绝对路径(通常是 `path.join(extensionPath, 'out/src/sync/parseWorker.js')`)。
 */
export function createWorkerThreadPoolWorker(
    workerScriptPath: string,
    extensionPath: string,
): PoolWorker {
    const worker = new Worker(workerScriptPath, { workerData: { extensionPath } });

    let nextRequestId = 1;
    const pending = new Map<number, PendingBatch>();
    let disposed = false;
    let initError: Error | undefined;

    worker.on('message', (msg: BatchResultMessage) => {
        if (msg.type !== 'batchResult') { return; }
        const p = pending.get(msg.requestId);
        if (!p) { return; }
        pending.delete(msg.requestId);
        p.resolve({ symbols: msg.symbols, metadata: msg.metadata, errors: msg.errors });
    });

    worker.on('error', err => {
        initError = err;
        for (const p of pending.values()) { p.reject(err); }
        pending.clear();
    });

    worker.on('exit', code => {
        if (code !== 0 && !disposed) {
            const err = new Error(`parseWorker exited with code ${code}`);
            initError = err;
            for (const p of pending.values()) { p.reject(err); }
            pending.clear();
        }
    });

    return {
        async parseBatch(files) {
            if (initError) { throw initError; }
            if (disposed) { throw new Error('worker disposed'); }
            if (files.length === 0) { return { symbols: [], metadata: [], errors: [] }; }

            const requestId = nextRequestId++;
            return new Promise<ParseBatchResult>((resolve, reject) => {
                pending.set(requestId, { resolve, reject });
                worker.postMessage({ type: 'parseBatch', requestId, files });
            });
        },

        async dispose() {
            disposed = true;
            for (const p of pending.values()) {
                p.reject(new Error('worker disposed'));
            }
            pending.clear();
            await worker.terminate();
        },
    };
}

/**
 * 构造 WorkerPool 可直接使用的 factory。返回的 factory 每次调用生成一个新的
 * PoolWorker(用于线程池尺寸 > 1 的情况)。
 */
export function createWorkerThreadFactory(extensionPath: string): () => Promise<PoolWorker> {
    const workerScriptPath = path.join(extensionPath, 'out', 'src', 'sync', 'parseWorker.js');
    return async () => createWorkerThreadPoolWorker(workerScriptPath, extensionPath);
}
