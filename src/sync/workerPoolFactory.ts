// src/sync/workerPoolFactory.ts
// 用 worker_threads 构造真实的 PoolWorker — 每个 worker 持有独立的
// tree-sitter 解析器实例,主线程通过消息协议派发批次并聚合结果。

import * as path from 'path';
import { Worker } from 'worker_threads';
import type { PoolWorker, ParseBatchResult } from './workerPool';

/**
 * Worker 构造参数。
 *
 * maxBytes:透传给 parseWorker → parseSymbols 的大文件阈值。0 = 禁用(始终 tree-sitter),
 *   正整数 = content.length >= maxBytes 时走正则回退。详见 ParseOptions。
 *
 * WorkerCtor:测试注入点。生产代码用默认的 worker_threads.Worker;测试可注入 spy
 *   来验证 workerData 真的带上了 maxBytes,不必启动真实线程。
 */
/**
 * Worker V8 old space 上限(MB)。
 *
 * 依据(2026-04-21 AMD GPU driver crash dump 分析):
 *   Linux kernel driver 目录下 dcn_3_2_0_sh_mask.h 约 24 MB;fs.readFileSync(utf-8)
 *   后以 V8 UTF-16 string 常驻 ~48 MB,再经 content.split('\n')(约 13 万行对象)
 *   和全局正则 match 池,峰值老年代可轻易打到 200+ MB。Node worker_threads 的
 *   maxOldGenerationSizeMb 默认值远低于此(主机内存小时甚至 < 100 MB),会触发
 *   V8 "last resort; GC in old space requested" → process.abort() → extension
 *   host exit 134。1024 MB 给足余量:够吃下单个极端大文件,且保留并发多 worker
 *   同时跑的空间。代价:worker 常驻上限变大,但 V8 按需分配,实际占用仍随负载。
 *
 * 这只是"闸门抬高",不是根治 —— Phase 5B 会把 largeFileParser 改流式,
 * 从源头避免整文件进堆。两道防线并存:Phase 5B 防住 99% 的文件,5A 兜底剩下的。
 */
const WORKER_MAX_OLD_GEN_MB = 1024;

export interface WorkerThreadPoolWorkerOptions {
    maxBytes?: number;
    WorkerCtor?: new (script: string, options: {
        workerData: unknown;
        resourceLimits?: { maxOldGenerationSizeMb?: number };
    }) => {
        on(event: 'message', listener: (msg: any) => void): void;
        on(event: 'error', listener: (err: Error) => void): void;
        on(event: 'exit', listener: (code: number) => void): void;
        postMessage(msg: unknown): void;
        terminate(): Promise<number>;
    };
}

interface BatchResultMessage {
    type: 'batchResult';
    requestId: number;
    symbols: ParseBatchResult['symbols'];
    metadata: ParseBatchResult['metadata'];
    errors: string[];
}

/**
 * Phase 5C-H:增量消息,每个文件处理完就发一条,避免 worker 跨文件累积。
 * 主线程在 batchResult 到来之前 accumulate 所有 chunk,再 resolve 合并结果。
 */
interface FileChunkMessage {
    type: 'fileChunk';
    requestId: number;
    symbols: ParseBatchResult['symbols'];
    metadata: ParseBatchResult['metadata'];
    errors: string[];
}

type WorkerMessage = BatchResultMessage | FileChunkMessage;

interface PendingBatch {
    resolve(result: ParseBatchResult): void;
    reject(err: Error): void;
    // chunk 累积器
    symbols: ParseBatchResult['symbols'];
    metadata: ParseBatchResult['metadata'];
    errors: string[];
}

/**
 * 创建一个基于 worker_threads 的 PoolWorker。workerScriptPath 必须是已编译的
 * parseWorker.js 的绝对路径(通常是 `path.join(extensionPath, 'out/src/sync/parseWorker.js')`)。
 */
export function createWorkerThreadPoolWorker(
    workerScriptPath: string,
    extensionPath: string,
    options: WorkerThreadPoolWorkerOptions = {},
): PoolWorker {
    const WorkerCtor = options.WorkerCtor ?? (Worker as unknown as NonNullable<WorkerThreadPoolWorkerOptions['WorkerCtor']>);
    const maxBytes = options.maxBytes ?? 0;
    const worker = new WorkerCtor(workerScriptPath, {
        workerData: { extensionPath, maxBytes },
        resourceLimits: { maxOldGenerationSizeMb: WORKER_MAX_OLD_GEN_MB },
    });

    let nextRequestId = 1;
    const pending = new Map<number, PendingBatch>();
    let disposed = false;
    let initError: Error | undefined;

    worker.on('message', (msg: WorkerMessage) => {
        const p = pending.get(msg.requestId);
        if (!p) { return; }
        if (msg.type === 'fileChunk') {
            // 累积到 pending 槽,worker 侧已经 copy 过不持有了
            if (msg.symbols.length) { p.symbols.push(...msg.symbols); }
            if (msg.metadata.length) { p.metadata.push(...msg.metadata); }
            if (msg.errors.length) { p.errors.push(...msg.errors); }
            return;
        }
        if (msg.type === 'batchResult') {
            // 批次结束:用累积的 chunk + 最后一条 batchResult 里可能的残留合并 resolve
            pending.delete(msg.requestId);
            if (msg.symbols.length) { p.symbols.push(...msg.symbols); }
            if (msg.metadata.length) { p.metadata.push(...msg.metadata); }
            if (msg.errors.length) { p.errors.push(...msg.errors); }
            p.resolve({ symbols: p.symbols, metadata: p.metadata, errors: p.errors });
        }
    });

    worker.on('error', err => {
        initError = err;
        for (const p of pending.values()) { p.reject(err); }
        pending.clear();
    });

    worker.on('exit', code => {
        if (code !== 0 && !disposed) {
            const err = new Error(`parseWorker exited with code ${code}`);
            initError = err;
            for (const p of pending.values()) { p.reject(err); }
            pending.clear();
        }
    });

    return {
        async parseBatch(files) {
            if (initError) { throw initError; }
            if (disposed) { throw new Error('worker disposed'); }
            if (files.length === 0) { return { symbols: [], metadata: [], errors: [] }; }

            const requestId = nextRequestId++;
            return new Promise<ParseBatchResult>((resolve, reject) => {
                pending.set(requestId, {
                    resolve,
                    reject,
                    symbols: [],
                    metadata: [],
                    errors: [],
                });
                worker.postMessage({ type: 'parseBatch', requestId, files });
            });
        },

        async dispose() {
            disposed = true;
            for (const p of pending.values()) {
                p.reject(new Error('worker disposed'));
            }
            pending.clear();
            await worker.terminate();
        },
    };
}

/**
 * 构造 WorkerPool 可直接使用的 factory。返回的 factory 每次调用生成一个新的
 * PoolWorker(用于线程池尺寸 > 1 的情况)。
 */
export function createWorkerThreadFactory(
    extensionPath: string,
    options: { maxBytes?: number } = {},
): () => Promise<PoolWorker> {
    const workerScriptPath = path.join(extensionPath, 'out', 'src', 'sync', 'parseWorker.js');
    return async () => createWorkerThreadPoolWorker(workerScriptPath, extensionPath, {
        maxBytes: options.maxBytes,
    });
}
