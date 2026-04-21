import * as assert from 'assert';
import { SyncOrchestrator } from '../../src/sync/syncOrchestrator';
import type { IndexedFile } from '../../src/index/indexTypes';
import type { ParseBatchResult } from '../../src/sync/workerPool';
import type { WriteBatch } from '../../src/index/dbBackend';

interface MockDb {
    writes: WriteBatch[];
    checkpoints: number;
    fileMetadata: Map<string, IndexedFile>;
    writeBatch: (b: WriteBatch) => void;
    getAllFileMetadata: () => Map<string, IndexedFile>;
    checkpoint: () => void;
}

function makeDb(initialFileMeta?: Map<string, IndexedFile>): MockDb {
    const state = {
        writes: [] as WriteBatch[],
        checkpoints: 0,
        fileMetadata: initialFileMeta ?? new Map<string, IndexedFile>(),
    };
    return {
        get writes() { return state.writes; },
        get checkpoints() { return state.checkpoints; },
        get fileMetadata() { return state.fileMetadata; },
        writeBatch: (b: WriteBatch) => {
            // clone to avoid callers mutating captured references
            state.writes.push({
                metadata: [...b.metadata],
                symbols: [...b.symbols],
                deletedRelativePaths: [...b.deletedRelativePaths],
            });
        },
        getAllFileMetadata: () => state.fileMetadata,
        checkpoint: () => { state.checkpoints += 1; },
    };
}

suite('syncOrchestrator', () => {
    test('applies deletions and worker parse results via db.writeBatch', async () => {
        const db = makeDb();

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
            db,
        });

        await orchestrator.synchronize({ workspaceRoot: '/workspace' });
        // First batch must carry BOTH deletions and metadata/symbols
        assert.strictEqual(db.writes.length, 1, 'expected a single writeBatch combining deletions + parse');
        assert.deepStrictEqual(db.writes[0].deletedRelativePaths, ['old.c']);
        assert.strictEqual(db.writes[0].metadata.length, 1);
        assert.strictEqual(db.writes[0].metadata[0].relativePath, 'a.c');
        assert.strictEqual(db.writes[0].symbols.length, 1);
        assert.strictEqual(db.checkpoints, 1, 'checkpoint must fire exactly once when anything changed');
    });

    test('skips workerPool.parse when toProcess is empty', async () => {
        let parseCalled = false;
        const db = makeDb();

        const orchestrator = new SyncOrchestrator({
            scanFiles: async () => [],
            classify: async () => ({ toProcess: [], toDelete: [] }),
            workerPool: {
                parse: async () => { parseCalled = true; },
            },
            db,
        });

        await orchestrator.synchronize({ workspaceRoot: '/workspace' });
        assert.strictEqual(parseCalled, false);
    });

    test('emits delete-only writeBatch when toDelete non-empty but toProcess empty', async () => {
        const db = makeDb();

        const orchestrator = new SyncOrchestrator({
            scanFiles: async () => [],
            classify: async () => ({ toProcess: [], toDelete: ['gone.c', 'also-gone.c'] }),
            workerPool: { parse: async () => {} },
            db,
        });

        await orchestrator.synchronize({ workspaceRoot: '/ws' });
        assert.strictEqual(db.writes.length, 1);
        assert.deepStrictEqual(db.writes[0].deletedRelativePaths.sort(), ['also-gone.c', 'gone.c']);
        assert.strictEqual(db.writes[0].metadata.length, 0);
        assert.strictEqual(db.writes[0].symbols.length, 0);
        assert.strictEqual(db.checkpoints, 1);
    });

    test('does not call writeBatch or checkpoint when nothing changed', async () => {
        const db = makeDb();

        const orchestrator = new SyncOrchestrator({
            scanFiles: async () => [],
            classify: async () => ({ toProcess: [], toDelete: [] }),
            workerPool: { parse: async () => {} },
            db,
        });

        await orchestrator.synchronize({ workspaceRoot: '/ws' });
        assert.strictEqual(db.writes.length, 0);
        assert.strictEqual(db.checkpoints, 0);
    });

    test('reads previousFiles from db.getAllFileMetadata and passes to classify', async () => {
        const previous = new Map<string, IndexedFile>([
            ['old.c', { relativePath: 'old.c', mtime: 5, size: 50, symbolCount: 3 }],
        ]);
        const db = makeDb(previous);
        let seenPrevious: Map<string, IndexedFile> | undefined;

        const orchestrator = new SyncOrchestrator({
            scanFiles: async () => [],
            classify: async (input) => { seenPrevious = input.previousFiles; return { toProcess: [], toDelete: [] }; },
            workerPool: { parse: async () => {} },
            db,
        });

        await orchestrator.synchronize({ workspaceRoot: '/ws' });
        assert.strictEqual(seenPrevious, previous, 'previousFiles must come from db.getAllFileMetadata()');
    });

    test('forwards workerPool onBatchComplete as parsing progress (regression: status bar stuck at 0/N)', async () => {
        const progressEvents: Array<{ phase: string; current: number; total: number; currentFile?: string }> = [];
        const db = makeDb();

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
            db,
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
});

suite('SyncOrchestrator streaming', () => {
    function makeDeps(overrides: any = {}): any {
        const db = makeDb();
        return {
            scanFiles: async () => [
                { relativePath: 'a.c', absPath: '/w/a.c', mtime: 1, size: 1 },
                { relativePath: 'b.c', absPath: '/w/b.c', mtime: 2, size: 2 },
            ],
            classify: async (x: any) => ({
                toProcess: x.currentFiles,
                toDelete: [],
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
            db,
            ...overrides,
        };
    }

    test('writeBatch is called once per worker batch (streaming)', async () => {
        const deps = makeDeps();
        const orch = new SyncOrchestrator(deps);
        await orch.synchronize({ workspaceRoot: '/w' });
        // One writeBatch per file since the mock emits one batch per file
        assert.strictEqual(deps.db.writes.length, 2);
        const relPaths = deps.db.writes
            .flatMap((w: WriteBatch) => w.metadata.map(m => m.relativePath))
            .sort();
        assert.deepStrictEqual(relPaths, ['a.c', 'b.c']);
    });

    test('each writeBatch carries both metadata and symbols for its batch', async () => {
        const deps = makeDeps();
        const orch = new SyncOrchestrator(deps);
        await orch.synchronize({ workspaceRoot: '/w' });
        for (const w of deps.db.writes as WriteBatch[]) {
            assert.strictEqual(w.metadata.length, 1);
            assert.strictEqual(w.symbols.length, 1);
        }
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

    test('checkpoint fires exactly once at end when writes happened', async () => {
        const deps = makeDeps();
        const orch = new SyncOrchestrator(deps);
        await orch.synchronize({ workspaceRoot: '/w' });
        assert.strictEqual(deps.db.checkpoints, 1);
    });

    test('first batch carries all pending deletes; subsequent batches carry none', async () => {
        // Two files → two worker batches. Deletions must all ride on the FIRST batch.
        const deps = makeDeps({
            classify: async (x: any) => ({
                toProcess: x.currentFiles,
                toDelete: ['old-1.c', 'old-2.c'],
            }),
        });
        const orch = new SyncOrchestrator(deps);
        await orch.synchronize({ workspaceRoot: '/w' });
        assert.strictEqual(deps.db.writes.length, 2);
        assert.deepStrictEqual(
            (deps.db.writes[0] as WriteBatch).deletedRelativePaths.sort(),
            ['old-1.c', 'old-2.c'],
        );
        assert.deepStrictEqual((deps.db.writes[1] as WriteBatch).deletedRelativePaths, []);
    });
});
