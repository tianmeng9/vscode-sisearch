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

/** 协作式取消信号。与 vscode.CancellationToken 结构兼容（只用 isCancellationRequested 字段），
 *  测试里直接传 `{ isCancellationRequested: boolean }` 即可,不需要真实 vscode 依赖。 */
export interface CancelSignal {
    readonly isCancellationRequested: boolean;
}

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
        cancelSignal?: CancelSignal,
    ): Promise<void> {
        if (files.length === 0) { return; }
        if (cancelSignal?.isCancellationRequested) { return; }

        const workers = await this.workersPromise;
        if (workers.length === 0) { return; }

        const total = files.length;
        const batchSize = this.batchSize;

        let cursor = 0;
        let done = 0;

        const workerLoop = async (worker: PoolWorker): Promise<void> => {
            while (true) {
                // Cancellation check at head — exit before claiming more work.
                if (cancelSignal?.isCancellationRequested) { return; }
                if (cursor >= total) { return; }
                const start = cursor;
                const end = Math.min(start + batchSize, total);
                cursor = end;

                const batch = files.slice(start, end);
                const result = await worker.parseBatch(batch);

                // Re-check after the long await — avoid invoking onBatchResult
                // (which may do disk I/O) after the caller asked us to stop.
                if (cancelSignal?.isCancellationRequested) { return; }

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

    /**
     * 销毁所有 worker 并用 factory 重建同等数量的新 worker。
     *
     * 为什么需要:Phase 1 已修掉 per-file `new Parser()` 的 WASM 碎片主源,正常
     * Sync 堆增长已经极小。但 Cancel 是边界场景 —— parseBatch 可能已发送到 worker、
     * 主线程却丢弃了 pending entry,worker 里的 parse() 仍在跑,最终 tree alloc
     * 发生了但 delete 对应的 Promise 已不存在。跨多次 cancel 累积,仍有复现 exit 134
     * 的风险。recycle 通过 terminate+重建,让 OS 整块回收 worker 线程栈和 WASM
     * linear memory,从零开始。
     *
     * 不在此处实现 quiesce —— dispose() 已经 reject 所有 pending、terminate 线程,
     * 主线程的 `await this.workerPool.parse(...)` 要么已返回(正常完成或 cancel 后
     * workerLoop 退出)、要么还在等 parseBatch 响应(被 reject)。调用方只需保证
     * 没有并发 parse 在跑(由 reentrancyGuard 保证)。
     */
    async recycle(): Promise<void> {
        const oldWorkers = await this.workersPromise;
        // 先原地替换 promise,避免并发 parse 看到半个旧 pool。
        this.workersPromise = Promise.all(
            Array.from({ length: this.options.size }, () => this.options.workerFactory()),
        );
        await Promise.all(oldWorkers.map(w => w.dispose()));
        // 等新 workers 真正构造完成,这样 recycle() 返回即可直接 parse。
        await this.workersPromise;
    }
}
