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
import type { DbBackend, WriteBatch } from './index/dbBackend';
import type { DbWriterClient as DbWriterClientType } from './index/dbWriterClient';
import { LineContentReader } from './index/lineContentReader';

// M7.1: 延迟加载 DbBackend，使得 better-sqlite3 原生绑定损坏时
// SymbolIndex 模块仍能成功装载（仅在首次访问 DB 时才触发 require）。
// 若 composition 层已通过 checkSqliteAvailable() 判断 native 不可用并
// 构造 SymbolIndex({ indexEnabled: false })，下面的 loader 永远不会被调用。
let _DbBackendCtor: typeof import('./index/dbBackend').DbBackend | undefined;
function loadDbBackend(): typeof import('./index/dbBackend').DbBackend {
    if (_DbBackendCtor) { return _DbBackendCtor; }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('./index/dbBackend') as typeof import('./index/dbBackend');
    _DbBackendCtor = mod.DbBackend;
    return _DbBackendCtor;
}
// M10c: 同样延迟加载 DbWriterClient —— 它本身依赖 worker_threads 但 require 时不会打开 native;
// 只有 getOrCreateWriterClient 路径会被真正触达。
let _DbWriterClientCtor: typeof import('./index/dbWriterClient').DbWriterClient | undefined;
function loadDbWriterClient(): typeof import('./index/dbWriterClient').DbWriterClient {
    if (_DbWriterClientCtor) { return _DbWriterClientCtor; }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('./index/dbWriterClient') as typeof import('./index/dbWriterClient');
    _DbWriterClientCtor = mod.DbWriterClient;
    return _DbWriterClientCtor;
}
import type { FileCandidate } from './sync/batchClassifier';
import { classifyBatches } from './sync/batchClassifier';
import type { WorkerPool, ParseBatchResult } from './sync/workerPool';
import { SyncOrchestrator, type SyncDeps as SyncOrchestratorDeps, type SyncDb } from './sync/syncOrchestrator';
import { createReentrancyGuard } from './sync/reentrancyGuard';
import { resetSearchDuringSyncState } from './search/searchDuringSyncState';

export interface SymbolIndexDeps {
    /** 可选注入 WorkerPool；未提供时 façade 回退为同步解析（测试用）。 */
    workerPool?: WorkerPool;
    /** 测试钩子:覆盖 DbBackend 文件路径(传 ':memory:' 可走内存 DB)。 */
    dbPath?: string;
    /**
     * M7.1: false 时索引功能被禁用——synchronize / searchSymbols / loadFromDisk
     * 均短路为 no-op，status 恒为 'none'；getStats 返回零。
     * 由 composition 层在 checkSqliteAvailable().available===false 时传入。
     * 默认 true（未传即启用）。
     */
    indexEnabled?: boolean;
    /**
     * M10c: 扩展根路径,用于定位 out/src/index/dbWriterWorker.js。
     * 非测试场景下由 activate(context) 传入 context.extensionPath。
     * 未提供时,writer worker 无法 spawn —— synchronize 会走同步 fallback(内存/测试路径)。
     */
    extensionPath?: string;
}

interface PerWorkspaceHandles {
    /** 主线程只读 handle(WAL 自动可见 writer 的 commit)。 */
    readHandle: DbBackend;
    /** worker_thread 写入端;按需 spawn,synchronize 期间常驻,dispose 时 terminate。 */
    writerClient: DbWriterClientType | null;
    /** 用于 spawn writerClient 的磁盘路径;:memory: 表示 inMemory。 */
    writerDbPath: string;
    /** 内存 DB(测试) —— 不走 writer worker,所有写直通单 handle。 */
    inMemory: boolean;
}

