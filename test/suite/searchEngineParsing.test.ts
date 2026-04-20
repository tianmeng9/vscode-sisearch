// test/suite/searchEngineParsing.test.ts
// P7.4: parseRgLine 纯函数单测,覆盖 ripgrep 输出各种合法/非法形态。

import * as assert from 'assert';
import * as path from 'path';
import { parseRgLine } from '../../src/search/searchEngine';

suite('parseRgLine (P7.4)', () => {
    const workspaceRoot = '/ws';

    test('parses standard rg line with ./-prefixed path', () => {
        const line = './src/foo.c:42:7:    int bar = baz();';
        const r = parseRgLine(line, workspaceRoot);
        assert.ok(r, 'should parse a match line');
        assert.strictEqual(r!.relativePath, 'src/foo.c');
        assert.strictEqual(r!.filePath, path.resolve(workspaceRoot, 'src/foo.c'));
        assert.strictEqual(r!.lineNumber, 42);
        assert.strictEqual(r!.lineContent, '    int bar = baz();');
        assert.strictEqual(r!.matchStart, 6, 'column is 1-based on wire, 0-based in SearchResult');
        assert.strictEqual(r!.matchLength, 0);
    });

    test('parses rg line without ./ prefix', () => {
        const line = 'src/a.c:1:1:x';
        const r = parseRgLine(line, workspaceRoot);
        assert.ok(r);
        assert.strictEqual(r!.relativePath, 'src/a.c');
        assert.strictEqual(r!.lineNumber, 1);
        assert.strictEqual(r!.matchStart, 0);
    });

    test('returns null for blank lines', () => {
        assert.strictEqual(parseRgLine('', workspaceRoot), null);
        assert.strictEqual(parseRgLine('   ', workspaceRoot), null);
        assert.strictEqual(parseRgLine('\t\t', workspaceRoot), null);
    });

    test('returns null for non-matching lines (e.g. stderr leak)', () => {
        assert.strictEqual(parseRgLine('rg: error: something broke', workspaceRoot), null);
        assert.strictEqual(parseRgLine('./noColon', workspaceRoot), null);
        assert.strictEqual(parseRgLine('./x.c:notanumber:7:hi', workspaceRoot), null);
    });

    test('preserves colons inside lineContent', () => {
        const line = './a.c:10:5:map<int, string>::value_type v;';
        const r = parseRgLine(line, workspaceRoot);
        assert.ok(r);
        assert.strictEqual(r!.lineNumber, 10);
        assert.strictEqual(r!.matchStart, 4);
        assert.strictEqual(
            r!.lineContent,
            'map<int, string>::value_type v;',
            'lineContent must keep every colon after the 3rd delimiter',
        );
    });
});
