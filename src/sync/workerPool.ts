// src/sync/workerPool.ts
// Worker 线程池：调度批次解析，支持工厂注入（可测试）
//
// 调度策略：task queue + 小批（BATCH_SIZE 文件/批），worker 空闲领批。
// 相比“每 worker 一个大 chunk”的平均切分，好处是：
// 1) 进度回调粒度细 —— 每完成一批就能 report 一次 (done/total + lastFile)；
// 2) 慢 worker 不会拖累整体 —— 空闲 worker 继续领新批。

import type { IndexedFile, SymbolEntry } from '../index/indexTypes';

/** 每个批次的文件数。太小 → IPC 开销; 太大 → 进度粒度粗 + native 分配爆发。
 *  取证：33k 文件 sync 中 VS Code 闪退,怀疑是 symbolParser 里 per-file `new ParserClass()`
 *  在一次 parseBatch 内爆发式创建销毁导致 WASM native 堆波动。先降到 32 试试。 */
const BATCH_SIZE = 32;

export interface ParseBatchResult {
    symbols: SymbolEntry[];
    metadata: IndexedFile[];
    errors: string[];
}

export interface PoolWorker {
    parseBatch(files: Array<{ absPath: string; relativePath: string }>): Promise<ParseBatchResult>;
    dispose(): Promise<void>;
}

export interface WorkerPoolOptions {
    size: number;
    workerFactory: () => Promise<PoolWorker>;
    /** 可选覆盖默认批大小（测试用）。 */
    batchSize?: number;
}

/** 每批完成的回调。done = 已完成文件数（累计）, total = 总文件数, lastFile = 本批最后一个文件的 relativePath。 */
export type OnBatchComplete = (done: number, total: number, lastFile?: string) => void;

export class WorkerPool {
    private workersPromise: Promise<PoolWorker[]>;
    private batchSize: number;

    constructor(private options: WorkerPoolOptions) {
        this.workersPromise = Promise.all(
            Array.from({ length: options.size }, () => options.workerFactory()),
        );
        this.batchSize = options.batchSize ?? BATCH_SIZE;
    }

    async parse(
        files: Array<{ absPath: string; relativePath: string }>,
        onBatchResult: (result: ParseBatchResult) => Promise<void>,
        onBatchComplete?: OnBatchComplete,
    ): Promise<void> {
        if (files.length === 0) { return; }

        const workers = await this.workersPromise;
        if (workers.length === 0) { return; }

        const total = files.length;
        const batchSize = this.batchSize;

        let cursor = 0;
        let done = 0;

        const workerLoop = async (worker: PoolWorker): Promise<void> => {
            while (true) {
                if (cursor >= total) { return; }
                const start = cursor;
                const end = Math.min(start + batchSize, total);
                cursor = end;

                const batch = files.slice(start, end);
                const result = await worker.parseBatch(batch);

                // Back-pressure: the next worker step only proceeds once the
                // caller has consumed this batch. Errors propagate to Promise.all.
                await onBatchResult(result);

                done += batch.length;
                onBatchComplete?.(done, total, batch[batch.length - 1]?.relativePath);
            }
        };

        await Promise.all(workers.map(w => workerLoop(w)));
    }

    async dispose(): Promise<void> {
        const workers = await this.workersPromise;
        await Promise.all(workers.map(w => w.dispose()));
    }
}
