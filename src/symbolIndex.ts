// src/symbolIndex.ts
// Façade：保留历史公开 API，但内部从 InMemorySymbolIndex + StorageManager 换成 DbBackend。
// 每次 writeBatch 在 SQLite 事务内落盘,saveToDisk 变 no-op;搜索走 FTS5,行内容按需从源文件读。

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
import { DbBackend } from './index/dbBackend';
import { LineContentReader } from './index/lineContentReader';
import type { FileCandidate } from './sync/batchClassifier';
import { classifyBatches } from './sync/batchClassifier';
import type { WorkerPool, ParseBatchResult } from './sync/workerPool';
import { SyncOrchestrator, type SyncDeps as SyncOrchestratorDeps } from './sync/syncOrchestrator';
import { groupParseResult } from './sync/parseResultGrouping';
import { createReentrancyGuard } from './sync/reentrancyGuard';

export interface SymbolIndexDeps {
    /** 可选注入 WorkerPool；未提供时 façade 回退为同步解析（测试用）。 */
    workerPool?: WorkerPool;
    /** 测试钩子:覆盖 DbBackend 文件路径(传 ':memory:' 可走内存 DB)。 */
    dbPath?: string;
}

export class SymbolIndex {
    private readonly dirtyFiles = new Set<string>();
    private readonly deletedFiles = new Set<string>();
    private _status: IndexStatus = 'none';
    private workerPool: WorkerPool | undefined;
    // 单并发 synchronize 闸门：cancel-then-resync 会并行两条 pipeline 共享 workerPool,
    // 33k 文件级别直接把 VS Code 打崩。详见 src/sync/reentrancyGuard.ts。
    private readonly syncGuard = createReentrancyGuard();
    // DbBackend 按 canonical workspaceRoot 记忆化。
    private readonly dbByRoot = new Map<string, DbBackend>();
    // 搜索命中后按需读取行内容的 LRU cache。
    private readonly lineReader = new LineContentReader();
    // 测试注入:覆盖 DbBackend 文件路径(如 ':memory:')。
    private readonly dbPathOverride: string | undefined;
    // S8: canonicalizeRoot 结果缓存 —— 避免每次都走 realpathSync syscall
    private readonly canonicalByInput = new Map<string, string>();
    // P7.3: 状态机事件化，替代 composition 层 2s 轮询
    private readonly _onStatusChanged = new vscode.EventEmitter<IndexStatus>();
    private readonly _onStatsChanged = new vscode.EventEmitter<{ files: number; symbols: number }>();

    constructor(deps: SymbolIndexDeps = {}) {
        this.workerPool = deps.workerPool;
        this.dbPathOverride = deps.dbPath;
    }

    get status(): IndexStatus { return this._status; }

    /** P7.3: status 状态机转换事件;相等守卫,重复赋值不 fire。 */
    get onStatusChanged(): vscode.Event<IndexStatus> { return this._onStatusChanged.event; }

    /** P7.3: stats 数量变更事件;仅在批处理完成末尾 fire,避免热循环风暴。 */
    get onStatsChanged(): vscode.Event<{ files: number; symbols: number }> { return this._onStatsChanged.event; }

    /** 释放 EventEmitter;由 composition 层在 ExtensionContext.subscriptions 中登记。 */
    dispose(): void {
        for (const db of this.dbByRoot.values()) {
            try { db.close(); } catch { /* ignore */ }
        }
        this.dbByRoot.clear();
        this._onStatusChanged.dispose();
        this._onStatsChanged.dispose();
    }

    /** @internal 测试钩子——不得用于生产代码路径。走 setStatus 以保持事件对称。 */
    _setStatusForTest(next: IndexStatus): void { this.setStatus(next); }

    /** @internal 测试钩子:暴露 dbByRoot 大小,用于验证路径标准化。 */
    _getStorageCountForTest(): number { return this.dbByRoot.size; }

    /** 公开查询:sync 是否正在进行。供搜索路径决定是否走 fallback。 */
    isSyncInProgress(): boolean { return this.syncGuard.isRunning(); }

