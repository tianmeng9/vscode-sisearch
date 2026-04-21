// test/suite/parserConfig.test.ts
// 契约:resolveMaxFileSizeBytes 把 VS Code 配置归一成一个非负整数 maxBytes。
//   - 未配置 / undefined → DEFAULT_MAX_FILE_SIZE_BYTES (2 MB)
//   - 0 → 0 (用户明示禁用阈值,承担 WASM 爆堆风险)
//   - 正整数 → 原值
//   - 负数 / NaN / 非数字 → DEFAULT(防御性回退)

import * as assert from 'assert';
import {
    DEFAULT_MAX_FILE_SIZE_BYTES,
    resolveMaxFileSizeBytes,
} from '../../src/parserConfig';

suite('resolveMaxFileSizeBytes', () => {
    test('undefined → default 2 MB', () => {
        assert.strictEqual(resolveMaxFileSizeBytes(undefined), DEFAULT_MAX_FILE_SIZE_BYTES);
        assert.strictEqual(DEFAULT_MAX_FILE_SIZE_BYTES, 2 * 1024 * 1024);
    });

    test('0 → 0 (user-disabled)', () => {
        // 用户显式关闭阈值,接受 WASM 爆堆风险 —— 保留 0,不被替换成默认。
        assert.strictEqual(resolveMaxFileSizeBytes(0), 0);
    });

    test('positive integer → passthrough', () => {
        assert.strictEqual(resolveMaxFileSizeBytes(512 * 1024), 512 * 1024);
        assert.strictEqual(resolveMaxFileSizeBytes(8 * 1024 * 1024), 8 * 1024 * 1024);
    });

    test('negative → default (defensive)', () => {
        assert.strictEqual(resolveMaxFileSizeBytes(-1), DEFAULT_MAX_FILE_SIZE_BYTES);
    });

    test('NaN / non-number → default', () => {
        assert.strictEqual(resolveMaxFileSizeBytes(NaN), DEFAULT_MAX_FILE_SIZE_BYTES);
        assert.strictEqual(resolveMaxFileSizeBytes('abc' as any), DEFAULT_MAX_FILE_SIZE_BYTES);
        assert.strictEqual(resolveMaxFileSizeBytes(null as any), DEFAULT_MAX_FILE_SIZE_BYTES);
    });

    test('non-integer → floor', () => {
        // 浮点配置值极罕见,但不应让它原样传到 worker —— 统一 floor 成整数。
        assert.strictEqual(resolveMaxFileSizeBytes(1024.7), 1024);
    });
});
