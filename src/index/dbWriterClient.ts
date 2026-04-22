// src/index/dbWriterClient.ts
// Main-thread handle to a dbWriterWorker. Fire-and-forget post for each
// batch so the main thread's event loop is never blocked on SQLite.
// drain() returns a Promise that resolves when the worker has ack'd every
// outstanding batch plus the drain barrier.

import { Worker } from 'worker_threads';
import type { WriteBatch } from './dbBackend';
import { writerDiag } from './writerDiag';

export interface WriterClientOptions {
    workerScriptPath: string;
    dbPath: string;
    // Test injection point (mirrors workerPoolFactory pattern)
    WorkerCtor?: new (script: string, options: { workerData: unknown }) => {
        on(event: 'message', listener: (msg: any) => void): void;
        on(event: 'error', listener: (err: Error) => void): void;
        on(event: 'exit', listener: (code: number) => void): void;
        postMessage(msg: unknown): void;
        terminate(): Promise<number>;
    };
}

interface OutMessage {
    type: 'batch' | 'drain' | 'checkpoint' | 'close';
    seq?: number;
    batch?: WriteBatch;
}

/** Shared waiter record for drain() and checkpoint() — worker replies with
 *  `{ type: 'ack', seq }` in both cases; client resolves the matching entry. */
interface PendingAck {
    seq: number;
    resolve: () => void;
    reject: (err: Error) => void;
}

export class DbWriterClient {
    private worker: {
        on(event: 'message', listener: (msg: any) => void): void;
        on(event: 'error', listener: (err: Error) => void): void;
        on(event: 'exit', listener: (code: number) => void): void;
        postMessage(msg: unknown): void;
        terminate(): Promise<number>;
    };
    private nextSeq = 1;
    private pendingBatches = new Set<number>();
    private pendingAcks: PendingAck[] = [];
    private disposed = false;
    private fatalError: Error | undefined;
    private errors: string[] = [];

    constructor(options: WriterClientOptions) {
        const Ctor = options.WorkerCtor ?? (Worker as any);
        writerDiag('main', 'client:spawn', { dbPath: options.dbPath, script: options.workerScriptPath });
        this.worker = new Ctor(options.workerScriptPath, {
            workerData: { dbPath: options.dbPath },
        });
        this.worker.on('message', (msg: any) => this.handleMessage(msg));
        this.worker.on('error', (err: Error) => {
            writerDiag('main', 'client:workerError', { message: err.message, stack: err.stack });
            this.handleFatal(err);
        });
        this.worker.on('exit', (code: number) => {
            writerDiag('main', 'client:workerExit', { code, disposed: this.disposed });
            if (code !== 0 && !this.disposed) {
                this.handleFatal(new Error(`dbWriterWorker exited with code ${code}`));
            }
        });
    }

    /** Fire-and-forget. Does not return until the *current* event loop tick ends. */
    postBatch(batch: WriteBatch): void {
        if (this.fatalError) { throw this.fatalError; }
        if (this.disposed) { throw new Error('DbWriterClient is disposed'); }
        const seq = this.nextSeq++;
        this.pendingBatches.add(seq);
        writerDiag('main', 'client:postBatch', {
            seq, symbols: batch.symbols.length, metadata: batch.metadata.length,
            deletes: batch.deletedRelativePaths.length,
            pendingBatchCount: this.pendingBatches.size,
        });
        this.worker.postMessage({ type: 'batch', seq, batch });
    }

    /** Resolves when every batch posted up to this call is durable.
     *  Safety timeout: if the worker never acks (dead worker / lost message),
     *  resolves after `timeoutMs` so the main-thread callsite doesn't hang.
     *  Default 60 s — generous for real workloads but bounded for UI. */
    async drain(timeoutMs: number = 60_000): Promise<void> {
        if (this.fatalError) { throw this.fatalError; }
        if (this.disposed) { return; }
        const seq = this.nextSeq++;
        writerDiag('main', 'client:postDrain', {
            seq, timeoutMs,
            pendingBatches: this.pendingBatches.size,
            pendingAcks: this.pendingAcks.length,
        });
        return this.waitForAckWithTimeout(seq, timeoutMs, () => {
            this.worker.postMessage({ type: 'drain', seq });
        });
    }

