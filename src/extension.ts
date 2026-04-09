// src/extension.ts
import * as vscode from 'vscode';
import * as fs from 'fs';
import { SearchStore } from './searchStore';
import { SidebarProvider } from './sidebarProvider';
import { ResultsPanel } from './resultsPanel';
import { EditorDecorations } from './editorDecorations';
import { executeSearch } from './searchEngine';
import { navigateNext, navigatePrevious, openResultInEditor } from './navigation';
import { SidebarMessage, SearchResult, PreviewResponse } from './types';

export function activate(context: vscode.ExtensionContext) {
    const store = new SearchStore();
    const sidebarProvider = new SidebarProvider(context.extensionUri);
    const resultsPanel = new ResultsPanel(context.extensionUri);
    const editorDecorations = new EditorDecorations(context.extensionUri);

    // 注册侧边栏 webview provider
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            SidebarProvider.viewType,
            sidebarProvider,
            { webviewOptions: { retainContextWhenHidden: true } }
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
                const extensions = config.get<string[]>('includeFileExtensions', ['.c', '.h', '.cpp', '.hpp']);
                const excludes = config.get<string[]>('excludePatterns', ['**/build/**', '**/.git/**']);

                sidebarProvider.postMessage({ command: 'searchStarted' });

                try {
                    const results = await executeSearch(
                        msg.query, workspaceRoot, msg.options, extensions, excludes
                    );

                    store.addSearch(msg.query, msg.options, results, msg.mode);
                    sidebarProvider.postMessage({ command: 'searchComplete', count: results.length });
                    updateSidebarHistory(store, sidebarProvider);

                    const entries = store.getActiveResultsPanelEntries();
                    if (msg.mode === 'replace') {
                        resultsPanel.showResults(entries, msg.query);
                    } else {
                        resultsPanel.appendResults(entries, msg.query);
                    }

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
                const config = vscode.workspace.getConfiguration('siSearch');
                const contextLines = config.get<number>('previewContextLines', 5);
                try {
                    const content = fs.readFileSync(msg.filePath, 'utf-8');
                    const allLines = content.split('\n');
                    const lineIdx = msg.lineNumber - 1;
                    const startLine = Math.max(0, lineIdx - contextLines);
                    const endLine = Math.min(allLines.length - 1, lineIdx + contextLines);

                    const lines: { num: number; content: string }[] = [];
                    for (let i = startLine; i <= endLine; i++) {
                        lines.push({ num: i + 1, content: allLines[i] });
                    }

                    const preview: PreviewResponse = {
                        command: 'previewData',
                        filePath: msg.filePath,
                        lineNumber: msg.lineNumber,
                        lines,
                    };
                    resultsPanel.sendPreviewData(preview);
                } catch {
                    // 文件不可读时静默忽略
                }
                break;
            }
            case 'clearAllHighlights': {
                editorDecorations.clearDecorations();
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
            resultsPanel.triggerHighlightSelection();
        }),

        vscode.commands.registerCommand('siSearch.clearAllHighlights', () => {
            resultsPanel.postMessage({ command: 'clearHighlights' });
            editorDecorations.clearDecorations();
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

export function deactivate() {}
