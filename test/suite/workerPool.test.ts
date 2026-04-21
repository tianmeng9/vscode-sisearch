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

    // --- recycle: cancel 后重建 workers,避免 WASM 堆脏状态跨 sync 累积 ---
    //
    // 背景:Phase 1 已经把 symbolParser 改成 per-language 持久 Parser,
    // 正常 Sync 的 WASM 堆几乎不增长。但 Cancel 是边界场景 —— worker.parseBatch()
    // 可能已把批次发给 worker、但还没收到响应就被丢弃,worker 里的 parse() 仍在跑,
    // tree alloc 已发生却没 matched delete(因为主线程的 pending Map 被清掉了)。
    // 跨一次 cancel 留下的"僵尸分配",累积若干次后仍可能复现 exit 134。
    // recycle() 通过 terminate+重建,让 OS 回收整个 worker 线程和 WASM 堆,从零开始。
    test('recycle() replaces all workers with fresh ones from factory', async () => {
        let constructed = 0;
        const pool = new WorkerPool({
            size: 2,
            workerFactory: async () => { constructed++; return makeStubWorker(); },
        });
        // 构造立即触发 2 次 factory 调用。等工厂完成。
        await pool.parse([], async () => {});
        assert.strictEqual(constructed, 2, 'initial pool should have created 2 workers');

        await pool.recycle();

        assert.strictEqual(constructed, 4, 'recycle must construct 2 new workers (total 4)');

        // recycled pool 仍可用。
        const files = [{ absPath: '/w/a.c', relativePath: 'a.c' }];
        const batches: ParseBatchResult[] = [];
        await pool.parse(files, async (r) => { batches.push(r); });
        assert.strictEqual(batches.length, 1, 'recycled pool must be parseable');
        await pool.dispose();
    });

    test('stress: 10 consecutive recycles keep pool usable', async () => {
        // 模拟用户反复 cancel→resync 10 次。每次 recycle 后 pool 必须仍能 parse,
        // 并且 worker 构造与销毁次数守恒。
        let constructed = 0;
        let disposed = 0;
        const pool = new WorkerPool({
            size: 2,
            workerFactory: async () => {
                constructed++;
                return {
                    parseBatch: makeStubWorker().parseBatch,
                    dispose: async () => { disposed++; },
                };
            },
        });
        await pool.parse([], async () => {}); // ensure initial factory calls
        assert.strictEqual(constructed, 2);

        for (let i = 0; i < 10; i++) {
            await pool.recycle();
            // 每轮后都能正常 parse。
            const files = [{ absPath: `/w/r${i}.c`, relativePath: `r${i}.c` }];
            const batches: ParseBatchResult[] = [];
            await pool.parse(files, async (r) => { batches.push(r); });
            assert.strictEqual(batches.length, 1, `round ${i}: parse must work after recycle`);
        }

        assert.strictEqual(constructed, 2 + 10 * 2, '每次 recycle 构造 2 个新 worker');
        assert.strictEqual(disposed, 10 * 2, '每次 recycle 销毁 2 个旧 worker');

        await pool.dispose();
        assert.strictEqual(disposed, 10 * 2 + 2, 'final dispose cleans up current 2 workers');
    });

    test('recycle() disposes old workers before replacing', async () => {
        const disposed: number[] = [];
        let id = 0;
        const pool = new WorkerPool({
            size: 2,
            workerFactory: async () => {
                const myId = ++id;
                return {
                    parseBatch: makeStubWorker().parseBatch,
                    dispose: async () => { disposed.push(myId); },
                };
            },
        });
        // Ensure initial factory calls complete.
        await pool.parse([], async () => {});

        await pool.recycle();

        // 原 workers (id 1,2) 必须被 dispose。disposed.sort 避免顺序断言脆弱。
        assert.deepStrictEqual(disposed.slice().sort((a, b) => a - b), [1, 2],
            `expected both original workers disposed; got ${JSON.stringify(disposed)}`);
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
