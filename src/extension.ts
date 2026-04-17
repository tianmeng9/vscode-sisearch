// src/extension.ts
import * as vscode from 'vscode';
import { SearchStore } from './searchStore';
import { SidebarProvider } from './sidebarProvider';
import { ResultsPanel } from './resultsPanel';
import { EditorDecorations } from './editorDecorations';
import { SearchResultCodeLensProvider } from './codeLensProvider';
import { executeSearchWithIndex } from './searchEngine';
import { navigateNext, navigatePrevious, openResultInEditor } from './navigation';
import { tokenizeFile } from './syntaxHighlight';
import { HighlightsTreeProvider } from './highlightsTreeProvider';
import { SymbolIndex } from './symbolIndex';
import { FileWatcher } from './fileWatcher';
import { initParser, disposeParser } from './symbolParser';
import { registerCommands } from './commands';
import { wireMessageRouter } from './messageRouter';

export function activate(context: vscode.ExtensionContext) {
    // ── 依赖实例化 ────────────────────────────────────────────────
    const store = new SearchStore();
    const sidebarProvider = new SidebarProvider(context.extensionUri);
    const resultsPanel = new ResultsPanel(context.extensionUri);
    const editorDecorations = new EditorDecorations(context.extensionUri);
    const codeLensProvider = new SearchResultCodeLensProvider(store);
    const highlightsTreeProvider = new HighlightsTreeProvider();
    const symbolIndex = new SymbolIndex();

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
        const fileWatcher = new FileWatcher(symbolIndex, workspaceRoot, extensions);
        context.subscriptions.push(fileWatcher);

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

    console.log('SI Search is now active');
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
