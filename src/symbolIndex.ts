// src/symbolIndex.ts
// Façade：保留历史公开 API，但内部委托给 InMemorySymbolIndex + StorageManager + SyncOrchestrator。
// 所有持久化走 MessagePack 分片（StorageManager），解析走 WorkerPool。

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import {
    IndexedFile,
    IndexStatus,
    SearchOptions,
    SearchResult,
    SyncProgress,
    SymbolEntry,
} from './types';
import { InMemorySymbolIndex } from './index/symbolIndex';
import { StorageManager } from './storage/storageManager';
import type { ClassifyResult, FileCandidate } from './sync/batchClassifier';
import { classifyBatches } from './sync/batchClassifier';
import type { WorkerPool } from './sync/workerPool';
import { SyncOrchestrator } from './sync/syncOrchestrator';

const DEFAULT_SHARD_COUNT = 16;

export interface SymbolIndexDeps {
    /** 可选注入 WorkerPool；未提供时 façade 回退为同步解析（测试用）。 */
    workerPool?: WorkerPool;
    shardCount?: number;
}

export class SymbolIndex {
    private readonly inner = new InMemorySymbolIndex();
    private readonly fileMetadata = new Map<string, IndexedFile>();
    private readonly dirtyFiles = new Set<string>();
    private readonly deletedFiles = new Set<string>();
    private _status: IndexStatus = 'none';
    private readonly shardCount: number;
    private workerPool: WorkerPool | undefined;

    constructor(deps: SymbolIndexDeps = {}) {
        this.workerPool = deps.workerPool;
        this.shardCount = deps.shardCount ?? DEFAULT_SHARD_COUNT;
    }

    get status(): IndexStatus { return this._status; }

    /** @internal 测试钩子——不得用于生产代码路径。 */
    _setStatusForTest(next: IndexStatus): void { this._status = next; }

    getStats(): { files: number; symbols: number } {
        return this.inner.getStats();
    }

    markDirty(relativePath: string): void {
        this.dirtyFiles.add(relativePath);
        this.deletedFiles.delete(relativePath);
        if (this._status === 'ready') { this._status = 'stale'; }
    }

    markDeleted(relativePath: string): void {
        this.deletedFiles.add(relativePath);
        this.dirtyFiles.delete(relativePath);
        if (this._status === 'ready') { this._status = 'stale'; }
    }

    setWorkerPool(workerPool: WorkerPool | undefined): void {
        this.workerPool = workerPool;
    }

    async synchronize(
        workspaceRoot: string,
        extensions: string[],
        excludePatterns: string[],
        token: vscode.CancellationToken,
        onProgress?: (p: SyncProgress) => void,
        includePaths?: string[],
    ): Promise<void> {
        this._status = 'building';

        const storage = new StorageManager({ workspaceRoot, shardCount: this.shardCount });
        const workerPool = this.workerPool;

        // Wrap the parse call to capture per-file metadata by relativePath. The orchestrator only
        // forwards symbols + metadata arrays; we use this map so index.update() can pick up the
        // matching IndexedFile at the moment it applies symbols.
        const pendingMetadata = new Map<string, IndexedFile>();
        const wrappedParse = async (files: Array<{ absPath: string; relativePath: string }>) => {
            const result = workerPool
                ? await workerPool.parse(files)
                : await this.parseInProcess(files, workspaceRoot);
            for (const m of result.metadata) {
                pendingMetadata.set(m.relativePath, m);
            }
            return result;
        };

        const orchestrator = new SyncOrchestrator({
            scanFiles: async (root) => this.scanWorkspace(root, extensions, excludePatterns, includePaths, token),
            classify: async (input) => classifyBatches(input),
            workerPool: { parse: wrappedParse },
            index: {
                update: (file, symbols) => {
                    this.inner.update(file, symbols);
                    const meta = pendingMetadata.get(file);
                    if (meta) {
                        this.fileMetadata.set(file, meta);
                        pendingMetadata.delete(file);
                    } else {
                        const existing = this.fileMetadata.get(file);
                        this.fileMetadata.set(file, existing ?? {
                            relativePath: file,
                            mtime: 0,
                            size: 0,
                            symbolCount: symbols.length,
                        });
                    }
                },
                remove: file => {
                    this.inner.remove(file);
                    this.fileMetadata.delete(file);
                },
                fileMetadata: this.fileMetadata,
            },
            storage: {
                saveFull: snapshot => storage.saveFull(snapshot),
                saveDirty: (snapshot, dirty) => storage.saveDirty(snapshot, dirty),
            },
            getSnapshot: () => ({
                symbolsByFile: this.inner.snapshot(),
                fileMetadata: new Map(this.fileMetadata),
            }),
            onProgress: (phase, current, total, currentFile) => {
                onProgress?.({ phase: phase as SyncProgress['phase'], current, total, currentFile });
            },
        });

        await orchestrator.synchronize({
            workspaceRoot,
            cancellationToken: { get isCancellationRequested() { return token.isCancellationRequested; } },
        });

        this.dirtyFiles.clear();
        this.deletedFiles.clear();
        if (token.isCancellationRequested) {
            this._status = this.inner.getStats().files > 0 ? 'stale' : 'none';
            return;
        }
        this._status = 'ready';
    }

