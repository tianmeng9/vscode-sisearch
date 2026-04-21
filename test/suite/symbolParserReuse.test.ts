// test/suite/symbolParserReuse.test.ts
// 回归测试：parseSymbols 必须复用 Parser 实例，不能每次文件新建一个。
//
// 背景：33k 文件 sync 中 VS Code 崩溃 (exit 134)，Crashpad dump 显示 V8 在 ~20 MB
// 堆时打出 "last resort; GC in old space requested" 并 abort。根因是
// symbolParser 里 per-file `new ParserClass()` + `parser.delete()` 造成 WASM
// native 堆碎片（V8 budget 还充足，但 WASM malloc 返回 null）。
//
// 修复契约：worker 生命周期内每种语言最多一个 Parser 实例；parseSymbols
// 只创建 Tree（并 tree.delete），不新建 Parser。

import * as assert from 'assert';
import * as path from 'path';
import {
    initParser,
    parseSymbols,
    disposeParser,
    _getParserStatsForTest,
} from '../../src/symbolParser';

// 定位 wasm 目录——编译后测试运行于 out/test/suite，wasm 在 project root。
// __dirname = <repo>/out/test/suite → 上溯三级到 repo root。
const EXTENSION_PATH = path.resolve(__dirname, '..', '..', '..');

const SAMPLE_C = `
int foo(int x) { return x + 1; }
int bar(int y) { return y * 2; }
struct Point { int x; int y; };
`;

const SAMPLE_CPP = `
class Widget {
public:
    void draw();
};
namespace ns {
    int helper();
}
`;

suite('symbolParser parser reuse', () => {
    suiteSetup(async function () {
        this.timeout(10_000);
        await initParser(EXTENSION_PATH);
    });

    suiteTeardown(() => {
        disposeParser();
    });

    test('parseSymbols does not create a new Parser per file', () => {
        const statsBefore = _getParserStatsForTest();
        // Parse 50 separate files — if each call did `new ParserClass()`,
        // parsersCreated would jump by 50.
        for (let i = 0; i < 50; i++) {
            parseSymbols(`/w/file${i}.c`, `file${i}.c`, SAMPLE_C);
        }
        const statsAfter = _getParserStatsForTest();

        const delta = statsAfter.parsersCreated - statsBefore.parsersCreated;
        assert.ok(
            delta <= 1,
            `parseSymbols must reuse Parser instance; got ${delta} new Parser(s) for 50 files`,
        );
    });

    test('parseSymbols reuses same Parser instance across languages', () => {
        const statsBefore = _getParserStatsForTest();
        // Alternate C and C++ files — pre-fix would fragment WASM with every call.
        // Post-fix: at most one Parser total (set/switch language on same instance
        // OR one parser per language — both bounded).
        for (let i = 0; i < 20; i++) {
            parseSymbols(`/w/mix${i}.c`, `mix${i}.c`, SAMPLE_C);
            parseSymbols(`/w/mix${i}.cpp`, `mix${i}.cpp`, SAMPLE_CPP);
        }
        const statsAfter = _getParserStatsForTest();
        const delta = statsAfter.parsersCreated - statsBefore.parsersCreated;
        assert.ok(
            delta <= 2,
            `C+C++ mix across 40 files must create <=2 Parsers; got ${delta}`,
        );
    });

    test('still produces correct symbols after reuse', () => {
        const cSyms = parseSymbols('/w/a.c', 'a.c', SAMPLE_C);
        assert.ok(cSyms.length >= 3, `expected at least 3 symbols from C sample, got ${cSyms.length}`);
        assert.ok(cSyms.some(s => s.name === 'foo'));
        assert.ok(cSyms.some(s => s.name === 'bar'));

        const cppSyms = parseSymbols('/w/a.cpp', 'a.cpp', SAMPLE_CPP);
        assert.ok(cppSyms.some(s => s.name === 'Widget'));
        assert.ok(cppSyms.some(s => s.name === 'ns'));
    });
});
