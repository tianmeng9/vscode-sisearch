import * as fs from 'fs';

interface CacheEntry {
    mtimeMs: number;
    lines: string[];
}

/**
 * 按 (absPath, lineNumber) 读行,带 LRU cache。
 *
 * 搜索路径原来存 lineContent 在内存索引里,数百 MB 浪费。现在搜索命中时
 * 才从源文件读;LRU 保最近访问的 N 个文件的整行数组(单文件 1-2 MB 量级)。
 * mtime 变化时 cache invalidate。
 */
export class LineContentReader {
    private cache = new Map<string, CacheEntry>();
    constructor(private readonly capacity: number = 100) {}

    read(absPath: string, lineNumber: number): string {
        if (lineNumber < 1) { return ''; }
        const entry = this.getOrLoad(absPath);
        if (!entry) { return ''; }
        const idx = lineNumber - 1;
        if (idx >= entry.lines.length) { return ''; }
        return entry.lines[idx];
    }

    private getOrLoad(absPath: string): CacheEntry | undefined {
        try {
            const stat = fs.statSync(absPath);
            const cached = this.cache.get(absPath);
            if (cached && cached.mtimeMs === stat.mtimeMs) {
                // LRU bump:delete + set
                this.cache.delete(absPath);
                this.cache.set(absPath, cached);
                return cached;
            }
            const content = fs.readFileSync(absPath, 'utf-8');
            const lines = content.split('\n');
            const entry: CacheEntry = { mtimeMs: stat.mtimeMs, lines };
            this.cache.set(absPath, entry);
            this.evictIfNeeded();
            return entry;
        } catch {
            return undefined;
        }
    }

    private evictIfNeeded(): void {
        while (this.cache.size > this.capacity) {
            const firstKey = this.cache.keys().next().value;
            if (!firstKey) { break; }
            this.cache.delete(firstKey);
        }
    }

    /** 测试钩子。 */
    _sizeForTest(): number { return this.cache.size; }
}
