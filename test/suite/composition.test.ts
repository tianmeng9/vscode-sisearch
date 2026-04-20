// test/suite/composition.test.ts
// 纯 DI 层单测:验证 updateStatusBar / updateSidebarHistory 的状态机渲染与消息投递。
// 这些函数不产生副作用外部可观测,用 stub 对象即可。

import * as assert from 'assert';
import { updateSidebarHistory, updateStatusBar } from '../../src/composition';
import type { SymbolIndex } from '../../src/symbolIndex';
import type { SearchStore } from '../../src/search/searchStore';
import type { SidebarProvider } from '../../src/ui/sidebarProvider';

type StatusBarStub = { text: string; tooltip: string };

function makeStatusBar(): StatusBarStub {
    return { text: '', tooltip: '' };
}

function makeIndex(status: string, files = 0, symbols = 0): SymbolIndex {
    return {
        status,
        getStats: () => ({ files, symbols }),
    } as unknown as SymbolIndex;
}

suite('composition.updateStatusBar', () => {
    test('renders none state with generic prompt', () => {
        const bar = makeStatusBar();
        updateStatusBar(bar as any, makeIndex('none'));
        assert.strictEqual(bar.text, '$(database) Index: None');
        assert.ok((bar.tooltip as string).includes('synchronize'));
    });

    test('renders building state with spinner icon', () => {
        const bar = makeStatusBar();
        updateStatusBar(bar as any, makeIndex('building'));
        assert.ok(bar.text.includes('sync~spin'));
        assert.ok(bar.text.includes('Syncing'));
    });

    test('renders ready state with symbol count and file count in tooltip', () => {
        const bar = makeStatusBar();
        updateStatusBar(bar as any, makeIndex('ready', 12, 3456));
        assert.ok(bar.text.includes('3,456 symbols'));
        assert.ok((bar.tooltip as string).includes('3456 symbols'));
        assert.ok((bar.tooltip as string).includes('12 files'));
    });

    test('renders stale state with (stale) suffix', () => {
        const bar = makeStatusBar();
        updateStatusBar(bar as any, makeIndex('stale', 2, 7));
        assert.ok(bar.text.includes('7 symbols (stale)'));
        assert.ok((bar.tooltip as string).includes('stale'));
    });
});

suite('composition.updateSidebarHistory', () => {
    test('posts updateHistory message with active flag matching store state', () => {
        const messages: Array<{ command: string; entries: Array<{ id: string; query: string; count: number; active: boolean }> }> = [];
        const sidebar = {
            postMessage: (msg: { command: string; entries: Array<{ id: string; query: string; count: number; active: boolean }> }) => {
                messages.push(msg);
            },
        } as unknown as SidebarProvider;

        const store = {
            getHistory: () => [
                { id: 'h1', query: 'foo', results: [{}, {}] },
                { id: 'h2', query: 'bar', results: [] },
                { id: 'h3', query: 'baz', results: [{}, {}, {}] },
            ],
            getActiveHistoryId: () => 'h2',
        } as unknown as SearchStore;

        updateSidebarHistory(store, sidebar);

        assert.strictEqual(messages.length, 1);
        assert.strictEqual(messages[0].command, 'updateHistory');
        assert.strictEqual(messages[0].entries.length, 3);
        assert.deepStrictEqual(
            messages[0].entries,
            [
                { id: 'h1', query: 'foo', count: 2, active: false },
                { id: 'h2', query: 'bar', count: 0, active: true },
                { id: 'h3', query: 'baz', count: 3, active: false },
            ],
        );
    });

    test('handles empty history', () => {
        const messages: Array<{ entries: unknown[] }> = [];
        const sidebar = {
            postMessage: (msg: { entries: unknown[] }) => { messages.push(msg); },
        } as unknown as SidebarProvider;
        const store = {
            getHistory: () => [],
            getActiveHistoryId: () => null,
        } as unknown as SearchStore;

        updateSidebarHistory(store, sidebar);
        assert.strictEqual(messages.length, 1);
        assert.deepStrictEqual(messages[0].entries, []);
    });

    test('marks no entry active when activeId is null', () => {
        const messages: Array<{ entries: Array<{ active: boolean }> }> = [];
        const sidebar = {
            postMessage: (msg: { entries: Array<{ active: boolean }> }) => { messages.push(msg); },
        } as unknown as SidebarProvider;
        const store = {
            getHistory: () => [
                { id: 'h1', query: 'x', results: [] },
                { id: 'h2', query: 'y', results: [] },
            ],
            getActiveHistoryId: () => null,
        } as unknown as SearchStore;

        updateSidebarHistory(store, sidebar);
        assert.ok(messages[0].entries.every(e => e.active === false));
    });
});
