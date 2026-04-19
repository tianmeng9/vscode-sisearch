// src/messageRouter.ts
// 集中处理 SidebarProvider 与 ResultsPanel 的双向消息路由

import type { SearchStore } from './search/searchStore';
import type { SidebarProvider } from './ui/sidebarProvider';
import type { ResultsPanel } from './ui/resultsPanel';
import type { EditorDecorations } from './ui/editorDecorations';
import type { HighlightsTreeProvider } from './ui/highlightsTree';
import type { SymbolIndex } from './symbolIndex';
import type { SidebarMessage, SearchResult, SearchOptions, PreviewResponse, ResultsPanelMessage } from './types';
import type { TokenizedLine } from './syntaxHighlight';

export interface MessageRouterDeps {
    store: SearchStore;
    sidebarProvider: SidebarProvider;
    resultsPanel: ResultsPanel;
    editorDecorations: EditorDecorations;
    highlightsTreeProvider: HighlightsTreeProvider;
    symbolIndex: SymbolIndex;
    executeSearch: (query: string, workspaceRoot: string, options: SearchOptions, extensions: string[], excludes: string[], symbolIndex: SymbolIndex) => Promise<SearchResult[]>;
    openResultInEditor: (result: SearchResult) => Promise<void>;
    tokenizeFile: (content: string, languageId: string) => Promise<{ lines: TokenizedLine[]; bg?: string }>;
    updateSidebarHistory: (store: SearchStore, sidebar: SidebarProvider) => void;
}

export function wireMessageRouter(
    vscode: typeof import('vscode'),
    deps: MessageRouterDeps,
): void {
    const {
        store, sidebarProvider, resultsPanel, editorDecorations, highlightsTreeProvider,
        symbolIndex, executeSearch, openResultInEditor, tokenizeFile, updateSidebarHistory,
    } = deps;

    // 侧边栏消息路由
    sidebarProvider.onMessage(async (msg: SidebarMessage) => {
        switch (msg.command) {
            case 'search': {
                const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                if (!workspaceRoot) {
                    vscode.window.showWarningMessage('SI Search: No workspace folder open');
                    return;
                }

                const config = vscode.workspace.getConfiguration('siSearch');
                const extensions = (msg.filesToInclude && msg.filesToInclude.length > 0)
                    ? msg.filesToInclude
                    : config.get<string[]>('includeFileExtensions', ['.c', '.h', '.cpp', '.hpp']);
                const settingExcludes = config.get<string[]>('excludePatterns', ['**/build/**', '**/.git/**']);
                const uiExcludes = msg.filesToExclude || [];
                const excludes = [...settingExcludes, ...uiExcludes];

                sidebarProvider.postMessage({ command: 'searchStarted' });

                try {
                    const results = await executeSearch(msg.query, workspaceRoot, msg.options, extensions, excludes, symbolIndex);

                    store.addSearch(msg.query, msg.options, results, msg.mode);
                    sidebarProvider.postMessage({ command: 'searchComplete', count: results.length });
                    updateSidebarHistory(store, sidebarProvider);

                    const entries = store.getActiveResultsPanelEntries();
                    resultsPanel.showResults(entries, msg.query);

                    editorDecorations.updateResults(store.getActiveResults());
                } catch (err: unknown) {
                    sidebarProvider.postMessage({ command: 'searchComplete', count: 0 });
                    const msg = err instanceof Error ? err.message : String(err);
                    vscode.window.showErrorMessage(`SI Search error: ${msg}`);
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

    // 结果面板消息路由
    resultsPanel.onMessage(async (msg: ResultsPanelMessage) => {
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
                        bg: result.bg ?? '',
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
}
