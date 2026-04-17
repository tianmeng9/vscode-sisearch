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
});
