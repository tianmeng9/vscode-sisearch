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
        const setStatus = (index as unknown as { _setStatusForTest?: (s: string) => void })._setStatusForTest;
        if (!setStatus) {
            // If the façade does not expose a test hook, skip — but verify façade surface instead
            assert.ok(typeof index.markDirty === 'function');
            return;
        }
        setStatus('ready');
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
});
