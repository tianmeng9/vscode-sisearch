// src/storage/shardStrategy.ts
// FNV-1a 分片哈希与分桶

export function fnv1a(input: string): number {
    let hash = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}

export function shardForPath(relativePath: string, shardCount: number): number {
    return fnv1a(relativePath) % shardCount;
}

export function shardFileName(index: number): string {
    return index.toString(16).padStart(2, '0') + '.msgpack';
}
