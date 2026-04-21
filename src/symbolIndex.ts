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
import type { FileCandidate } from './sync/batchClassifier';
import { classifyBatches } from './sync/batchClassifier';
import type { WorkerPool, ParseBatchResult } from './sync/workerPool';
import { SyncOrchestrator } from './sync/syncOrchestrator';
import { groupParseResult } from './sync/parseResultGrouping';

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
    // StorageManager 按 workspaceRoot 记忆化 —— 避免每次 sync/save/load 重新 new
    private readonly storageByRoot = new Map<string, StorageManager>();
    // S8: canonicalizeRoot 结果缓存 —— 避免每次 getStorage/clearDisk 都走 realpathSync syscall
    private readonly canonicalByInput = new Map<string, string>();
    // P7.3: 状态机事件化，替代 composition 层 2s 轮询
    private readonly _onStatusChanged = new vscode.EventEmitter<IndexStatus>();
    private readonly _onStatsChanged = new vscode.EventEmitter<{ files: number; symbols: number }>();

    constructor(deps: SymbolIndexDeps = {}) {
        this.workerPool = deps.workerPool;
        this.shardCount = deps.shardCount ?? DEFAULT_SHARD_COUNT;
    }

    get status(): IndexStatus { return this._status; }

    /** P7.3: status 状态机转换事件;相等守卫,重复赋值不 fire。 */
    get onStatusChanged(): vscode.Event<IndexStatus> { return this._onStatusChanged.event; }

    /** P7.3: stats 数量变更事件;仅在批处理完成末尾 fire,避免热循环风暴。 */
    get onStatsChanged(): vscode.Event<{ files: number; symbols: number }> { return this._onStatsChanged.event; }

    /** 释放 EventEmitter;由 composition 层在 ExtensionContext.subscriptions 中登记。 */
    dispose(): void {
        this._onStatusChanged.dispose();
        this._onStatsChanged.dispose();
    }

    /** @internal 测试钩子——不得用于生产代码路径。走 setStatus 以保持事件对称。 */
    _setStatusForTest(next: IndexStatus): void { this.setStatus(next); }

    /** @internal 测试钩子:暴露 storageByRoot 大小,用于验证路径标准化。 */
    _getStorageCountForTest(): number { return this.storageByRoot.size; }

    /** P7.3: 所有 this._status = X 赋值都走这里,带相等守卫,仅在状态确实变化时 fire。 */
    private setStatus(next: IndexStatus): void {
        if (this._status === next) { return; }
        this._status = next;
        this._onStatusChanged.fire(next);
    }

    /** P7.3: 在批处理完成末尾调用,fire 当前 stats 快照。 */
    private emitStats(): void {
        this._onStatsChanged.fire(this.inner.getStats());
    }

    getStats(): { files: number; symbols: number } {
        return this.inner.getStats();
    }

    markDirty(relativePath: string): void {
        this.dirtyFiles.add(relativePath);
        this.deletedFiles.delete(relativePath);
        if (this._status === 'ready') { this.setStatus('stale'); }
    }

    markDeleted(relativePath: string): void {
        this.deletedFiles.add(relativePath);
        this.dirtyFiles.delete(relativePath);
        if (this._status === 'ready') { this.setStatus('stale'); }
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
        this.setStatus('building');

        const storage = this.getStorage(workspaceRoot);
        const orchestrator = new SyncOrchestrator({
            scanFiles: async (root) => this.scanWorkspace(root, extensions, excludePatterns, includePaths, token),
            classify: async (input) => classifyBatches(input),
            workerPool: {
                parse: async (files, onBatchResult, onBatchComplete) => {
                    if (this.workerPool) {
                        await this.workerPool.parse(files, onBatchResult, onBatchComplete);
                        return;
                    }
                    // Fallback: single-batch emit
                    const result = await this.parseInProcess(files, workspaceRoot, onBatchComplete);
                    if (result.symbols.length + result.metadata.length + result.errors.length > 0) {
                        await onBatchResult(result);
                    }
                },
            },
            index: {
                update: (file, symbols) => this.inner.update(file, symbols),
                remove: file => {
                    this.inner.remove(file);
                    this.fileMetadata.delete(file);
                },
                applyMetadata: (metadata) => this.applyMetadataToCache(metadata),
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
            const fallback = this.inner.getStats().files > 0 ? 'stale' : 'none';
            this.setStatus(fallback);
            this.emitStats();
            return;
        }
        this.setStatus('ready');
        this.emitStats();
    }

    async syncDirty(workspaceRoot: string): Promise<void> {
        if (this.dirtyFiles.size === 0 && this.deletedFiles.size === 0) { return; }

        const storage = this.getStorage(workspaceRoot);
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

            const result = await this.runParse(files, workspaceRoot);
            this.applyParseResult(result);
        }
        this.dirtyFiles.clear();

        await storage.saveDirty(
            { symbolsByFile: this.inner.snapshot(), fileMetadata: new Map(this.fileMetadata) },
            dirtyPaths,
        );

        if (this._status === 'stale') { this.setStatus('ready'); }
        this.emitStats();
    }

    searchSymbols(query: string, workspaceRoot: string, options: SearchOptions): SearchResult[] {
        if (this._status !== 'ready' && this._status !== 'stale') { return []; }
        return this.inner.search(query, workspaceRoot, options);
    }

    async saveToDisk(workspaceRoot: string): Promise<void> {
        await this.getStorage(workspaceRoot).saveFull({
            symbolsByFile: this.inner.snapshot(),
            fileMetadata: new Map(this.fileMetadata),
        });
    }

    async loadFromDisk(workspaceRoot: string): Promise<boolean> {
        const snap = await this.getStorage(workspaceRoot).load();
        if (snap.symbolsByFile.size === 0 && snap.fileMetadata.size === 0) { return false; }
        this.inner.replaceAll(snap.symbolsByFile);
        this.fileMetadata.clear();
        for (const [k, v] of snap.fileMetadata) { this.fileMetadata.set(k, v); }
        this.setStatus('ready');
        this.emitStats();
        return true;
    }

    clear(): void {
        this.inner.replaceAll(new Map());
        this.fileMetadata.clear();
        this.dirtyFiles.clear();
        this.deletedFiles.clear();
        this.setStatus('none');
        this.emitStats();
    }

    clearDisk(workspaceRoot: string): void {
        const canonical = this.canonicalizeRoot(workspaceRoot);
        const indexDir = path.join(canonical, '.sisearch');
        try {
            fs.rmSync(indexDir, { recursive: true, force: true });
        } catch {
            // ignore
        }
        // 失效缓存,避免过时 StorageManager/canonical 指向已删目录
        this.storageByRoot.delete(canonical);
        // S8: 清掉所有映射到该 canonical 的输入缓存项
        for (const [input, canon] of this.canonicalByInput) {
            if (canon === canonical) { this.canonicalByInput.delete(input); }
        }
    }

    // ── Private helpers ─────────────────────────────────────────────────

    /** P7.5: 标准化 workspaceRoot —— 先 path.resolve 去 trailing slash / 相对段,
     *  再 fs.realpathSync 展开 symlink,使 `/proj` 与 `/var/real/proj`(若前者是 symlink)
     *  归一到同一 canonical key。realpathSync 失败(目录不存在等)时静默回退到 resolve 结果。
     *  S8: 结果按 resolved 输入缓存,避免同一 root 每次触达都走 syscall。 */
    private canonicalizeRoot(workspaceRoot: string): string {
        const resolved = path.resolve(workspaceRoot);
        const cached = this.canonicalByInput.get(resolved);
        if (cached !== undefined) { return cached; }
        let canonical: string;
        try {
            canonical = fs.realpathSync(resolved);
        } catch {
            canonical = resolved;
        }
        this.canonicalByInput.set(resolved, canonical);
        return canonical;
    }

    /** 按 workspaceRoot 记忆化 StorageManager,避免每次 sync/save/load 都重复 new。
     *  路径标准化:`/a/b`、`/a/b/`、以及 symlink 不同入口都归一到同一 key,防止重复实例化。 */
    private getStorage(workspaceRoot: string): StorageManager {
        const canonical = this.canonicalizeRoot(workspaceRoot);
        let storage = this.storageByRoot.get(canonical);
        if (!storage) {
            storage = new StorageManager({ workspaceRoot: canonical, shardCount: this.shardCount });
            this.storageByRoot.set(canonical, storage);
        }
        return storage;
    }

    /** 统一 parse 入口:有 WorkerPool 走它,否则主线程回退。
     *  onBatchComplete(done,total,lastFile) 会在每小批(默认 128 files)完成后触发,
     *  给 sync 驱动的 UI 提供逐批进度。主线程 fallback 下按单文件粒度发信号。 */
    private async runParse(
        files: Array<{ absPath: string; relativePath: string }>,
        workspaceRoot: string,
        onBatchComplete?: (done: number, total: number, lastFile?: string) => void,
    ): Promise<ParseBatchResult> {
        if (this.workerPool) {
            const aggregated: ParseBatchResult = { symbols: [], metadata: [], errors: [] };
            await this.workerPool.parse(
                files,
                async (batch) => {
                    for (const s of batch.symbols) { aggregated.symbols.push(s); }
                    for (const m of batch.metadata) { aggregated.metadata.push(m); }
                    for (const e of batch.errors) { aggregated.errors.push(e); }
                },
                onBatchComplete,
            );
            return aggregated;
        }
        return this.parseInProcess(files, workspaceRoot, onBatchComplete);
    }

    /** syncDirty 路径:把 parse 结果回灌 inner + fileMetadata。
     *  与 SyncOrchestrator.synchronize 共享 groupParseResult + applyMetadataToCache 语义。 */
    private applyParseResult(result: ParseBatchResult): void {
        const grouped = groupParseResult(result);
        this.applyMetadataToCache(result.metadata);
        for (const [file, symbols] of grouped) {
            this.inner.update(file, symbols);
        }
    }

    /** 共享:将 per-file 元数据写入 fileMetadata 缓存。
     *  收口 orchestrator applyMetadata closure 与 applyParseResult 两处调用。 */
    private applyMetadataToCache(metadata: IndexedFile[]): void {
        for (const meta of metadata) {
            this.fileMetadata.set(meta.relativePath, meta);
        }
    }

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
        onBatchComplete?: (done: number, total: number, lastFile?: string) => void,
    ): Promise<ParseBatchResult> {
        const { parseSymbols } = await import('./symbolParser');
        const symbols: SymbolEntry[] = [];
        const metadata: IndexedFile[] = [];
        const errors: string[] = [];

        const total = files.length;
        // 主线程 fallback:无 WorkerPool 场景,按 32 文件小批发进度,避免 per-file 抖动。
        const BATCH = 32;
        for (let i = 0; i < files.length; i++) {
            const f = files[i];
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
            if ((i + 1) % BATCH === 0 || i === files.length - 1) {
                onBatchComplete?.(i + 1, total, f.relativePath);
            }
        }
        void workspaceRoot;
        return { symbols, metadata, errors };
    }
}
