import * as assert from 'assert';
import { SearchStore } from '../../src/searchStore';
import { SearchResult, SearchOptions } from '../../src/types';

function makeResult(file: string, line: number, content: string): SearchResult {
    return {
        filePath: `/workspace/${file}`,
        relativePath: file,
        lineNumber: line,
        lineContent: content,
        matchStart: 0,
        matchLength: 5,
    };
}

const defaultOpts: SearchOptions = { caseSensitive: false, wholeWord: false, regex: false };

suite('SearchStore', () => {
    let store: SearchStore;

    setup(() => {
        store = new SearchStore();
    });

    test('addSearch creates a history entry', () => {
        const results = [makeResult('a.c', 1, 'hello')];
        store.addSearch('hello', defaultOpts, results, 'replace');
        const history = store.getHistory();
        assert.strictEqual(history.length, 1);
        assert.strictEqual(history[0].query, 'hello');
        assert.strictEqual(history[0].results.length, 1);
    });

    test('replace mode clears active results', () => {
        store.addSearch('first', defaultOpts, [makeResult('a.c', 1, 'first')], 'replace');
        store.addSearch('second', defaultOpts, [makeResult('b.c', 2, 'second')], 'replace');
        const all = store.getActiveResults();
        assert.strictEqual(all.length, 1);
        assert.ok(all[0].lineContent.includes('second'));
    });

    test('append mode adds to active results', () => {
        store.addSearch('first', defaultOpts, [makeResult('a.c', 1, 'first')], 'replace');
        store.addSearch('second', defaultOpts, [makeResult('b.c', 2, 'second')], 'append');
        const all = store.getActiveResults();
        assert.strictEqual(all.length, 2);
    });

    test('selectHistory switches active results', () => {
        store.addSearch('first', defaultOpts, [makeResult('a.c', 1, 'first')], 'replace');
        const firstId = store.getHistory()[0].id;
        store.addSearch('second', defaultOpts, [makeResult('b.c', 2, 'second')], 'replace');
        store.selectHistory(firstId);
        const all = store.getActiveResults();
        assert.strictEqual(all.length, 1);
        assert.ok(all[0].lineContent.includes('first'));
    });

    test('deleteHistory removes entry', () => {
        store.addSearch('hello', defaultOpts, [makeResult('a.c', 1, 'hello')], 'replace');
        const id = store.getHistory()[0].id;
        store.deleteHistory(id);
        assert.strictEqual(store.getHistory().length, 0);
    });

    test('navigation cursor advances correctly', () => {
        const results = [
            makeResult('a.c', 1, 'line1'),
            makeResult('b.c', 2, 'line2'),
            makeResult('c.c', 3, 'line3'),
        ];
        store.addSearch('test', defaultOpts, results, 'replace');
        assert.strictEqual(store.getNavigationIndex(), -1);

        const r1 = store.nextResult(true);
        assert.strictEqual(r1?.lineNumber, 1);
        assert.strictEqual(store.getNavigationIndex(), 0);

        const r2 = store.nextResult(true);
        assert.strictEqual(r2?.lineNumber, 2);

        const r3 = store.nextResult(true);
        assert.strictEqual(r3?.lineNumber, 3);

        // wrap around
        const r4 = store.nextResult(true);
        assert.strictEqual(r4?.lineNumber, 1);
    });

    test('navigation without wrap stops at end', () => {
        const results = [makeResult('a.c', 1, 'line1')];
        store.addSearch('test', defaultOpts, results, 'replace');
        store.nextResult(false);
        const r = store.nextResult(false);
        assert.strictEqual(r, undefined);
    });

    test('previousResult navigates backwards', () => {
        const results = [
            makeResult('a.c', 1, 'line1'),
            makeResult('b.c', 2, 'line2'),
        ];
        store.addSearch('test', defaultOpts, results, 'replace');
        store.nextResult(true); // 0
        store.nextResult(true); // 1
        const r = store.previousResult(true);
        assert.strictEqual(r?.lineNumber, 1);
    });

    test('onChange fires when search is added', () => {
        let fired = false;
        store.onChange(() => { fired = true; });
        store.addSearch('test', defaultOpts, [makeResult('a.c', 1, 'x')], 'replace');
        assert.ok(fired);
    });
});
