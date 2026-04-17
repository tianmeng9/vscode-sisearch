import * as assert from 'assert';
import { registerCommands } from '../../src/commands';

suite('commands', () => {
    test('registerCommands returns disposable for every command', () => {
        const registered: string[] = [];
        const disposed: string[] = [];

        const fakeVscode = {
            commands: {
                registerCommand(id: string, _handler: unknown) {
                    registered.push(id);
                    return { dispose() { disposed.push(id); } };
                },
                executeCommand: async (_id: string) => {},
            },
            window: {
                activeTextEditor: undefined,
                showWarningMessage: async (_msg: string) => {},
                showErrorMessage: async (_msg: string) => {},
                withProgress: async (_opts: unknown, task: (p: any, t: any) => Promise<void>) => {
                    await task({ report: () => {} }, { isCancellationRequested: false });
                },
            },
            workspace: {
                workspaceFolders: undefined,
                getConfiguration: (_section: string) => ({
                    get: (_key: string, defaultValue: unknown) => defaultValue,
                }),
            },
            ProgressLocation: { Notification: 15 },
        } as any;

        const fakeDeps = {
            store: { clearAll: () => {}, getActiveResults: () => [], setNavigationIndex: () => {}, getActiveResultsPanelEntries: () => [] } as any,
            resultsPanel: { toggle: () => {}, highlightEntry: () => {}, postMessage: () => {}, show: () => {}, showResults: () => {}, triggerHighlightSelection: () => {} } as any,
            sidebarProvider: { postMessage: () => {} } as any,
            editorDecorations: { updateResults: () => {}, clearDecorations: () => {} } as any,
            highlightsTreeProvider: { update: () => {} } as any,
            symbolIndex: { clear: () => {}, clearDisk: () => {}, synchronize: async () => {}, getStats: () => ({ symbols: 0, files: 0 }) } as any,
            statusBarItem: { text: '', tooltip: '' } as any,
            extensionPath: '/tmp',
            navigateNext: async () => null as any,
            navigatePrevious: async () => null as any,
            initParser: async () => {},
            updateStatusBar: () => {},
            updateSidebarHistory: () => {},
        };

        const disposables = registerCommands(fakeVscode, fakeDeps);

        assert.ok(disposables.length >= 10, `Expected >= 10 disposables, got ${disposables.length}`);
        assert.ok(registered.includes('siSearch.syncIndex'), 'siSearch.syncIndex not registered');
        assert.ok(registered.includes('siSearch.clearIndex'), 'siSearch.clearIndex not registered');
        assert.ok(registered.includes('siSearch.toggleResultsPanel'), 'siSearch.toggleResultsPanel not registered');
        assert.ok(registered.includes('siSearch.nextResult'), 'siSearch.nextResult not registered');
        assert.ok(registered.includes('siSearch.previousResult'), 'siSearch.previousResult not registered');
        assert.ok(registered.includes('siSearch.highlightSelection'), 'siSearch.highlightSelection not registered');
        assert.ok(registered.includes('siSearch.clearAllHighlights'), 'siSearch.clearAllHighlights not registered');
        assert.ok(registered.includes('siSearch.jumpToResult'), 'siSearch.jumpToResult not registered');
        assert.ok(registered.includes('siSearch.clearResults'), 'siSearch.clearResults not registered');
        assert.ok(registered.includes('siSearch.removeHighlight'), 'siSearch.removeHighlight not registered');

        disposables.forEach(d => d.dispose());
    });
});
