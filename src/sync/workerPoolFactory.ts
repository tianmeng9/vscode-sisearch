// src/sync/workerPoolFactory.ts
// 用 worker_threads 构造真实的 PoolWorker — 每个 worker 持有独立的
// tree-sitter 解析器实例,主线程通过消息协议派发批次并聚合结果。

import * as path from 'path';
import { Worker } from 'worker_threads';
import type { PoolWorker, ParseBatchResult } from './workerPool';

/**
 * Worker 构造参数。
 *
 * maxBytes:透传给 parseWorker → parseSymbols 的大文件阈值。0 = 禁用(始终 tree-sitter),
 *   正整数 = content.length >= maxBytes 时走正则回退。详见 ParseOptions。
 *
 * WorkerCtor:测试注入点。生产代码用默认的 worker_threads.Worker;测试可注入 spy
 *   来验证 workerData 真的带上了 maxBytes,不必启动真实线程。
 */
export interface WorkerThreadPoolWorkerOptions {
    maxBytes?: number;
    WorkerCtor?: new (script: string, options: { workerData: unknown }) => {
        on(event: 'message', listener: (msg: any) => void): void;
        on(event: 'error', listener: (err: Error) => void): void;
        on(event: 'exit', listener: (code: number) => void): void;
        postMessage(msg: unknown): void;
        terminate(): Promise<number>;
    };
}

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
    options: WorkerThreadPoolWorkerOptions = {},
): PoolWorker {
    const WorkerCtor = options.WorkerCtor ?? (Worker as unknown as NonNullable<WorkerThreadPoolWorkerOptions['WorkerCtor']>);
    const maxBytes = options.maxBytes ?? 0;
    const worker = new WorkerCtor(workerScriptPath, {
        workerData: { extensionPath, maxBytes },
    });

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
export function createWorkerThreadFactory(
    extensionPath: string,
    options: { maxBytes?: number } = {},
): () => Promise<PoolWorker> {
    const workerScriptPath = path.join(extensionPath, 'out', 'src', 'sync', 'parseWorker.js');
    return async () => createWorkerThreadPoolWorker(workerScriptPath, extensionPath, {
        maxBytes: options.maxBytes,
    });
}
