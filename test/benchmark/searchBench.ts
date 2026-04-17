// test/benchmark/searchBench.ts
// 搜索性能基准 — 测量 50k symbol 索引下的搜索耗时

import { performance } from 'perf_hooks';
import { SymbolIndex } from '../../src/index/symbolIndex';

const BASELINE_MS = 50;
const SYMBOL_COUNT = 50000;

async function main(): Promise<void> {
    const index = new SymbolIndex();

    // 预填 50k symbols
    const filesPerBatch = 500;
    const symbolsPerFile = SYMBOL_COUNT / filesPerBatch;

    for (let f = 0; f < filesPerBatch; f++) {
        const rel = `src/file${f}.c`;
        const symbols = Array.from({ length: symbolsPerFile }, (_, i) => ({
            name: `handler_${f}_${i}`,
            kind: 'function' as const,
            filePath: `/workspace/${rel}`,
            relativePath: rel,
            lineNumber: i + 1,
            endLineNumber: i + 1,
            column: 0,
            lineContent: `void handler_${f}_${i}() {}`,
        }));
        index.update(rel, symbols);
    }

    const opts = { caseSensitive: false, wholeWord: false, regex: false };

    // Warmup
    index.search('handler', '/workspace', opts);

    const start = performance.now();
    const results = index.search('handler', '/workspace', opts);
    const elapsed = performance.now() - start;

    const result = { name: 'search', symbols: SYMBOL_COUNT, matches: results.length, elapsedMs: Math.round(elapsed * 100) / 100 };
    console.log(JSON.stringify(result));

    if (elapsed > BASELINE_MS * 1.2) {
        console.warn(`Benchmark regression: ${elapsed.toFixed(1)}ms > ${BASELINE_MS * 1.2}ms baseline`);
    }
}

void main();
