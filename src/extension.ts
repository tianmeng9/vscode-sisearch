// src/extension.ts
import * as vscode from 'vscode';
import { SearchStore } from './search/searchStore';
import { SidebarProvider } from './ui/sidebarProvider';
import { ResultsPanel } from './ui/resultsPanel';
import { EditorDecorations } from './ui/editorDecorations';
import { executeSearchWithIndex } from './search/searchEngine';
import { navigateNext, navigatePrevious, openResultInEditor } from './search/navigation';
import { tokenizeFile } from './syntaxHighlight';
import { HighlightsTreeProvider } from './ui/highlightsTree';
import { SymbolIndex } from './symbolIndex';
import { initParser, disposeParser } from './symbolParser';
import { registerCommands } from './commands';
import { wireMessageRouter } from './messageRouter';
import {
    attachWorkerPool, bindWorkspace, updateSidebarHistory, updateStatusBar,
    probeNativeAndNotify, registerRebuildNativeCommand,
} from './composition';

export function activate(context: vscode.ExtensionContext) {
    // ── M7.1: 原生模块探测 ────────────────────────────────────────
    // better-sqlite3 native binding 若失败,降级为"仅 ripgrep 搜索"模式:
    //   - SymbolIndex({indexEnabled:false}) 让所有索引路径 no-op
    //   - 状态栏恒显 'None'
    //   - siSearch.syncIndex 命令在 commands.ts 里会提示并拒绝
    //   - siSearch.rebuildNative 命令打开 terminal 跑 npm rebuild
    const nativeCheck = probeNativeAndNotify(vscode);

    // ── 组件实例化 ────────────────────────────────────────────────
    const store = new SearchStore();
    const sidebarProvider = new SidebarProvider(context.extensionUri);
    const resultsPanel = new ResultsPanel(context.extensionUri);
    const editorDecorations = new EditorDecorations(context.extensionUri);
    const highlightsTreeProvider = new HighlightsTreeProvider();
    const symbolIndex = new SymbolIndex({
        indexEnabled: nativeCheck.available,
        extensionPath: context.extensionPath,
    });

    // ── 基础设施布线 ──────────────────────────────────────────────
    if (nativeCheck.available) {
        attachWorkerPool(context, symbolIndex);
    }
    registerRebuildNativeCommand(context);

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
