import * as assert from 'assert';
import { WorkerPool } from '../../src/sync/workerPool';
import type { PoolWorker, ParseBatchResult } from '../../src/sync/workerPool';

function makeStubWorker(): PoolWorker {
    return {
        parseBatch: async (files) => ({
            symbols: files.map(f => ({
                name: f.relativePath,
                kind: 'function' as const,
                filePath: f.absPath,
                relativePath: f.relativePath,
                lineNumber: 1,
                endLineNumber: 1,
                column: 0,
                lineContent: f.relativePath,
            })),
            metadata: files.map(f => ({
                relativePath: f.relativePath,
                mtime: 1,
                size: 1,
                symbolCount: 1,
            })),
            errors: [],
        }),
        dispose: async () => {},
    };
}

suite('workerPool', () => {
    test('invokes onBatchResult once per batch', async () => {
        const pool = new WorkerPool({
            size: 1,
            workerFactory: async () => makeStubWorker(),
            batchSize: 2,
        });
        const files = [
            { absPath: '/w/a.c', relativePath: 'a.c' },
            { absPath: '/w/b.c', relativePath: 'b.c' },
            { absPath: '/w/c.c', relativePath: 'c.c' },
        ];
        const batches: ParseBatchResult[] = [];
        await pool.parse(files, async (r) => { batches.push(r); });
        assert.strictEqual(batches.length, 2, 'ceil(3/2) = 2 batches');
        assert.strictEqual(batches[0].symbols.length, 2);
        assert.strictEqual(batches[1].symbols.length, 1);
        await pool.dispose();
    });

    test('empty file list does not invoke callback', async () => {
        const pool = new WorkerPool({
            size: 1,
            workerFactory: async () => makeStubWorker(),
        });
        let called = 0;
        await pool.parse([], async () => { called++; });
        assert.strictEqual(called, 0);
        await pool.dispose();
    });

    test('pending callback throttles cursor (back-pressure)', async () => {
        const pool = new WorkerPool({
            size: 1,
            workerFactory: async () => makeStubWorker(),
            batchSize: 1,
        });
        const files = [
            { absPath: '/w/a.c', relativePath: 'a.c' },
            { absPath: '/w/b.c', relativePath: 'b.c' },
        ];
        let released!: () => void;
        const gate = new Promise<void>(res => { released = res; });
        let observedBatches = 0;
        const parsePromise = pool.parse(files, async () => {
            observedBatches++;
            if (observedBatches === 1) { await gate; }
        });
        await new Promise(res => setImmediate(res));
        await new Promise(res => setImmediate(res));
        assert.strictEqual(observedBatches, 1, 'second batch must wait on first callback');
        released();
        await parsePromise;
        assert.strictEqual(observedBatches, 2);
        await pool.dispose();
    });

    test('callback throwing rejects parse', async () => {
        const pool = new WorkerPool({
            size: 1,
            workerFactory: async () => makeStubWorker(),
        });
        const files = [{ absPath: '/w/a.c', relativePath: 'a.c' }];
        await assert.rejects(
            () => pool.parse(files, async () => { throw new Error('boom'); }),
            /boom/,
        );
        await pool.dispose();
    });

    test('worker errors surface in callback result.errors', async () => {
        const pool = new WorkerPool({
            size: 1,
            workerFactory: async () => ({
                parseBatch: async () => ({ symbols: [], metadata: [], errors: ['a.c: parse error'] }),
                dispose: async () => {},
            }),
        });
        const files = [{ absPath: '/w/a.c', relativePath: 'a.c' }];
        const seen: ParseBatchResult[] = [];
        await pool.parse(files, async (r) => { seen.push(r); });
        assert.deepStrictEqual(seen[0].errors, ['a.c: parse error']);
        await pool.dispose();
    });

    test('cancellation token stops parse mid-stream', async () => {
        // Regression: cancel during a long sync left orchestrator blocked on
        // workerPool.parse(), so the UI "cancel" button did not actually stop work.
        // After fix: token.isCancellationRequested causes workerLoop to exit
        // promptly, and parse() resolves without processing remaining files.
        const cancelAfter = 2;
        const pool = new WorkerPool({
            size: 1,
            workerFactory: async () => makeStubWorker(),
            batchSize: 1,
        });
        const files = Array.from({ length: 10 }, (_, i) => ({
            absPath: `/w/f${i}.c`, relativePath: `f${i}.c`,
        }));

        const token = { isCancellationRequested: false };
        let seenBatches = 0;
        await pool.parse(
            files,
            async () => {
                seenBatches++;
                if (seenBatches >= cancelAfter) { token.isCancellationRequested = true; }
            },
            undefined,
            token,
        );
        assert.ok(
            seenBatches <= cancelAfter + 1,
            `expected parse to stop shortly after cancel (saw ${seenBatches} batches of ${files.length})`,
        );
        assert.ok(seenBatches < files.length, 'parse must not process all files after cancel');
        await pool.dispose();
    });

    test('pre-cancelled token skips parse entirely', async () => {
        const pool = new WorkerPool({
            size: 2,
            workerFactory: async () => makeStubWorker(),
            batchSize: 1,
        });
        const files = [
            { absPath: '/w/a.c', relativePath: 'a.c' },
            { absPath: '/w/b.c', relativePath: 'b.c' },
        ];
        let seen = 0;
        await pool.parse(
            files,
            async () => { seen++; },
            undefined,
            { isCancellationRequested: true },
        );
        assert.strictEqual(seen, 0, 'no batches should be processed when token is already cancelled');
        await pool.dispose();
    });
});
