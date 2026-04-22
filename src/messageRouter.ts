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
    executeSearch: (query: string, workspaceRoot: string, options: SearchOptions, extensions: string[], excludes: string[], symbolIndex: SymbolIndex, offset?: number) => Promise<{ results: SearchResult[]; totalCount: number }>;
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
                    const { results, totalCount } = await executeSearch(msg.query, workspaceRoot, msg.options, extensions, excludes, symbolIndex);

                    store.addSearch(msg.query, msg.options, results, msg.mode, { totalCount, loadedCount: results.length });
                    sidebarProvider.postMessage({ command: 'searchComplete', count: totalCount });
                    updateSidebarHistory(store, sidebarProvider);

                    const entries = store.getActiveResultsPanelEntries();
                    resultsPanel.showResults(entries, msg.query, { totalCount, loadedCount: results.length });

                    editorDecorations.updateResults(store.getActiveResults());
                } catch (err: unknown) {
                    // 搜索失败不骚扰用户 —— 侧栏 count=0 + 空结果面板已经足够传达
                    // "没结果"。用户看到 error toast 会以为扩展坏了,实际可能只是
                    // 一个 regex 无效 / FTS 语法特殊字符 / 临时 DB 忙。详细错误写
                    // 进 console,开发者需要 debug 时打开 Output 面板能看到。
                    sidebarProvider.postMessage({ command: 'searchComplete', count: 0 });
                    const em = err instanceof Error ? err.message : String(err);
                    console.error('[SI Search] search failed:', em);
                    const emptyEntries = store.getActiveResultsPanelEntries();
                    resultsPanel.showResults(emptyEntries, msg.query, { totalCount: 0, loadedCount: 0 });
                }
                break;
            }
            case 'selectHistory': {
                store.selectHistory(msg.id);
                updateSidebarHistory(store, sidebarProvider);
                const entries = store.getActiveResultsPanelEntries();
                const activeEntry = store.getHistory().find(e => e.id === msg.id);
                const pagination = activeEntry
                    ? {
                        totalCount: activeEntry.totalCount ?? activeEntry.results.length,
                        loadedCount: activeEntry.loadedCount ?? activeEntry.results.length,
                    }
                    : undefined;
                resultsPanel.showResults(entries, activeEntry?.query || '', pagination);
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
            case 'loadMore': {
                // loadMore 是从 resultsPanel webview 发出的 —— webview 里的
                // `vscode.postMessage({command:'loadMore'})` 走的是 ResultsPanel
                // 这条 channel,而不是 sidebar。历史上它被错放在了 sidebar 分支,
                // 导致 webview 滚到底永远拿不到追加结果。
                const active = store.getActive();
                if (!active) { break; }
                const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                if (!workspaceRoot) { break; }

                const config = vscode.workspace.getConfiguration('siSearch');
                const extensions = config.get<string[]>('includeFileExtensions', ['.c', '.h', '.cpp', '.hpp']);
                const excludes = config.get<string[]>('excludePatterns', ['**/build/**', '**/.git/**']);

                const offset = active.loadedCount ?? active.results.length;
                try {
                    const { results: more } = await executeSearch(
                        active.query, workspaceRoot, active.options, extensions, excludes, symbolIndex, offset,
                    );
                    store.appendToActive(more);

                    const newLoadedCount = offset + more.length;
                    const totalCount = active.totalCount ?? newLoadedCount;
                    const newEntries = more.map((r, i) => ({ ...r, globalIndex: offset + i }));
                    resultsPanel.appendResults(newEntries, totalCount, newLoadedCount);
                    editorDecorations.updateResults(store.getActiveResults());
                } catch (err: unknown) {
                    const em = err instanceof Error ? err.message : String(err);
                    console.error('[SI Search] loadMore failed:', em);
                }
                break;
            }
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
