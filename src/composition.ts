// src/composition.ts
// DI 组装层:把 activate() 里的 WorkerPool / AutoSync / FileWatcher / 状态栏定时器 /
// onSave 监听等基础设施布线抽出来,让 extension.ts 专注于对外契约。

import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { SymbolIndex } from './symbolIndex';
import { cleanupLegacyShards } from './legacyCleanup';
export { cleanupLegacyShards } from './legacyCleanup';
import { checkSqliteAvailable } from './nativeAvailability';
export { checkSqliteAvailable } from './nativeAvailability';
import { SearchStore } from './search/searchStore';
import { SidebarProvider } from './ui/sidebarProvider';
import { FileWatcher } from './fileWatcher';
import { WorkerPool } from './sync/workerPool';
import { createWorkerThreadFactory } from './sync/workerPoolFactory';
import { AutoSyncController } from './sync/autoSync';
import { resolveMaxFileSizeBytes } from './parserConfig';

/** 把 store 当前历史快照推给 sidebar webview。 */
export function updateSidebarHistory(store: SearchStore, sidebar: SidebarProvider): void {
    const history = store.getHistory();
    const activeId = store.getActiveHistoryId();
    sidebar.postMessage({
        command: 'updateHistory',
        entries: history.map(e => ({
            id: e.id,
            query: e.query,
            count: e.results.length,
            active: e.id === activeId,
        })),
    });
}

/** 状态栏文本/提示渲染,与索引状态机同步。 */
export function updateStatusBar(item: vscode.StatusBarItem, index: SymbolIndex): void {
    const status = index.status;
    switch (status) {
        case 'none':
            item.text = '$(database) Index: None';
            item.tooltip = 'Click to synchronize symbol index';
            break;
        case 'building':
            item.text = '$(sync~spin) Index: Syncing...';
            item.tooltip = 'Symbol index is being built';
            break;
        case 'ready': {
            const stats = index.getStats();
            item.text = `$(database) ${stats.symbols.toLocaleString()} symbols`;
            item.tooltip = `SI Search: ${stats.symbols} symbols in ${stats.files} files (click to re-sync)`;
            break;
        }
        case 'stale': {
            const stats = index.getStats();
            item.text = `$(database) ${stats.symbols.toLocaleString()} symbols (stale)`;
            item.tooltip = 'Index is stale — click to re-sync';
            break;
        }
    }
}

/**
 * M7.1: 运行 native 探测;若 better-sqlite3 不可用则向用户发警告,
 * 并返回 available 标志供 activate() 决定是否启用索引。
 * 放在此处以便:
 *  - extension.ts 在构造 SymbolIndex 前拿到 available 值;
 *  - 测试可单独调用 probeNativeAndNotify 而不必激活整个扩展。
 */
export function probeNativeAndNotify(vs: typeof vscode = vscode): { available: boolean; error?: string } {
    const result = checkSqliteAvailable();
    if (!result.available) {
        void vs.window.showWarningMessage(
            `SI Search: native SQLite module failed to load (${result.error ?? 'unknown error'}). ` +
            `Symbol indexing is disabled; search will fall back to ripgrep. ` +
            `Run "SI Search: Rebuild Native (SQLite)" from the command palette to retry.`
        );
    }
    return result;
}

/**
 * M7.1: 注册 siSearch.rebuildNative 命令。
 * 打开一个 terminal,在扩展目录跑 npm rebuild better-sqlite3,提示重载窗口。
 */
export function registerRebuildNativeCommand(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('siSearch.rebuildNative', () => {
            const term = vscode.window.createTerminal('SI Search Rebuild');
            term.show();
            // 用 extensionPath 作为 cwd;完成后提示用户 Reload Window。
            term.sendText(
                `cd "${context.extensionPath}" && npm rebuild better-sqlite3 && ` +
                `echo "Done. Reload the window (Developer: Reload Window) to apply."`,
            );
        }),
    );
}

