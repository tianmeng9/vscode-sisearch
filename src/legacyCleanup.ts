// src/legacyCleanup.ts
// M6 / Decision 11:激活时静默删除遗留 msgpack 分片目录 .sisearch/shards/。
//
// 抽离为独立模块(不 import vscode),使其可在纯 Node 测试环境直接加载。
// SQLite FTS5 迁移后,老版本写入的 msgpack 分片不再使用;保留 .sisearch/ 本身
// 因为新的 SQLite 数据库(index.db)可能位于同级目录。
//
// 合约:best-effort,绝不抛出。任何 IO / 权限错误都被吞掉,激活不应被阻塞。

import * as fs from 'fs';
import * as path from 'path';

/**
 * 静默删除 `<workspaceRoot>/.sisearch/shards/` 整棵子树。
 * 目录不存在时直接返回;任何底层错误均被捕获。
 */
export function cleanupLegacyShards(workspaceRoot: string): void {
    try {
        const shardsDir = path.join(workspaceRoot, '.sisearch', 'shards');
        if (!fs.existsSync(shardsDir)) { return; }
        fs.rmSync(shardsDir, { recursive: true, force: true });
    } catch {
        // Silent — 权限问题 / 挂载异常等不应阻塞激活。
    }
}
