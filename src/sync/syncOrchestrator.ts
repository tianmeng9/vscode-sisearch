// src/sync/syncOrchestrator.ts
// 全量/增量 Sync 主线程调度器

import type { SymbolEntry, IndexedFile } from '../index/indexTypes';
import type { FileCandidate, ClassifyResult } from './batchClassifier';
import type { ParseBatchResult } from './workerPool';
import { groupParseResult } from './parseResultGrouping';

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
        ): Promise<void>;
    };
    index: {
        update(file: string, symbols: SymbolEntry[]): void;
        remove(file: string): void;
        /** 由 worker parse 产出的 per-file 元数据;在 update() 之前调用,避免闭包 kludge */
        applyMetadata(metadata: IndexedFile[]): void;
        fileMetadata?: Map<string, IndexedFile>;
    };
    storage: {
        saveFull(snapshot: {
            symbolsByFile: Map<string, SymbolEntry[]>;
            fileMetadata: Map<string, IndexedFile>;
        }): Promise<void>;
        saveDirty?(
            snapshot: {
                symbolsByFile: Map<string, SymbolEntry[]>;
                fileMetadata: Map<string, IndexedFile>;
            },
            dirtyPaths: Set<string>,
        ): Promise<void>;
    };
    /** 读取最新索引快照，用于驱动 storage.saveFull/saveDirty。 */
    getSnapshot: () => {
        symbolsByFile: Map<string, SymbolEntry[]>;
        fileMetadata: Map<string, IndexedFile>;
    };
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
        const previousFiles = this.deps.index.fileMetadata ?? new Map<string, IndexedFile>();
        const classified = await this.deps.classify({ workspaceRoot, currentFiles, previousFiles });

        // Track paths that changed this run — drives saveDirty
        const dirtyPaths = new Set<string>();

        // Apply deletions
        for (const relativePath of classified.toDelete) {
            this.deps.index.remove(relativePath);
            dirtyPaths.add(relativePath);
        }

        if (cancellationToken?.isCancellationRequested) { return; }

        // Parse changed/new files via worker pool
        if (classified.toProcess.length > 0) {
            this.deps.onProgress?.('parsing', 0, classified.toProcess.length);
            await this.deps.workerPool.parse(
                classified.toProcess.map(f => ({ absPath: f.absPath, relativePath: f.relativePath })),
                async (batch) => {
                    const grouped = groupParseResult(batch);
                    this.deps.index.applyMetadata(batch.metadata);
                    for (const [file, symbols] of grouped) {
                        this.deps.index.update(file, symbols);
                        dirtyPaths.add(file);
                    }
                },
                (done, total, lastFile) => {
                    this.deps.onProgress?.('parsing', done, total, lastFile);
                },
            );
        }

        if (cancellationToken?.isCancellationRequested) { return; }

        // Persist to storage — incremental if possible
        if (dirtyPaths.size > 0) {
            this.deps.onProgress?.('saving', 0, dirtyPaths.size);
            const snapshot = this.deps.getSnapshot();
            if (this.deps.storage.saveDirty) {
                await this.deps.storage.saveDirty(snapshot, dirtyPaths);
            } else {
                await this.deps.storage.saveFull(snapshot);
            }
        } else {
            this.deps.onProgress?.('saving', 0, 0);
        }
    }
}
