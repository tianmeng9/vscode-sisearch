// test/suite/symbolIndexFacade.test.ts
// Façade 约定：保持老 SymbolIndex 公开 API，但内部必须委托给新模块。

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SymbolIndex } from '../../src/symbolIndex';

suite('SymbolIndex (façade)', () => {
    test('exposes legacy public API for status/stats/markDirty/markDeleted/clear', () => {
        const index = new SymbolIndex();
        assert.strictEqual(index.status, 'none');
        assert.deepStrictEqual(index.getStats(), { files: 0, symbols: 0 });
        index.markDirty('a.c');     // must not throw before ready
        index.markDeleted('a.c');   // must not throw before ready
        index.clear();
        assert.strictEqual(index.status, 'none');
    });

    test('searchSymbols returns empty before a build', () => {
        const index = new SymbolIndex();
        const results = index.searchSymbols('foo', '/ws', { caseSensitive: false, wholeWord: false, regex: false });
        assert.deepStrictEqual(results, []);
    });

    test('loadFromDisk returns false when no index exists', async () => {
        const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sisearch-facade-'));
        try {
            const index = new SymbolIndex();
            const loaded = await index.loadFromDisk(workspaceRoot);
            assert.strictEqual(loaded, false);
            assert.strictEqual(index.status, 'none');
        } finally {
            fs.rmSync(workspaceRoot, { recursive: true });
        }
    });

    test('status transitions to stale after markDirty when ready', () => {
        const index = new SymbolIndex();
        // Force status to ready via test hook (uses internal _setStatus if present)
        const hook = (index as unknown as { _setStatusForTest?: (s: string) => void })._setStatusForTest;
        if (!hook) {
            // If the façade does not expose a test hook, skip — but verify façade surface instead
            assert.ok(typeof index.markDirty === 'function');
            return;
        }
        hook.call(index, 'ready'); // preserve `this` binding (P7.3 setStatus requires it)
        index.markDirty('a.c');
        assert.strictEqual(index.status, 'stale');
    });

    test('clearDisk does not throw even when index dir is absent', () => {
        const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sisearch-facade-cd-'));
        try {
            const index = new SymbolIndex();
            assert.doesNotThrow(() => index.clearDisk(workspaceRoot));
        } finally {
            fs.rmSync(workspaceRoot, { recursive: true });
        }
    });

    test('storageByRoot normalizes path variants (trailing slash) to one entry (P6.6 regression)', async () => {
        const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sisearch-facade-norm-'));
        try {
            const index = new SymbolIndex();
            const getCount = (index as unknown as { _getStorageCountForTest(): number })._getStorageCountForTest.bind(index);

            // 两个调用使用同一目录的不同表示:trailing slash vs 无
            await index.loadFromDisk(workspaceRoot);
            await index.loadFromDisk(workspaceRoot + path.sep);

            // 标准化后应当只有 1 个 StorageManager 实例
            assert.strictEqual(getCount(), 1, 'path variants should share one StorageManager instance');

            // clearDisk 用 trailing slash 版本也要能 invalidate 同一 key
            index.clearDisk(workspaceRoot + path.sep);
            assert.strictEqual(getCount(), 0, 'clearDisk should invalidate normalized key regardless of trailing slash');
        } finally {
            fs.rmSync(workspaceRoot, { recursive: true, force: true });
        }
    });
});

suite('SymbolIndex events (P7.3)', () => {
    test('onStatusChanged fires once per transition, not on equal assignments', () => {
        const index = new SymbolIndex();
        const events: string[] = [];
        const disp = index.onStatusChanged(s => events.push(s));
        try {
            // _setStatusForTest 走 setStatus,相等守卫生效
            const hook = (index as unknown as { _setStatusForTest(s: string): void })._setStatusForTest;
            hook.call(index, 'building');
            hook.call(index, 'building'); // no-fire
            hook.call(index, 'ready');
            hook.call(index, 'ready');    // no-fire
            assert.deepStrictEqual(events, ['building', 'ready']);
        } finally {
            disp.dispose();
            index.dispose();
        }
    });

    test('onStatsChanged does not fire when loadFromDisk finds no snapshot', async () => {
        // 空目录 loadFromDisk 返回 false,不 fire stats
        const emptyWs = fs.mkdtempSync(path.join(os.tmpdir(), 'sisearch-facade-evt-'));
        try {
            const index = new SymbolIndex();
            const fires: Array<{ files: number; symbols: number }> = [];
            const disp = index.onStatsChanged(s => fires.push(s));
            try {
                const loaded = await index.loadFromDisk(emptyWs);
                assert.strictEqual(loaded, false);
                assert.strictEqual(fires.length, 0, 'no-snapshot load should not fire stats');
            } finally {
                disp.dispose();
                index.dispose();
            }
        } finally {
            fs.rmSync(emptyWs, { recursive: true, force: true });
        }
    });

    test('clear fires onStatusChanged and onStatsChanged', () => {
        const index = new SymbolIndex();
        // 先推到 ready 状态,才能观察 clear 导致的 none 事件
        const hook = (index as unknown as { _setStatusForTest(s: string): void })._setStatusForTest;
        hook.call(index, 'ready');

        const statusEvents: string[] = [];
        const statsEvents: Array<{ files: number; symbols: number }> = [];
        const d1 = index.onStatusChanged(s => statusEvents.push(s));
        const d2 = index.onStatsChanged(s => statsEvents.push(s));

        try {
            index.clear();
            assert.deepStrictEqual(statusEvents, ['none']);
            assert.strictEqual(statsEvents.length, 1);
            assert.deepStrictEqual(statsEvents[0], { files: 0, symbols: 0 });
        } finally {
            d1.dispose();
            d2.dispose();
            index.dispose();
        }
    });
});
