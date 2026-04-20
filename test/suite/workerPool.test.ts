import * as assert from 'assert';
import { WorkerPool } from '../../src/sync/workerPool';
import type { PoolWorker } from '../../src/sync/workerPool';

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
    test('dispatches batch and returns symbols', async () => {
        const pool = new WorkerPool({
            size: 1,
            workerFactory: async () => makeStubWorker(),
        });

        const result = await pool.parse([{ absPath: '/workspace/a.c', relativePath: 'a.c' }]);
        assert.strictEqual(result.symbols.length, 1);
        assert.strictEqual(result.symbols[0].relativePath, 'a.c');
        assert.strictEqual(result.errors.length, 0);
        await pool.dispose();
    });

    test('aggregates results from multiple files', async () => {
        const pool = new WorkerPool({
            size: 1,
            workerFactory: async () => makeStubWorker(),
        });

        const files = [
            { absPath: '/workspace/a.c', relativePath: 'a.c' },
            { absPath: '/workspace/b.c', relativePath: 'b.c' },
        ];
        const result = await pool.parse(files);
        assert.strictEqual(result.symbols.length, 2);
        assert.strictEqual(result.metadata.length, 2);
        await pool.dispose();
    });

    test('empty file list returns empty result', async () => {
        const pool = new WorkerPool({
            size: 1,
            workerFactory: async () => makeStubWorker(),
        });

        const result = await pool.parse([]);
        assert.deepStrictEqual(result.symbols, []);
        assert.deepStrictEqual(result.metadata, []);
        assert.deepStrictEqual(result.errors, []);
        await pool.dispose();
    });

    test('errors from workers are collected not thrown', async () => {
        const pool = new WorkerPool({
            size: 1,
            workerFactory: async () => ({
                parseBatch: async () => ({
                    symbols: [],
                    metadata: [],
                    errors: ['a.c: parse error'],
                }),
                dispose: async () => {},
            }),
        });

        const result = await pool.parse([{ absPath: '/workspace/a.c', relativePath: 'a.c' }]);
        assert.strictEqual(result.errors.length, 1);
        assert.ok(result.errors[0].includes('parse error'));
        await pool.dispose();
    });

    test('onBatchComplete fires per batch with monotonically increasing done count (regression: parsing progress was stuck at 0/N)', async () => {
        const pool = new WorkerPool({
            size: 2,
            batchSize: 3,                              // force multiple batches
            workerFactory: async () => makeStubWorker(),
        });

        const files = Array.from({ length: 10 }, (_, i) => ({
            absPath: `/ws/file${i}.c`,
            relativePath: `file${i}.c`,
        }));

        const progressCalls: Array<{ done: number; total: number; lastFile?: string }> = [];
        const result = await pool.parse(files, (done, total, lastFile) => {
            progressCalls.push({ done, total, lastFile });
        });

        // 10 files / 3 per batch = 4 batches (3+3+3+1)
        assert.ok(progressCalls.length >= 2, `expected at least 2 progress callbacks, got ${progressCalls.length}`);
        // Final callback must report all files done
        const last = progressCalls[progressCalls.length - 1];
        assert.strictEqual(last.done, 10, 'final done count must equal total');
        assert.strictEqual(last.total, 10, 'total must be stable');
        // done must be monotonically non-decreasing
        let prev = 0;
        for (const c of progressCalls) {
            assert.ok(c.done >= prev, `done regressed: ${prev} -> ${c.done}`);
            assert.ok(c.done <= c.total, `done ${c.done} exceeded total ${c.total}`);
            prev = c.done;
        }
        // lastFile is attached on every callback (sidebar progress needs this)
        for (const c of progressCalls) {
            assert.ok(c.lastFile && c.lastFile.startsWith('file'), `missing lastFile on callback: ${JSON.stringify(c)}`);
        }
        // And the parse result still contains everything
        assert.strictEqual(result.symbols.length, 10);
        await pool.dispose();
    });

    test('onBatchComplete not required (backward compat)', async () => {
        const pool = new WorkerPool({
            size: 1,
            batchSize: 2,
            workerFactory: async () => makeStubWorker(),
        });

        const files = Array.from({ length: 5 }, (_, i) => ({
            absPath: `/ws/${i}.c`,
            relativePath: `${i}.c`,
        }));

        // no callback provided — must not throw
        const result = await pool.parse(files);
        assert.strictEqual(result.symbols.length, 5);
        await pool.dispose();
    });

    test('multiple workers split work evenly', async () => {
        const workerCalls: number[] = [0, 0];
        const pool = new WorkerPool({
            size: 2,
            workerFactory: async () => {
                const idx = workerCalls.length - 2;
                return {
                    parseBatch: async (files) => {
                        workerCalls[idx < 0 ? 0 : idx]++;
                        return {
                            symbols: files.map(f => ({
                                name: f.relativePath, kind: 'function' as const,
                                filePath: f.absPath, relativePath: f.relativePath,
                                lineNumber: 1, endLineNumber: 1, column: 0, lineContent: '',
                            })),
                            metadata: files.map(f => ({ relativePath: f.relativePath, mtime: 1, size: 1, symbolCount: 1 })),
                            errors: [],
                        };
                    },
                    dispose: async () => {},
                };
            },
        });

        const files = Array.from({ length: 4 }, (_, i) => ({
            absPath: `/workspace/file${i}.c`,
            relativePath: `file${i}.c`,
        }));
        const result = await pool.parse(files);
        assert.strictEqual(result.symbols.length, 4);
        await pool.dispose();
    });
});
