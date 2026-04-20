// src/sync/parseResultGrouping.ts
// 将 worker parse 返回的扁平 symbols[] + metadata[] 折叠为 per-file 分桶。
// 两处调用点共享此逻辑:
//   1. SyncOrchestrator.synchronize —— 全量 sync 路径
//   2. SymbolIndex.applyParseResult —— syncDirty 路径
// 抽出来避免两侧独立漂移(R2 报告 N10)。

import type { SymbolEntry } from '../index/indexTypes';
import type { ParseBatchResult } from './workerPool';

/**
 * 按 relativePath 对 symbols 分桶;零符号的文件也保留空桶,确保
 * 每个被解析的文件都会触发一次 index.update(file, symbols),
 * 从而覆盖"文件变为无符号"的场景(必须 update 清空旧符号)。
 */
export function groupParseResult(result: ParseBatchResult): Map<string, SymbolEntry[]> {
    const grouped = new Map<string, SymbolEntry[]>();
    for (const symbol of result.symbols) {
        const bucket = grouped.get(symbol.relativePath);
        if (bucket) {
            bucket.push(symbol);
        } else {
            grouped.set(symbol.relativePath, [symbol]);
        }
    }
    for (const meta of result.metadata) {
        if (!grouped.has(meta.relativePath)) {
            grouped.set(meta.relativePath, []);
        }
    }
    return grouped;
}
