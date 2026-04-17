import * as assert from 'assert';
import { AutoSyncController } from '../../src/sync/autoSync';

suite('autoSync', () => {
    test('coalesces rapid dirty marks into one sync', async () => {
        let count = 0;
        const controller = new AutoSyncController({
            delayMs: 20,
            enabled: true,
            syncDirty: async () => { count += 1; },
        });

        controller.markDirty('a.c');
        controller.markDirty('b.c');
        controller.markDirty('c.c');

        await new Promise(resolve => setTimeout(resolve, 60));
        assert.strictEqual(count, 1);
        controller.dispose();
    });

    test('does not sync when disabled', async () => {
        let count = 0;
        const controller = new AutoSyncController({
            delayMs: 10,
            enabled: false,
            syncDirty: async () => { count += 1; },
        });

        controller.markDirty('a.c');
        await new Promise(resolve => setTimeout(resolve, 40));
        assert.strictEqual(count, 0);
        controller.dispose();
    });

    test('markDeleted also triggers sync', async () => {
        let count = 0;
        const controller = new AutoSyncController({
            delayMs: 20,
            enabled: true,
            syncDirty: async () => { count += 1; },
        });

        controller.markDeleted('removed.c');
        await new Promise(resolve => setTimeout(resolve, 60));
        assert.strictEqual(count, 1);
        controller.dispose();
    });

    test('dispose cancels pending timer', async () => {
        let count = 0;
        const controller = new AutoSyncController({
            delayMs: 50,
            enabled: true,
            syncDirty: async () => { count += 1; },
        });

        controller.markDirty('a.c');
        controller.dispose();

        await new Promise(resolve => setTimeout(resolve, 100));
        assert.strictEqual(count, 0);
    });
});