export class SymbolIndex {
    private readonly dirtyFiles = new Set<string>();
    private readonly deletedFiles = new Set<string>();
    private _status: IndexStatus = 'none';
    private workerPool: WorkerPool | undefined;
    // 单并发 synchronize 闸门：cancel-then-resync 会并行两条 pipeline 共享 workerPool,
    // 33k 文件级别直接把 VS Code 打崩。详见 src/sync/reentrancyGuard.ts。
    private readonly syncGuard = createReentrancyGuard();
    // M10c: 每 workspace 一组 handles(readonly + writerClient)
    private readonly handlesByRoot = new Map<string, PerWorkspaceHandles>();
    // 搜索命中后按需读取行内容的 LRU cache。
    private readonly lineReader = new LineContentReader();
    // 测试注入:覆盖 DbBackend 文件路径(如 ':memory:')。
    private readonly dbPathOverride: string | undefined;
    // M7.1: 索引启用开关；false 时所有需要 DbBackend 的路径短路返回。
    private readonly indexEnabled: boolean;
    // M10c: 扩展根路径,用于构造 writer worker 的脚本绝对路径。
    private readonly extensionPath: string | undefined;
    // S8: canonicalizeRoot 结果缓存 —— 避免每次都走 realpathSync syscall
    private readonly canonicalByInput = new Map<string, string>();
    // P7.3: 状态机事件化，替代 composition 层 2s 轮询
    private readonly _onStatusChanged = new vscode.EventEmitter<IndexStatus>();
    private readonly _onStatsChanged = new vscode.EventEmitter<{ files: number; symbols: number }>();

    constructor(deps: SymbolIndexDeps = {}) {
        this.workerPool = deps.workerPool;
        this.dbPathOverride = deps.dbPath;
        this.indexEnabled = deps.indexEnabled !== false;  // 默认启用
        this.extensionPath = deps.extensionPath;
    }

    /** @internal 公开查询：索引功能是否启用。供 composition/commands 层决定是否提示/降级。 */
    get isIndexEnabled(): boolean { return this.indexEnabled; }

    get status(): IndexStatus { return this._status; }

    /** P7.3: status 状态机转换事件;相等守卫,重复赋值不 fire。 */
    get onStatusChanged(): vscode.Event<IndexStatus> { return this._onStatusChanged.event; }

    /** P7.3: stats 数量变更事件;仅在批处理完成末尾 fire,避免热循环风暴。 */
    get onStatsChanged(): vscode.Event<{ files: number; symbols: number }> { return this._onStatsChanged.event; }

    /** 释放 EventEmitter;由 composition 层在 ExtensionContext.subscriptions 中登记。 */
    dispose(): void {
        for (const h of this.handlesByRoot.values()) {
            // writer 先 terminate(drain + close worker thread),再关 readHandle
            if (h.writerClient) {
                // fire-and-forget — dispose() is sync per VS Code contract;
                // Node will wait on the promise via process exit in practice.
                void h.writerClient.dispose();
            }
            try { h.readHandle.close(); } catch { /* ignore */ }
        }
        this.handlesByRoot.clear();
        this._onStatusChanged.dispose();
        this._onStatsChanged.dispose();
    }

    /** @internal 测试钩子——不得用于生产代码路径。走 setStatus 以保持事件对称。 */
    _setStatusForTest(next: IndexStatus): void { this.setStatus(next); }

    /** @internal 测试钩子:暴露 handlesByRoot 大小,用于验证路径标准化。 */
    _getStorageCountForTest(): number { return this.handlesByRoot.size; }

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
        for (const h of this.handlesByRoot.values()) {
            try { return h.readHandle.getStats(); } catch { /* fall through */ }
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
        // M7.1: 索引禁用（native 加载失败）时，sync 直接 no-op。
        if (!this.indexEnabled) { return; }
        // M5.2: 每一轮 sync 开始时清掉搜索侧的 Sync-during-search 缓存选择,
        // 保证用户每次 sync 期间搜索都会拿到一次新提示,而不是沿用上一轮的旧选择。
        // 放在 syncGuard.run 之外故意:若同一个 guard 正在跑,reset 也不会扰动它,
        // 因为 cached state 是搜索侧的短期去抖量(1s),不是 sync 的依赖。
        resetSearchDuringSyncState();
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

        const handles = this.getOrCreateHandles(workspaceRoot);
        // M10c: 构造 SyncDb 适配器 —— writeBatch 路由到 writerClient(worker_thread)
        // 或 (内存/测试) 直通 readHandle;getAllFileMetadata 从 readHandle(readonly) 读;
        // checkpoint 在 orchestrator 视角是 no-op,façade 在本函数末尾 drain+checkpoint。
        let dbAdapter: SyncDb;
        let writerClient: DbWriterClientType | null = null;
        if (handles.inMemory) {
            // 测试/内存路径:一个 handle 即读即写,writeBatch 直通。
            dbAdapter = {
                writeBatch: (b: WriteBatch) => handles.readHandle.writeBatch(b),
                getAllFileMetadata: () => handles.readHandle.getAllFileMetadata(),
                checkpoint: () => { /* façade 收尾 */ },
            };
        } else {
            writerClient = this.getOrCreateWriterClient(workspaceRoot);
            dbAdapter = {
                writeBatch: (b: WriteBatch) => { writerClient!.postBatch(b); },
                getAllFileMetadata: () => handles.readHandle.getAllFileMetadata(),
                checkpoint: () => { /* no-op in orchestrator — drain+checkpoint done below */ },
            };
        }

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
            db: dbAdapter,
            onProgress: (phase: string, current: number, total: number, currentFile?: string) => {
                onProgress?.({ phase: phase as SyncProgress['phase'], current, total, currentFile });
            },
        };
        const orchestrator = new SyncOrchestrator(deps);

