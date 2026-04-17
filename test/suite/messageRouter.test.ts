import * as assert from 'assert';
import { wireMessageRouter } from '../../src/messageRouter';

suite('messageRouter', () => {
    function makeDeps() {
        const calls: string[] = [];

        const sidebarProvider = {
            messageCallback: null as ((msg: any) => void) | null,
            onMessage(cb: (msg: any) => void) { this.messageCallback = cb; },
            postMessage: (_msg: unknown) => {},
        };

        const resultsPanel = {
            messageCallback: null as ((msg: any) => void) | null,
            onMessage(cb: (msg: any) => void) { this.messageCallback = cb; },
            postMessage: (_msg: unknown) => {},
            show: () => {},
            showResults: (_entries: unknown[], _query: string) => { calls.push('showResults'); },
            sendPreviewData: (_data: unknown) => { calls.push('sendPreviewData'); },
        };

        const store = {
            addSearch: () => {},
            selectHistory: (id: string) => { calls.push(`selectHistory:${id}`); },
            deleteHistory: () => {},
            getHistory: () => [],
            getActiveHistoryId: () => '',
            getActiveResults: () => [],
            getActiveResultsPanelEntries: () => [],
        } as any;

        const editorDecorations = {
            updateResults: () => {},
            clearDecorations: () => { calls.push('clearDecorations'); },
            updateManualHighlights: () => {},
        } as any;

        const highlightsTreeProvider = {
            update: () => {},
        } as any;

        const fakeVscode = {
            workspace: {
                workspaceFolders: [{ uri: { fsPath: '/workspace' } }],
                getConfiguration: (_s: string) => ({ get: (_k: string, d: unknown) => d }),
                openTextDocument: async (_uri: unknown) => ({ getText: () => '', languageId: 'c', uri: {} }),
            },
            Uri: { file: (p: string) => ({ fsPath: p }) },
            window: {
                activeTextEditor: undefined,
                showWarningMessage: async (_m: string) => {},
                showErrorMessage: async (_m: string) => {},
            },
        } as any;

        const symbolIndex = {
            /* stub */
        } as any;

        const executeSearch = async () => { calls.push('executeSearch'); return []; };
        const openResultInEditor = async () => { calls.push('openResult'); };
        const tokenizeFile = async () => ({ lines: [], bg: '' });
        const updateSidebarHistory = () => {};

        return { sidebarProvider, resultsPanel, store, editorDecorations, highlightsTreeProvider, fakeVscode, symbolIndex, executeSearch, openResultInEditor, tokenizeFile, updateSidebarHistory, calls };
    }

    test('sidebar search message triggers executeSearch', async () => {
        const deps = makeDeps();
        wireMessageRouter(deps.fakeVscode, {
            store: deps.store,
            sidebarProvider: deps.sidebarProvider as any,
            resultsPanel: deps.resultsPanel as any,
            editorDecorations: deps.editorDecorations,
            highlightsTreeProvider: deps.highlightsTreeProvider,
            symbolIndex: deps.symbolIndex,
            executeSearch: deps.executeSearch,
            openResultInEditor: deps.openResultInEditor,
            tokenizeFile: deps.tokenizeFile,
            updateSidebarHistory: deps.updateSidebarHistory,
        });

        await deps.sidebarProvider.messageCallback!({
            command: 'search',
            query: 'foo',
            options: { caseSensitive: false, wholeWord: false, regex: false },
            mode: 'replace',
        });

        assert.ok(deps.calls.includes('executeSearch'), 'search did not trigger executeSearch');
        assert.ok(deps.calls.includes('showResults'), 'search did not call showResults');
    });

    test('sidebar selectHistory message calls store.selectHistory', async () => {
        const deps = makeDeps();
        wireMessageRouter(deps.fakeVscode, {
            store: deps.store,
            sidebarProvider: deps.sidebarProvider as any,
            resultsPanel: deps.resultsPanel as any,
            editorDecorations: deps.editorDecorations,
            highlightsTreeProvider: deps.highlightsTreeProvider,
            symbolIndex: deps.symbolIndex,
            executeSearch: deps.executeSearch,
            openResultInEditor: deps.openResultInEditor,
            tokenizeFile: deps.tokenizeFile,
            updateSidebarHistory: deps.updateSidebarHistory,
        });

        await deps.sidebarProvider.messageCallback!({ command: 'selectHistory', id: 'abc' });

        assert.ok(deps.calls.includes('selectHistory:abc'), 'selectHistory not called with correct id');
    });

    test('resultsPanel jumpToFile message calls openResultInEditor', async () => {
        const deps = makeDeps();
        wireMessageRouter(deps.fakeVscode, {
            store: deps.store,
            sidebarProvider: deps.sidebarProvider as any,
            resultsPanel: deps.resultsPanel as any,
            editorDecorations: deps.editorDecorations,
            highlightsTreeProvider: deps.highlightsTreeProvider,
            symbolIndex: deps.symbolIndex,
            executeSearch: deps.executeSearch,
            openResultInEditor: deps.openResultInEditor,
            tokenizeFile: deps.tokenizeFile,
            updateSidebarHistory: deps.updateSidebarHistory,
        });

        await deps.resultsPanel.messageCallback!({ command: 'jumpToFile', filePath: '/workspace/a.c', lineNumber: 10 });

        assert.ok(deps.calls.includes('openResult'), 'jumpToFile did not call openResultInEditor');
    });

    test('resultsPanel requestPreview message calls tokenizeFile and sendPreviewData', async () => {
        const deps = makeDeps();
        wireMessageRouter(deps.fakeVscode, {
            store: deps.store,
            sidebarProvider: deps.sidebarProvider as any,
            resultsPanel: deps.resultsPanel as any,
            editorDecorations: deps.editorDecorations,
            highlightsTreeProvider: deps.highlightsTreeProvider,
            symbolIndex: deps.symbolIndex,
            executeSearch: deps.executeSearch,
            openResultInEditor: deps.openResultInEditor,
            tokenizeFile: deps.tokenizeFile,
            updateSidebarHistory: deps.updateSidebarHistory,
        });

        await deps.resultsPanel.messageCallback!({ command: 'requestPreview', filePath: '/workspace/a.c', lineNumber: 5 });

        assert.ok(deps.calls.includes('sendPreviewData'), 'requestPreview did not call sendPreviewData');
    });
});
