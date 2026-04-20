import * as assert from 'assert';
import { classifyBatches } from '../../src/sync/batchClassifier';

suite('batchClassifier', () => {
    test('classifies new changed and deleted files', async () => {
        const result = await classifyBatches({
            workspaceRoot: '/workspace',
            currentFiles: [
                { relativePath: 'a.c', absPath: '/workspace/a.c', mtime: 10, size: 100 },
                { relativePath: 'b.c', absPath: '/workspace/b.c', mtime: 20, size: 200 },
            ],
            previousFiles: new Map([
                ['b.c', { relativePath: 'b.c', mtime: 15, size: 200, symbolCount: 1 }],
                ['old.c', { relativePath: 'old.c', mtime: 5, size: 10, symbolCount: 1 }],
            ]),
        });

        assert.deepStrictEqual(result.toDelete, ['old.c']);
        assert.deepStrictEqual(result.toProcess.map(f => f.relativePath), ['a.c', 'b.c']);
    });

    test('unchanged files are not included in toProcess', async () => {
        const result = await classifyBatches({
            workspaceRoot: '/workspace',
            currentFiles: [
                { relativePath: 'a.c', absPath: '/workspace/a.c', mtime: 10, size: 100 },
            ],
            previousFiles: new Map([
                ['a.c', { relativePath: 'a.c', mtime: 10, size: 100, symbolCount: 5 }],
            ]),
        });

        assert.deepStrictEqual(result.toProcess, []);
        assert.deepStrictEqual(result.toDelete, []);
    });

    test('size change marks file for reprocess', async () => {
        const result = await classifyBatches({
            workspaceRoot: '/workspace',
            currentFiles: [
                { relativePath: 'a.c', absPath: '/workspace/a.c', mtime: 10, size: 999 },
            ],
            previousFiles: new Map([
                ['a.c', { relativePath: 'a.c', mtime: 10, size: 100, symbolCount: 5 }],
            ]),
        });

        assert.strictEqual(result.toProcess.length, 1);
        assert.strictEqual(result.toProcess[0].relativePath, 'a.c');
    });
});
