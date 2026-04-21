// src/storage/storageManager.ts
// 分片加载/保存、WAL 追加、压实与旧 JSON 迁移

import * as fs from 'fs';
import * as path from 'path';
import { decodeMessagePackMulti, encodeMessagePack } from './codec';
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
        this.chunkThreshold = options.chunkThreshold ?? 512;
    }

    private get indexDir(): string {
        return path.join(this.options.workspaceRoot, '.sisearch');
    }

    private get shardsDir(): string {
        return path.join(this.indexDir, 'shards');
    }

    async saveFull(snapshot: IndexSnapshot): Promise<void> {
        fs.mkdirSync(this.shardsDir, { recursive: true });
        const shardBuckets = this.bucketizeShards(snapshot);
        for (let i = 0; i < this.options.shardCount; i++) {
            this.writeShard(i, shardBuckets.get(i) ?? []);
        }
    }

    /**
     * 只重写受 dirtyPaths 影响的 shard。调用方负责确保 snapshot 反映的是
     * 最新全量状态（dirtyPaths 中的删除项应已从 snapshot 里移除，新增/修改
     * 项应已写入 snapshot）。
     */
    async saveDirty(snapshot: IndexSnapshot, dirtyPaths: Set<string>): Promise<void> {
        if (dirtyPaths.size === 0) { return; }
        fs.mkdirSync(this.shardsDir, { recursive: true });

        const dirtyShards = new Set<number>();
        for (const p of dirtyPaths) {
            dirtyShards.add(shardForPath(p, this.options.shardCount));
        }

        // 重新分桶整个 snapshot,但只写 dirtyShards
        const shardBuckets = this.bucketizeShards(snapshot);
        for (const shard of dirtyShards) {
            this.writeShard(shard, shardBuckets.get(shard) ?? []);
        }
    }

    private bucketizeShards(snapshot: IndexSnapshot): Map<number, ShardEntry[]> {
        const shardBuckets = new Map<number, ShardEntry[]>();
        for (const [relativePath, symbols] of snapshot.symbolsByFile) {
            const shard = shardForPath(relativePath, this.options.shardCount);
            const meta = snapshot.fileMetadata.get(relativePath) ?? { relativePath, mtime: 0, size: 0, symbolCount: symbols.length };
            const bucket = shardBuckets.get(shard) ?? [];
            bucket.push({ relativePath, symbols, metadata: meta });
            shardBuckets.set(shard, bucket);
        }
        return shardBuckets;
    }

    private writeShard(index: number, bucket: ShardEntry[]): void {
        const filePath = path.join(this.shardsDir, shardFileName(index));
        fs.writeFileSync(filePath, Buffer.from(encodeMessagePack(bucket)));
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
