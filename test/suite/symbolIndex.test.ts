import * as assert from 'assert';
import { InMemorySymbolIndex } from '../../src/index/symbolIndex';
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
        const index = new InMemorySymbolIndex();
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
        const index = new InMemorySymbolIndex();
        index.update('a.c', [makeSymbol('foo', 'a.c', 1)]);
        index.remove('a.c');

        assert.deepStrictEqual(index.getStats(), { files: 0, symbols: 0 });
        assert.strictEqual(index.search('foo', '/workspace', opts).length, 0);
    });

    test('search supports exact and substring matching', () => {
        const index = new InMemorySymbolIndex();
        index.update('a.c', [makeSymbol('AlphaHandler', 'a.c', 1)]);
        index.update('b.c', [makeSymbol('BetaHandler', 'b.c', 2)]);

        const exact = index.search('AlphaHandler', '/workspace', opts);
        const partial = index.search('Handler', '/workspace', opts);

        assert.strictEqual(exact.length, 1);
        assert.strictEqual(partial.length, 2);
    });

    test('replaceAll atomically swaps entire index', () => {
        const index = new InMemorySymbolIndex();
        index.update('a.c', [makeSymbol('old', 'a.c', 1)]);

        const next = new Map<string, SymbolEntry[]>();
        next.set('b.c', [makeSymbol('newFn', 'b.c', 5)]);
        index.replaceAll(next);

        assert.deepStrictEqual(index.getStats(), { files: 1, symbols: 1 });
        assert.strictEqual(index.search('old', '/workspace', opts).length, 0);
        assert.strictEqual(index.search('newFn', '/workspace', opts).length, 1);
    });

    test('snapshot returns copy of current index data', () => {
        const index = new InMemorySymbolIndex();
        index.update('a.c', [makeSymbol('snap', 'a.c', 1)]);
        const snap = index.snapshot();
        index.remove('a.c');

        assert.ok(snap.has('a.c'), 'snapshot should contain a.c');
        assert.strictEqual(index.getStats().files, 0, 'live index should be empty after remove');
    });

    test('wholeWord search uses nameIndex for O(1) lookup', () => {
        const index = new InMemorySymbolIndex();
        index.update('a.c', [makeSymbol('exactly', 'a.c', 1)]);
        index.update('b.c', [makeSymbol('exactly_something', 'b.c', 2)]);

        const exact = index.search('exactly', '/workspace', { caseSensitive: false, wholeWord: true, regex: false });
        assert.strictEqual(exact.length, 1, 'wholeWord should match exact name only, not substring');
        assert.strictEqual(exact[0].relativePath, 'a.c');
    });

    test('wholeWord caseSensitive respects exact casing', () => {
        const index = new InMemorySymbolIndex();
        index.update('a.c', [makeSymbol('Foo', 'a.c', 1)]);
        index.update('b.c', [makeSymbol('foo', 'b.c', 2)]);

        const caseSensitive = index.search('Foo', '/workspace', { caseSensitive: true, wholeWord: true, regex: false });
        assert.strictEqual(caseSensitive.length, 1);
        assert.strictEqual(caseSensitive[0].relativePath, 'a.c');

        const caseInsensitive = index.search('foo', '/workspace', { caseSensitive: false, wholeWord: true, regex: false });
        assert.strictEqual(caseInsensitive.length, 2);
    });

    test('regex search matches name pattern across index', () => {
        const index = new InMemorySymbolIndex();
        index.update('a.c', [makeSymbol('handle_read', 'a.c', 1)]);
        index.update('b.c', [makeSymbol('handle_write', 'b.c', 2)]);
        index.update('c.c', [makeSymbol('other', 'c.c', 3)]);

        const results = index.search('^handle_', '/workspace', { caseSensitive: false, wholeWord: false, regex: true });
        assert.strictEqual(results.length, 2);
    });

    test('substring search still works (long query path)', () => {
        const index = new InMemorySymbolIndex();
        index.update('a.c', [makeSymbol('AlphaHandler', 'a.c', 1)]);
        index.update('b.c', [makeSymbol('BetaHandler', 'b.c', 2)]);

        const partial = index.search('Handler', '/workspace', { caseSensitive: false, wholeWord: false, regex: false });
        assert.strictEqual(partial.length, 2);
    });

    test('substring + caseSensitive=true matches uppercase query against uppercase symbol (N7 regression)', () => {
        const index = new InMemorySymbolIndex();
        index.update('a.c', [makeSymbol('FooBar', 'a.c', 1)]);
        index.update('b.c', [makeSymbol('foobar', 'b.c', 2)]);

        const results = index.search('Foo', '/workspace', { caseSensitive: true, wholeWord: false, regex: false });
        assert.strictEqual(results.length, 1, 'caseSensitive "Foo" should match FooBar only');
        assert.strictEqual(results[0].relativePath, 'a.c');
    });

    test('regex + caseSensitive=true matches uppercase pattern against uppercase symbol (N7 regression)', () => {
        const index = new InMemorySymbolIndex();
        index.update('a.c', [makeSymbol('FOOBAR', 'a.c', 1)]);
        index.update('b.c', [makeSymbol('foobar', 'b.c', 2)]);

        const results = index.search('FOO', '/workspace', { caseSensitive: true, wholeWord: false, regex: true });
        assert.strictEqual(results.length, 1, 'caseSensitive /FOO/ should match FOOBAR only');
        assert.strictEqual(results[0].relativePath, 'a.c');
    });

    test('regex caseSensitive=false is backward compatible (N7 regression)', () => {
        const index = new InMemorySymbolIndex();
        index.update('a.c', [makeSymbol('FooBar', 'a.c', 1)]);
        index.update('b.c', [makeSymbol('foobar', 'b.c', 2)]);

        const results = index.search('foo', '/workspace', { caseSensitive: false, wholeWord: false, regex: true });
        assert.strictEqual(results.length, 2, 'caseInsensitive /foo/ should match both FooBar and foobar');
    });

    test('remove cleans up nameIndex so later searches do not return stale hits', () => {
        const index = new InMemorySymbolIndex();
        index.update('a.c', [makeSymbol('gone', 'a.c', 1)]);
        index.remove('a.c');

        const wholeWord = index.search('gone', '/workspace', { caseSensitive: false, wholeWord: true, regex: false });
        assert.strictEqual(wholeWord.length, 0);
    });
});
