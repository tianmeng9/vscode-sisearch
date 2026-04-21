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

    test('passes cancellationToken through to workerPool.parse', async () => {
        // Regression: orchestrator used to await parse() with no way for the
        // underlying pool to know about cancellation, so cancel couldn't stop
        // parsing mid-stream. Now orchestrator must forward its cancelToken.
        let seenSignal: { isCancellationRequested: boolean } | undefined;
        const deps = makeDeps({
            workerPool: {
                parse: async (
                    _files: any,
                    _onBatch: any,
                    _onComplete: any,
                    signal?: { isCancellationRequested: boolean },
                ) => {
                    seenSignal = signal;
                },
            },
        });
        const orch = new SyncOrchestrator(deps);
        const token = { isCancellationRequested: false };
        await orch.synchronize({ workspaceRoot: '/w', cancellationToken: token });
        assert.ok(seenSignal, 'workerPool.parse must receive a cancel signal');
        // Mutating the orchestrator's token must propagate to the signal object
        // the pool saw — same reference or live-read proxy.
        token.isCancellationRequested = true;
        assert.strictEqual(
            seenSignal!.isCancellationRequested,
            true,
            'signal must observe live token state, not a stale snapshot',
        );
    });

    // --- recycle on cancel ---
    //
    // Phase 2 契约:Sync 被 cancel 且 parse 已开始,orchestrator 必须调用
    // workerPool.recycle() 清掉 worker 的脏 WASM 堆,防止跨 sync 碎片累积。
    // 没有 recycle 时 worker 继续服役,Parser Phase-1 修复后仍可能因
    // "parseBatch 发出但被丢弃"留下未配对的 tree alloc。
    test('calls workerPool.recycle() after parse when cancelled mid-parse', async () => {
        let recycleCalled = 0;
        const token = { isCancellationRequested: false };
        const deps = makeDeps({
            workerPool: {
                parse: async (_files: any, onBatch: any, _onComplete: any, signal: any) => {
                    // 模拟 workerPool: 处理第一个 batch 后用户点了 cancel,
                    // workerLoop 应立即退出(真实 WorkerPool 的行为)。
                    await onBatch({ symbols: [], metadata: [], errors: [] });
                    token.isCancellationRequested = true;
                    // signal 已被 orchestrator 传进来,对它生效。
                    assert.ok(signal, 'orchestrator must forward cancellationToken');
                    // 真实 WorkerPool 在下一次 loop head 检查 signal 并返回,这里提早返回。
                },
                recycle: async () => { recycleCalled++; },
            },
        });
        const orch = new SyncOrchestrator(deps);
        await orch.synchronize({ workspaceRoot: '/w', cancellationToken: token });
        assert.strictEqual(recycleCalled, 1,
            'recycle must run exactly once after a cancelled parse');
    });

    test('does not call recycle() when sync completes without cancellation', async () => {
        let recycleCalled = 0;
        const deps = makeDeps({
            workerPool: {
                parse: async (files: any[], onBatch: any) => {
                    for (const f of files) {
                        await onBatch({
                            symbols: [], metadata: [{ relativePath: f.relativePath, mtime: 1, size: 1, symbolCount: 0 }], errors: [],
                        });
                    }
                },
                recycle: async () => { recycleCalled++; },
            },
        });
        const orch = new SyncOrchestrator(deps);
        await orch.synchronize({ workspaceRoot: '/w' });
        assert.strictEqual(recycleCalled, 0,
            'normal completion should NOT trigger recycle');
    });

    test('does not call recycle() when cancelled before parse starts', async () => {
        let recycleCalled = 0;
        let parseCalled = 0;
        // 预置 cancel:classify 阶段后的检查就会 return,parse 从未运行,
        // 因此不需要 recycle。
        const token = { isCancellationRequested: true };
        const deps = makeDeps({
            workerPool: {
                parse: async () => { parseCalled++; },
                recycle: async () => { recycleCalled++; },
            },
        });
        const orch = new SyncOrchestrator(deps);
        await orch.synchronize({ workspaceRoot: '/w', cancellationToken: token });
        assert.strictEqual(parseCalled, 0, 'parse should be skipped');
        assert.strictEqual(recycleCalled, 0, 'recycle should be skipped (no parse ran)');
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