    /** P7.3: 所有 this._status = X 赋值都走这里,带相等守卫,仅在状态确实变化时 fire。 */
    private setStatus(next: IndexStatus): void {
        if (this._status === next) { return; }
        this._status = next;
        this._onStatusChanged.fire(next);
    }

    /** P7.3: 在批处理完成末尾调用,fire 当前 stats 快照。 */
    private emitStats(): void {
        this._onStatsChanged.fire(this.getStats());
    }

    getStats(): { files: number; symbols: number } {
        for (const db of this.dbByRoot.values()) {
            try { return db.getStats(); } catch { /* fall through */ }
        }
        return { files: 0, symbols: 0 };
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
        // 单并发闸门：若已有 sync 在跑（例如用户点了 Cancel 但上一轮 workerPool.parse
        // 还在 drain 队列），第二次调用会拿到同一个 promise，不再并行跑两条 pipeline。
        return this.syncGuard.run(() =>
            this._doSynchronize(workspaceRoot, extensions, excludePatterns, token, onProgress, includePaths),
        );
    }

    private async _doSynchronize(
        workspaceRoot: string,
        extensions: string[],
        excludePatterns: string[],
        token: vscode.CancellationToken,
        onProgress?: (p: SyncProgress) => void,
        includePaths?: string[],
    ): Promise<void> {
        this.setStatus('building');

        const db = this.getOrCreateDb(workspaceRoot);
        // M2.3 会把 SyncOrchestratorDeps 改成 { db } —— 此处构造的 deps 满足当前旧接口形状,
        // 但 index/storage/getSnapshot 是 no-op 占位。M2.3 task 会把 orchestrator 改成
        // 直接 db.writeBatch,届时一起清掉这些占位字段。
        const deps: SyncOrchestratorDeps = {
            scanFiles: async (root: string) => this.scanWorkspace(root, extensions, excludePatterns, includePaths, token),
            classify: async (input) => classifyBatches(input),
            workerPool: {
                parse: async (files, onBatchResult, onBatchComplete, cancelSignal) => {
                    if (this.workerPool) {
                        await this.workerPool.parse(files, onBatchResult, onBatchComplete, cancelSignal);
                        return;
                    }
                    // Fallback: single-batch emit
                    const result = await this.parseInProcess(files, workspaceRoot, onBatchComplete);
                    if (result.symbols.length + result.metadata.length + result.errors.length > 0) {
                        await onBatchResult(result);
                    }
                },
            },
            // 占位:M2.3 task 会把 SyncOrchestratorDeps 改成只含 db,此处也一起清理。
            index: {
                update: (_file: string, _symbols: SymbolEntry[]) => { /* no-op; M2.3 routes to db.writeBatch */ },
                remove: (_file: string) => { /* no-op; M2.3 routes to db.writeBatch */ },
                applyMetadata: (_metadata: IndexedFile[]) => { /* no-op; M2.3 routes to db.writeBatch */ },
                fileMetadata: db.getAllFileMetadata(),
            },
            storage: {
                saveFull: async () => { /* no-op; DbBackend transactions already persist */ },
                saveDirty: async () => { /* no-op; DbBackend transactions already persist */ },
            },
            getSnapshot: () => ({
                symbolsByFile: new Map<string, SymbolEntry[]>(),
                fileMetadata: db.getAllFileMetadata(),
            }),
            onProgress: (phase: string, current: number, total: number, currentFile?: string) => {
                onProgress?.({ phase: phase as SyncProgress['phase'], current, total, currentFile });
            },
        };
        const orchestrator = new SyncOrchestrator(deps);

        await orchestrator.synchronize({
            workspaceRoot,
            cancellationToken: { get isCancellationRequested() { return token.isCancellationRequested; } },
        });

        this.dirtyFiles.clear();
        this.deletedFiles.clear();
        if (token.isCancellationRequested) {
            const fallback = this.getStats().files > 0 ? 'stale' : 'none';
            this.setStatus(fallback);
            this.emitStats();
            return;
        }
        this.setStatus('ready');
        this.emitStats();
    }

