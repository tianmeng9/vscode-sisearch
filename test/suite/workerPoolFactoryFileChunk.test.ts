// test/suite/workerPoolFactoryFileChunk.test.ts
// Phase 5C-H 契约:
//   1. factory 必须把多条 'fileChunk' 消息的 symbols/metadata/errors 累积
//   2. 最终 'batchResult' 到达时合并 resolve
//   3. 即便 fileChunk 有 0 条、batchResult symbols 也为 0,资源也要能 resolve 空结果

import * as assert from 'assert';
import { EventEmitter } from 'events';
import { createWorkerThreadPoolWorker } from '../../src/sync/workerPoolFactory';

function makeSpy() {
    let lastWorker: any = null;
    class SpyWorker extends EventEmitter {
        postedMessages: any[] = [];
        constructor(_script: string, _options: any) {
            super();
            lastWorker = this;
        }
        postMessage(m: any): void { this.postedMessages.push(m); }
        async terminate(): Promise<number> { return 0; }
    }
    return {
        WorkerCtor: SpyWorker as any,
        getWorker: () => lastWorker as InstanceType<typeof SpyWorker>,
    };
}

suite('workerPoolFactory fileChunk accumulation', () => {
    test('aggregates fileChunk messages before batchResult', async () => {
        const spy = makeSpy();
        const pw = createWorkerThreadPoolWorker('/fake.js', '/ext', {
            WorkerCtor: spy.WorkerCtor,
        });
        const promise = pw.parseBatch([
            { absPath: '/a', relativePath: 'a' },
            { absPath: '/b', relativePath: 'b' },
        ]);
        const w = spy.getWorker();
        // 模拟 worker 分两批 flush,再发 batchResult
        const reqId = w.postedMessages[0].requestId;
        w.emit('message', {
            type: 'fileChunk', requestId: reqId,
            symbols: [{ name: 'a_sym' } as any],
            metadata: [{ relativePath: 'a', size: 100, mtime: 0, symbolCount: 1 } as any],
            errors: [],
        });
        w.emit('message', {
            type: 'fileChunk', requestId: reqId,
            symbols: [{ name: 'b_sym' } as any],
            metadata: [{ relativePath: 'b', size: 200, mtime: 0, symbolCount: 1 } as any],
            errors: ['b: oops'],
        });
        w.emit('message', {
            type: 'batchResult', requestId: reqId,
            symbols: [], metadata: [], errors: [],
        });
        const result = await promise;
        assert.strictEqual(result.symbols.length, 2);
        assert.strictEqual(result.metadata.length, 2);
        assert.strictEqual(result.errors.length, 1);
        assert.strictEqual((result.symbols[0] as any).name, 'a_sym');
        assert.strictEqual((result.symbols[1] as any).name, 'b_sym');
    });

    test('resolves empty result when no fileChunk and empty batchResult', async () => {
        const spy = makeSpy();
        const pw = createWorkerThreadPoolWorker('/fake.js', '/ext', {
            WorkerCtor: spy.WorkerCtor,
        });
        const promise = pw.parseBatch([{ absPath: '/a', relativePath: 'a' }]);
        const w = spy.getWorker();
        const reqId = w.postedMessages[0].requestId;
        w.emit('message', {
            type: 'batchResult', requestId: reqId,
            symbols: [], metadata: [], errors: [],
        });
        const result = await promise;
        assert.strictEqual(result.symbols.length, 0);
        assert.strictEqual(result.metadata.length, 0);
        assert.strictEqual(result.errors.length, 0);
    });
});
