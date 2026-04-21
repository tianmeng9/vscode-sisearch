// test/suite/symbolParserMaxBytes.test.ts
// 契约:parseSymbols 在 content.length >= maxBytes 时,必须走 largeFileParser
// 正则回退,不得调用 tree-sitter —— 这是防 WASM 爆堆的硬闸门。
//
// 验证手段:disposeParser() 之后 parser 未 init;此时 tree-sitter 路径会返回 [];
// 而回退路径不依赖 parser,仍能产出符号。用这个不对称性作为"真的走了回退"的证据。

import * as assert from 'assert';
import { parseSymbols, disposeParser } from '../../src/symbolParser';

suite('parseSymbols maxBytes guard', () => {
    suiteSetup(() => {
        // 确保 parser 未 init,让 tree-sitter 路径必返回空。
        disposeParser();
    });

    test('content >= maxBytes falls back to regex (no parser needed)', () => {
        const content = [
            '#define AAA 1',
            '#define BBB 2',
            'struct S { int x; };',
        ].join('\n');
        // 设置 maxBytes 刚好 <= content.length → 强制走回退
        const syms = parseSymbols('/w/x.h', 'x.h', content, { maxBytes: content.length });
        const names = syms.map(s => s.name).sort();
        assert.ok(names.includes('AAA'), `AAA missing: ${names.join(',')}`);
        assert.ok(names.includes('BBB'));
        assert.ok(names.includes('S'));
    });

    test('content < maxBytes still goes to tree-sitter path (returns [] when parser not inited)', () => {
        const content = '#define AAA 1';
        // maxBytes 远大于内容 → 走 tree-sitter 路径;parser 未 init → 返回 [].
        const syms = parseSymbols('/w/x.h', 'x.h', content, { maxBytes: 1024 * 1024 });
        assert.deepStrictEqual(syms, []);
    });

    test('maxBytes = 0 disables threshold (always tree-sitter path)', () => {
        // maxBytes = 0 表示"禁用回退",即使内容巨大也走 tree-sitter —— 用户明示接受崩溃风险。
        // 此处 parser 未 init,走 tree-sitter 路径返回 [].
        const content = '#'.repeat(10 * 1024 * 1024); // 10 MB
        const syms = parseSymbols('/w/huge.h', 'huge.h', content, { maxBytes: 0 });
        assert.deepStrictEqual(syms, []);
    });

    test('maxBytes undefined = disabled (parity with maxBytes: 0)', () => {
        // 兼容既有 API:不传 options 时保持原行为 —— 走 tree-sitter 路径。
        const content = '#'.repeat(10 * 1024 * 1024);
        const syms = parseSymbols('/w/huge.h', 'huge.h', content);
        assert.deepStrictEqual(syms, []);
    });
});
