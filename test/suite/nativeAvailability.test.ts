// test/suite/nativeAvailability.test.ts
// M7.1 契约:checkSqliteAvailable() 探测 better-sqlite3 是否可用。
// - 本机 (M1.1 已安装 better-sqlite3) 应返回 available=true
// - 结果缓存:多次调用返回同一对象引用
// - _resetCheckForTest() 清缓存
//
// 无法在纯 node 下测试 available=false 路径(需要模块级 mock require);
// 留给 host-only fallback 测试 / 人工 F5 冒烟(mv better_sqlite3.node)。

import * as assert from 'assert';
import { checkSqliteAvailable, _resetCheckForTest } from '../../src/nativeAvailability';

suite('nativeAvailability', () => {
    setup(() => { _resetCheckForTest(); });

    test('returns available=true on this machine (binding installed)', () => {
        const r = checkSqliteAvailable();
        assert.strictEqual(r.available, true);
        assert.strictEqual(r.error, undefined);
    });

    test('result is cached across calls (same object reference)', () => {
        const r1 = checkSqliteAvailable();
        const r2 = checkSqliteAvailable();
        assert.strictEqual(r1, r2);
    });

    test('_resetCheckForTest clears the cache', () => {
        const r1 = checkSqliteAvailable();
        _resetCheckForTest();
        const r2 = checkSqliteAvailable();
        assert.notStrictEqual(r1, r2);
        assert.strictEqual(r2.available, true);
    });
});
