import * as assert from 'assert';
import { SyncOrchestrator } from '../../src/sync/syncOrchestrator';
import type { SymbolEntry, IndexedFile } from '../../src/index/indexTypes';

suite('syncOrchestrator', () => {
    test('applies deletions and worker parse results to index', async () => {
        const updates: string[] = [];
        const removals: string[] = [];

        const orchestrator = new SyncOrchestrator({
            scanFiles: async () => [{ relativePath: 'a.c', absPath: '/workspace/a.c', mtime: 10, size: 100 }],
            classify: async () => ({
                toProcess: [{ relativePath: 'a.c', absPath: '/workspace/a.c', mtime: 10, size: 100 }],
                toDelete: ['old.c'],
            }),
            workerPool: {
                parse: async () => ({
                    symbols: [{ name: 'foo', kind: 'function' as const, filePath: '/workspace/a.c', relativePath: 'a.c', lineNumber: 1, endLineNumber: 1, column: 0, lineContent: 'foo();' }],
                    metadata: [{ relativePath: 'a.c', mtime: 10, size: 100, symbolCount: 1 }],
                    errors: [],
                }),
            },
            index: {
                update(file: string, symbols: unknown[]) { updates.push(`${file}:${symbols.length}`); },
                remove(file: string) { removals.push(file); },
                applyMetadata: () => {},
            },
            storage: { saveFull: async () => {} },
            getSnapshot: () => ({ symbolsByFile: new Map(), fileMetadata: new Map() }),
        });

        await orchestrator.synchronize({ workspaceRoot: '/workspace' });
        assert.deepStrictEqual(removals, ['old.c']);
        assert.deepStrictEqual(updates, ['a.c:1']);
    });

    test('skips workerPool.parse when toProcess is empty', async () => {
        let parseCalled = false;

        const orchestrator = new SyncOrchestrator({
            scanFiles: async () => [],
            classify: async () => ({ toProcess: [], toDelete: [] }),
            workerPool: { parse: async () => { parseCalled = true; return { symbols: [], metadata: [], errors: [] }; } },
            index: { update: () => {}, remove: () => {}, applyMetadata: () => {} },
            storage: { saveFull: async () => {} },
            getSnapshot: () => ({ symbolsByFile: new Map(), fileMetadata: new Map() }),
        });

        await orchestrator.synchronize({ workspaceRoot: '/workspace' });
        assert.strictEqual(parseCalled, false);
    });

    test('calls storage.saveDirty with dirtyPaths when available', async () => {
        const saveDirtyCalls: Array<{ paths: string[] }> = [];
        const saveFullCalls: number[] = [];

        const snapshot = { symbolsByFile: new Map<string, SymbolEntry[]>(), fileMetadata: new Map<string, IndexedFile>() };

        const orchestrator = new SyncOrchestrator({
            scanFiles: async () => [{ relativePath: 'new.c', absPath: '/ws/new.c', mtime: 1, size: 1 }],
            classify: async () => ({
                toProcess: [{ relativePath: 'new.c', absPath: '/ws/new.c', mtime: 1, size: 1 }],
                toDelete: ['gone.c'],
            }),
            workerPool: {
                parse: async () => ({
                    symbols: [],
                    metadata: [{ relativePath: 'new.c', mtime: 1, size: 1, symbolCount: 0 }],
                    errors: [],
                }),
            },
            index: { update: () => {}, remove: () => {}, applyMetadata: () => {} },
            storage: {
                saveFull: async () => { saveFullCalls.push(1); },
                saveDirty: async (_snap, paths) => { saveDirtyCalls.push({ paths: [...paths] }); },
            },
            getSnapshot: () => snapshot,
        });

        await orchestrator.synchronize({ workspaceRoot: '/ws' });
        assert.strictEqual(saveDirtyCalls.length, 1, 'saveDirty should be called exactly once');
        assert.strictEqual(saveFullCalls.length, 0, 'saveFull should not be called when saveDirty is available');
        assert.ok(saveDirtyCalls[0].paths.includes('gone.c'), 'deleted path should be marked dirty');
        assert.ok(saveDirtyCalls[0].paths.includes('new.c'), 'added path should be marked dirty');
    });

    test('falls back to saveFull when saveDirty not provided', async () => {
        let saveFullCalled = false;

        const orchestrator = new SyncOrchestrator({
            scanFiles: async () => [],
            classify: async () => ({ toProcess: [], toDelete: ['x.c'] }),
            workerPool: { parse: async () => ({ symbols: [], metadata: [], errors: [] }) },
            index: { update: () => {}, remove: () => {}, applyMetadata: () => {} },
            storage: { saveFull: async () => { saveFullCalled = true; } },
            getSnapshot: () => ({ symbolsByFile: new Map(), fileMetadata: new Map() }),
        });

        await orchestrator.synchronize({ workspaceRoot: '/ws' });
        assert.strictEqual(saveFullCalled, true);
    });

    test('invokes index.applyMetadata with parse result before index.update', async () => {
        const order: string[] = [];
        const appliedMeta: IndexedFile[] = [];

        const orchestrator = new SyncOrchestrator({
            scanFiles: async () => [{ relativePath: 'x.c', absPath: '/ws/x.c', mtime: 2, size: 3 }],
            classify: async () => ({
                toProcess: [{ relativePath: 'x.c', absPath: '/ws/x.c', mtime: 2, size: 3 }],
                toDelete: [],
            }),
            workerPool: {
                parse: async () => ({
                    symbols: [],
                    metadata: [{ relativePath: 'x.c', mtime: 2, size: 3, symbolCount: 0 }],
                    errors: [],
                }),
            },
            index: {
                update: () => { order.push('update'); },
                remove: () => {},
                applyMetadata: (meta) => { order.push('applyMetadata'); appliedMeta.push(...meta); },
            },
            storage: { saveFull: async () => {} },
            getSnapshot: () => ({ symbolsByFile: new Map(), fileMetadata: new Map() }),
        });

        await orchestrator.synchronize({ workspaceRoot: '/ws' });
        assert.deepStrictEqual(order, ['applyMetadata', 'update'], 'applyMetadata must fire before update');
        assert.strictEqual(appliedMeta.length, 1);
        assert.strictEqual(appliedMeta[0].relativePath, 'x.c');
    });

    test('does not call storage when nothing changed', async () => {
        let anySaveCalled = false;

        const orchestrator = new SyncOrchestrator({
            scanFiles: async () => [],
            classify: async () => ({ toProcess: [], toDelete: [] }),
            workerPool: { parse: async () => ({ symbols: [], metadata: [], errors: [] }) },
            index: { update: () => {}, remove: () => {}, applyMetadata: () => {} },
            storage: {
                saveFull: async () => { anySaveCalled = true; },
                saveDirty: async () => { anySaveCalled = true; },
            },
            getSnapshot: () => ({ symbolsByFile: new Map(), fileMetadata: new Map() }),
        });

        await orchestrator.synchronize({ workspaceRoot: '/ws' });
        assert.strictEqual(anySaveCalled, false);
    });
});