        try {
            await orchestrator.synchronize({
                workspaceRoot,
                cancellationToken: { get isCancellationRequested() { return token.isCancellationRequested; } },
            });
        } finally {
            // 关键:即使 cancel 也必须 drain — 否则未落盘的 in-flight 批次可能残留。
            if (writerClient) {
                try {
                    await writerClient.drain();
                } catch {
                    // drain 失败(worker fatal)时不抛出 —— 让 status 回退逻辑走下去。
                }
                // M10d: drain 之后再显式 TRUNCATE checkpoint,把 -wal 压到 0 字节。
                // synchronous=OFF 下 WAL 只靠 auto-checkpoint 会长期膨胀;主动收尾一次
                // 也把磁盘占用还给用户。checkpoint 失败同样不向上抛。
                try {
                    await writerClient.checkpoint();
                } catch {
                    // ignore —— checkpoint 失败不影响 sync 结果的可见性(WAL 仍可被读)。
                }
            }
        }

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
        // M7.1: 索引禁用时 no-op；顺便清掉已积累的 dirty/deleted 集合避免内存无限涨。
        if (!this.indexEnabled) {
            this.dirtyFiles.clear();
            this.deletedFiles.clear();
            return;
        }
        if (this.dirtyFiles.size === 0 && this.deletedFiles.size === 0) { return; }

        const handles = this.getOrCreateHandles(workspaceRoot);
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

        const batch: WriteBatch = {
            metadata: parseResult?.metadata ?? [],
            symbols: parseResult?.symbols ?? [],
            deletedRelativePaths: deletedPaths,
        };
        if (handles.inMemory) {
            handles.readHandle.writeBatch(batch);
        } else {
            const writer = this.getOrCreateWriterClient(workspaceRoot);
            writer.postBatch(batch);
            // syncDirty 是 small-batch 路径,等 drain 保证后续读可见。
            await writer.drain();
        }

