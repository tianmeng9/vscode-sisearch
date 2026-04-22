// src/sync/syncOrchestrator.ts
// 全量/增量 Sync 主线程调度器 —— M10c 后 db 变成 SyncDb 接口(由 façade 提供适配器),
// 主线程 read handle + writer worker 的组合被透明封装在适配器里。

import type { IndexedFile } from '../index/indexTypes';
import type { FileCandidate, ClassifyResult } from './batchClassifier';
import type { ParseBatchResult } from './workerPool';
import type { WriteBatch } from '../index/dbBackend';

/**
 * M10c: 抽象化 SyncOrchestrator 所需的 db 能力。实际实现可能是:
 *  - 直接的 DbBackend(测试走 :memory:)
 *  - 适配器:writeBatch 转发到 DbWriterClient(worker_thread),getAllFileMetadata 从 readonly handle 读
 *
 *  writeBatch 返回 void | Promise<void>:void = 立即完成(:memory: 直通),
 *  Promise = adapter 需要 back-pressure(例如 writerClient 的 pending 队列满)。
 *  orchestrator 会 await 返回值,从而天然节流。
 *
 *  checkpoint 从 orchestrator 视角可以是 no-op —— façade 在 orchestrator 返回后 drain + checkpoint 收尾。
 */
export interface SyncDb {
    writeBatch(batch: WriteBatch): void | Promise<void>;
    getAllFileMetadata(): Map<string, IndexedFile>;
    checkpoint(): void;
}

export interface SyncDeps {
    scanFiles: (workspaceRoot: string) => Promise<FileCandidate[]>;
    classify: (input: {
        workspaceRoot: string;
        currentFiles: FileCandidate[];
        previousFiles: Map<string, IndexedFile>;
    }) => Promise<ClassifyResult>;
    workerPool: {
        parse(
            files: Array<{ absPath: string; relativePath: string }>,
            onBatchResult: (result: ParseBatchResult) => Promise<void>,
            onBatchComplete?: (done: number, total: number, lastFile?: string) => void,
            cancelSignal?: { readonly isCancellationRequested: boolean },
        ): Promise<void>;
    };
    /** 单一持久化出口:writeBatch / getAllFileMetadata / checkpoint。 */
    db: SyncDb;
    onProgress?: (phase: string, current: number, total: number, currentFile?: string) => void;
}

export interface SyncOptions {
    workspaceRoot: string;
    cancellationToken?: { isCancellationRequested: boolean };
}

export class SyncOrchestrator {
    constructor(private deps: SyncDeps) {}

    async synchronize(options: SyncOptions): Promise<void> {
        const { workspaceRoot, cancellationToken } = options;

        this.deps.onProgress?.('scanning', 0, 0);
        const currentFiles = await this.deps.scanFiles(workspaceRoot);

        if (cancellationToken?.isCancellationRequested) { return; }

        this.deps.onProgress?.('classifying', 0, currentFiles.length);
        const previousFiles = this.deps.db.getAllFileMetadata();
        const classified = await this.deps.classify({ workspaceRoot, currentFiles, previousFiles });

        // 待写入的删除列表:第一批 writeBatch 把它们全部带走(并清空),后续批次只有 metadata/symbols。
        const pendingDeletes: string[] = [...classified.toDelete];
        // 是否本轮有任何 DB 变更 —— 决定末尾是否 checkpoint。
        let hadWrite = pendingDeletes.length > 0;

        if (cancellationToken?.isCancellationRequested) { return; }

        // Parse changed/new files via worker pool
        if (classified.toProcess.length > 0) {
            this.deps.onProgress?.('parsing', 0, classified.toProcess.length);
            await this.deps.workerPool.parse(
                classified.toProcess.map(f => ({ absPath: f.absPath, relativePath: f.relativePath })),
                async (batch: ParseBatchResult) => {
                    const deletes = pendingDeletes.splice(0);
                    // await 返回值:void 立即 resolve(测试路径),Promise 则阻塞
                    // workerLoop 直到 writer back-pressure 松开。这是防止 writer
                    // 队列被 fire-and-forget 淹没的关键节流点。
                    await this.deps.db.writeBatch({
                        metadata: batch.metadata,
                        symbols: batch.symbols,
                        deletedRelativePaths: deletes,
                    });
                    hadWrite = true;
                },
                (done, total, lastFile) => {
                    this.deps.onProgress?.('parsing', done, total, lastFile);
                },
                // Forward cancellation so the pool can exit workerLoops promptly
                // instead of draining every file after the user hit cancel.
                cancellationToken,
            );
        }

        if (cancellationToken?.isCancellationRequested) { return; }

        // 如果解析阶段没有任何批次(e.g. toProcess 空但 toDelete 非空),单独下发 delete-only 批。
        if (pendingDeletes.length > 0) {
            this.deps.db.writeBatch({
                metadata: [],
                symbols: [],
                deletedRelativePaths: pendingDeletes.splice(0),
            });
            hadWrite = true;
        }

        // Persist —— DbBackend 事务已随 writeBatch 落盘,这里只需一次 WAL checkpoint 收尾。
        if (hadWrite) {
            this.deps.onProgress?.('saving', 0, 1);
            this.deps.db.checkpoint();
        } else {
            this.deps.onProgress?.('saving', 0, 0);
        }
    }
}