    async syncDirty(workspaceRoot: string): Promise<void> {
        if (this.dirtyFiles.size === 0 && this.deletedFiles.size === 0) { return; }

        const storage = new StorageManager({ workspaceRoot, shardCount: this.shardCount });
        const workerPool = this.workerPool;
        const dirtyPaths = new Set<string>([...this.dirtyFiles, ...this.deletedFiles]);

        for (const rel of this.deletedFiles) {
            this.inner.remove(rel);
            this.fileMetadata.delete(rel);
        }
        this.deletedFiles.clear();

        if (this.dirtyFiles.size > 0) {
            const files = [...this.dirtyFiles].map(rel => ({
                absPath: path.resolve(workspaceRoot, rel),
                relativePath: rel,
            }));

            const result = workerPool
                ? await workerPool.parse(files)
                : await this.parseInProcess(files, workspaceRoot);

            // Group symbols by file
            const grouped = new Map<string, SymbolEntry[]>();
            for (const sym of result.symbols) {
                const bucket = grouped.get(sym.relativePath);
                if (bucket) { bucket.push(sym); } else { grouped.set(sym.relativePath, [sym]); }
            }
            for (const meta of result.metadata) {
                if (!grouped.has(meta.relativePath)) { grouped.set(meta.relativePath, []); }
                this.fileMetadata.set(meta.relativePath, meta);
            }
            for (const [file, symbols] of grouped) {
                this.inner.update(file, symbols);
            }
        }
        this.dirtyFiles.clear();

        await storage.saveDirty(
            { symbolsByFile: this.inner.snapshot(), fileMetadata: new Map(this.fileMetadata) },
            dirtyPaths,
        );

        if (this._status === 'stale') { this._status = 'ready'; }
    }

    searchSymbols(query: string, workspaceRoot: string, options: SearchOptions): SearchResult[] {
        if (this._status !== 'ready' && this._status !== 'stale') { return []; }
        return this.inner.search(query, workspaceRoot, options);
    }

    async saveToDisk(workspaceRoot: string): Promise<void> {
        const storage = new StorageManager({ workspaceRoot, shardCount: this.shardCount });
        await storage.saveFull({
            symbolsByFile: this.inner.snapshot(),
            fileMetadata: new Map(this.fileMetadata),
        });
    }

    async loadFromDisk(workspaceRoot: string): Promise<boolean> {
        const storage = new StorageManager({ workspaceRoot, shardCount: this.shardCount });
        const snap = await storage.load();
        if (snap.symbolsByFile.size === 0 && snap.fileMetadata.size === 0) { return false; }
        this.inner.replaceAll(snap.symbolsByFile);
        this.fileMetadata.clear();
        for (const [k, v] of snap.fileMetadata) { this.fileMetadata.set(k, v); }
        this._status = 'ready';
        return true;
    }

    clear(): void {
        this.inner.replaceAll(new Map());
        this.fileMetadata.clear();
        this.dirtyFiles.clear();
        this.deletedFiles.clear();
        this._status = 'none';
    }

    clearDisk(workspaceRoot: string): void {
        const indexDir = path.join(workspaceRoot, '.sisearch');
        try {
            fs.rmSync(indexDir, { recursive: true, force: true });
        } catch {
            // ignore
        }
    }

    // ── Private helpers ─────────────────────────────────────────────────

    private async scanWorkspace(
        workspaceRoot: string,
        extensions: string[],
        excludePatterns: string[],
        includePaths: string[] | undefined,
        token: vscode.CancellationToken,
    ): Promise<FileCandidate[]> {
        const extGlob = `*{${extensions.join(',')}}`;
        const excludeGlob = excludePatterns.length ? `{${excludePatterns.join(',')}}` : undefined;
        const prefixes = includePaths && includePaths.length > 0 ? includePaths : ['**'];

        const allUris: vscode.Uri[] = [];
        for (const prefix of prefixes) {
            if (token.isCancellationRequested) { break; }
            const pattern = prefix === '**' ? `**/${extGlob}` : `${prefix}/**/${extGlob}`;
            const uris = await vscode.workspace.findFiles(pattern, excludeGlob);
            allUris.push(...uris);
        }

        const candidates: FileCandidate[] = [];
        for (const uri of allUris) {
            try {
                const stat = await vscode.workspace.fs.stat(uri);
                const rel = path.relative(workspaceRoot, uri.fsPath);
                candidates.push({ relativePath: rel, absPath: uri.fsPath, mtime: stat.mtime, size: stat.size });
            } catch {
                // Skip files we cannot stat
            }
        }
        return candidates;
    }

    /**
     * 无 WorkerPool 时的回退路径：在主线程同步解析（仅用于测试/降级）。
     */
    private async parseInProcess(
        files: Array<{ absPath: string; relativePath: string }>,
        workspaceRoot: string,
    ): Promise<{ symbols: SymbolEntry[]; metadata: IndexedFile[]; errors: string[] }> {
        const { parseSymbols } = await import('./symbolParser');
        const symbols: SymbolEntry[] = [];
        const metadata: IndexedFile[] = [];
        const errors: string[] = [];

        for (const f of files) {
            try {
                const uri = vscode.Uri.file(f.absPath);
                const contentBytes = await vscode.workspace.fs.readFile(uri);
                const content = Buffer.from(contentBytes).toString('utf-8');
                const parsed = parseSymbols(f.absPath, f.relativePath, content);
                symbols.push(...parsed);
                const stat = await vscode.workspace.fs.stat(uri);
                metadata.push({ relativePath: f.relativePath, mtime: stat.mtime, size: stat.size, symbolCount: parsed.length });
            } catch (e) {
                errors.push(`${f.relativePath}: ${(e as Error).message}`);
            }
        }
        // Silence unused parameter — workspaceRoot not needed after refactor
        void workspaceRoot;
        return { symbols, metadata, errors };
    }
}
