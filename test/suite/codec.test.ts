import * as assert from 'assert';
import { encodeMessagePack, decodeMessagePack, decodeMessagePackMulti } from '../../src/storage/codec';
import { shardForPath, fnv1a, shardFileName } from '../../src/storage/shardStrategy';

suite('storage codec', () => {
    test('encodes and decodes symbol snapshot', () => {
        const input = {
            version: 2,
            files: [{ relativePath: 'a.c', mtime: 1, size: 2, symbolCount: 3 }],
        };
        const encoded = encodeMessagePack(input);
        const decoded = decodeMessagePack<typeof input>(encoded);

        assert.deepStrictEqual(decoded, input);
    });

    test('encodes and decodes array of symbol entries', () => {
        const symbols = [
            { name: 'foo', kind: 'function', filePath: '/workspace/a.c', relativePath: 'a.c', lineNumber: 1, endLineNumber: 1, column: 0, lineContent: 'foo();' },
        ];
        const encoded = encodeMessagePack(symbols);
        const decoded = decodeMessagePack<typeof symbols>(encoded);
        assert.deepStrictEqual(decoded, symbols);
    });

    test('shardForPath is stable (same input → same output)', () => {
        assert.strictEqual(shardForPath('src/a.c', 16), shardForPath('src/a.c', 16));
    });

    test('shardForPath distributes across range', () => {
        const shardCount = 16;
        const shard = shardForPath('src/a.c', shardCount);
        assert.ok(shard >= 0 && shard < shardCount, `shard ${shard} out of range [0, ${shardCount})`);
    });

    test('fnv1a produces consistent hash', () => {
        assert.strictEqual(fnv1a('hello'), fnv1a('hello'));
        assert.notStrictEqual(fnv1a('hello'), fnv1a('world'));
    });

    test('shardFileName formats correctly', () => {
        assert.strictEqual(shardFileName(0), '00.msgpack');
        assert.strictEqual(shardFileName(15), '0f.msgpack');
        assert.strictEqual(shardFileName(255), 'ff.msgpack');
    });
});

suite('decodeMessagePackMulti', () => {
    test('decodes single top-level value (legacy single-array file)', () => {
        const buf = encodeMessagePack([{ a: 1 }, { a: 2 }]);
        const out = [...decodeMessagePackMulti(Buffer.from(buf))];
        assert.strictEqual(out.length, 1);
        assert.deepStrictEqual(out[0], [{ a: 1 }, { a: 2 }]);
    });

    test('decodes concatenated chunks', () => {
        const c1 = encodeMessagePack([{ a: 1 }]);
        const c2 = encodeMessagePack([{ a: 2 }, { a: 3 }]);
        const buf = Buffer.concat([Buffer.from(c1), Buffer.from(c2)]);
        const out = [...decodeMessagePackMulti(buf)];
        assert.strictEqual(out.length, 2);
        assert.deepStrictEqual(out[0], [{ a: 1 }]);
        assert.deepStrictEqual(out[1], [{ a: 2 }, { a: 3 }]);
    });

    test('empty buffer yields nothing', () => {
        const out = [...decodeMessagePackMulti(Buffer.alloc(0))];
        assert.strictEqual(out.length, 0);
    });
});
