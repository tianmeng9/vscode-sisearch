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
            showResults: (_entries: unknown[], _query: string, _pagination?: unknown) => { calls.push('showResults'); },
            appendResults: (_entries: unknown[], _total: number, _loaded: number) => { calls.push(`appendResults:${_total}:${_loaded}`); },
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
            getActive: () => undefined as any,
            appendToActive: (_more: unknown[]) => { calls.push('appendToActive'); },
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

        const executeSearch = async (
            _q: string, _root: string, _opts: unknown, _ext: string[], _exc: string[], _idx: unknown, offset?: number,
        ) => { calls.push(`executeSearch:${offset ?? 0}`); return { results: [] as any[], totalCount: 0 }; };
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

        assert.ok(deps.calls.some(c => c.startsWith('executeSearch')), 'search did not trigger executeSearch');
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

    test('sidebar loadMore is a no-op when no active entry', async () => {
        const deps = makeDeps();
        // getActive returns undefined by default
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

        await deps.sidebarProvider.messageCallback!({ command: 'loadMore' });

        assert.ok(!deps.calls.some(c => c.startsWith('executeSearch')),
            'loadMore should not call executeSearch without active');
        assert.ok(!deps.calls.includes('appendToActive'),
            'loadMore should not call appendToActive without active');
    });

    test('sidebar loadMore calls executeSearch with active.loadedCount as offset', async () => {
        const deps = makeDeps();
        const activeEntry = {
            id: 'x',
            query: 'foo',
            options: { caseSensitive: false, wholeWord: false, regex: false },
            results: [],
            timestamp: 0,
            totalCount: 500,
            loadedCount: 200,
        };
        deps.store.getActive = () => activeEntry;
        deps.executeSearch = async (
            _q: string, _root: string, _opts: unknown, _ext: string[], _exc: string[], _idx: unknown, offset?: number,
        ) => { deps.calls.push(`executeSearch:${offset ?? 0}`); return { results: [{ filePath: '/workspace/b.c', relativePath: 'b.c', lineNumber: 1, lineContent: '', matchStart: 0, matchLength: 0 }] as any[], totalCount: 500 }; };

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

        await deps.sidebarProvider.messageCallback!({ command: 'loadMore' });

        assert.ok(deps.calls.includes('executeSearch:200'),
            `loadMore should pass offset=200 to executeSearch, got: ${deps.calls.join(',')}`);
        assert.ok(deps.calls.includes('appendToActive'),
            'loadMore should call store.appendToActive with returned results');
        assert.ok(deps.calls.includes('appendResults:500:201'),
            `loadMore should call appendResults(results, totalCount=500, loadedCount=201), got: ${deps.calls.join(',')}`);
    });
});
