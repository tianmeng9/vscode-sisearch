// test/benchmark/storageBench.ts
// 存储性能基准 — 测量 MessagePack 编解码 10k 条目的耗时与体积

import { performance } from 'perf_hooks';
import { decodeMessagePack, encodeMessagePack } from '../../src/storage/codec';

const BASELINE_MS = 300;
const ENTRY_COUNT = 10000;

async function main(): Promise<void> {
    const payload = {
        files: Array.from({ length: ENTRY_COUNT }, (_, i) => ({
            relativePath: `src/file${i}.c`,
            mtime: Date.now() - i * 1000,
            size: (i + 1) * 512,
            symbolCount: (i % 10) + 1,
        })),
    };

    const encStart = performance.now();
    const encoded = encodeMessagePack(payload);
    const encElapsed = performance.now() - encStart;

    const decStart = performance.now();
    const decoded = decodeMessagePack<typeof payload>(encoded);
    const decElapsed = performance.now() - decStart;

    const totalElapsed = encElapsed + decElapsed;
    const result = {
        name: 'storage',
        entries: ENTRY_COUNT,
        encodeMs: Math.round(encElapsed * 100) / 100,
        decodeMs: Math.round(decElapsed * 100) / 100,
        elapsedMs: Math.round(totalElapsed * 100) / 100,
        bytes: encoded.byteLength,
        decodedEntries: decoded.files.length,
    };
    console.log(JSON.stringify(result));

    if (totalElapsed > BASELINE_MS * 1.2) {
        console.warn(`Benchmark regression: ${totalElapsed.toFixed(1)}ms > ${BASELINE_MS * 1.2}ms baseline`);
    }
}

void main();
