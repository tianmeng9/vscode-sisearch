import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { StorageManager } from '../../src/storage/storageManager';

suite('storageManager', () => {
    test('saveFull writes shards and load rebuilds snapshot', async () => {
        const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sisearch-'));
        const manager = new StorageManager({ workspaceRoot, shardCount: 4 });

        await manager.saveFull({
            symbolsByFile: new Map([
                ['a.c', [{
                    name: 'foo', kind: 'function', filePath: '/workspace/a.c',
                    relativePath: 'a.c', lineNumber: 1, endLineNumber: 1, column: 0, lineContent: 'foo();',
                }]],
            ]),
            fileMetadata: new Map([
                ['a.c', { relativePath: 'a.c', mtime: 1, size: 10, symbolCount: 1 }],
            ]),
        });

        const loaded = await manager.load();
        assert.strictEqual(loaded.symbolsByFile.get('a.c')?.length, 1);
        assert.strictEqual(loaded.symbolsByFile.get('a.c')?.[0]?.name, 'foo');
        assert.strictEqual(loaded.fileMetadata.get('a.c')?.symbolCount, 1);

        // Cleanup
        fs.rmSync(workspaceRoot, { recursive: true });
    });

    test('load returns empty when no index directory exists', async () => {
        const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sisearch-'));
        const manager = new StorageManager({ workspaceRoot, shardCount: 4 });

        const loaded = await manager.load();
        assert.deepStrictEqual([...loaded.symbolsByFile.entries()], []);
        assert.deepStrictEqual([...loaded.fileMetadata.entries()], []);

        fs.rmSync(workspaceRoot, { recursive: true });
    });

    test('migrates legacy JSON index to sharded format', async () => {
        const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sisearch-'));
        const sisearchDir = path.join(workspaceRoot, '.sisearch');
        fs.mkdirSync(sisearchDir, { recursive: true });

        // Write legacy JSON format
        const legacyData = {
            version: 1,
            symbols: {
                'b.c': [{ name: 'bar', kind: 'function', filePath: '/workspace/b.c', relativePath: 'b.c', lineNumber: 2, endLineNumber: 2, column: 0, lineContent: 'bar();' }],
            },
            files: {
                'b.c': { relativePath: 'b.c', mtime: 5, size: 50, symbolCount: 1 },
            },
        };
        fs.writeFileSync(path.join(sisearchDir, 'index.json'), JSON.stringify(legacyData));

        const manager = new StorageManager({ workspaceRoot, shardCount: 4 });
        const loaded = await manager.load();

        assert.strictEqual(loaded.symbolsByFile.get('b.c')?.length, 1);
        assert.strictEqual(loaded.fileMetadata.get('b.c')?.symbolCount, 1);
        // Legacy file should be removed after migration
        assert.ok(!fs.existsSync(path.join(sisearchDir, 'index.json')), 'legacy index.json should be removed after migration');

        fs.rmSync(workspaceRoot, { recursive: true });
    });

    test('saveFull with multiple files distributes across shards correctly', async () => {
        const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sisearch-'));
        const manager = new StorageManager({ workspaceRoot, shardCount: 4 });

        const symbolsByFile = new Map<string, any[]>();
        const fileMetadata = new Map<string, any>();
        for (let i = 0; i < 8; i++) {
            const rel = `file${i}.c`;
            symbolsByFile.set(rel, [{ name: `fn${i}`, kind: 'function', filePath: `/ws/${rel}`, relativePath: rel, lineNumber: 1, endLineNumber: 1, column: 0, lineContent: '' }]);
            fileMetadata.set(rel, { relativePath: rel, mtime: i, size: i * 10, symbolCount: 1 });
        }

        await manager.saveFull({ symbolsByFile, fileMetadata });
        const loaded = await manager.load();

        assert.strictEqual(loaded.symbolsByFile.size, 8);
        assert.strictEqual(loaded.fileMetadata.size, 8);

        fs.rmSync(workspaceRoot, { recursive: true });
    });
});
