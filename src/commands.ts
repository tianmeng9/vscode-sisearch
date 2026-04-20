// src/commands.ts
// 集中注册所有 VS Code 命令，通过依赖注入支持测试

import type * as vscode from 'vscode';
import type { SearchStore } from './search/searchStore';
import type { ResultsPanel } from './ui/resultsPanel';
import type { SidebarProvider } from './ui/sidebarProvider';
import type { EditorDecorations } from './ui/editorDecorations';
import type { HighlightsTreeProvider } from './ui/highlightsTree';
import type { SymbolIndex } from './symbolIndex';
import type { SearchResult, SyncProgress } from './types';

export interface CommandDeps {
    store: SearchStore;
    resultsPanel: ResultsPanel;
    sidebarProvider: SidebarProvider;
    editorDecorations: EditorDecorations;
    highlightsTreeProvider: HighlightsTreeProvider;
    symbolIndex: SymbolIndex;
    statusBarItem: vscode.StatusBarItem;
    extensionPath: string;
    navigateNext: (store: SearchStore, wrap: boolean) => Promise<{ result: SearchResult; index: number } | undefined>;
    navigatePrevious: (store: SearchStore, wrap: boolean) => Promise<{ result: SearchResult; index: number } | undefined>;
    initParser: (extensionPath: string) => Promise<void>;
    updateStatusBar: (item: vscode.StatusBarItem, index: SymbolIndex) => void;
    updateSidebarHistory: (store: SearchStore, sidebar: SidebarProvider) => void;
}

export function registerCommands(
    vscode: typeof import('vscode'),
    deps: CommandDeps,
): { dispose(): void }[] {
    const {
        store, resultsPanel, sidebarProvider, editorDecorations, highlightsTreeProvider,
        symbolIndex, statusBarItem, extensionPath,
        navigateNext, navigatePrevious, initParser, updateStatusBar, updateSidebarHistory,
    } = deps;

    return [
        vscode.commands.registerCommand('siSearch.focusSearchPanel', () => {
            vscode.commands.executeCommand('siSearch.searchPanel.focus');
        }),

        vscode.commands.registerCommand('siSearch.toggleResultsPanel', () => {
            resultsPanel.toggle();
        }),

        vscode.commands.registerCommand('siSearch.nextResult', async () => {
            const config = vscode.workspace.getConfiguration('siSearch');
            const wrap = config.get<boolean>('navigationWrap', true);
            const nav = await navigateNext(store, wrap);
            if (nav) { resultsPanel.highlightEntry(nav.index); }
        }),

        vscode.commands.registerCommand('siSearch.previousResult', async () => {
            const config = vscode.workspace.getConfiguration('siSearch');
            const wrap = config.get<boolean>('navigationWrap', true);
            const nav = await navigatePrevious(store, wrap);
            if (nav) { resultsPanel.highlightEntry(nav.index); }
        }),

        vscode.commands.registerCommand('siSearch.highlightSelection', () => {
            const editor = vscode.window.activeTextEditor;
            const editorSelection = editor ? editor.document.getText(editor.selection).trim() : '';
            if (editorSelection) {
                resultsPanel.postMessage({ command: 'toggleHighlightText', text: editorSelection });
            } else {
                resultsPanel.triggerHighlightSelection();
            }
        }),

        vscode.commands.registerCommand('siSearch.clearAllHighlights', () => {
            resultsPanel.postMessage({ command: 'clearHighlights' });
            editorDecorations.clearDecorations();
            highlightsTreeProvider.update([]);
        }),

        vscode.commands.registerCommand('siSearch.jumpToResult', () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) { return; }
            const filePath = editor.document.uri.fsPath;
            const lineNumber = editor.selection.active.line + 1;
            const results = store.getActiveResults();
            const idx = results.findIndex(
                r => r.filePath === filePath && r.lineNumber === lineNumber
            );
            if (idx >= 0) {
                store.setNavigationIndex(idx);
                resultsPanel.highlightEntry(idx);
                resultsPanel.show();
            }
        }),

        vscode.commands.registerCommand('siSearch.clearResults', () => {
            store.clearAll();
            updateSidebarHistory(store, sidebarProvider);
            sidebarProvider.postMessage({ command: 'clearSearch' });
            resultsPanel.showResults([], '');
            editorDecorations.updateResults([]);
        }),

        vscode.commands.registerCommand('siSearch.removeHighlight', (item: any) => {
            const text = item?.entry?.text;
            if (!text) { return; }
            resultsPanel.postMessage({ command: 'toggleHighlightText', text });
        }),

        vscode.commands.registerCommand('siSearch.syncIndex', async () => {
            const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!wsRoot) {
                vscode.window.showWarningMessage('SI Search: No workspace folder open');
                return;
            }

            try {
                await initParser(extensionPath);
            } catch (err: any) {
                const msg = err?.stack || err?.message || String(err);
                console.error('SI Search: initParser failed:', msg);
                vscode.window.showErrorMessage(`SI Search: Failed to init parser: ${msg}`);
                return;
            }

            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'SI Search: Synchronizing symbols...',
                cancellable: true,
            }, async (progress, token) => {
                const cfg = vscode.workspace.getConfiguration('siSearch');
                const exts = cfg.get<string[]>('includeFileExtensions', ['.c', '.h', '.cpp', '.hpp', '.cc', '.cxx', '.hxx', '.inl']);
                const excl = cfg.get<string[]>('excludePatterns', ['**/build/**', '**/.git/**', '**/node_modules/**']);
                const incPaths = cfg.get<string[]>('includePaths', []);

                updateStatusBar(statusBarItem, symbolIndex);

                await symbolIndex.synchronize(wsRoot, exts, excl, token, (p: SyncProgress) => {
                    if (p.phase === 'scanning') {
                        progress.report({ message: 'Scanning files...' });
                    } else if (p.phase === 'parsing') {
                        progress.report({ message: `Parsing ${p.current}/${p.total}: ${p.currentFile || ''}`, increment: (1 / Math.max(p.total, 1)) * 100 });
                    } else {
                        progress.report({ message: 'Saving index...' });
                    }
                }, incPaths);

                updateStatusBar(statusBarItem, symbolIndex);
                const stats = symbolIndex.getStats();
                vscode.window.showInformationMessage(`SI Search: Indexed ${stats.symbols} symbols in ${stats.files} files`);
            });
        }),

        vscode.commands.registerCommand('siSearch.clearIndex', () => {
            const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            symbolIndex.clear();
            if (wsRoot) { symbolIndex.clearDisk(wsRoot); }
            updateStatusBar(statusBarItem, symbolIndex);
            vscode.window.showInformationMessage('SI Search: Symbol index cleared');
        }),
    ];
}
