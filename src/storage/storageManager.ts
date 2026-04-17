// src/storage/storageManager.ts
// 分片加载/保存、WAL 追加、压实与旧 JSON 迁移

import * as fs from 'fs';
import * as path from 'path';
import { decodeMessagePack, encodeMessagePack } from './codec';
import { shardFileName, shardForPath } from './shardStrategy';
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
    constructor(private options: { workspaceRoot: string; shardCount: number }) {}

    private get indexDir(): string {
        return path.join(this.options.workspaceRoot, '.sisearch');
    }

    private get shardsDir(): string {
        return path.join(this.indexDir, 'shards');
    }

    async saveFull(snapshot: IndexSnapshot): Promise<void> {
        fs.mkdirSync(this.shardsDir, { recursive: true });

        const shardBuckets = new Map<number, ShardEntry[]>();
        for (const [relativePath, symbols] of snapshot.symbolsByFile) {
            const shard = shardForPath(relativePath, this.options.shardCount);
            const meta = snapshot.fileMetadata.get(relativePath) ?? { relativePath, mtime: 0, size: 0, symbolCount: symbols.length };
            const bucket = shardBuckets.get(shard) ?? [];
            bucket.push({ relativePath, symbols, metadata: meta });
            shardBuckets.set(shard, bucket);
        }

        for (let i = 0; i < this.options.shardCount; i++) {
            const filePath = path.join(this.shardsDir, shardFileName(i));
            const bucket = shardBuckets.get(i) ?? [];
            fs.writeFileSync(filePath, Buffer.from(encodeMessagePack(bucket)));
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
            if (!fs.existsSync(filePath)) {
                continue;
            }
            try {
                const entries = decodeMessagePack<ShardEntry[]>(fs.readFileSync(filePath));
                for (const entry of entries) {
                    symbolsByFile.set(entry.relativePath, entry.symbols);
                    fileMetadata.set(entry.relativePath, entry.metadata);
                }
            } catch {
                // Corrupt shard — skip
            }
        }

        return { symbolsByFile, fileMetadata };
    }
}
