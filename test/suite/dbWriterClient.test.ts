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
        w.emit('message', { type: 'drainDone', seq: 3 });
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
        w.emit('message', { type: 'drainDone', seq: 2 });
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
        w.emit('message', { type: 'drainDone', seq: 2 });
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

    test('dispose drains then terminates', async () => {
        const spy = makeSpy();
        const c = new DbWriterClient({
            workerScriptPath: '/fake', dbPath: ':memory:', WorkerCtor: spy.WorkerCtor,
        });
        c.postBatch({ metadata: [], symbols: [], deletedRelativePaths: [] });
        const disposePromise = c.dispose();
        const w = spy.instance();
        w.emit('message', { type: 'batchDone', seq: 1 });
        w.emit('message', { type: 'drainDone', seq: 2 });
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
        w.emit('message', { type: 'drainDone', seq: 1 });
        await p1;
        await c.dispose();  // must not throw
    });
});
