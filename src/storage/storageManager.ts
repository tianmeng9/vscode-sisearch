// src/storage/storageManager.ts
// 分片加载/保存、WAL 追加、压实与旧 JSON 迁移

import * as fs from 'fs';
import * as path from 'path';
import { decodeMessagePackMulti } from './codec';
import { shardFileName, shardForPath } from './shardStrategy';
import { ShardStreamWriter } from './shardStreamWriter';
import type { SymbolEntry, IndexedFile } from '../index/indexTypes';

export interface IndexSnapshot {
    symbolsByFile: Map<string, SymbolEntry[]>;
    fileMetadata: Map<string, IndexedFile>;
}

interface ShardEntry {
    relativePath: string;
    symbols: SymbolEntry[];
    metadata: IndexedFile;
}

interface LegacyIndex {
    version: number;
    symbols: Record<string, SymbolEntry[]>;
    files: Record<string, IndexedFile>;
}

export class StorageManager {
    private readonly chunkThreshold: number;
    constructor(private options: { workspaceRoot: string; shardCount: number; chunkThreshold?: number }) {
        // Phase 5F:512 对 AMD GPU 驱动这种含 10+ MB 寄存器头、单文件 15 万符号的
        // 仓库太大 —— bucket flush 时一次 encodeMessagePack 要序列化 100 万级符号,
        // 峰值 Buffer 几百 MB。降到 128 让 bucket 更频繁 flush,单次 encode 规模 ÷ 4。
        // 对普通仓库影响几乎没有(小文件几乎立即填不满 bucket,flushAll 会兜底)。
        this.chunkThreshold = options.chunkThreshold ?? 128;
    }

    private get indexDir(): string {
        return path.join(this.options.workspaceRoot, '.sisearch');
    }

    private get shardsDir(): string {
        return path.join(this.indexDir, 'shards');
    }

    async saveFull(snapshot: IndexSnapshot): Promise<void> {
        // Full save = truncate existing shards then stream-write. Truncate prevents
        // stale appended chunks from previous runs contaminating the result.
        fs.mkdirSync(this.shardsDir, { recursive: true });
        for (let i = 0; i < this.options.shardCount; i++) {
            const p = path.join(this.shardsDir, shardFileName(i));
            if (fs.existsSync(p)) { fs.truncateSync(p, 0); }
        }
        const writer = this.openStreamWriter();
        try {
            for (const [relativePath, symbols] of snapshot.symbolsByFile) {
                const shard = shardForPath(relativePath, this.options.shardCount);
                const meta = snapshot.fileMetadata.get(relativePath)
                    ?? { relativePath, mtime: 0, size: 0, symbolCount: symbols.length };
                writer.add(shard, { relativePath, symbols, metadata: meta });
            }
            writer.flushAll();
        } finally {
            writer.close();
        }
    }

    /**
     * 只重写受 dirtyPaths 影响的 shard:先把这些 shard 从磁盘全量读回,
     * 应用 snapshot 里对应的最新内容(删除项 snapshot 里已无),
     * 然后 truncate + stream-write 这些 shard。
     */
    async saveDirty(snapshot: IndexSnapshot, dirtyPaths: Set<string>): Promise<void> {
        if (dirtyPaths.size === 0) { return; }
        fs.mkdirSync(this.shardsDir, { recursive: true });

        const dirtyShards = new Set<number>();
        for (const p of dirtyPaths) {
            dirtyShards.add(shardForPath(p, this.options.shardCount));
        }

        // Truncate each dirty shard FIRST so writer.add 追加的是干净文件。
        for (const shard of dirtyShards) {
            const p = path.join(this.shardsDir, shardFileName(shard));
            if (fs.existsSync(p)) { fs.truncateSync(p, 0); }
        }

        // Phase 5F:流式填入 writer,不再先建中间 entriesByShard Map。
        // writer 的 chunkThreshold bucket 到达阈值就 flush,内存上限 = 单 shard
        // bucket(512 entries),不是"全量 dirty shard × 所有文件"。
        // 2026-04-21 26k 文件 sync 时主线程堆打到 3.4 GB,就是因为 entriesByShard
        // 把所有 symbols 引用结构都堆在一张 map 里等,加上 encodeMessagePack 的
        // Buffer 开销,直接 OOM。
        const writer = this.openStreamWriter();
        try {
            for (const [relativePath, symbols] of snapshot.symbolsByFile) {
                const shard = shardForPath(relativePath, this.options.shardCount);
                if (!dirtyShards.has(shard)) { continue; }
                const meta = snapshot.fileMetadata.get(relativePath)
                    ?? { relativePath, mtime: 0, size: 0, symbolCount: symbols.length };
                writer.add(shard, { relativePath, symbols, metadata: meta });
            }
            writer.flushAll();
        } finally {
            writer.close();
        }
    }

    async load(): Promise<IndexSnapshot> {
        const symbolsByFile = new Map<string, SymbolEntry[]>();
        const fileMetadata = new Map<string, IndexedFile>();

        // Migrate legacy JSON format if present
        const legacyPath = path.join(this.indexDir, 'index.json');
        if (fs.existsSync(legacyPath)) {
            try {
                const raw = JSON.parse(fs.readFileSync(legacyPath, 'utf-8')) as LegacyIndex;
                for (const [rel, symbols] of Object.entries(raw.symbols ?? {})) {
                    symbolsByFile.set(rel, symbols);
                }
                for (const [rel, meta] of Object.entries(raw.files ?? {})) {
                    fileMetadata.set(rel, meta);
                }
                // Migrate to sharded format and remove legacy file
                await this.saveFull({ symbolsByFile: new Map(symbolsByFile), fileMetadata: new Map(fileMetadata) });
                fs.unlinkSync(legacyPath);
                return { symbolsByFile, fileMetadata };
            } catch {
                // Corrupt legacy file — ignore and fall through to shards
            }
        }

        if (!fs.existsSync(this.shardsDir)) {
            return { symbolsByFile, fileMetadata };
        }

        for (let i = 0; i < this.options.shardCount; i++) {
            const filePath = path.join(this.shardsDir, shardFileName(i));
            if (!fs.existsSync(filePath)) { continue; }
            this.readShardTolerant(filePath, symbolsByFile, fileMetadata);
        }

        return { symbolsByFile, fileMetadata };
    }

    private readShardTolerant(
        filePath: string,
        symbolsByFile: Map<string, SymbolEntry[]>,
        fileMetadata: Map<string, IndexedFile>,
    ): void {
        let buf: Buffer;
        try {
            buf = fs.readFileSync(filePath);
        } catch {
            return;
        }
        const iter = decodeMessagePackMulti<ShardEntry[]>(buf);
        while (true) {
            let result: IteratorResult<ShardEntry[]>;
            try {
                result = iter.next();
            } catch {
                // decoder choked on bad bytes (truncated tail or garbage) — stop, keep what we have
                return;
            }
            if (result.done) { return; }
            if (!Array.isArray(result.value)) {
                // Unexpected top-level shape (e.g. corrupt bytes that happened to msgpack-decode
                // to a scalar) — stop here rather than partially ingest nonsense.
                return;
            }
            for (const entry of result.value) {
                symbolsByFile.set(entry.relativePath, entry.symbols);
                fileMetadata.set(entry.relativePath, entry.metadata);
            }
        }
    }

    openStreamWriter(): ShardStreamWriter {
        fs.mkdirSync(this.shardsDir, { recursive: true });
        return new ShardStreamWriter({
            shardsDir: this.shardsDir,
            shardCount: this.options.shardCount,
            chunkThreshold: this.chunkThreshold,
        });
    }
}
