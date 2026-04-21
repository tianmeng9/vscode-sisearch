// src/parserConfig.ts
// parser 相关的 VS Code 配置归一化 —— 单独一个文件,不 import vscode,
// 方便单测在 node 下直接跑(不用走 @vscode/test-electron)。

/**
 * 默认大文件阈值:2 MB。
 *
 * 依据:
 *  - 真实环境(Linux kernel drivers 33k 文件)里,tree-sitter 能稳吃的
 *    最大文件约在 1-2 MB 级;
 *  - AMD GPU dcn_3_2_0_sh_mask.h 等 24 MB 级自动生成头是 crash 源,
 *    远超此阈值,会被路由到正则回退;
 *  - 普通手写源文件几乎都 < 200 KB,不受影响。
 */
export const DEFAULT_MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024;

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
