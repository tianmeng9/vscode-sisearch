// src/parserConfig.ts
// parser 相关的 VS Code 配置归一化 —— 单独一个文件,不 import vscode,
// 方便单测在 node 下直接跑(不用走 @vscode/test-electron)。

/**
 * 默认大文件阈值:1 MB。
 *
 * 依据(2026-04-21 实证调整,从 2 MB 下调):
 *  - AMD GPU 驱动 `asic_reg/**\/*_offset.h` 系列文件 1.3-1.8 MB,每文件
 *    10 万+ 行 `#define REG_XXX 0x...`。虽然单文件 <2 MB,但一次 Sync 里
 *    有几十个这样的 offset.h,8 worker 并发时概率命中多个 → tree-sitter
 *    WASM 堆瞬间膨胀到对 extension host 致命的量级 → exit 134。
 *  - 1 MB 闸门把所有机器生成的寄存器头导向 Phase 5D onSymbol stream 路径,
 *    单文件产物不在 worker 内驻留,worker 堆稳态 < 5 MB。
 *  - 普通手写源文件几乎都 < 200 KB,不受影响。
 *  - stream 路径的精度 trade-off(不识别模板/尾返回/lambda)对机器生成
 *    寄存器头没有实际损失 —— 它们全是单行 #define。
 */
export const DEFAULT_MAX_FILE_SIZE_BYTES = 1 * 1024 * 1024;

/**
 * 把用户配置值归一成 parseSymbols 能直接消费的非负整数。
 *
 *   undefined / 非数 / 负数 / NaN → DEFAULT_MAX_FILE_SIZE_BYTES
 *   0                             → 0  (用户明示禁用阈值)
 *   正整数                        → 原值
 *   正浮点                        → floor 到整数
 *
 * 之所以单独列出 0:VS Code settings UI 里 "0 = disabled" 是常见惯例,
 * 我们必须把它当合法输入保留,不替换成默认。禁用阈值的后果(可能 WASM
 * 爆堆闪退)在 package.json 的 description 里已经讲清楚。
 */
export function resolveMaxFileSizeBytes(raw: unknown): number {
    if (raw === 0) { return 0; }
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) {
        return DEFAULT_MAX_FILE_SIZE_BYTES;
    }
    return Math.floor(raw);
}
