// src/sync/workerDiag.ts
// Worker 崩溃前诊断日志 —— 用同步 append 保证 SIGABRT 前信息落盘。
//
// 背景:2026-04-21 Linux kernel drivers Sync 场景定位 exit 134 根因用的。
// Phase 4/5A-5H 逐步把崩溃治好,这套日志是定位工具,不是常驻设施。
//
// 默认关闭。设 SISEARCH_WORKER_DIAG=1 启用。启用后每次 sync 会在
// $TMPDIR/sisearch-worker-<pid>.log 里落 JSON Lines 日志(33k 文件仓库 ~10 MB)。
// 将来遇到新的大仓库崩溃,直接启用就能定位,无需改代码 + 重编译。
//
// 为什么用 fs.appendFileSync(同步):SIGABRT 直接杀进程,任何异步 IO 都被打断。
// 只有同步调用能保证崩前 flush。代价:每次 append 阻塞线程 <1 ms,只在启用时付出。

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * 日志事件类型 —— 覆盖 worker 生命周期和每个文件的处理前/后。
 */
export type DiagEvent =
    | 'worker:start'
    | 'worker:exit'
    | 'worker:uncaughtException'
    | 'worker:unhandledRejection'
    | 'file:entered'       // fs.readFileSync 之前
    | 'file:readDone'      // fs.readFileSync 之后,parseSymbols 之前
    | 'file:parseDone'     // parseSymbols 返回后
    | 'file:error';        // 捕获到 catch 块

/**
 * 格式化单行诊断为 JSON Lines(一行一个事件,jq/grep 友好)。
 *
 * timestamp 使用 Date.now() 毫秒,便于与 Crashpad dump / VS Code main.log 对齐。
 */
export function formatDiagLine(event: DiagEvent, payload: Record<string, unknown>): string {
    const entry = {
        t: Date.now(),
        event,
        pid: typeof process !== 'undefined' ? process.pid : 0,
        ...payload,
    };
    return JSON.stringify(entry) + '\n';
}

/**
 * 诊断日志是否启用。通过环境变量 SISEARCH_WORKER_DIAG=1 打开。
 *
 * 默认关闭 —— appendDiag 会变成一个便宜的 no-op:调用者可以无脑调用而
 * 不用自己判断 env,性能零影响。每次调用重读 env,便于测试时临时切换。
 */
export function isDiagEnabled(): boolean {
    return process.env.SISEARCH_WORKER_DIAG === '1';
}

/**
 * 同步 append 到 logPath。目录不存在则创建。不抛错(诊断失败不能影响主流程)。
 *
 * 未启用诊断时直接返回,不做任何 IO 或对象构造 —— 保证 per-file 调用零开销。
 */
export function appendDiag(logPath: string, event: DiagEvent, payload: Record<string, unknown>): void {
    if (!isDiagEnabled()) { return; }
    try {
        const dir = path.dirname(logPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.appendFileSync(logPath, formatDiagLine(event, payload), { encoding: 'utf-8' });
    } catch {
        // 诊断失败保持沉默 —— 不能让日志写失败反过来把 worker 搞崩。
    }
}

/**
 * 决定 worker 诊断日志写到哪里。
 *
 * 策略:tmpdir + pid —— 每次 F5 新文件,互不覆盖;pid 可与 VS Code main.log 的
 * "Extension host with pid X exited with code 134" 交叉对应;/tmp 系统重启自动清理。
 *
 * 想找最新一次?`ls -t /tmp/sisearch-worker-*.log | head -1` 或直接按 pid 查。
 */
export function resolveDiagLogPath(): string {
    return path.join(os.tmpdir(), `sisearch-worker-${process.pid}.log`);
}
