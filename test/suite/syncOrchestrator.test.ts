import * as assert from 'assert';
import { SyncOrchestrator } from '../../src/sync/syncOrchestrator';

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
            },
            storage: { saveFull: async () => {} },
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
            index: { update: () => {}, remove: () => {} },
            storage: { saveFull: async () => {} },
        });

        await orchestrator.synchronize({ workspaceRoot: '/workspace' });
        assert.strictEqual(parseCalled, false);
    });
});
