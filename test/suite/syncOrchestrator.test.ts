import * as assert from 'assert';
import { SyncOrchestrator } from '../../src/sync/syncOrchestrator';
import type { SymbolEntry, IndexedFile } from '../../src/index/indexTypes';
import type { ParseBatchResult } from '../../src/sync/workerPool';

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
                parse: async (files, onBatchResult, onBatchComplete) => {
                    await onBatchResult({
                        symbols: [{ name: 'foo', kind: 'function' as const, filePath: '/workspace/a.c', relativePath: 'a.c', lineNumber: 1, endLineNumber: 1, column: 0, lineContent: 'foo();' }],
                        metadata: [{ relativePath: 'a.c', mtime: 10, size: 100, symbolCount: 1 }],
                        errors: [],
                    });
                    onBatchComplete?.(files.length, files.length, files[files.length - 1]?.relativePath);
                },
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
            workerPool: {
                parse: async () => { parseCalled = true; },
            },
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
                parse: async (files, onBatchResult, onBatchComplete) => {
                    await onBatchResult({
                        symbols: [],
                        metadata: [{ relativePath: 'new.c', mtime: 1, size: 1, symbolCount: 0 }],
                        errors: [],
                    });
                    onBatchComplete?.(files.length, files.length, files[files.length - 1]?.relativePath);
                },
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
            workerPool: {
                parse: async () => {},
            },
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
                parse: async (files, onBatchResult, onBatchComplete) => {
                    await onBatchResult({
                        symbols: [{ name: 'bar', kind: 'function' as const, filePath: '/ws/x.c', relativePath: 'x.c', lineNumber: 1, endLineNumber: 1, column: 0, lineContent: '' }],
                        metadata: [{ relativePath: 'x.c', mtime: 2, size: 3, symbolCount: 0 }],
                        errors: [],
                    });
                    onBatchComplete?.(files.length, files.length, files[files.length - 1]?.relativePath);
                },
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

    test('forwards workerPool onBatchComplete as parsing progress (regression: status bar stuck at 0/N)', async () => {
        const progressEvents: Array<{ phase: string; current: number; total: number; currentFile?: string }> = [];

        const orchestrator = new SyncOrchestrator({
            scanFiles: async () => [
                { relativePath: 'a.c', absPath: '/ws/a.c', mtime: 1, size: 1 },
                { relativePath: 'b.c', absPath: '/ws/b.c', mtime: 1, size: 1 },
            ],
            classify: async () => ({
                toProcess: [
                    { relativePath: 'a.c', absPath: '/ws/a.c', mtime: 1, size: 1 },
                    { relativePath: 'b.c', absPath: '/ws/b.c', mtime: 1, size: 1 },
                ],
                toDelete: [],
            }),
            workerPool: {
                // Simulate WorkerPool firing onBatchResult + onBatchComplete after each batch.
                parse: async (files, onBatchResult, onBatchComplete) => {
                    for (let i = 0; i < files.length; i++) {
                        const f = files[i];
                        await onBatchResult({
                            symbols: [],
                            metadata: [{ relativePath: f.relativePath, mtime: 1, size: 1, symbolCount: 0 }],
                            errors: [],
                        });
                        onBatchComplete?.(i + 1, files.length, f.relativePath);
                    }
                },
            },
            index: { update: () => {}, remove: () => {}, applyMetadata: () => {} },
            storage: { saveFull: async () => {} },
            getSnapshot: () => ({ symbolsByFile: new Map(), fileMetadata: new Map() }),
            onProgress: (phase, current, total, currentFile) => {
                progressEvents.push({ phase, current, total, currentFile });
            },
        });

        await orchestrator.synchronize({ workspaceRoot: '/ws' });

        const parsingEvents = progressEvents.filter(e => e.phase === 'parsing');
        // Must see at least: initial (0, total), then per-batch updates
        assert.ok(parsingEvents.length >= 3, `expected >=3 parsing events, got ${parsingEvents.length}`);
        // First event must be the initial 0/total
        assert.strictEqual(parsingEvents[0].current, 0);
        assert.strictEqual(parsingEvents[0].total, 2);
        // Later events must carry progress > 0 and currentFile
        const withProgress = parsingEvents.filter(e => e.current > 0);
        assert.ok(withProgress.length >= 2, 'expected >=2 per-batch updates');
        assert.ok(withProgress.every(e => typeof e.currentFile === 'string'), 'per-batch updates must include currentFile');
        // Final parsing event reports all files done
        const lastParsing = parsingEvents[parsingEvents.length - 1];
        assert.strictEqual(lastParsing.current, 2);
    });

    test('does not call storage when nothing changed', async () => {
        let anySaveCalled = false;

        const orchestrator = new SyncOrchestrator({
            scanFiles: async () => [],
            classify: async () => ({ toProcess: [], toDelete: [] }),
            workerPool: {
                parse: async () => {},
            },
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

suite('SyncOrchestrator streaming', () => {
    function makeDeps(overrides: any = {}): any {
        const updates: Array<[string, number]> = [];
        const metaApplied: Array<{ relativePath: string }> = [];
        return {
            scanFiles: async () => [
                { relativePath: 'a.c', absPath: '/w/a.c', mtime: 1, size: 1 },
                { relativePath: 'b.c', absPath: '/w/b.c', mtime: 2, size: 2 },
            ],
            classify: async (x: any) => ({
                toProcess: x.currentFiles,
                toDelete: new Set<string>(),
            }),
            workerPool: {
                parse: async (files: any[], onBatch: (r: ParseBatchResult) => Promise<void>) => {
                    for (const f of files) {
                        await onBatch({
                            symbols: [{
                                name: f.relativePath, kind: 'function',
                                filePath: f.absPath, relativePath: f.relativePath,
                                lineNumber: 1, endLineNumber: 1, column: 0, lineContent: '',
                            }] as any,
                            metadata: [{ relativePath: f.relativePath, mtime: 1, size: 1, symbolCount: 1 }],
                            errors: [],
                        });
                    }
                },
            },
            index: {
                update: (file: string, symbols: any[]) => { updates.push([file, symbols.length]); },
                remove: () => {},
                applyMetadata: (m: any[]) => { for (const x of m) { metaApplied.push(x); } },
                fileMetadata: new Map(),
            },
            storage: {
                saveFull: async () => {},
                saveDirty: async () => {},
            },
            getSnapshot: () => ({ symbolsByFile: new Map(), fileMetadata: new Map() }),
            _spy: { updates, metaApplied },
            ...overrides,
        };
    }

    test('update is called once per file, per batch', async () => {
        const deps = makeDeps();
        const orch = new SyncOrchestrator(deps);
        await orch.synchronize({ workspaceRoot: '/w' });
        assert.strictEqual(deps._spy.updates.length, 2);
        assert.deepStrictEqual(deps._spy.updates.map((u: any) => u[0]).sort(), ['a.c', 'b.c']);
    });

    test('applyMetadata called per batch (not once at end)', async () => {
        const deps = makeDeps();
        const orch = new SyncOrchestrator(deps);
        await orch.synchronize({ workspaceRoot: '/w' });
        assert.strictEqual(deps._spy.metaApplied.length, 2);
    });

    test('saveDirty called at end with collected dirty paths', async () => {
        let saveDirtyArgs: any;
        const deps = makeDeps({
            storage: {
                saveFull: async () => {},
                saveDirty: async (_snap: any, dirty: Set<string>) => { saveDirtyArgs = [...dirty].sort(); },
            },
        });
        const orch = new SyncOrchestrator(deps);
        await orch.synchronize({ workspaceRoot: '/w' });
        assert.deepStrictEqual(saveDirtyArgs, ['a.c', 'b.c']);
    });
});