    async syncDirty(workspaceRoot: string): Promise<void> {
        if (this.dirtyFiles.size === 0 && this.deletedFiles.size === 0) { return; }

        const db = this.getOrCreateDb(workspaceRoot);
        const deletedPaths = [...this.deletedFiles];
        this.deletedFiles.clear();

        let parseResult: ParseBatchResult | undefined;
        if (this.dirtyFiles.size > 0) {
            const files = [...this.dirtyFiles].map(rel => ({
                absPath: path.resolve(workspaceRoot, rel),
                relativePath: rel,
            }));
            parseResult = await this.runParse(files, workspaceRoot);
        }
        this.dirtyFiles.clear();

        db.writeBatch({
            metadata: parseResult?.metadata ?? [],
            symbols: parseResult?.symbols ?? [],
            deletedRelativePaths: deletedPaths,
        });
        db.checkpoint();

        if (this._status === 'stale') { this.setStatus('ready'); }
        this.emitStats();
    }

    searchSymbols(
        query: string,
        workspaceRoot: string,
        options: SearchOptions,
        pagination?: { limit: number; offset: number },
    ): SearchResult[] {
        if (this._status !== 'ready' && this._status !== 'stale') { return []; }
        const db = this.getOrCreateDb(workspaceRoot);
        const canonical = this.canonicalizeRoot(workspaceRoot);
        const rawResults = db.search(query, options, pagination);
        return rawResults.map(r => {
            const abs = path.join(canonical, r.relativePath);
            const line = this.lineReader.read(abs, r.lineNumber);
            return {
                ...r,
                filePath: abs,
                lineContent: line,
                // 近似 matchStart/matchLength —— searchEngine 侧会基于 query 再算,M4 纠正。
                matchStart: 0,
                matchLength: r.matchLength,
            };
        });
    }

    async saveToDisk(_workspaceRoot: string): Promise<void> {
        // no-op: DbBackend 事务已经把每个 writeBatch 落盘;保留方法签名供 commands.ts 等老调用点。
    }

    async loadFromDisk(workspaceRoot: string): Promise<boolean> {
        try {
            const db = this.getOrCreateDb(workspaceRoot);
            const stats = db.getStats();
            if (stats.files > 0) {
                this.setStatus('ready');
                this.emitStats();
                return true;
            }
            this.setStatus('none');
            return false;
        } catch {
            this.setStatus('none');
            return false;
        }
    }

    clear(): void {
        for (const db of this.dbByRoot.values()) {
            try { db.clearAll(); } catch { /* ignore */ }
        }
        this.dirtyFiles.clear();
        this.deletedFiles.clear();
        this.setStatus('none');
        this.emitStats();
    }

    clearDisk(workspaceRoot: string): void {
        const canonical = this.canonicalizeRoot(workspaceRoot);
        const existing = this.dbByRoot.get(canonical);
        if (existing) {
            try { existing.close(); } catch { /* ignore */ }
            this.dbByRoot.delete(canonical);
        }
        const p = path.join(canonical, '.sisearch', 'index.sqlite');
        for (const suffix of ['', '-wal', '-shm']) {
            try { fs.unlinkSync(p + suffix); } catch { /* ignore */ }
        }
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

    /** 按 canonical workspaceRoot 记忆化 DbBackend;首次访问时 openOrInit。
     *  测试场景下 dbPathOverride(例如 ':memory:') 覆盖默认的 .sisearch/index.sqlite。 */
    private getOrCreateDb(workspaceRoot: string): DbBackend {
        const canonical = this.canonicalizeRoot(workspaceRoot);
        let db = this.dbByRoot.get(canonical);
        if (!db) {
            const dbPath = this.dbPathOverride ?? path.join(canonical, '.sisearch', 'index.sqlite');
            db = new DbBackend(dbPath);
            db.openOrInit();
            this.dbByRoot.set(canonical, db);
        }
        return db;
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

    // groupParseResult 用于 parse 聚合时按 relativePath 分组。目前 syncDirty 直接把 batch
    // 丢给 db.writeBatch,由 DbBackend 内部 upsert。保留 import 以备后续扩展。
    // (无 @ts-expect-error 是因为 groupParseResult 未再被调用——编译器不报错因为它是纯 import。)
    private _unusedGroupImport = groupParseResult;

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
