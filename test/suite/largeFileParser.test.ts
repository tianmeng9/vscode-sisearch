// test/suite/largeFileParser.test.ts
// 回归测试契约:
//   tree-sitter 对 24 MB 级自动生成的 AMD GPU 头文件 (drivers/gpu/drm/amd/.../dcn_3_2_0_sh_mask.h)
//   会在单次 parser.parse(content) 里把 WASM 线性内存从 32 MB 爆到 2 GB 上限 → process.abort() →
//   整个 extension host exit 134。parser 层面无解,唯一出路是超阈值走正则回退,抽出
//   粗粒度符号,避开 tree-sitter 这条 AST 调用。
//
// 这里只测 extractSymbolsByRegex 的 pure-function 行为,不挂 tree-sitter。

import * as assert from 'assert';
import { extractSymbolsByRegex } from '../../src/largeFileParser';

suite('largeFileParser', () => {
    test('extracts #define macros', () => {
        const source = [
            '#define FOO_REG 0x1234',
            '#define BAR(x) ((x) + 1)',
            '#define BAZ 42',
        ].join('\n');
        const syms = extractSymbolsByRegex('/w/big.h', 'big.h', source);
        const names = syms.map(s => s.name).sort();
        assert.deepStrictEqual(names, ['BAR', 'BAZ', 'FOO_REG']);
        for (const s of syms) {
            assert.strictEqual(s.kind, 'macro');
            assert.strictEqual(s.relativePath, 'big.h');
            assert.strictEqual(s.filePath, '/w/big.h');
            assert.ok(s.lineNumber >= 1);
            assert.strictEqual(s.endLineNumber, s.lineNumber);
        }
    });

    test('extracts struct / union / enum / class / namespace', () => {
        const source = [
            'struct Point { int x; int y; };',
            'union U { int a; float b; };',
            'enum Color { RED, GREEN };',
            'class Widget { public: void draw(); };',
            'namespace ns { int helper(); }',
        ].join('\n');
        const syms = extractSymbolsByRegex('/w/types.h', 'types.h', source);
        const byKind = new Map<string, string[]>();
        for (const s of syms) {
            if (!byKind.has(s.kind)) { byKind.set(s.kind, []); }
            byKind.get(s.kind)!.push(s.name);
        }
        assert.deepStrictEqual(byKind.get('struct'), ['Point']);
        assert.deepStrictEqual(byKind.get('union'), ['U']);
        assert.deepStrictEqual(byKind.get('enum'), ['Color']);
        assert.deepStrictEqual(byKind.get('class'), ['Widget']);
        assert.deepStrictEqual(byKind.get('namespace'), ['ns']);
    });

    test('extracts function definitions (common shapes)', () => {
        // 只要求识别最常见定义形态:返回类型 + 标识符 + ( + ) + {
        // 不指望覆盖模板、尾返回类型等复杂情况 —— 超阈值回退就是粗略工作。
        const source = [
            'int foo(int x) {',
            '    return x + 1;',
            '}',
            '',
            'static inline void bar(void) { }',
            '',
            'const char* baz(int n)',
            '{',
            '    return 0;',
            '}',
        ].join('\n');
        const syms = extractSymbolsByRegex('/w/fn.c', 'fn.c', source);
        const fnNames = syms.filter(s => s.kind === 'function').map(s => s.name).sort();
        // 至少要覆盖 foo/bar/baz 三个中的两个以上 —— 正则本来就做近似。
        assert.ok(fnNames.includes('foo'), `foo missing: ${fnNames.join(',')}`);
        assert.ok(fnNames.includes('bar'), `bar missing: ${fnNames.join(',')}`);
    });

    test('line numbers are 1-based and lineContent matches', () => {
        const source = '\n\n#define AAA 1\n\nstruct S { int v; };';
        const syms = extractSymbolsByRegex('/w/x.c', 'x.c', source);
        const aaa = syms.find(s => s.name === 'AAA');
        const s = syms.find(s => s.name === 'S');
        assert.ok(aaa, 'AAA not extracted');
        assert.ok(s, 'struct S not extracted');
        assert.strictEqual(aaa!.lineNumber, 3);
        assert.strictEqual(s!.lineNumber, 5);
        assert.ok(aaa!.lineContent.includes('#define AAA'));
        assert.ok(s!.lineContent.includes('struct S'));
    });

    test('survives synthetic 5 MB header without crashing and extracts >0 symbols', function () {
        this.timeout(10_000);
        // 合成一个 5 MB 的 .h —— 还不到真实 24 MB dcn_3_2_0_sh_mask.h 的规模,
        // 但足够证明正则扫描是 O(n) 且完成时间可预测(<2s)。
        const lines: string[] = [];
        const target = 5 * 1024 * 1024;
        let acc = 0;
        let i = 0;
        while (acc < target) {
            const line = `#define REG_FIELD_${i}_MASK 0x${(i & 0xffff).toString(16)}`;
            lines.push(line);
            acc += line.length + 1;
            i++;
        }
        const big = lines.join('\n');
        const t0 = Date.now();
        const syms = extractSymbolsByRegex('/w/huge.h', 'huge.h', big);
        const dt = Date.now() - t0;
        assert.ok(syms.length > 1000, `expected many symbols, got ${syms.length}`);
        assert.ok(dt < 2000, `regex extraction must be O(n); took ${dt}ms for 5 MB`);
    });
});
