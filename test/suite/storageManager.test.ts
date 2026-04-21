import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { StorageManager } from '../../src/storage/storageManager';
import { encodeMessagePack } from '../../src/storage/codec';
import { shardFileName } from '../../src/storage/shardStrategy';
import { ShardStreamWriter } from '../../src/storage/shardStreamWriter';

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

    test('saveDirty only rewrites shards that contain dirty paths', async () => {
        const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sisearch-'));
        const manager = new StorageManager({ workspaceRoot, shardCount: 4 });
        const { shardForPath, shardFileName } = require('../../src/storage/shardStrategy');

        // Seed full snapshot
        const symbolsByFile = new Map<string, any[]>();
        const fileMetadata = new Map<string, any>();
        for (let i = 0; i < 12; i++) {
            const rel = `file${i}.c`;
            symbolsByFile.set(rel, [{ name: `fn${i}`, kind: 'function', filePath: `/ws/${rel}`, relativePath: rel, lineNumber: 1, endLineNumber: 1, column: 0, lineContent: '' }]);
            fileMetadata.set(rel, { relativePath: rel, mtime: i, size: i * 10, symbolCount: 1 });
        }
        await manager.saveFull({ symbolsByFile, fileMetadata });

        // Capture original mtimes of every shard
        const shardsDir = path.join(workspaceRoot, '.sisearch', 'shards');
        const originalMtimes = new Map<number, number>();
        for (let i = 0; i < 4; i++) {
            originalMtimes.set(i, fs.statSync(path.join(shardsDir, shardFileName(i))).mtimeMs);
        }

        // Modify exactly one file: mutate symbols + metadata for file0.c
        const dirtyPath = 'file0.c';
        symbolsByFile.set(dirtyPath, [{ name: 'updated', kind: 'function', filePath: `/ws/${dirtyPath}`, relativePath: dirtyPath, lineNumber: 99, endLineNumber: 99, column: 0, lineContent: 'updated;' }]);
        fileMetadata.set(dirtyPath, { relativePath: dirtyPath, mtime: 999, size: 999, symbolCount: 1 });

        // Delay to ensure mtime granularity
        await new Promise(r => setTimeout(r, 30));

        await manager.saveDirty({ symbolsByFile, fileMetadata }, new Set([dirtyPath]));

        const expectedDirtyShard = shardForPath(dirtyPath, 4);
        for (let i = 0; i < 4; i++) {
            const current = fs.statSync(path.join(shardsDir, shardFileName(i))).mtimeMs;
            const original = originalMtimes.get(i)!;
            if (i === expectedDirtyShard) {
                assert.ok(current > original, `dirty shard ${i} should be rewritten`);
            } else {
                assert.strictEqual(current, original, `clean shard ${i} must not be rewritten`);
            }
        }

        // Verify data round-trip
        const reloaded = await manager.load();
        assert.strictEqual(reloaded.symbolsByFile.get(dirtyPath)?.[0]?.name, 'updated');
        assert.strictEqual(reloaded.fileMetadata.get(dirtyPath)?.mtime, 999);

        fs.rmSync(workspaceRoot, { recursive: true });
    });

    test('saveDirty handles deleted files by writing shard without them', async () => {
        const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sisearch-'));
        const manager = new StorageManager({ workspaceRoot, shardCount: 4 });

        const symbolsByFile = new Map<string, any[]>();
        const fileMetadata = new Map<string, any>();
        for (let i = 0; i < 6; i++) {
            const rel = `f${i}.c`;
            symbolsByFile.set(rel, [{ name: `fn${i}`, kind: 'function', filePath: `/ws/${rel}`, relativePath: rel, lineNumber: 1, endLineNumber: 1, column: 0, lineContent: '' }]);
            fileMetadata.set(rel, { relativePath: rel, mtime: i, size: i * 10, symbolCount: 1 });
        }
        await manager.saveFull({ symbolsByFile, fileMetadata });

        // Delete f0.c from the snapshot and flag it as dirty
        symbolsByFile.delete('f0.c');
        fileMetadata.delete('f0.c');
        await manager.saveDirty({ symbolsByFile, fileMetadata }, new Set(['f0.c']));

        const reloaded = await manager.load();
        assert.strictEqual(reloaded.symbolsByFile.has('f0.c'), false);
        assert.strictEqual(reloaded.fileMetadata.has('f0.c'), false);
        assert.strictEqual(reloaded.symbolsByFile.size, 5);

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

suite('StorageManager.load chunked format', () => {
    function setupRoot(): string {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smload-'));
        fs.mkdirSync(path.join(root, '.sisearch', 'shards'), { recursive: true });
        return root;
    }

    test('reads legacy single-array shard file', async () => {
        const root = setupRoot();
        const shardFile = path.join(root, '.sisearch', 'shards', shardFileName(0));
        const legacy = [{ relativePath: 'a.c', symbols: [], metadata: { relativePath: 'a.c', mtime: 1, size: 1, symbolCount: 0 } }];
        fs.writeFileSync(shardFile, Buffer.from(encodeMessagePack(legacy)));

        const mgr = new StorageManager({ workspaceRoot: root, shardCount: 16 });
        const snap = await mgr.load();
        assert.strictEqual(snap.fileMetadata.has('a.c'), true);
    });

    test('reads multi-chunk shard file', async () => {
        const root = setupRoot();
        const shardFile = path.join(root, '.sisearch', 'shards', shardFileName(0));
        const c1 = encodeMessagePack([{ relativePath: 'a.c', symbols: [], metadata: { relativePath: 'a.c', mtime: 1, size: 1, symbolCount: 0 } }]);
        const c2 = encodeMessagePack([{ relativePath: 'b.c', symbols: [], metadata: { relativePath: 'b.c', mtime: 2, size: 2, symbolCount: 0 } }]);
        fs.writeFileSync(shardFile, Buffer.concat([Buffer.from(c1), Buffer.from(c2)]));

        const mgr = new StorageManager({ workspaceRoot: root, shardCount: 16 });
        const snap = await mgr.load();
        assert.strictEqual(snap.fileMetadata.has('a.c'), true);
        assert.strictEqual(snap.fileMetadata.has('b.c'), true);
    });

    test('truncated final chunk: keep whole chunks, drop tail, no throw', async () => {
        const root = setupRoot();
        const shardFile = path.join(root, '.sisearch', 'shards', shardFileName(0));
        const c1 = encodeMessagePack([{ relativePath: 'a.c', symbols: [], metadata: { relativePath: 'a.c', mtime: 1, size: 1, symbolCount: 0 } }]);
        const c2 = encodeMessagePack([{ relativePath: 'b.c', symbols: [], metadata: { relativePath: 'b.c', mtime: 2, size: 2, symbolCount: 0 } }]);
        const truncated = Buffer.concat([Buffer.from(c1), Buffer.from(c2).subarray(0, 3)]);
        fs.writeFileSync(shardFile, truncated);

        const mgr = new StorageManager({ workspaceRoot: root, shardCount: 16 });
        const snap = await mgr.load();
        assert.strictEqual(snap.fileMetadata.has('a.c'), true, 'first whole chunk survives');
        assert.strictEqual(snap.fileMetadata.has('b.c'), false, 'truncated tail dropped');
    });

    test('fully corrupt shard: empty result, no throw', async () => {
        const root = setupRoot();
        const shardFile = path.join(root, '.sisearch', 'shards', shardFileName(0));
        fs.writeFileSync(shardFile, Buffer.from([0xff, 0xff, 0xff, 0xff]));

        const mgr = new StorageManager({ workspaceRoot: root, shardCount: 16 });
        const snap = await mgr.load();
        assert.strictEqual(snap.fileMetadata.size, 0);
    });
});

suite('StorageManager.openStreamWriter', () => {
    test('returns writer writing into .sisearch/shards with matching shardCount', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smwriter-'));
        const mgr = new StorageManager({ workspaceRoot: root, shardCount: 4, chunkThreshold: 1 });
        const writer = mgr.openStreamWriter();
        assert.ok(writer instanceof ShardStreamWriter);

        writer.add(2, { relativePath: 'x.c', symbols: [], metadata: { relativePath: 'x.c', mtime: 1, size: 1, symbolCount: 0 } });
        writer.flushAll();
        writer.close();

        assert.deepStrictEqual(fs.readdirSync(path.join(root, '.sisearch', 'shards')), ['02.msgpack']);
    });
});
