// src/index/dbWriterWorker.ts
// worker_thread that owns the write-side DbBackend connection.
// Receives batches from the main thread, writes them serially in order,
// acknowledges each one. Drain requests simply flow through the same
// message queue and produce an ack — SQLite transaction ordering guarantees
// all earlier batches are durable when the drain ack arrives.

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
interface CloseMessage {
    type: 'close';
}
type InMessage = BatchMessage | DrainMessage | CloseMessage;

function post(msg: unknown): void {
    parentPort?.postMessage(msg);
}

const dbPath = (workerData as { dbPath: string }).dbPath;
const db = new DbBackend(dbPath);
db.openOrInit();

parentPort?.on('message', (msg: InMessage) => {
    try {
        if (msg.type === 'batch') {
            db.writeBatch(msg.batch);
            post({ type: 'batchDone', seq: msg.seq });
        } else if (msg.type === 'drain') {
            // SQLite transactions are already durable at commit time
            // (WAL mode); this ack is pure ordering barrier.
            post({ type: 'drainDone', seq: msg.seq });
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
