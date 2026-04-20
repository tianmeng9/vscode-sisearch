// src/extension.ts
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { SearchStore } from './search/searchStore';
import { SidebarProvider } from './ui/sidebarProvider';
import { ResultsPanel } from './ui/resultsPanel';
import { EditorDecorations } from './ui/editorDecorations';
import { SearchResultCodeLensProvider } from './ui/codeLensProvider';
import { executeSearchWithIndex } from './search/searchEngine';
import { navigateNext, navigatePrevious, openResultInEditor } from './search/navigation';
import { tokenizeFile } from './syntaxHighlight';
import { HighlightsTreeProvider } from './ui/highlightsTree';
import { SymbolIndex } from './symbolIndex';
import { FileWatcher } from './fileWatcher';
import { initParser, disposeParser } from './symbolParser';
import { registerCommands } from './commands';
import { wireMessageRouter } from './messageRouter';
import { WorkerPool } from './sync/workerPool';
import { createWorkerThreadFactory } from './sync/workerPoolFactory';
import { AutoSyncController } from './sync/autoSync';

export function activate(context: vscode.ExtensionContext) {
    // ── 依赖实例化 ────────────────────────────────────────────────
    const store = new SearchStore();
    const sidebarProvider = new SidebarProvider(context.extensionUri);
    const resultsPanel = new ResultsPanel(context.extensionUri);
    const editorDecorations = new EditorDecorations(context.extensionUri);
    const codeLensProvider = new SearchResultCodeLensProvider(store);
    const highlightsTreeProvider = new HighlightsTreeProvider();
    const symbolIndex = new SymbolIndex();

    // ── Worker 池（真正的线程级并行） ─────────────────────────────
    const poolSize = Math.max(2, Math.min(8, os.cpus().length - 1));
    const workerPool = new WorkerPool({
        size: poolSize,
        workerFactory: createWorkerThreadFactory(context.extensionPath),
    });
    symbolIndex.setWorkerPool(workerPool);
    context.subscriptions.push({ dispose: () => { void workerPool.dispose(); } });

    // ── 状态栏 ────────────────────────────────────────────────────
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    statusBarItem.command = 'siSearch.syncIndex';
    updateStatusBar(statusBarItem, symbolIndex);
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    // ── 索引加载与文件监视 ────────────────────────────────────────
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspaceRoot) {
        symbolIndex.loadFromDisk(workspaceRoot).then(loaded => {
            if (loaded) { updateStatusBar(statusBarItem, symbolIndex); }
        });

        const config = vscode.workspace.getConfiguration('siSearch');
        const extensions = config.get<string[]>('includeFileExtensions', ['.c', '.h', '.cpp', '.hpp', '.cc', '.cxx', '.hxx', '.inl']);
        const autoSyncEnabled = config.get<boolean>('autoSync', true);
        const autoSyncDelayMs = config.get<number>('autoSyncDelay', 5000);
        const autoSyncOnSave = config.get<boolean>('autoSyncOnSave', false);

        const autoSync = new AutoSyncController({
            enabled: autoSyncEnabled,
            delayMs: autoSyncDelayMs,
            syncDirty: async () => {
                try {
                    await symbolIndex.syncDirty(workspaceRoot);
                    updateStatusBar(statusBarItem, symbolIndex);
                } catch {
                    // Silent — next sync attempt will retry
                }
            },
        });
        context.subscriptions.push({ dispose: () => autoSync.dispose() });

        const fileWatcher = new FileWatcher(symbolIndex, workspaceRoot, extensions, autoSync);
        context.subscriptions.push(fileWatcher);

        // 按文件扩展名白名单判断 save 是否应触发 dirty flush。
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

        const statusTimer = setInterval(() => { updateStatusBar(statusBarItem, symbolIndex); }, 2000);
        context.subscriptions.push({ dispose: () => clearInterval(statusTimer) });
    }

    // ── Webview / TreeView / CodeLens ─────────────────────────────
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(SidebarProvider.viewType, sidebarProvider, { webviewOptions: { retainContextWhenHidden: true } }),
        vscode.window.registerTreeDataProvider('siSearch.highlightsView', highlightsTreeProvider),
        vscode.languages.registerCodeLensProvider({ scheme: 'file' }, codeLensProvider),
        editorDecorations,
    );

    // ── 消息路由 ──────────────────────────────────────────────────
    wireMessageRouter(vscode, {
        store, sidebarProvider, resultsPanel, editorDecorations, highlightsTreeProvider, symbolIndex,
        executeSearch: executeSearchWithIndex,
        openResultInEditor,
        tokenizeFile,
        updateSidebarHistory,
    });

    // ── 命令注册 ──────────────────────────────────────────────────
    context.subscriptions.push(
        ...registerCommands(vscode, {
            store, resultsPanel, sidebarProvider, editorDecorations, highlightsTreeProvider,
            symbolIndex, statusBarItem, extensionPath: context.extensionPath,
            navigateNext, navigatePrevious, initParser,
            updateStatusBar, updateSidebarHistory,
        })
    );
}

function updateSidebarHistory(store: SearchStore, sidebar: SidebarProvider): void {
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

function updateStatusBar(item: vscode.StatusBarItem, index: SymbolIndex): void {
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

export function deactivate() {
    disposeParser();
}
