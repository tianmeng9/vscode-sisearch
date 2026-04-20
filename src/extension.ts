// src/extension.ts
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
import { initParser, disposeParser } from './symbolParser';
import { registerCommands } from './commands';
import { wireMessageRouter } from './messageRouter';
import { attachWorkerPool, bindWorkspace, updateSidebarHistory, updateStatusBar } from './composition';

export function activate(context: vscode.ExtensionContext) {
    // ── 组件实例化 ────────────────────────────────────────────────
    const store = new SearchStore();
    const sidebarProvider = new SidebarProvider(context.extensionUri);
    const resultsPanel = new ResultsPanel(context.extensionUri);
    const editorDecorations = new EditorDecorations(context.extensionUri);
    const codeLensProvider = new SearchResultCodeLensProvider(store);
    const highlightsTreeProvider = new HighlightsTreeProvider();
    const symbolIndex = new SymbolIndex();

    // ── 基础设施布线 ──────────────────────────────────────────────
    attachWorkerPool(context, symbolIndex);

    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    statusBarItem.command = 'siSearch.syncIndex';
    const refreshStatus = () => updateStatusBar(statusBarItem, symbolIndex);
    refreshStatus();
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    bindWorkspace(context, symbolIndex, refreshStatus);

    // ── UI 注册 ──────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(SidebarProvider.viewType, sidebarProvider, { webviewOptions: { retainContextWhenHidden: true } }),
        vscode.window.registerTreeDataProvider('siSearch.highlightsView', highlightsTreeProvider),
        vscode.languages.registerCodeLensProvider({ scheme: 'file' }, codeLensProvider),
        editorDecorations,
    );

    // ── 消息路由 / 命令 ───────────────────────────────────────────
    wireMessageRouter(vscode, {
        store, sidebarProvider, resultsPanel, editorDecorations, highlightsTreeProvider, symbolIndex,
        executeSearch: executeSearchWithIndex,
        openResultInEditor,
        tokenizeFile,
        updateSidebarHistory,
    });

    context.subscriptions.push(
        ...registerCommands(vscode, {
            store, resultsPanel, sidebarProvider, editorDecorations, highlightsTreeProvider,
            symbolIndex, statusBarItem, extensionPath: context.extensionPath,
            navigateNext, navigatePrevious, initParser,
            updateStatusBar, updateSidebarHistory,
        })
    );
}

export function deactivate() {
    disposeParser();
}
