// src/index/dbWriterClient.ts
// Main-thread handle to a dbWriterWorker. Fire-and-forget post for each
// batch so the main thread's event loop is never blocked on SQLite.
// drain() returns a Promise that resolves when the worker has ack'd every
// outstanding batch plus the drain barrier.

import { Worker } from 'worker_threads';
import type { WriteBatch } from './dbBackend';

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
        this.worker = new Ctor(options.workerScriptPath, {
            workerData: { dbPath: options.dbPath },
        });
        this.worker.on('message', (msg: any) => this.handleMessage(msg));
        this.worker.on('error', (err: Error) => this.handleFatal(err));
        this.worker.on('exit', (code: number) => {
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
        this.worker.postMessage({ type: 'batch', seq, batch });
    }

    /** Resolves when every batch posted up to this call is durable. */
    async drain(): Promise<void> {
        if (this.fatalError) { throw this.fatalError; }
        if (this.disposed) { return; }
        const seq = this.nextSeq++;
        return new Promise<void>((resolve, reject) => {
            this.pendingAcks.push({ seq, resolve, reject });
            this.worker.postMessage({ type: 'drain', seq });
        });
    }

    /** M10d: Requests a WAL TRUNCATE checkpoint in the worker. Resolves when
     *  the worker has finished the checkpoint. Ordered with earlier batches;
     *  like drain(), all previously-posted batches are durable when this
     *  resolves. Façade calls this in synchronize()'s finally block so the
     *  on-disk -wal file is compacted after each sync burst. */
    async checkpoint(): Promise<void> {
        if (this.fatalError) { throw this.fatalError; }
        if (this.disposed) { return; }
        const seq = this.nextSeq++;
        return new Promise<void>((resolve, reject) => {
            this.pendingAcks.push({ seq, resolve, reject });
            this.worker.postMessage({ type: 'checkpoint', seq });
        });
    }

    /** drain + terminate. Idempotent. */
    async dispose(): Promise<void> {
        if (this.disposed) { return; }
        try {
            await this.drain();
        } catch {
            // ignore — we're tearing down anyway
        }
        this.disposed = true;
        try {
            this.worker.postMessage({ type: 'close' });
        } catch { /* already dead */ }
        try {
            await this.worker.terminate();
        } catch { /* ignore */ }
    }

    /** Per-batch errors that were recoverable (worker continued). */
    getErrors(): string[] {
        return [...this.errors];
    }

    private handleMessage(msg: any): void {
        if (msg?.type === 'batchDone' && typeof msg.seq === 'number') {
            this.pendingBatches.delete(msg.seq);
        } else if (msg?.type === 'ack' && typeof msg.seq === 'number') {
            // Unified ack for drain + checkpoint: resolve the matching waiter.
            const idx = this.pendingAcks.findIndex(d => d.seq === msg.seq);
            if (idx >= 0) {
                const d = this.pendingAcks[idx];
                this.pendingAcks.splice(idx, 1);
                d.resolve();
            }
        } else if (msg?.type === 'error') {
            const text = typeof msg.message === 'string' ? msg.message : String(msg.message);
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
