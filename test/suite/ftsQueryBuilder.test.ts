import * as assert from 'assert';
import { escapeFtsLiteral, extractLiteralTokens } from '../../src/index/ftsQueryBuilder';

suite('ftsQueryBuilder', () => {
    test('escapeFtsLiteral wraps plain query in double-quotes', () => {
        assert.strictEqual(escapeFtsLiteral('hello'), '"hello"');
    });

    test('escapeFtsLiteral doubles embedded double-quotes', () => {
        assert.strictEqual(escapeFtsLiteral('say "hi"'), '"say ""hi"""');
    });

    test('escapeFtsLiteral neutralizes FTS5 operators', () => {
        // 把 AND/OR/NEAR/NOT/* 等都视为普通字面量
        assert.strictEqual(escapeFtsLiteral('foo AND bar'), '"foo AND bar"');
        assert.strictEqual(escapeFtsLiteral('x*'), '"x*"');
    });

    test('extractLiteralTokens pulls alphanum runs from regex source', () => {
        assert.deepStrictEqual(extractLiteralTokens('amdgpu.*init'), ['amdgpu', 'init']);
        assert.deepStrictEqual(extractLiteralTokens('^foo_bar$'), ['foo_bar']);
        assert.deepStrictEqual(extractLiteralTokens('\\d+'), []);
    });

    test('extractLiteralTokens length-filters very short fragments', () => {
        // "a" 和 "b" 过短不当作 token,避免 FTS5 过度粗筛
        assert.deepStrictEqual(extractLiteralTokens('a.+b'), []);
    });

    test('escapeFtsLiteral preserves unicode identifiers', () => {
        assert.strictEqual(escapeFtsLiteral('变量名'), '"变量名"');
    });
});
