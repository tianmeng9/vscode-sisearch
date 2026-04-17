// src/extension.ts
import * as vscode from 'vscode';
import { SearchStore } from './searchStore';
import { SidebarProvider } from './sidebarProvider';
import { ResultsPanel } from './resultsPanel';
import { EditorDecorations } from './editorDecorations';
import { SearchResultCodeLensProvider } from './codeLensProvider';
import { executeSearchWithIndex } from './searchEngine';
import { navigateNext, navigatePrevious, openResultInEditor } from './navigation';
import { SidebarMessage, SearchResult, PreviewResponse } from './types';
import { tokenizeFile } from './syntaxHighlight';
import { HighlightsTreeProvider } from './highlightsTreeProvider';
import { SymbolIndex } from './symbolIndex';
import { FileWatcher } from './fileWatcher';
import { initParser, disposeParser } from './symbolParser';

export function activate(context: vscode.ExtensionContext) {
    const store = new SearchStore();
    const sidebarProvider = new SidebarProvider(context.extensionUri);
    const resultsPanel = new ResultsPanel(context.extensionUri);
    const editorDecorations = new EditorDecorations(context.extensionUri);
    const codeLensProvider = new SearchResultCodeLensProvider(store);
    const highlightsTreeProvider = new HighlightsTreeProvider();

    // Symbol index & file watcher
    const symbolIndex = new SymbolIndex();
    let fileWatcher: FileWatcher | undefined;

    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    statusBarItem.command = 'siSearch.syncIndex';
    updateStatusBar(statusBarItem, symbolIndex);
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    // Try to restore index from disk & init file watcher
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspaceRoot) {
        symbolIndex.loadFromDisk(workspaceRoot).then(loaded => {
            if (loaded) { updateStatusBar(statusBarItem, symbolIndex); }
        });

        const config = vscode.workspace.getConfiguration('siSearch');
        const extensions = config.get<string[]>('includeFileExtensions', ['.c', '.h', '.cpp', '.hpp', '.cc', '.cxx', '.hxx', '.inl']);
        fileWatcher = new FileWatcher(symbolIndex, workspaceRoot, extensions);
        context.subscriptions.push(fileWatcher);

        // Watch for status changes from file watcher
        const statusTimer = setInterval(() => {
            updateStatusBar(statusBarItem, symbolIndex);
        }, 2000);
        context.subscriptions.push({ dispose: () => clearInterval(statusTimer) });
    }

    // 注册侧边栏 webview provider
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            SidebarProvider.viewType,
            sidebarProvider,
            { webviewOptions: { retainContextWhenHidden: true } }
        )
    );

    // 注册 Highlights TreeView
    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('siSearch.highlightsView', highlightsTreeProvider)
    );

    // 注册 CodeLens Provider（用于源文件中的"跳转回结果"链接）
    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider(
            { scheme: 'file' },
            codeLensProvider
        )
    );

    // 处理侧边栏消息
    sidebarProvider.onMessage(async (msg: SidebarMessage) => {
        switch (msg.command) {
            case 'search': {
                const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                if (!workspaceRoot) {
                    vscode.window.showWarningMessage('SI Search: No workspace folder open');
                    return;
                }

                const config = vscode.workspace.getConfiguration('siSearch');
                // If user specified include patterns in UI, use those; otherwise fall back to settings
                const extensions = (msg.filesToInclude && msg.filesToInclude.length > 0)
                    ? msg.filesToInclude
                    : config.get<string[]>('includeFileExtensions', ['.c', '.h', '.cpp', '.hpp']);
                // Merge UI excludes with settings excludes
                const settingExcludes = config.get<string[]>('excludePatterns', ['**/build/**', '**/.git/**']);
                const uiExcludes = msg.filesToExclude || [];
                const excludes = [...settingExcludes, ...uiExcludes];

                sidebarProvider.postMessage({ command: 'searchStarted' });

                try {
                    const results = await executeSearchWithIndex(
                        msg.query, workspaceRoot, msg.options, extensions, excludes, symbolIndex
                    );

                    store.addSearch(msg.query, msg.options, results, msg.mode);
                    sidebarProvider.postMessage({ command: 'searchComplete', count: results.length });
                    updateSidebarHistory(store, sidebarProvider);

                    const entries = store.getActiveResultsPanelEntries();
                    resultsPanel.showResults(entries, msg.query);

                    editorDecorations.updateResults(store.getActiveResults());
                } catch (err: any) {
                    sidebarProvider.postMessage({ command: 'searchComplete', count: 0 });
                    vscode.window.showErrorMessage(`SI Search error: ${err.message}`);
                }
                break;
            }
            case 'selectHistory': {
                store.selectHistory(msg.id);
                updateSidebarHistory(store, sidebarProvider);
                const entries = store.getActiveResultsPanelEntries();
                const activeEntry = store.getHistory().find(e => e.id === msg.id);
                resultsPanel.showResults(entries, activeEntry?.query || '');
                editorDecorations.updateResults(store.getActiveResults());
                break;
            }
            case 'deleteHistory': {
                store.deleteHistory(msg.id);
                updateSidebarHistory(store, sidebarProvider);
                const entries = store.getActiveResultsPanelEntries();
                resultsPanel.showResults(entries, '');
                editorDecorations.updateResults(store.getActiveResults());
                break;
            }
            case 'clearAllHighlights': {
                resultsPanel.postMessage({ command: 'clearHighlights' });
                editorDecorations.clearDecorations();
                highlightsTreeProvider.update([]);
                break;
            }
        }
    });

    // 处理结果面板消息
    resultsPanel.onMessage(async (msg) => {
        switch (msg.command) {
            case 'jumpToFile': {
                const result: SearchResult = {
                    filePath: msg.filePath,
                    relativePath: '',
                    lineNumber: msg.lineNumber,
                    lineContent: '',
                    matchStart: 0,
                    matchLength: 0,
                };
                await openResultInEditor(result);
                break;
            }
            case 'requestPreview': {
                try {
                    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(msg.filePath));
                    const result = await tokenizeFile(doc.getText(), doc.languageId);
                    const tabSize = vscode.workspace.getConfiguration('editor', doc.uri).get<number>('tabSize', 4);

                    const preview: PreviewResponse = {
                        command: 'previewData',
                        filePath: msg.filePath,
                        lineNumber: msg.lineNumber,
                        lines: result.lines,
                        bg: result.bg,
                        tabSize,
                    };
                    resultsPanel.sendPreviewData(preview);
                } catch {
                    // 文件不可读时静默忽略
                }
                break;
            }
            case 'clearAllHighlights': {
                editorDecorations.clearDecorations();
                highlightsTreeProvider.update([]);
                break;
            }
            case 'syncManualHighlights': {
                const highlights = msg.highlights || [];
                editorDecorations.updateManualHighlights(
                    highlights,
                    msg.boxMode !== false,
                );
                highlightsTreeProvider.update(highlights);
                break;
            }
        }
    });

    // 注册命令
    context.subscriptions.push(
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

        // 清除搜索结果（同时清除左侧历史和搜索关键字）
        vscode.commands.registerCommand('siSearch.clearResults', () => {
            store.clearAll();
            updateSidebarHistory(store, sidebarProvider);
            sidebarProvider.postMessage({ command: 'clearSearch' });
            resultsPanel.showResults([], '');
            editorDecorations.updateResults([]);
        }),

        // 移除单个高亮
        vscode.commands.registerCommand('siSearch.removeHighlight', (item: any) => {
            const text = item?.entry?.text;
            if (!text) { return; }
            resultsPanel.postMessage({ command: 'toggleHighlightText', text });
        }),

        // Sync symbol index
        vscode.commands.registerCommand('siSearch.syncIndex', async () => {
            const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!wsRoot) {
                vscode.window.showWarningMessage('SI Search: No workspace folder open');
                return;
            }

            try {
                await initParser(context.extensionPath);
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

                await symbolIndex.synchronize(wsRoot, exts, excl, token, (p) => {
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

        // Clear symbol index
        vscode.commands.registerCommand('siSearch.clearIndex', () => {
            const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            symbolIndex.clear();
            if (wsRoot) { symbolIndex.clearDisk(wsRoot); }
            updateStatusBar(statusBarItem, symbolIndex);
            vscode.window.showInformationMessage('SI Search: Symbol index cleared');
        })
    );

    context.subscriptions.push(editorDecorations);
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
