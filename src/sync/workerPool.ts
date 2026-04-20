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
        onBatchComplete?: OnBatchComplete,
    ): Promise<ParseBatchResult> {
        if (files.length === 0) {
            return { symbols: [], metadata: [], errors: [] };
        }

        const workers = await this.workersPromise;
        if (workers.length === 0) {
            return { symbols: [], metadata: [], errors: [] };
        }

        const total = files.length;
        const batchSize = this.batchSize;

        // 共享游标：下一个要处理的文件起点索引。
        // Node 单线程事件循环内 cursor 的读改写是原子的 —— 每个 worker 的 loop 是 async 函数，
        // 真正的竞争只发生在 await 之后重新调度时，期间 cursor 只被单一执行路径推进。
        let cursor = 0;
        let done = 0;
        const aggregated: ParseBatchResult = { symbols: [], metadata: [], errors: [] };

        const workerLoop = async (worker: PoolWorker): Promise<void> => {
            while (true) {
                if (cursor >= total) { return; }
                const start = cursor;
                const end = Math.min(start + batchSize, total);
                cursor = end;

                const batch = files.slice(start, end);
                const result = await worker.parseBatch(batch);

                // 聚合结果
                for (const s of result.symbols) { aggregated.symbols.push(s); }
                for (const m of result.metadata) { aggregated.metadata.push(m); }
                for (const e of result.errors) { aggregated.errors.push(e); }

                done += batch.length;
                onBatchComplete?.(done, total, batch[batch.length - 1]?.relativePath);
            }
        };

        await Promise.all(workers.map(w => workerLoop(w)));

        return aggregated;
    }

    async dispose(): Promise<void> {
        const workers = await this.workersPromise;
        await Promise.all(workers.map(w => w.dispose()));
    }
}
