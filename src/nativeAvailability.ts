// src/nativeAvailability.ts
// M7.1: 激活早期探测 better-sqlite3 原生模块是否可加载/实例化。
// 若 require() 或 new Database(':memory:') 抛出(ABI 不匹配 / 缺失 .node / OS 不支持),
// 返回 available=false，让 composition 层走降级路径:禁用符号索引，只剩 ripgrep 搜索。
//
// 故意不 import 'better-sqlite3'(避免 TS 把 require 提到模块 top),
// 用运行时 require 放在 try/catch 内,native 绑定加载失败才能被捕获。
//
// 模块零依赖 vscode，可直接在 node 测试环境中加载。

let cached: { available: boolean; error?: string } | undefined;

/**
 * 首次调用运行探测并缓存结果；后续调用返回相同引用。
 * 失败时 `error` 携带原始异常消息,供用户提示/诊断。
 */
export function checkSqliteAvailable(): { available: boolean; error?: string } {
    if (cached) { return cached; }
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const Database = require('better-sqlite3');
        const db = new Database(':memory:');
        db.close();
        cached = { available: true };
    } catch (e) {
        cached = {
            available: false,
            error: e instanceof Error ? e.message : String(e),
        };
    }
    return cached;
}

/** @internal 测试钩子:清除缓存，允许重新探测。 */
export function _resetCheckForTest(): void {
    cached = undefined;
}
