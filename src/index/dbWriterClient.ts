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
    type: 'batch' | 'drain' | 'close';
    seq?: number;
    batch?: WriteBatch;
}

interface PendingDrain {
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
    private pendingDrains: PendingDrain[] = [];
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
            this.pendingDrains.push({ seq, resolve, reject });
            this.worker.postMessage({ type: 'drain', seq });
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
        } else if (msg?.type === 'drainDone' && typeof msg.seq === 'number') {
            // Find the drain with this seq and resolve it
            const idx = this.pendingDrains.findIndex(d => d.seq === msg.seq);
            if (idx >= 0) {
                const d = this.pendingDrains[idx];
                this.pendingDrains.splice(idx, 1);
                d.resolve();
            }
        } else if (msg?.type === 'error') {
            const text = typeof msg.message === 'string' ? msg.message : String(msg.message);
            this.errors.push(text);
            if (typeof msg.seq === 'number') {
                // Treat a per-batch error as "batch done" so drain doesn't hang
                this.pendingBatches.delete(msg.seq);
            }
        }
    }

    private handleFatal(err: Error): void {
        this.fatalError = err;
        // Reject all outstanding drains
        for (const d of this.pendingDrains) { d.reject(err); }
        this.pendingDrains = [];
    }
}
