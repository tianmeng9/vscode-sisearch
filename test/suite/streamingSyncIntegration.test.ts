import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { StorageManager } from '../../src/storage/storageManager';
import { ShardStreamWriter } from '../../src/storage/shardStreamWriter';
import { shardForPath, shardFileName } from '../../src/storage/shardStrategy';
import { decodeMessagePackMulti } from '../../src/storage/codec';

suite('streaming sync integration (synthetic)', () => {
    test('5000 synthetic files produce multi-chunk shards loadable end-to-end', async function () {
        this.timeout(10000);
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'streamsync-'));
        const shardCount = 16;
        const chunkThreshold = 64;  // small to force multi-chunk files
        const mgr = new StorageManager({ workspaceRoot: root, shardCount, chunkThreshold });

        // Build a synthetic snapshot of 5000 files and save it through the streaming write path.
        const symbolsByFile = new Map<string, any[]>();
        const fileMetadata = new Map<string, any>();
        for (let i = 0; i < 5000; i++) {
            const rel = `dir${i % 50}/file${i}.c`;
            symbolsByFile.set(rel, [{
                name: 'f' + i, kind: 'function',
                filePath: '/w/' + rel, relativePath: rel,
                lineNumber: 1, endLineNumber: 1, column: 0, lineContent: 'void f' + i + '(){}',
            }]);
            fileMetadata.set(rel, { relativePath: rel, mtime: 1, size: 1, symbolCount: 1 });
        }

        await mgr.saveFull({ symbolsByFile, fileMetadata });

        // Assert: at least one shard file contains > 1 msgpack chunk
        const shardsDir = path.join(root, '.sisearch', 'shards');
        let multiChunkShardFound = false;
        for (let i = 0; i < shardCount; i++) {
            const p = path.join(shardsDir, shardFileName(i));
            if (!fs.existsSync(p)) { continue; }
            const buf = fs.readFileSync(p);
            let chunks = 0;
            for (const _c of decodeMessagePackMulti(buf)) { chunks++; }
            if (chunks > 1) { multiChunkShardFound = true; break; }
        }
        assert.strictEqual(multiChunkShardFound, true, 'at least one shard must be multi-chunk under chunkThreshold=64');

        // Assert: round-trip via load() restores all 5000 entries
        const back = await mgr.load();
        assert.strictEqual(back.fileMetadata.size, 5000);
        assert.strictEqual(back.symbolsByFile.size, 5000);
    });

    test('direct ShardStreamWriter: rapid appends do not leave empty files', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'streamsync-'));
        const shardsDir = path.join(root, 'shards');
        fs.mkdirSync(shardsDir, { recursive: true });
        const writer = new ShardStreamWriter({ shardsDir, shardCount: 16, chunkThreshold: 1 });

        for (let i = 0; i < 100; i++) {
            const rel = `f${i}.c`;
            const shard = shardForPath(rel, 16);
            writer.add(shard, { relativePath: rel, symbols: [], metadata: { relativePath: rel, mtime: 1, size: 1, symbolCount: 0 } });
        }
        writer.flushAll();
        writer.close();

        for (const name of fs.readdirSync(shardsDir)) {
            const stat = fs.statSync(path.join(shardsDir, name));
            assert.ok(stat.size > 0, `${name} must not be empty`);
        }
    });
});
