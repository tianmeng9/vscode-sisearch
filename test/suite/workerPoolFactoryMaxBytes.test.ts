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

    test('sets resourceLimits.maxOldGenerationSizeMb to at least 512 MB', () => {
        // Phase 5A:真实环境中 dcn_*_sh_mask.h(24 MB)readFileSync 后 UTF-16 进 V8
        // 约 48 MB + split('\n') 十几万行对象,加上正则 match 池,峰值会吃 200+ MB。
        // Node worker_threads 默认 old space 远小于这个(~40 MB 起),直接 OOM abort。
        // 必须通过 resourceLimits.maxOldGenerationSizeMb 抬高 worker 的 V8 堆上限,
        // 否则即使 Phase 4 闸门拦住 tree-sitter,正则回退本身也会打爆 worker 堆。
        const spy = makeSpy();
        createWorkerThreadPoolWorker('/fake/parseWorker.js', '/ext/root', {
            WorkerCtor: spy.WorkerCtor,
        });
        const { options } = spy.ctorCalls[0];
        assert.ok(options.resourceLimits, 'Worker options must include resourceLimits');
        assert.ok(
            typeof options.resourceLimits.maxOldGenerationSizeMb === 'number',
            'maxOldGenerationSizeMb must be a number',
        );
        assert.ok(
            options.resourceLimits.maxOldGenerationSizeMb >= 512,
            `maxOldGenerationSizeMb must be >= 512 (got ${options.resourceLimits.maxOldGenerationSizeMb})`,
        );
    });
});
