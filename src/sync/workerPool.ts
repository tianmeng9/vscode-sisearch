// src/sync/workerPool.ts
// Worker 线程池：调度批次解析，支持工厂注入（可测试）

import type { IndexedFile, SymbolEntry } from '../index/indexTypes';

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
}

export class WorkerPool {
    private workersPromise: Promise<PoolWorker[]>;

    constructor(private options: WorkerPoolOptions) {
        this.workersPromise = Promise.all(
            Array.from({ length: options.size }, () => options.workerFactory()),
        );
    }

    async parse(files: Array<{ absPath: string; relativePath: string }>): Promise<ParseBatchResult> {
        if (files.length === 0) {
            return { symbols: [], metadata: [], errors: [] };
        }

        const workers = await this.workersPromise;
        if (workers.length === 0) {
            return { symbols: [], metadata: [], errors: [] };
        }

        // Split files across workers for parallel processing
        const chunkSize = Math.ceil(files.length / workers.length);
        const chunks: Array<Array<{ absPath: string; relativePath: string }>> = [];
        for (let i = 0; i < files.length; i += chunkSize) {
            chunks.push(files.slice(i, i + chunkSize));
        }

        const results = await Promise.all(
            chunks.map((chunk, i) => workers[i % workers.length].parseBatch(chunk))
        );

        return results.reduce<ParseBatchResult>(
            (acc, r) => ({
                symbols: [...acc.symbols, ...r.symbols],
                metadata: [...acc.metadata, ...r.metadata],
                errors: [...acc.errors, ...r.errors],
            }),
            { symbols: [], metadata: [], errors: [] },
        );
    }

    async dispose(): Promise<void> {
        const workers = await this.workersPromise;
        await Promise.all(workers.map(w => w.dispose()));
    }
}
