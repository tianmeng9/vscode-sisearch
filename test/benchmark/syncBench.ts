// test/benchmark/syncBench.ts
// Sync 性能基准 — 测量 SyncOrchestrator 调度 1000 个 fixture 文件的耗时

import { performance } from 'perf_hooks';
import { SyncOrchestrator } from '../../src/sync/syncOrchestrator';
import type { SymbolEntry } from '../../src/index/indexTypes';

const BASELINE_MS = 500;
const FILE_COUNT = 1000;

async function main(): Promise<void> {
    const symbols: SymbolEntry[] = [
        { name: 'fn', kind: 'function', filePath: '', relativePath: '', lineNumber: 1, endLineNumber: 1, column: 0, lineContent: '' },
    ];

    const orchestrator = new SyncOrchestrator({
        scanFiles: async () =>
            Array.from({ length: FILE_COUNT }, (_, i) => ({
                relativePath: `file${i}.c`,
                absPath: `/workspace/file${i}.c`,
                mtime: i,
                size: i * 10,
            })),
        classify: async ({ currentFiles }) => ({
            toProcess: currentFiles,
            toDelete: [],
        }),
        workerPool: {
            // Task 8 changed parse() from returning ParseBatchResult to a callback-driven void.
            // Emit one batch carrying all fixture files — matches the pre-refactor semantics for
            // benchmarking purposes (single synchronous delivery, no back-pressure delay).
            parse: async (files, onBatchResult) => {
                await onBatchResult({
                    symbols: files.flatMap(f => symbols.map(s => ({ ...s, filePath: f.absPath, relativePath: f.relativePath }))),
                    metadata: files.map(f => ({ relativePath: f.relativePath, mtime: 1, size: 100, symbolCount: 1 })),
                    errors: [],
                });
            },
        },
        index: {
            update: () => {},
            remove: () => {},
            applyMetadata: () => {},
        },
        storage: { saveFull: async () => {} },
        getSnapshot: () => ({ symbolsByFile: new Map(), fileMetadata: new Map() }),
    });

    const start = performance.now();
    await orchestrator.synchronize({ workspaceRoot: '/workspace' });
    const elapsed = performance.now() - start;

    const result = { name: 'sync', files: FILE_COUNT, elapsedMs: Math.round(elapsed) };
    console.log(JSON.stringify(result));

    if (elapsed > BASELINE_MS * 1.2) {
        console.warn(`Benchmark regression: ${elapsed.toFixed(1)}ms > ${BASELINE_MS * 1.2}ms baseline`);
    }
}

void main();
