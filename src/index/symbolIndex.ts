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
        const needle = options.caseSensitive ? query : query.toLowerCase();
        const results: SearchResult[] = [];

        for (const symbols of this.symbolsByFile.values()) {
            for (const symbol of symbols) {
                const haystack = options.caseSensitive ? symbol.name : symbol.name.toLowerCase();
                if (haystack === needle || haystack.includes(needle)) {
                    results.push({
                        filePath: symbol.filePath,
                        relativePath: symbol.relativePath,
                        lineNumber: symbol.lineNumber,
                        lineContent: symbol.lineContent,
                        matchStart: symbol.lineContent.indexOf(symbol.name),
                        matchLength: symbol.name.length,
                    });
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
