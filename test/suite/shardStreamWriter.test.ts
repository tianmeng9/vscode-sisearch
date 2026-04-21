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

    test('add reaching threshold appends msgpack chunk once', () => {
        const dir = mkTmpDir();
        const writer = new ShardStreamWriter({ shardsDir: dir, shardCount: 2, chunkThreshold: 2 });
        const entry = (rel: string): any => ({ relativePath: rel, symbols: [], metadata: { relativePath: rel, mtime: 1, size: 1, symbolCount: 0 } });
        writer.add(0, entry('a.c'));
        assert.strictEqual(fs.readdirSync(dir).length, 0, 'no flush before threshold');
        writer.add(0, entry('b.c'));
        const files = fs.readdirSync(dir);
        assert.deepStrictEqual(files, ['00.msgpack']);
        const bytes = fs.readFileSync(path.join(dir, '00.msgpack'));
        assert.ok(bytes.length > 0);
        writer.close();
    });

    test('different shards accumulate independently', () => {
        const dir = mkTmpDir();
        const writer = new ShardStreamWriter({ shardsDir: dir, shardCount: 2, chunkThreshold: 1 });
        const entry = (rel: string): any => ({ relativePath: rel, symbols: [], metadata: { relativePath: rel, mtime: 1, size: 1, symbolCount: 0 } });
        writer.add(0, entry('a.c'));
        writer.add(1, entry('b.c'));
        assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['00.msgpack', '01.msgpack']);
        writer.close();
    });

    test('flushAll drains all non-empty buckets exactly once', () => {
        const dir = mkTmpDir();
        const writer = new ShardStreamWriter({ shardsDir: dir, shardCount: 2, chunkThreshold: 10 });
        const entry = (rel: string): any => ({ relativePath: rel, symbols: [], metadata: { relativePath: rel, mtime: 1, size: 1, symbolCount: 0 } });
        writer.add(0, entry('a.c'));
        writer.add(1, entry('b.c'));
        writer.flushAll();
        assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['00.msgpack', '01.msgpack']);
        const sizeBefore = fs.statSync(path.join(dir, '00.msgpack')).size;
        writer.flushAll();  // second call: buckets empty, no-op
        const sizeAfter = fs.statSync(path.join(dir, '00.msgpack')).size;
        assert.strictEqual(sizeAfter, sizeBefore, 'flushAll on empty buckets must not append');
        writer.close();
    });

    test('flushAll does NOT create files for empty buckets', () => {
        const dir = mkTmpDir();
        const writer = new ShardStreamWriter({ shardsDir: dir, shardCount: 4, chunkThreshold: 10 });
        const entry = (rel: string): any => ({ relativePath: rel, symbols: [], metadata: { relativePath: rel, mtime: 1, size: 1, symbolCount: 0 } });
        writer.add(2, entry('x.c'));
        writer.flushAll();
        assert.deepStrictEqual(fs.readdirSync(dir), ['02.msgpack']);
        writer.close();
    });

    test('appendFileSync failure propagates out of add', () => {
        const dir = mkTmpDir();
        const badPath = path.join(dir, 'not-a-directory');
        fs.writeFileSync(badPath, 'blocker');  // 00.msgpack would live in 'not-a-directory' subdir
        const writer = new ShardStreamWriter({ shardsDir: badPath, shardCount: 1, chunkThreshold: 1 });
        const entry: any = { relativePath: 'a.c', symbols: [], metadata: { relativePath: 'a.c', mtime: 1, size: 1, symbolCount: 0 } };
        assert.throws(() => writer.add(0, entry));
        writer.close();
    });
});
