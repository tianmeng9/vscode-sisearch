import * as assert from 'assert';
import { SymbolIndex } from '../../src/index/symbolIndex';
import type { SymbolEntry } from '../../src/index/indexTypes';

function makeSymbol(name: string, relativePath: string, lineNumber: number): SymbolEntry {
    return {
        name,
        kind: 'function',
        filePath: `/workspace/${relativePath}`,
        relativePath,
        lineNumber,
        endLineNumber: lineNumber,
        column: 0,
        lineContent: `${name}();`,
    };
}

const opts = { caseSensitive: false, wholeWord: false, regex: false };

suite('SymbolIndex', () => {
    test('update replaces previous symbols for same file', () => {
        const index = new SymbolIndex();
        index.update('a.c', [makeSymbol('foo', 'a.c', 1)]);
        index.update('a.c', [makeSymbol('bar', 'a.c', 2)]);

        const stats = index.getStats();
        const results = index.search('bar', '/workspace', opts);

        assert.deepStrictEqual(stats, { files: 1, symbols: 1 });
        assert.strictEqual(results.length, 1);
        assert.strictEqual(results[0].relativePath, 'a.c');
        assert.strictEqual(index.search('foo', '/workspace', opts).length, 0);
    });

    test('remove deletes file and name index entries', () => {
        const index = new SymbolIndex();
        index.update('a.c', [makeSymbol('foo', 'a.c', 1)]);
        index.remove('a.c');

        assert.deepStrictEqual(index.getStats(), { files: 0, symbols: 0 });
        assert.strictEqual(index.search('foo', '/workspace', opts).length, 0);
    });

    test('search supports exact and substring matching', () => {
        const index = new SymbolIndex();
        index.update('a.c', [makeSymbol('AlphaHandler', 'a.c', 1)]);
        index.update('b.c', [makeSymbol('BetaHandler', 'b.c', 2)]);

        const exact = index.search('AlphaHandler', '/workspace', opts);
        const partial = index.search('Handler', '/workspace', opts);

        assert.strictEqual(exact.length, 1);
        assert.strictEqual(partial.length, 2);
    });

    test('replaceAll atomically swaps entire index', () => {
        const index = new SymbolIndex();
        index.update('a.c', [makeSymbol('old', 'a.c', 1)]);

        const next = new Map<string, SymbolEntry[]>();
        next.set('b.c', [makeSymbol('newFn', 'b.c', 5)]);
        index.replaceAll(next);

        assert.deepStrictEqual(index.getStats(), { files: 1, symbols: 1 });
        assert.strictEqual(index.search('old', '/workspace', opts).length, 0);
        assert.strictEqual(index.search('newFn', '/workspace', opts).length, 1);
    });

    test('snapshot returns copy of current index data', () => {
        const index = new SymbolIndex();
        index.update('a.c', [makeSymbol('snap', 'a.c', 1)]);
        const snap = index.snapshot();
        index.remove('a.c');

        assert.ok(snap.has('a.c'), 'snapshot should contain a.c');
        assert.strictEqual(index.getStats().files, 0, 'live index should be empty after remove');
    });
});
