// src/index/symbolIndex.ts
// 纯内存符号索引 — 无任何 IO，可直接在测试中实例化

import type { SearchOptions, SearchResult } from '../types';
import type { SymbolEntry } from './indexTypes';

export class InMemorySymbolIndex {
    private symbolsByFile = new Map<string, SymbolEntry[]>();
    private nameIndex = new Map<string, SymbolEntry[]>();

    update(file: string, symbols: SymbolEntry[]): void {
        this.remove(file);
        this.symbolsByFile.set(file, symbols);
        for (const symbol of symbols) {
            const key = symbol.name.toLowerCase();
            const existing = this.nameIndex.get(key);
            if (existing) {
                existing.push(symbol);
            } else {
                this.nameIndex.set(key, [symbol]);
            }
        }
    }

    remove(file: string): void {
        const existing = this.symbolsByFile.get(file);
        if (!existing) {
            return;
        }
        this.symbolsByFile.delete(file);
        for (const symbol of existing) {
            const key = symbol.name.toLowerCase();
            const bucket = this.nameIndex.get(key);
            if (!bucket) {
                continue;
            }
            const next = bucket.filter(
                e => !(e.relativePath === symbol.relativePath && e.lineNumber === symbol.lineNumber && e.name === symbol.name)
            );
            if (next.length === 0) {
                this.nameIndex.delete(key);
            } else {
                this.nameIndex.set(key, next);
            }
        }
    }

    search(query: string, _workspaceRoot: string, options: SearchOptions): SearchResult[] {
        const results: SearchResult[] = [];
        const push = (symbol: SymbolEntry) => {
            results.push({
                filePath: symbol.filePath,
                relativePath: symbol.relativePath,
                lineNumber: symbol.lineNumber,
                lineContent: symbol.lineContent,
                matchStart: symbol.lineContent.indexOf(symbol.name),
                matchLength: symbol.name.length,
            });
        };

        if (options.wholeWord && !options.regex) {
            // 精确匹配 —— 直接走 nameIndex 哈希，O(1) 查桶
            const candidates = this.nameIndex.get(query.toLowerCase()) ?? [];
            for (const symbol of candidates) {
                if (options.caseSensitive && symbol.name !== query) { continue; }
                push(symbol);
            }
        } else if (options.regex) {
            // 正则匹配 —— 桶粗过滤永远 case-insensitive(因桶名本身就是 lowercase),
            // 精确过滤用原 query 的 flag。这样 caseSensitive=true + 含大写 pattern
            // 不会被 lowercase 桶误跳。
            let coarseRe: RegExp;
            let exactRe: RegExp;
            try {
                coarseRe = new RegExp(query, 'i');
                exactRe = options.caseSensitive ? new RegExp(query) : coarseRe;
            } catch {
                return [];
            }
            for (const [name, symbols] of this.nameIndex) {
                if (!coarseRe.test(name)) { continue; }
                for (const symbol of symbols) {
                    if (exactRe.test(symbol.name)) { push(symbol); }
                }
            }
        } else {
            // 子串匹配 —— 桶粗过滤永远 lowercase(桶名本身就是 lowercase),
            // 精确过滤用原 query。caseSensitive=true + 含大写 query 不再被误跳。
            const coarseNeedle = query.toLowerCase();
            for (const [name, symbols] of this.nameIndex) {
                if (!name.includes(coarseNeedle)) { continue; }
                if (options.caseSensitive) {
                    for (const symbol of symbols) {
                        if (symbol.name.includes(query)) { push(symbol); }
                    }
                } else {
                    for (const symbol of symbols) { push(symbol); }
                }
            }
        }

        return results.sort(
            (a, b) => a.relativePath.localeCompare(b.relativePath) || a.lineNumber - b.lineNumber
        );
    }

    getStats(): { files: number; symbols: number } {
        let symbols = 0;
        for (const entries of this.symbolsByFile.values()) {
            symbols += entries.length;
        }
        return { files: this.symbolsByFile.size, symbols };
    }

    snapshot(): Map<string, SymbolEntry[]> {
        return new Map(this.symbolsByFile);
    }

    replaceAll(next: Map<string, SymbolEntry[]>): void {
        this.symbolsByFile.clear();
        this.nameIndex.clear();
        for (const [file, symbols] of next) {
            this.update(file, symbols);
        }
    }
}
