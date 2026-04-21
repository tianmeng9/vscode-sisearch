import * as assert from 'assert';
import { createReentrancyGuard } from '../../src/sync/reentrancyGuard';

suite('reentrancyGuard', () => {
    test('first call runs the task', async () => {
        const guard = createReentrancyGuard();
        let called = 0;
        await guard.run(async () => { called++; });
        assert.strictEqual(called, 1);
    });

    test('concurrent call while in-flight returns the same promise', async () => {
        // Regression: re-sync while a previous sync is running used to spin
        // up a second orchestrator that shared workerPool/index state and
        // doubled memory, leading to VS Code crash on large repos.
        const guard = createReentrancyGuard();
        let started = 0;
        let release!: () => void;
        const gate = new Promise<void>((res) => { release = res; });

        const task = async () => { started++; await gate; };

        const p1 = guard.run(task);
        const p2 = guard.run(task);
        assert.strictEqual(p1, p2, 'second call must return the in-flight promise');
        assert.strictEqual(started, 1, 'task must only be started once');

        release();
        await p1;
        assert.strictEqual(started, 1);
    });

    test('releases in-flight state after task resolves', async () => {
        const guard = createReentrancyGuard();
        let started = 0;
        await guard.run(async () => { started++; });
        await guard.run(async () => { started++; });
        assert.strictEqual(started, 2, 'second run after first resolved must execute');
    });

    test('releases in-flight state after task rejects', async () => {
        const guard = createReentrancyGuard();
        await assert.rejects(
            () => guard.run(async () => { throw new Error('boom'); }),
            /boom/,
        );
        let ran = false;
        await guard.run(async () => { ran = true; });
        assert.strictEqual(ran, true, 'guard must release even if task throws');
    });

    test('concurrent callers observing a rejection all see the same error', async () => {
        const guard = createReentrancyGuard();
        let release!: () => void;
        const gate = new Promise<void>((res) => { release = res; });

        const task = async () => { await gate; throw new Error('kaboom'); };
        const p1 = guard.run(task);
        const p2 = guard.run(task);
        release();
        await assert.rejects(() => p1, /kaboom/);
        await assert.rejects(() => p2, /kaboom/);
    });
});
