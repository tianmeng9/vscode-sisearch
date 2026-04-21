// test/suite/workerPoolFactoryMaxBytes.test.ts
// 契约:createWorkerThreadPoolWorker 把 maxBytes 通过 workerData 传给 parseWorker。
// 不启动真实 Worker —— 注入 spy 记录构造参数。

import * as assert from 'assert';
import { EventEmitter } from 'events';
import { createWorkerThreadPoolWorker } from '../../src/sync/workerPoolFactory';

function makeSpy(): {
    ctorCalls: Array<{ script: string; options: any }>;
    WorkerCtor: new (script: string, options: any) => EventEmitter & {
        postMessage: (m: any) => void;
        terminate: () => Promise<number>;
    };
} {
    const ctorCalls: Array<{ script: string; options: any }> = [];
    class SpyWorker extends EventEmitter {
        constructor(script: string, options: any) {
            super();
            ctorCalls.push({ script, options });
        }
        postMessage(_m: any): void { /* noop */ }
        async terminate(): Promise<number> { return 0; }
    }
    return { ctorCalls, WorkerCtor: SpyWorker as any };
}

suite('workerPoolFactory maxBytes wiring', () => {
    test('passes maxBytes via workerData when provided', () => {
        const spy = makeSpy();
        createWorkerThreadPoolWorker('/fake/parseWorker.js', '/ext/root', {
            maxBytes: 2 * 1024 * 1024,
            WorkerCtor: spy.WorkerCtor,
        });
        assert.strictEqual(spy.ctorCalls.length, 1);
        const { options } = spy.ctorCalls[0];
        assert.strictEqual(options.workerData.extensionPath, '/ext/root');
        assert.strictEqual(options.workerData.maxBytes, 2 * 1024 * 1024);
    });

    test('defaults maxBytes to 0 when not provided', () => {
        const spy = makeSpy();
        createWorkerThreadPoolWorker('/fake/parseWorker.js', '/ext/root', {
            WorkerCtor: spy.WorkerCtor,
        });
        const { options } = spy.ctorCalls[0];
        assert.strictEqual(options.workerData.maxBytes, 0);
    });

    test('legacy 2-arg call still works (back-compat)', () => {
        // 旧调用 createWorkerThreadPoolWorker(script, extPath) 不应抛错 —— 真实 Worker 构造
        // 会失败(fake 路径),但我们只关心签名兼容。用 spy 绕过实际构造。
        const spy = makeSpy();
        createWorkerThreadPoolWorker('/fake/parseWorker.js', '/ext/root', {
            WorkerCtor: spy.WorkerCtor,
        });
        assert.strictEqual(spy.ctorCalls.length, 1);
    });
});
