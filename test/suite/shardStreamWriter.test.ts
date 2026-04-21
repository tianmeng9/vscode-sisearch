import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ShardStreamWriter } from '../../src/storage/shardStreamWriter';

function mkTmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'shardwriter-'));
}

suite('ShardStreamWriter', () => {
    test('add below threshold does not write to disk', () => {
        const dir = mkTmpDir();
        const writer = new ShardStreamWriter({ shardsDir: dir, shardCount: 2, chunkThreshold: 10 });
        writer.add(0, { relativePath: 'a.c', symbols: [], metadata: { relativePath: 'a.c', mtime: 1, size: 1, symbolCount: 0 } });
        assert.strictEqual(fs.readdirSync(dir).length, 0);
        writer.close();
    });
});