        if (this._status === 'stale') { this.setStatus('ready'); }
        this.emitStats();
    }

    searchSymbols(
        query: string,
        workspaceRoot: string,
        options: SearchOptions,
        pagination?: { limit: number; offset: number },
    ): SearchResult[] {
        // M7.1: 索引禁用时直接返回空；searchEngine 会退回 ripgrep 全文搜索。
        if (!this.indexEnabled) { return []; }
        if (this._status !== 'ready' && this._status !== 'stale') { return []; }
        const handles = this.getOrCreateHandles(workspaceRoot);
        const canonical = this.canonicalizeRoot(workspaceRoot);
        const rawResults = handles.readHandle.search(query, options, pagination);
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

    countMatches(query: string, workspaceRoot: string, options: SearchOptions): number {
        // M7.1: 索引禁用时返回 0。
        if (!this.indexEnabled) { return 0; }
        if (this._status !== 'ready' && this._status !== 'stale') { return 0; }
        const handles = this.getOrCreateHandles(workspaceRoot);
        return handles.readHandle.countMatches(query, options);
    }

    async saveToDisk(_workspaceRoot: string): Promise<void> {
        // no-op: DbBackend 事务已经把每个 writeBatch 落盘;保留方法签名供 commands.ts 等老调用点。
    }

    async loadFromDisk(workspaceRoot: string): Promise<boolean> {
        // M7.1: 索引禁用时不尝试打开 DB，status 恒为 'none'。
        if (!this.indexEnabled) {
            this.setStatus('none');
            return false;
        }
        try {
            const handles = this.getOrCreateHandles(workspaceRoot);
            const stats = handles.readHandle.getStats();
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
        for (const h of this.handlesByRoot.values()) {
            // clearAll 需要 write 权限 —— readonly handle 不支持,inMemory 走单 handle。
            if (h.inMemory) {
                try { h.readHandle.clearAll(); } catch { /* ignore */ }
            }
            // 生产路径下 clear() 仅把 status 重置;真正清盘走 clearDisk()。
            // 这是保持 P7.3 原有语义(测试中 :memory: 可见清空,生产 :file 只重置 status)。
        }
        this.dirtyFiles.clear();
        this.deletedFiles.clear();
        this.setStatus('none');
        this.emitStats();
    }

    clearDisk(workspaceRoot: string): void {
        const canonical = this.canonicalizeRoot(workspaceRoot);
        const existing = this.handlesByRoot.get(canonical);
        if (existing) {
            // 关闭顺序:先 writer(Windows 上文件句柄要先 release),再 readHandle
            if (existing.writerClient) {
                // fire-and-forget dispose; worker 挂在自己的 event loop 里,UI 不能阻塞。
                void existing.writerClient.dispose();
            }
            try { existing.readHandle.close(); } catch { /* ignore */ }
            this.handlesByRoot.delete(canonical);
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

    /** M10c: 按 canonical workspaceRoot 记忆化每-workspace handle 组。
     *  生产路径:file DB → 先 bootstrap 创 schema,再开 readonly readHandle;writerClient lazy。
     *  测试路径:':memory:' → readHandle 即读即写,不 spawn writerClient(inMemory=true)。 */
    private getOrCreateHandles(workspaceRoot: string): PerWorkspaceHandles {
        const canonical = this.canonicalizeRoot(workspaceRoot);
        let handles = this.handlesByRoot.get(canonical);
        if (handles) { return handles; }

        const dbPath = this.dbPathOverride ?? path.join(canonical, '.sisearch', 'index.sqlite');
        const DbBackendCtor = loadDbBackend();
        const isMemory = dbPath === ':memory:';

        if (isMemory) {
            // 测试场景:单 writer handle 兼做 read。
            const handle = new DbBackendCtor(dbPath);
            handle.openOrInit();
            handles = {
                readHandle: handle,
                writerClient: null,
                writerDbPath: dbPath,
                inMemory: true,
            };
            this.handlesByRoot.set(canonical, handles);
            return handles;
        }

        // 生产路径:确保 DB 文件 + schema 已存在,然后 readonly 开 handle。
        // readonly 的 { fileMustExist: true } 若 file 不存在会抛;因此首次 bootstrap 一次 writer。
        if (!fs.existsSync(dbPath)) {
            fs.mkdirSync(path.dirname(dbPath), { recursive: true });
            const bootstrap = new DbBackendCtor(dbPath);
            bootstrap.openOrInit();
            bootstrap.close();
        }
        const readHandle = new DbBackendCtor(dbPath, { readonly: true });
        readHandle.openOrInit();

        handles = {
            readHandle,
            writerClient: null,
            writerDbPath: dbPath,
            inMemory: false,
        };
        this.handlesByRoot.set(canonical, handles);
        return handles;
    }

    /** M10c: 按 canonical workspaceRoot 记忆化 DbWriterClient。
     *  首次调用时 spawn worker_thread;synchronize / syncDirty 期间常驻,dispose/clearDisk 时 terminate。
     *  :memory: 路径不应走到这里 —— 调用方需先检查 handles.inMemory。 */
    private getOrCreateWriterClient(workspaceRoot: string): DbWriterClientType {
        const handles = this.getOrCreateHandles(workspaceRoot);
        if (handles.inMemory) {
            throw new Error('getOrCreateWriterClient called on in-memory workspace');
        }
        if (handles.writerClient) { return handles.writerClient; }
        if (!this.extensionPath) {
            throw new Error(
                'SymbolIndex: extensionPath not configured — cannot spawn dbWriterWorker. ' +
                'Pass extensionPath via SymbolIndexDeps (see composition.ts).',
            );
        }
        const DbWriterClientCtor = loadDbWriterClient();
        // tsc outputs to out/src/index/dbWriterWorker.js — same pattern as workerPoolFactory.
        const scriptPath = path.join(this.extensionPath, 'out', 'src', 'index', 'dbWriterWorker.js');
        handles.writerClient = new DbWriterClientCtor({
            workerScriptPath: scriptPath,
            dbPath: handles.writerDbPath,
        });
        return handles.writerClient;
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
