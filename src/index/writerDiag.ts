// src/index/writerDiag.ts
// DB writer 诊断日志。跟 sync/workerDiag 同构:同步 append + 可选 env gate。
//
// 启用:SISEARCH_WORKER_DIAG=1(复用 sync 侧同一 env,方便同时打开)。
// 输出:$TMPDIR/sisearch-writer-<pid>-<role>.log
//   role = 'main' (主线程 client 侧) 或 'worker' (writer worker 侧)
//
// 事件覆盖两条链路:
//   主线程:postBatch 发送、drain/checkpoint 发送、ack 接收、timeout、dispose
//   worker:message 到达、handler 开始、handler 完成/抛错、close
//
// 目的:定位"sync 已完,但 UI 卡在 Saving Index"这类问题 — 主线程/worker 任何
// 一方消息丢了或卡了,日志能指出最后一次通信点。

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type WriterDiagEvent =
    // Main-thread client side
    | 'client:spawn'
    | 'client:postBatch'
    | 'client:postDrain'
    | 'client:postCheckpoint'
    | 'client:postClose'
    | 'client:ackReceived'
    | 'client:batchDoneReceived'
    | 'client:errorReceived'
    | 'client:workerError'
    | 'client:workerExit'
    | 'client:timeout'
    | 'client:disposeStart'
    | 'client:disposeDone'
    // Worker side
    | 'worker:start'
    | 'worker:dbOpen'
    | 'worker:messageReceived'
    | 'worker:batchStart'
    | 'worker:batchDone'
    | 'worker:drainReceived'
    | 'worker:drainAckSent'
    | 'worker:checkpointStart'
    | 'worker:checkpointDone'
    | 'worker:checkpointAckSent'
    | 'worker:closeReceived'
    | 'worker:error'
    | 'worker:uncaughtException'
    // Query side (main thread readonly path)
    | 'query:start'
    | 'query:done'
    | 'query:error';

function isEnabled(): boolean {
    return process.env.SISEARCH_WORKER_DIAG === '1';
}

export function resolveWriterLogPath(role: 'main' | 'worker'): string {
    return path.join(os.tmpdir(), `sisearch-writer-${process.pid}-${role}.log`);
}

export function formatWriterDiagLine(
    role: 'main' | 'worker',
    event: WriterDiagEvent,
    payload: Record<string, unknown>,
): string {
    const entry = {
        t: Date.now(),
        role,
        event,
        pid: typeof process !== 'undefined' ? process.pid : 0,
        ...payload,
    };
    return JSON.stringify(entry) + '\n';
}

/**
 * 同步 append。默认 gated by env;未启用是便宜 no-op(env 读一次)。
 * 不抛错:诊断失败不能影响主流程。
 */
export function writerDiag(
    role: 'main' | 'worker',
    event: WriterDiagEvent,
    payload: Record<string, unknown> = {},
): void {
    if (!isEnabled()) { return; }
    try {
        const logPath = resolveWriterLogPath(role);
        const dir = path.dirname(logPath);
        if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
        fs.appendFileSync(logPath, formatWriterDiagLine(role, event, payload), { encoding: 'utf-8' });
    } catch {
        // silent
    }
}
