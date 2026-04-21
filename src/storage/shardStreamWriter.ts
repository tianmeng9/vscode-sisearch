// src/storage/shardStreamWriter.ts
// Per-shard bucket accumulator. 每个 shard 一个内存桶;达到 chunkThreshold 时
// encode 为 msgpack chunk 并 appendFileSync 到 shard 文件。
// 生命周期:对应一次 sync。orchestrator 调用 close()/flushAll() 释放。

import * as fs from 'fs';
import * as path from 'path';
import { encodeMessagePack } from './codec';
import { shardFileName } from './shardStrategy';
import type { SymbolEntry, IndexedFile } from '../index/indexTypes';

export interface ShardEntry {
    relativePath: string;
    symbols: SymbolEntry[];
    metadata: IndexedFile;
}

export interface ShardStreamWriterOptions {
    shardsDir: string;
    shardCount: number;
    chunkThreshold: number;
}

export class ShardStreamWriter {
    private readonly buckets: ShardEntry[][];
    private closed = false;

    constructor(private readonly opts: ShardStreamWriterOptions) {
        this.buckets = Array.from({ length: opts.shardCount }, () => []);
    }

    add(shard: number, entry: ShardEntry): void {
        if (this.closed) { throw new Error('ShardStreamWriter is closed'); }
        const bucket = this.buckets[shard];
        bucket.push(entry);
        if (bucket.length >= this.opts.chunkThreshold) {
            this.flushBucket(shard);
        }
    }

    flushAll(): void {
        if (this.closed) { return; }
        for (let i = 0; i < this.buckets.length; i++) {
            if (this.buckets[i].length > 0) { this.flushBucket(i); }
        }
    }

    close(): void {
        this.closed = true;
    }

    private flushBucket(shard: number): void {
        const chunk = this.buckets[shard];
        if (chunk.length === 0) { return; }
        this.buckets[shard] = [];
        const filePath = path.join(this.opts.shardsDir, shardFileName(shard));
        fs.appendFileSync(filePath, Buffer.from(encodeMessagePack(chunk)));
    }
}