    /** M10d: Requests a WAL TRUNCATE checkpoint in the worker. Same timeout
     *  semantics as drain(). Checkpoint on a multi-GB DB can take seconds;
     *  allow up to 60 s before giving up. */
    async checkpoint(timeoutMs: number = 60_000): Promise<void> {
        if (this.fatalError) { throw this.fatalError; }
        if (this.disposed) { return; }
        const seq = this.nextSeq++;
        writerDiag('main', 'client:postCheckpoint', {
            seq, timeoutMs,
            pendingBatches: this.pendingBatches.size,
            pendingAcks: this.pendingAcks.length,
        });
        return this.waitForAckWithTimeout(seq, timeoutMs, () => {
            this.worker.postMessage({ type: 'checkpoint', seq });
        });
    }

    private waitForAckWithTimeout(
        seq: number,
        timeoutMs: number,
        send: () => void,
    ): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            let settled = false;
            const timer = setTimeout(() => {
                if (settled) { return; }
                settled = true;
                // Evict the pending waiter so it doesn't leak
                const idx = this.pendingAcks.findIndex(d => d.seq === seq);
                if (idx >= 0) { this.pendingAcks.splice(idx, 1); }
                writerDiag('main', 'client:timeout', {
                    seq, timeoutMs,
                    pendingBatches: this.pendingBatches.size,
                    pendingAcks: this.pendingAcks.length,
                });
                // Resolve (not reject) — the sync itself succeeded; we just
                // couldn't get a clean shutdown barrier. Data is still on disk
                // thanks to SQLite transactions committing synchronously inside
                // the worker. Caller can proceed.
                this.errors.push(`drain/checkpoint seq=${seq} timed out after ${timeoutMs}ms`);
                resolve();
            }, timeoutMs);
            this.pendingAcks.push({
                seq,
                resolve: () => { if (!settled) { settled = true; clearTimeout(timer); resolve(); } },
                reject: (err) => { if (!settled) { settled = true; clearTimeout(timer); reject(err); } },
            });
            send();
        });
    }

    /** drain + terminate. Idempotent. */
    async dispose(): Promise<void> {
        if (this.disposed) { return; }
        writerDiag('main', 'client:disposeStart', {
            pendingBatches: this.pendingBatches.size,
            pendingAcks: this.pendingAcks.length,
        });
        try {
            await this.drain();
        } catch {
            // ignore — we're tearing down anyway
        }
        this.disposed = true;
        writerDiag('main', 'client:postClose', {});
        try {
            this.worker.postMessage({ type: 'close' });
        } catch { /* already dead */ }
        try {
            await this.worker.terminate();
        } catch { /* ignore */ }
        writerDiag('main', 'client:disposeDone', {});
    }

    /** Per-batch errors that were recoverable (worker continued). */
    getErrors(): string[] {
        return [...this.errors];
    }

    private handleMessage(msg: any): void {
        if (msg?.type === 'batchDone' && typeof msg.seq === 'number') {
            writerDiag('main', 'client:batchDoneReceived', {
                seq: msg.seq, pendingBatchesBefore: this.pendingBatches.size,
            });
            this.pendingBatches.delete(msg.seq);
        } else if (msg?.type === 'ack' && typeof msg.seq === 'number') {
            writerDiag('main', 'client:ackReceived', {
                seq: msg.seq, pendingAcksBefore: this.pendingAcks.length,
            });
            // Unified ack for drain + checkpoint: resolve the matching waiter.
            const idx = this.pendingAcks.findIndex(d => d.seq === msg.seq);
            if (idx >= 0) {
                const d = this.pendingAcks[idx];
                this.pendingAcks.splice(idx, 1);
                d.resolve();
            }
        } else if (msg?.type === 'error') {
            const text = typeof msg.message === 'string' ? msg.message : String(msg.message);
            writerDiag('main', 'client:errorReceived', { seq: msg.seq, message: text });
            this.errors.push(text);
            if (typeof msg.seq === 'number') {
                // Treat a per-batch error as "batch done" so drain doesn't hang
                this.pendingBatches.delete(msg.seq);
                // If the errored seq was actually a drain/checkpoint, also
                // release its waiter so callers don't hang.
                const idx = this.pendingAcks.findIndex(d => d.seq === msg.seq);
                if (idx >= 0) {
                    const d = this.pendingAcks[idx];
                    this.pendingAcks.splice(idx, 1);
                    d.reject(new Error(text));
                }
            }
        }
    }

    private handleFatal(err: Error): void {
        this.fatalError = err;
        // Reject all outstanding drain/checkpoint waiters
        for (const d of this.pendingAcks) { d.reject(err); }
        this.pendingAcks = [];
    }
}