/** 为 SymbolIndex 挂接 WorkerPool,并把 dispose 登记到 extension context。
 *  从 VS Code 配置读取 siSearch.parser.maxFileSizeBytes,透传给 parseWorker,
 *  用作大文件 tree-sitter 回退阈值(防 WASM 爆堆 → extension host exit 134)。 */
export function attachWorkerPool(
    context: vscode.ExtensionContext,
    symbolIndex: SymbolIndex,
): void {
    const poolSize = Math.max(2, Math.min(8, os.cpus().length - 1));
    const cfg = vscode.workspace.getConfiguration('siSearch');
    const maxBytes = resolveMaxFileSizeBytes(cfg.get('parser.maxFileSizeBytes'));
    const workerPool = new WorkerPool({
        size: poolSize,
        workerFactory: createWorkerThreadFactory(context.extensionPath, { maxBytes }),
    });
    symbolIndex.setWorkerPool(workerPool);
    context.subscriptions.push({ dispose: () => { void workerPool.dispose(); } });
}

/**
 * 绑定单工作区的所有基础设施:
 * 1. loadFromDisk 后回传 status 更新
 * 2. 构造 AutoSyncController 并接 syncDirty
 * 3. 构造 FileWatcher 把脏文件事件接 autoSync
 * 4. 按扩展名白名单过滤 onDidSaveTextDocument,触发 autoSync.flush()
 * 5. 订阅 SymbolIndex onStatusChanged/onStatsChanged 事件驱动状态栏刷新(替代 2s 轮询)
 */
export function bindWorkspace(
    context: vscode.ExtensionContext,
    symbolIndex: SymbolIndex,
    refreshStatus: () => void,
): void {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) { return; }

    // M6 / Decision 11:激活时静默清除遗留 msgpack 分片目录。
    // 必须在 loadFromDisk 前执行,避免与新 SQLite 后端路径冲突。
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        cleanupLegacyShards(folder.uri.fsPath);
    }

    // P7.3: 事件驱动,替代 2s setInterval 轮询。
    context.subscriptions.push(symbolIndex.onStatusChanged(() => refreshStatus()));
    context.subscriptions.push(symbolIndex.onStatsChanged(() => refreshStatus()));
    context.subscriptions.push({ dispose: () => symbolIndex.dispose() });

    // P7.3: loadFromDisk 成功时内部 emit onStatusChanged+onStatsChanged,
    // 两个事件订阅都会触发 refreshStatus,这里无需额外 .then 回调。
    void symbolIndex.loadFromDisk(workspaceRoot);

    const config = vscode.workspace.getConfiguration('siSearch');
    const extensions = config.get<string[]>(
        'includeFileExtensions',
        ['.c', '.h', '.cpp', '.hpp', '.cc', '.cxx', '.hxx', '.inl'],
    );
    const autoSyncEnabled = config.get<boolean>('autoSync', true);
    const autoSyncDelayMs = config.get<number>('autoSyncDelay', 5000);
    const autoSyncOnSave = config.get<boolean>('autoSyncOnSave', false);

    const autoSync = new AutoSyncController({
        enabled: autoSyncEnabled,
        delayMs: autoSyncDelayMs,
        syncDirty: async () => {
            try {
                await symbolIndex.syncDirty(workspaceRoot);
                refreshStatus();
            } catch {
                // Silent — next sync attempt will retry
            }
        },
    });
    context.subscriptions.push({ dispose: () => autoSync.dispose() });

    const fileWatcher = new FileWatcher(symbolIndex, workspaceRoot, extensions, autoSync);
    context.subscriptions.push(fileWatcher);

    if (autoSyncOnSave) {
        const extSet = new Set(extensions.map(e => e.toLowerCase()));
        context.subscriptions.push(
            vscode.workspace.onDidSaveTextDocument(doc => {
                const ext = path.extname(doc.uri.fsPath).toLowerCase();
                if (!extSet.has(ext)) { return; }
                void autoSync.flush();
            }),
        );
    }

}
