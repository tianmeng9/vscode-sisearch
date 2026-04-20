// test/suite/navigation.test.ts
import * as assert from 'assert';
import { SearchStore } from '../../src/search/searchStore';
import { SearchResult, SearchOptions } from '../../src/types';

function makeResult(file: string, line: number): SearchResult {
    return {
        filePath: `/workspace/${file}`,
        relativePath: file,
        lineNumber: line,
        lineContent: 'test',
        matchStart: 0,
        matchLength: 4,
    };
}

const opts: SearchOptions = { caseSensitive: false, wholeWord: false, regex: false };

suite('Navigation', () => {
    test('navigateNext cycles through results', () => {
        const store = new SearchStore();
        store.addSearch('test', opts, [
            makeResult('a.c', 10),
            makeResult('b.c', 20),
            makeResult('c.c', 30),
        ], 'replace');

        const r1 = store.nextResult(true);
        assert.strictEqual(r1?.filePath, '/workspace/a.c');
        assert.strictEqual(r1?.lineNumber, 10);

        const r2 = store.nextResult(true);
        assert.strictEqual(r2?.filePath, '/workspace/b.c');

        const r3 = store.nextResult(true);
        assert.strictEqual(r3?.filePath, '/workspace/c.c');

        // 循环
        const r4 = store.nextResult(true);
        assert.strictEqual(r4?.filePath, '/workspace/a.c');
    });

    test('navigatePrevious goes backwards', () => {
        const store = new SearchStore();
        store.addSearch('test', opts, [
            makeResult('a.c', 10),
            makeResult('b.c', 20),
        ], 'replace');

        store.nextResult(true); // 0: a.c
        store.nextResult(true); // 1: b.c

        const r = store.previousResult(true);
        assert.strictEqual(r?.filePath, '/workspace/a.c');
    });
});
