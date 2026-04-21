// src/sync/reentrancyGuard.ts
// 单并发闸门：同一时刻最多一个 task 在跑。
// 背景：用户点 Sync → 点 Cancel → 再点 Sync，若 WorkerPool.parse 的 await 还在
//       drain 上一轮文件,第二次 sync 会和第一次并行跑,共享 workerPool/index state,
//       内存近似翻倍,33k 文件级别的 workspace 直接把 VS Code 打崩。
//
// 语义:in-flight 期间任何 run() 调用都拿到同一个 promise。task resolve/reject
//      之后 guard 释放,下一个 run() 才真正执行。

export interface ReentrancyGuard {
    run<T>(task: () => Promise<T>): Promise<T>;
}

export function createReentrancyGuard(): ReentrancyGuard {
    let inFlight: Promise<unknown> | undefined;

    return {
        run<T>(task: () => Promise<T>): Promise<T> {
            if (inFlight) { return inFlight as Promise<T>; }
            const p = task().finally(() => {
                if (inFlight === p) { inFlight = undefined; }
            });
            inFlight = p;
            return p;
        },
    };
}
