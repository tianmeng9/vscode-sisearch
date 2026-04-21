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
            cancelSignal?: { readonly isCancellationRequested: boolean },
        ): Promise<void>;
        /** 可选:在 cancel 后由 orchestrator 调用,丢弃被中断的 worker 以防 WASM
         *  堆脏状态累积。老 adapter 可能没实现,因此可选。 */
        recycle?(): Promise<void>;
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
                // Forward cancellation so the pool can exit workerLoops promptly
                // instead of draining every file after the user hit cancel.
                cancellationToken,
            );
        }

        if (cancellationToken?.isCancellationRequested) {
            // parse 被中断:丢弃的 parseBatch 可能已让 worker 的 WASM 堆留下僵尸 alloc
            // (主线程 pending Map 已清,但 worker 里的 tree.alloc 已发生)。
            // 跨多次 cancel 累积后仍可能触发 exit 134。recycle 让 OS 回收整条 worker
            // 线程 + WASM linear memory,下一轮 sync 从干净状态开始。
            // 只在 parse 真正跑过(toProcess > 0)时才需要 —— 之前阶段 cancel 无脏堆。
            if (classified.toProcess.length > 0) {
                await this.deps.workerPool.recycle?.();
            }
            return;
        }

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
