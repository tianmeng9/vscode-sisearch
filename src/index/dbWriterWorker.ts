// src/index/dbWriterWorker.ts
// worker_thread that owns the write-side DbBackend connection.
// Receives batches from the main thread, writes them serially in order,
// acknowledges each one. Drain + checkpoint requests flow through the same
// ordered message queue and produce an `ack` — SQLite transaction ordering
// guarantees all earlier batches are durable when the ack arrives.

import { parentPort, workerData } from 'worker_threads';
import { DbBackend } from './dbBackend';
import type { WriteBatch } from './dbBackend';

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
const db = new DbBackend(dbPath);
db.openOrInit();
// M10d: enter bulk-write pragma mode for the lifetime of the worker.
// synchronous=OFF + cache_size=256MB trades fsync durability for ~3x throughput.
// Recovery on crash = user re-syncs; WAL still protects readers mid-write.
db.pragmaForSyncMode();

parentPort?.on('message', (msg: InMessage) => {
    try {
        if (msg.type === 'batch') {
            db.writeBatch(msg.batch);
            post({ type: 'batchDone', seq: msg.seq });
        } else if (msg.type === 'drain') {
            // SQLite transactions are already durable at commit time
            // (WAL mode); this ack is pure ordering barrier.
            post({ type: 'ack', seq: msg.seq });
        } else if (msg.type === 'checkpoint') {
            // wal_checkpoint(TRUNCATE) — compacts the -wal file to zero length.
            // Called by the façade in synchronize()'s finally block to cap
            // on-disk WAL size after a sync burst.
            db.checkpoint();
            post({ type: 'ack', seq: msg.seq });
        } else if (msg.type === 'close') {
            db.close();
            process.exit(0);
        }
    } catch (e) {
        const seq = msg.type !== 'close' ? msg.seq : undefined;
        const message = e instanceof Error ? e.message : String(e);
        post({ type: 'error', seq, message });
    }
});
