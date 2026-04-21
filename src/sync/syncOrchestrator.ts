// src/sync/syncOrchestrator.ts
// 全量/增量 Sync 主线程调度器 —— M2.3 后 deps 只含 db: DbBackend。

import type { IndexedFile } from '../index/indexTypes';
import type { FileCandidate, ClassifyResult } from './batchClassifier';
import type { ParseBatchResult } from './workerPool';
import type { DbBackend } from '../index/dbBackend';

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
    db: Pick<DbBackend, 'writeBatch' | 'getAllFileMetadata' | 'checkpoint'>;
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
                    this.deps.db.writeBatch({
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
