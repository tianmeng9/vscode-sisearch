// test/suite/symbolIndexFacade.test.ts
// Façade 约定：保持老 SymbolIndex 公开 API，但内部必须委托给新模块 (M2: DbBackend)。

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SymbolIndex } from '../../src/symbolIndex';

suite('SymbolIndex (façade)', () => {
    test('exposes legacy public API for status/stats/markDirty/markDeleted/clear', () => {
        const index = new SymbolIndex({ dbPath: ':memory:' });
        try {
            assert.strictEqual(index.status, 'none');
            assert.deepStrictEqual(index.getStats(), { files: 0, symbols: 0 });
            index.markDirty('a.c');     // must not throw before ready
            index.markDeleted('a.c');   // must not throw before ready
            index.clear();
            assert.strictEqual(index.status, 'none');
        } finally {
            index.dispose();
        }
    });

    test('searchSymbols returns empty before a build', () => {
        const index = new SymbolIndex({ dbPath: ':memory:' });
        try {
            const results = index.searchSymbols('foo', '/ws', { caseSensitive: false, wholeWord: false, regex: false });
            assert.deepStrictEqual(results, []);
        } finally {
            index.dispose();
        }
    });

    test('loadFromDisk returns false when DbBackend has no rows', async () => {
        const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sisearch-facade-'));
        const index = new SymbolIndex({ dbPath: ':memory:' });
        try {
            const loaded = await index.loadFromDisk(workspaceRoot);
            assert.strictEqual(loaded, false);
            assert.strictEqual(index.status, 'none');
        } finally {
            index.dispose();
            fs.rmSync(workspaceRoot, { recursive: true, force: true });
        }
    });

    test('isSyncInProgress reports false when idle', () => {
        const index = new SymbolIndex({ dbPath: ':memory:' });
        try {
            assert.strictEqual(index.isSyncInProgress(), false);
        } finally {
            index.dispose();
        }
    });

    test('status transitions to stale after markDirty when ready', () => {
        const index = new SymbolIndex({ dbPath: ':memory:' });
        try {
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
        } finally {
            index.dispose();
        }
    });

    test('clearDisk does not throw even when index dir is absent', () => {
        const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sisearch-facade-cd-'));
        const index = new SymbolIndex({ dbPath: ':memory:' });
        try {
            assert.doesNotThrow(() => index.clearDisk(workspaceRoot));
        } finally {
            index.dispose();
            fs.rmSync(workspaceRoot, { recursive: true, force: true });
        }
    });

    test('dbByRoot normalizes path variants (trailing slash) to one entry (P6.6 regression)', async () => {
        const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sisearch-facade-norm-'));
        // 此测试必须走真实 DbBackend(而非 :memory:)来观测 canonicalization;
        // 测试结束 clearDisk 会关闭并删除 DB 文件。
        const index = new SymbolIndex();
        try {
            const getCount = (index as unknown as { _getStorageCountForTest(): number })._getStorageCountForTest.bind(index);

            // 两个调用使用同一目录的不同表示:trailing slash vs 无
            await index.loadFromDisk(workspaceRoot);
            await index.loadFromDisk(workspaceRoot + path.sep);

            // 标准化后应当只有 1 个 DbBackend 实例
            assert.strictEqual(getCount(), 1, 'path variants should share one DbBackend instance');

            // clearDisk 用 trailing slash 版本也要能 invalidate 同一 key
            index.clearDisk(workspaceRoot + path.sep);
            assert.strictEqual(getCount(), 0, 'clearDisk should invalidate normalized key regardless of trailing slash');
        } finally {
            index.dispose();
            fs.rmSync(workspaceRoot, { recursive: true, force: true });
        }
    });
});

suite('SymbolIndex events (P7.3)', () => {
    test('onStatusChanged fires once per transition, not on equal assignments', () => {
        const index = new SymbolIndex({ dbPath: ':memory:' });
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
        // 空 DbBackend loadFromDisk 返回 false,不 fire stats
        const emptyWs = fs.mkdtempSync(path.join(os.tmpdir(), 'sisearch-facade-evt-'));
        const index = new SymbolIndex({ dbPath: ':memory:' });
        try {
            const fires: Array<{ files: number; symbols: number }> = [];
            const disp = index.onStatsChanged(s => fires.push(s));
            try {
                const loaded = await index.loadFromDisk(emptyWs);
                assert.strictEqual(loaded, false);
                assert.strictEqual(fires.length, 0, 'no-data load should not fire stats');
            } finally {
                disp.dispose();
            }
        } finally {
            index.dispose();
            fs.rmSync(emptyWs, { recursive: true, force: true });
        }
    });

    test('clear fires onStatusChanged and onStatsChanged', () => {
        const index = new SymbolIndex({ dbPath: ':memory:' });
        try {
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
            }
        } finally {
            index.dispose();
        }
    });
});

suite('SymbolIndex storage canonicalization (P7.5)', () => {
    test('symlink path and real path share one DbBackend instance', async () => {
        const realRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sisearch-p75-real-'));
        const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'sisearch-p75-link-'));
        const linkRoot = path.join(parent, 'linked');
        try {
            try {
                fs.symlinkSync(realRoot, linkRoot, 'dir');
            } catch (e) {
                // 某些 CI/沙箱禁用 symlink;跳过本测试而非 fail
                console.warn('skip: cannot create symlink:', (e as Error).message);
                return;
            }

            const index = new SymbolIndex();
            try {
                const getCount = (index as unknown as { _getStorageCountForTest(): number })._getStorageCountForTest.bind(index);

                await index.loadFromDisk(realRoot);
                await index.loadFromDisk(linkRoot);

                assert.strictEqual(
                    getCount(),
                    1,
                    'symlink and real path should canonicalize to the same DbBackend',
                );

                index.clearDisk(linkRoot);
                assert.strictEqual(getCount(), 0, 'clearDisk via symlink should invalidate canonical key');
            } finally {
                index.dispose();
            }
        } finally {
            try { fs.unlinkSync(linkRoot); } catch { /* noop */ }
            fs.rmSync(realRoot, { recursive: true, force: true });
            fs.rmSync(parent, { recursive: true, force: true });
        }
    });

    test('canonicalize falls back to resolve for non-existent root (no throw)', () => {
        const index = new SymbolIndex({ dbPath: ':memory:' });
        try {
            const getCount = (index as unknown as { _getStorageCountForTest(): number })._getStorageCountForTest.bind(index);
            // 一个肯定不存在的路径,realpathSync 会抛 ENOENT,canonicalizeRoot 必须静默回退到 path.resolve
            const bogus = path.join(os.tmpdir(), 'sisearch-p75-nonexistent-' + Date.now() + '-' + Math.random().toString(36).slice(2));
            assert.doesNotThrow(() => index.clearDisk(bogus));
            // clearDisk 走 canonicalize,不抛且不留缓存
            assert.strictEqual(getCount(), 0);
        } finally {
            index.dispose();
        }
    });
});
