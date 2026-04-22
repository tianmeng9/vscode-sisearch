// src/index/dbWriterWorker.ts
// worker_thread that owns the write-side DbBackend connection.
// Receives batches from the main thread, writes them serially in order,
// acknowledges each one. Drain + checkpoint requests flow through the same
// ordered message queue and produce an `ack` — SQLite transaction ordering
// guarantees all earlier batches are durable when the ack arrives.

import { parentPort, workerData } from 'worker_threads';
import { DbBackend } from './dbBackend';
import type { WriteBatch } from './dbBackend';
import { writerDiag } from './writerDiag';

interface BatchMessage {
    type: 'batch';
    seq: number;
    batch: WriteBatch;
}
interface DrainMessage {
    type: 'drain';
    seq: number;
}
interface CheckpointMessage {
    type: 'checkpoint';
    seq: number;
}
interface CloseMessage {
    type: 'close';
}
type InMessage = BatchMessage | DrainMessage | CheckpointMessage | CloseMessage;

function post(msg: unknown): void {
    parentPort?.postMessage(msg);
}

const dbPath = (workerData as { dbPath: string }).dbPath;
writerDiag('worker', 'worker:start', { dbPath });
const db = new DbBackend(dbPath);
db.openOrInit();
writerDiag('worker', 'worker:dbOpen', {});
// M10d: enter bulk-write pragma mode for the lifetime of the worker.
// synchronous=OFF + cache_size=256MB trades fsync durability for ~3x throughput.
// Recovery on crash = user re-syncs; WAL still protects readers mid-write.
db.pragmaForSyncMode();

process.on('uncaughtException', (err: Error) => {
    writerDiag('worker', 'worker:uncaughtException', {
        name: err.name, message: err.message, stack: err.stack,
    });
});

parentPort?.on('message', (msg: InMessage) => {
    writerDiag('worker', 'worker:messageReceived', {
        type: msg.type,
        seq: msg.type !== 'close' ? msg.seq : undefined,
        symbolCount: msg.type === 'batch' ? msg.batch.symbols.length : undefined,
    });
    try {
        if (msg.type === 'batch') {
            writerDiag('worker', 'worker:batchStart', { seq: msg.seq, symbols: msg.batch.symbols.length });
            db.writeBatch(msg.batch);
            writerDiag('worker', 'worker:batchDone', { seq: msg.seq });
            post({ type: 'batchDone', seq: msg.seq });
        } else if (msg.type === 'drain') {
            // SQLite transactions are already durable at commit time
            // (WAL mode); this ack is pure ordering barrier.
            writerDiag('worker', 'worker:drainReceived', { seq: msg.seq });
            post({ type: 'ack', seq: msg.seq });
            writerDiag('worker', 'worker:drainAckSent', { seq: msg.seq });
        } else if (msg.type === 'checkpoint') {
            // wal_checkpoint(TRUNCATE) — compacts the -wal file to zero length.
            // Called by the façade in synchronize()'s finally block to cap
            // on-disk WAL size after a sync burst.
            writerDiag('worker', 'worker:checkpointStart', { seq: msg.seq });
            db.checkpoint();
            writerDiag('worker', 'worker:checkpointDone', { seq: msg.seq });
            post({ type: 'ack', seq: msg.seq });
            writerDiag('worker', 'worker:checkpointAckSent', { seq: msg.seq });
        } else if (msg.type === 'close') {
            writerDiag('worker', 'worker:closeReceived', {});
            db.close();
            process.exit(0);
        }
    } catch (e) {
        const seq = msg.type !== 'close' ? msg.seq : undefined;
        const message = e instanceof Error ? e.message : String(e);
        writerDiag('worker', 'worker:error', { seq, message, stack: e instanceof Error ? e.stack : undefined });
        post({ type: 'error', seq, message });
    }
});
