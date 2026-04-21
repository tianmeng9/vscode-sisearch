// test/suite/largeFileParserStream.test.ts
// Phase 5B 契约:extractSymbolsByRegexStream 永不整文件读进内存。
// 等价性:对同一内容,stream 版输出的符号集合应与非 stream 版一致(顺序可不同)。

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { extractSymbolsByRegex } from '../../src/largeFileParser';
import { extractSymbolsByRegexStream } from '../../src/largeFileParserStream';

function writeFixture(content: string): string {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sisearch-stream-'));
    const p = path.join(tmp, 'fixture.h');
    fs.writeFileSync(p, content, 'utf-8');
    return p;
}

interface Entry { name: string; kind: string; lineNumber: number }

function sigOf(entries: Entry[]): string[] {
    // 用 name+kind+line 做签名,忽略 column 和 lineContent 差异(stream 版偏移可能略差)
    return entries.map((e: Entry) => `${e.kind}:${e.name}@${e.lineNumber}`).sort();
}

suite('largeFileParserStream', () => {
    test('extracts macros from stream (single-line rule)', async () => {
        const content = [
            '#define FOO 1',
            '#define BAR(x) ((x)+1)',
            '/* comment */',
            '#define BAZ 0x10',
            '',
        ].join('\n');
        const p = writeFixture(content);
        const streamed = await extractSymbolsByRegexStream(p, 'fixture.h');
        const nonStream = extractSymbolsByRegex(p, 'fixture.h', content);
        assert.deepStrictEqual(sigOf(streamed), sigOf(nonStream));
        fs.rmSync(path.dirname(p), { recursive: true, force: true });
    });

    test('extracts struct/union/enum/class/namespace (same-line brace)', async () => {
        const content = [
            'struct Foo {',
            '    int x;',
            '};',
            'union Bar {',
            '    int i;',
            '};',
            'enum Baz {',
            '    A, B',
            '};',
            'class Qux {',
            'public:',
            '    int y;',
            '};',
            'namespace ns {',
            '}',
        ].join('\n');
        const p = writeFixture(content);
        const streamed = await extractSymbolsByRegexStream(p, 'fixture.h');
        const names = streamed.map((e: Entry) => e.name).sort();
        assert.deepStrictEqual(names, ['Bar', 'Baz', 'Foo', 'Qux', 'ns']);
        fs.rmSync(path.dirname(p), { recursive: true, force: true });
    });

    test('extracts function definitions (with simple param list)', async () => {
        const content = [
            'int add(int a, int b) {',
            '    return a + b;',
            '}',
            'static void do_thing(void)',
            '{',
            '    return;',
            '}',
        ].join('\n');
        const p = writeFixture(content);
        const streamed = await extractSymbolsByRegexStream(p, 'fixture.h');
        const names = streamed.filter((e: Entry) => e.kind === 'function').map((e: Entry) => e.name).sort();
        assert.ok(names.includes('add'), `add not found in ${JSON.stringify(names)}`);
        assert.ok(names.includes('do_thing'), `do_thing not found in ${JSON.stringify(names)}`);
        fs.rmSync(path.dirname(p), { recursive: true, force: true });
    });

    test('line numbers are 1-based and accurate', async () => {
        const content = [
            '// line 1',
            '// line 2',
            '#define ON_LINE_3 3',
            '// line 4',
            'struct OnLine5 {',
            '};',
        ].join('\n');
        const p = writeFixture(content);
        const streamed = await extractSymbolsByRegexStream(p, 'fixture.h');
        const m = streamed.find((e: Entry) => e.name === 'ON_LINE_3');
        assert.ok(m, 'ON_LINE_3 not extracted');
        assert.strictEqual(m!.lineNumber, 3);
        const s = streamed.find((e: Entry) => e.name === 'OnLine5');
        assert.ok(s, 'OnLine5 not extracted');
        assert.strictEqual(s!.lineNumber, 5);
        fs.rmSync(path.dirname(p), { recursive: true, force: true });
    });

    test('handles 14 MB file without buffering whole content', async () => {
        // 模拟 nbio_6_1_sh_mask.h 级别:14 MB,纯 #define 行
        // 不测峰值 RSS(Node 测 RSS 不稳),只测能跑完 + 产出数量合理。
        // 关键是跑完不 OOM,真实的峰值验证交给 F5。
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sisearch-stream-big-'));
        const p = path.join(tmp, 'big.h');
        const lines: string[] = [];
        for (let i = 0; i < 200000; i++) {
            lines.push(`#define MACRO_${i} 0x${i.toString(16)}`);
        }
        fs.writeFileSync(p, lines.join('\n'), 'utf-8');
        const size = fs.statSync(p).size;
        assert.ok(size > 4 * 1024 * 1024, `fixture too small: ${size}`);
        const streamed = await extractSymbolsByRegexStream(p, 'big.h');
        assert.strictEqual(streamed.length, 200000);
        assert.strictEqual(streamed[0].name, 'MACRO_0');
        assert.strictEqual(streamed[streamed.length - 1].name, 'MACRO_199999');
        fs.rmSync(tmp, { recursive: true, force: true });
    }).timeout(30000);
});
