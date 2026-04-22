import * as assert from 'assert';
import { EventEmitter } from 'events';
import { DbWriterClient } from '../../src/index/dbWriterClient';

function makeSpy(): {
    ctorCalls: Array<{ script: string; options: any }>;
    posted: any[];
    WorkerCtor: new (script: string, options: any) => EventEmitter & {
        postMessage: (m: any) => void;
        terminate: () => Promise<number>;
    };
    instance: () => any;
} {
    const ctorCalls: Array<{ script: string; options: any }> = [];
    const posted: any[] = [];
    let current: any;
    class SpyWorker extends EventEmitter {
        constructor(script: string, options: any) {
            super();
            ctorCalls.push({ script, options });
            current = this;
        }
        postMessage(m: any): void { posted.push(m); }
        async terminate(): Promise<number> { return 0; }
    }
    return { ctorCalls, posted, WorkerCtor: SpyWorker as any, instance: () => current };
}

suite('DbWriterClient', () => {
    test('spawns worker with workerData.dbPath', () => {
        const spy = makeSpy();
        const c = new DbWriterClient({
            workerScriptPath: '/fake/writer.js',
            dbPath: '/tmp/x.sqlite',
            WorkerCtor: spy.WorkerCtor,
        });
        assert.strictEqual(spy.ctorCalls.length, 1);
        assert.strictEqual(spy.ctorCalls[0].script, '/fake/writer.js');
        assert.strictEqual(spy.ctorCalls[0].options.workerData.dbPath, '/tmp/x.sqlite');
        // quiet teardown
        spy.instance().emit('exit', 0);
    });

    test('postBatch sends batch message and returns synchronously', () => {
        const spy = makeSpy();
        const c = new DbWriterClient({
            workerScriptPath: '/fake', dbPath: ':memory:', WorkerCtor: spy.WorkerCtor,
        });
        c.postBatch({ metadata: [], symbols: [], deletedRelativePaths: [] });
        c.postBatch({ metadata: [], symbols: [], deletedRelativePaths: [] });
        assert.strictEqual(spy.posted.length, 2);
        assert.strictEqual(spy.posted[0].type, 'batch');
        assert.strictEqual(spy.posted[0].seq, 1);
        assert.strictEqual(spy.posted[1].seq, 2);
    });

    test('drain resolves after all in-flight batches + drain ack', async () => {
        const spy = makeSpy();
        const c = new DbWriterClient({
            workerScriptPath: '/fake', dbPath: ':memory:', WorkerCtor: spy.WorkerCtor,
        });
        c.postBatch({ metadata: [], symbols: [], deletedRelativePaths: [] });
        c.postBatch({ metadata: [], symbols: [], deletedRelativePaths: [] });
        const drainPromise = c.drain();
        // Simulate worker acks
        const w = spy.instance();
        w.emit('message', { type: 'batchDone', seq: 1 });
        w.emit('message', { type: 'batchDone', seq: 2 });
        // drain is seq 3
        w.emit('message', { type: 'ack', seq: 3 });
        await drainPromise;  // should resolve without throwing
    });

    test('drain waits for drainDone even if batch acks arrive first', async () => {
        const spy = makeSpy();
        const c = new DbWriterClient({
            workerScriptPath: '/fake', dbPath: ':memory:', WorkerCtor: spy.WorkerCtor,
        });
        c.postBatch({ metadata: [], symbols: [], deletedRelativePaths: [] });
        const drainPromise = c.drain();
        const w = spy.instance();
        w.emit('message', { type: 'batchDone', seq: 1 });
        // drain not yet acked: Promise still pending
        let resolved = false;
        drainPromise.then(() => { resolved = true; });
        await new Promise(r => setImmediate(r));
        assert.strictEqual(resolved, false);
        w.emit('message', { type: 'ack', seq: 2 });
        await drainPromise;
    });

    test('per-batch error is recorded but doesn\'t reject drain', async () => {
        const spy = makeSpy();
        const c = new DbWriterClient({
            workerScriptPath: '/fake', dbPath: ':memory:', WorkerCtor: spy.WorkerCtor,
        });
        c.postBatch({ metadata: [], symbols: [], deletedRelativePaths: [] });
        const drainPromise = c.drain();
        const w = spy.instance();
        w.emit('message', { type: 'error', seq: 1, message: 'disk full' });
        w.emit('message', { type: 'ack', seq: 2 });
        await drainPromise;
        assert.deepStrictEqual(c.getErrors(), ['disk full']);
    });

    test('worker fatal error rejects pending drains', async () => {
        const spy = makeSpy();
        const c = new DbWriterClient({
            workerScriptPath: '/fake', dbPath: ':memory:', WorkerCtor: spy.WorkerCtor,
        });
        c.postBatch({ metadata: [], symbols: [], deletedRelativePaths: [] });
        const drainPromise = c.drain();
        const w = spy.instance();
        w.emit('error', new Error('worker crashed'));
        await assert.rejects(drainPromise, /worker crashed/);
    });

    test('checkpoint posts checkpoint message and resolves on ack', async () => {
        const spy = makeSpy();
        const c = new DbWriterClient({
            workerScriptPath: '/fake', dbPath: ':memory:', WorkerCtor: spy.WorkerCtor,
        });
        c.postBatch({ metadata: [], symbols: [], deletedRelativePaths: [] });
        const ckptPromise = c.checkpoint();
        // checkpoint is seq 2 (postBatch took seq 1)
        const ckptMsg = spy.posted.find((m: any) => m.type === 'checkpoint');
        assert.ok(ckptMsg, 'checkpoint message should have been posted');
        assert.strictEqual(ckptMsg.seq, 2);
        const w = spy.instance();
        w.emit('message', { type: 'batchDone', seq: 1 });
        // Before ack, checkpoint promise is still pending
        let resolved = false;
        ckptPromise.then(() => { resolved = true; });
        await new Promise(r => setImmediate(r));
        assert.strictEqual(resolved, false);
        w.emit('message', { type: 'ack', seq: 2 });
        await ckptPromise;
    });

    test('dispose drains then terminates', async () => {
        const spy = makeSpy();
        const c = new DbWriterClient({
            workerScriptPath: '/fake', dbPath: ':memory:', WorkerCtor: spy.WorkerCtor,
        });
        c.postBatch({ metadata: [], symbols: [], deletedRelativePaths: [] });
        const disposePromise = c.dispose();
        const w = spy.instance();
        w.emit('message', { type: 'batchDone', seq: 1 });
        w.emit('message', { type: 'ack', seq: 2 });
        await disposePromise;
        // a close message was posted
        const closeMsgs = spy.posted.filter((m: any) => m.type === 'close');
        assert.strictEqual(closeMsgs.length, 1);
    });

    test('dispose is idempotent', async () => {
        const spy = makeSpy();
        const c = new DbWriterClient({
            workerScriptPath: '/fake', dbPath: ':memory:', WorkerCtor: spy.WorkerCtor,
        });
        const w = spy.instance();
        const p1 = c.dispose();
        w.emit('message', { type: 'ack', seq: 1 });
        await p1;
        await c.dispose();  // must not throw
    });

    test('drain timeout resolves (not rejects) after timeoutMs with no ack', async () => {
        const spy = makeSpy();
        const c = new DbWriterClient({
            workerScriptPath: '/fake', dbPath: ':memory:', WorkerCtor: spy.WorkerCtor,
        });
        // no ack emitted → must not hang
        const p = c.drain(30);  // 30 ms
        const start = Date.now();
        await p;  // resolves, doesn't reject
        const elapsed = Date.now() - start;
        assert.ok(elapsed >= 25, `expected to wait ~30ms, got ${elapsed}ms`);
        const errs = c.getErrors();
        assert.ok(errs.some(e => /timed out/.test(e)), `errors should note timeout: ${errs}`);
    });

    test('checkpoint timeout resolves after timeoutMs with no ack', async () => {
        const spy = makeSpy();
        const c = new DbWriterClient({
            workerScriptPath: '/fake', dbPath: ':memory:', WorkerCtor: spy.WorkerCtor,
        });
        const p = c.checkpoint(30);
        await p;  // must resolve, not hang
        const errs = c.getErrors();
        assert.ok(errs.some(e => /timed out/.test(e)));
    });

    test('timeout cleans up pendingAck so a later ack does nothing', async () => {
        const spy = makeSpy();
        const c = new DbWriterClient({
            workerScriptPath: '/fake', dbPath: ':memory:', WorkerCtor: spy.WorkerCtor,
        });
        await c.drain(20);  // timeout
        const w = spy.instance();
        // Late ack should be a no-op (no exception, no double-resolve)
        assert.doesNotThrow(() => {
            w.emit('message', { type: 'ack', seq: 1 });
        });
    });

    test('awaitBackpressure returns immediately when under watermark', async () => {
        const spy = makeSpy();
        const c = new DbWriterClient({
            workerScriptPath: '/fake', dbPath: ':memory:', WorkerCtor: spy.WorkerCtor,
        });
        c.postBatch({ metadata: [], symbols: [], deletedRelativePaths: [] });
        // 1 pending, watermark 10 → no wait
        const start = Date.now();
        await c.awaitBackpressure(10);
        assert.ok(Date.now() - start < 50, 'should not wait when under watermark');
    });

    test('awaitBackpressure waits until pending drops to <= watermark', async () => {
        const spy = makeSpy();
        const c = new DbWriterClient({
            workerScriptPath: '/fake', dbPath: ':memory:', WorkerCtor: spy.WorkerCtor,
        });
        // Load 5 pending batches
        for (let i = 0; i < 5; i++) {
            c.postBatch({ metadata: [], symbols: [], deletedRelativePaths: [] });
        }
        assert.strictEqual(c.pendingBatchCount(), 5);

        // Start a backpressure wait for watermark=2. Resolves once pending <= 2.
        const waitP = c.awaitBackpressure(2);
        let resolved = false;
        waitP.then(() => { resolved = true; });

        // At 5 pending, should still be waiting
        await new Promise(r => setTimeout(r, 40));
        assert.strictEqual(resolved, false);

        const w = spy.instance();
        // Ack 3 batches → pending drops to 2
        w.emit('message', { type: 'batchDone', seq: 1 });
        w.emit('message', { type: 'batchDone', seq: 2 });
        w.emit('message', { type: 'batchDone', seq: 3 });

        await waitP;  // must resolve now
        assert.strictEqual(c.pendingBatchCount(), 2);
    });

    test('awaitBackpressure throws if worker fatal error occurs mid-wait', async () => {
        const spy = makeSpy();
        const c = new DbWriterClient({
            workerScriptPath: '/fake', dbPath: ':memory:', WorkerCtor: spy.WorkerCtor,
        });
        for (let i = 0; i < 5; i++) {
            c.postBatch({ metadata: [], symbols: [], deletedRelativePaths: [] });
        }
        const waitP = c.awaitBackpressure(0);
        // Simulate a worker fatal error
        setTimeout(() => spy.instance().emit('error', new Error('worker died')), 10);
        await assert.rejects(waitP, /worker died/);
    });
});
