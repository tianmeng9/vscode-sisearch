import * as assert from 'assert';
import { groupParseResult } from '../../src/sync/parseResultGrouping';
import type { SymbolEntry, IndexedFile } from '../../src/index/indexTypes';
import type { ParseBatchResult } from '../../src/sync/workerPool';

function sym(name: string, rel: string, line: number): SymbolEntry {
    return {
        name,
        kind: 'function',
        filePath: `/ws/${rel}`,
        relativePath: rel,
        lineNumber: line,
        endLineNumber: line,
        column: 0,
        lineContent: `${name}();`,
    };
}

function meta(rel: string, symbolCount: number): IndexedFile {
    return { relativePath: rel, mtime: 1, size: 10, symbolCount };
}

suite('groupParseResult', () => {
    test('groups symbols by relativePath', () => {
        const result: ParseBatchResult = {
            symbols: [sym('foo', 'a.c', 1), sym('bar', 'a.c', 2), sym('baz', 'b.c', 1)],
            metadata: [meta('a.c', 2), meta('b.c', 1)],
            errors: [],
        };

        const grouped = groupParseResult(result);
        assert.strictEqual(grouped.size, 2);
        assert.strictEqual(grouped.get('a.c')?.length, 2);
        assert.strictEqual(grouped.get('b.c')?.length, 1);
    });

    test('preserves zero-symbol files as empty buckets (so index.update clears old symbols)', () => {
        const result: ParseBatchResult = {
            symbols: [],
            metadata: [meta('empty.c', 0)],
            errors: [],
        };

        const grouped = groupParseResult(result);
        assert.strictEqual(grouped.size, 1);
        assert.deepStrictEqual(grouped.get('empty.c'), []);
    });

    test('metadata without symbols still creates empty bucket alongside symbol-bearing files', () => {
        const result: ParseBatchResult = {
            symbols: [sym('foo', 'a.c', 1)],
            metadata: [meta('a.c', 1), meta('b.c', 0)],
            errors: [],
        };

        const grouped = groupParseResult(result);
        assert.strictEqual(grouped.size, 2);
        assert.strictEqual(grouped.get('a.c')?.length, 1);
        assert.deepStrictEqual(grouped.get('b.c'), []);
    });

    test('empty input yields empty map', () => {
        const grouped = groupParseResult({ symbols: [], metadata: [], errors: [] });
        assert.strictEqual(grouped.size, 0);
    });
});
