import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { executeSearch } from '../../src/search/searchEngine';
import { SearchOptions } from '../../src/types';

suite('SearchEngine', () => {
    let tmpDir: string;

    setup(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sisearch-test-'));
        fs.writeFileSync(path.join(tmpDir, 'test.c'), [
            '#include <stdio.h>',
            'int main() {',
            '    printf("hello");',
            '    printf("Hello");',
            '    return 0;',
            '}'
        ].join('\n'));
        fs.writeFileSync(path.join(tmpDir, 'test.h'), [
            '#ifndef TEST_H',
            '#define TEST_H',
            'void hello_func();',
            '#endif'
        ].join('\n'));
        fs.writeFileSync(path.join(tmpDir, 'ignore.txt'), 'hello from txt');
    });

    teardown(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('case-insensitive search finds both cases', async () => {
        const opts: SearchOptions = { caseSensitive: false, wholeWord: false, regex: false };
        const results = await executeSearch('hello', tmpDir, opts, ['.c', '.h'], []);
        assert.ok(results.length >= 3, `Expected >=3 results, got ${results.length}`);
    });

    test('case-sensitive search filters correctly', async () => {
        const opts: SearchOptions = { caseSensitive: true, wholeWord: false, regex: false };
        const results = await executeSearch('hello', tmpDir, opts, ['.c', '.h'], []);
        const allLower = results.every(r => r.lineContent.includes('hello'));
        assert.ok(allLower, 'Case-sensitive search should only match lowercase');
    });

    test('whole word search filters partial matches', async () => {
        const opts: SearchOptions = { caseSensitive: false, wholeWord: true, regex: false };
        const results = await executeSearch('hello', tmpDir, opts, ['.c', '.h'], []);
        const hasHelloFunc = results.some(r => r.lineContent.includes('hello_func'));
        assert.strictEqual(hasHelloFunc, false, 'Whole word should not match hello_func');
    });

    test('regex search works', async () => {
        const opts: SearchOptions = { caseSensitive: false, wholeWord: false, regex: true };
        const results = await executeSearch('print.*hello', tmpDir, opts, ['.c'], []);
        assert.ok(results.length >= 1, 'Regex should match printf lines');
    });

    test('file extension filter works', async () => {
        const opts: SearchOptions = { caseSensitive: false, wholeWord: false, regex: false };
        const results = await executeSearch('hello', tmpDir, opts, ['.c'], []);
        const allC = results.every(r => r.filePath.endsWith('.c'));
        assert.ok(allC, 'Should only return .c files');
    });

    test('result fields are populated correctly', async () => {
        const opts: SearchOptions = { caseSensitive: true, wholeWord: false, regex: false };
        const results = await executeSearch('printf', tmpDir, opts, ['.c'], []);
        assert.ok(results.length >= 2);
        const first = results[0];
        assert.ok(first.filePath.endsWith('test.c'));
        assert.ok(first.lineNumber > 0);
        assert.ok(first.lineContent.includes('printf'));
        assert.ok(first.relativePath === 'test.c');
    });
});
