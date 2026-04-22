// test/suite/searchDuringSync.test.ts
// M5.2: node-runnable tests for the pure decision function behind
// handleSearchDuringSync. The full prompt path (vscode.window.showInformationMessage)
// is exercised via host-only tests in searchEngine.test.ts; here we cover the
// config-behavior fan-out and 1s frequency cache in isolation.

import * as assert from 'assert';
import {
    decideSearchDuringSyncAction as decide,
    resetSearchDuringSyncState,
} from '../../src/search/searchDuringSyncState';

suite('handleSearchDuringSync decision', () => {
    test('behavior=cancel returns action=cancel without prompt', () => {
        const r = decide('cancel', 1000, 0, undefined);
        assert.strictEqual(r.action, 'cancel');
        assert.strictEqual(r.promptExpect, null);
    });

    test('behavior=grep-fallback returns action=grep without prompt', () => {
        const r = decide('grep-fallback', 1000, 0, undefined);
        assert.strictEqual(r.action, 'grep');
        assert.strictEqual(r.promptExpect, null);
    });

    test('behavior=prompt-grep-fallback returns prompt with grep-fallback hint', () => {
        const r = decide('prompt-grep-fallback', 1000, 0, undefined);
        assert.strictEqual(r.action, 'prompt');
        assert.strictEqual(r.promptExpect, 'grep-fallback');
    });

    test('behavior=prompt-cancel returns prompt with cancel hint', () => {
        const r = decide('prompt-cancel', 1000, 0, undefined);
        assert.strictEqual(r.action, 'prompt');
        assert.strictEqual(r.promptExpect, 'cancel');
    });

    test('unknown behavior falls back to prompt-grep-fallback defaults', () => {
        const r = decide('garbage-value', 1000, 0, undefined);
        assert.strictEqual(r.action, 'prompt');
        assert.strictEqual(r.promptExpect, 'grep-fallback');
    });

    test('within 1s of prompt + cached=grep reuses grep without re-prompt', () => {
        const r = decide('prompt-grep-fallback', 1500, 1000, 'grep');
        assert.strictEqual(r.action, 'grep');
        assert.strictEqual(r.promptExpect, null);
    });

    test('within 1s of prompt + cached=cancel reuses cancel without re-prompt', () => {
        const r = decide('prompt-grep-fallback', 1999, 1000, 'cancel');
        assert.strictEqual(r.action, 'cancel');
        assert.strictEqual(r.promptExpect, null);
    });

    test('>=1s after prompt discards cached choice and re-prompts (prompt-*)', () => {
        // Exactly 1000ms later is the boundary: `now - last < 1000` is false, so re-prompt.
        const r = decide('prompt-grep-fallback', 2000, 1000, 'grep');
        assert.strictEqual(r.action, 'prompt');
        assert.strictEqual(r.promptExpect, 'grep-fallback');
    });

    test('cache only short-circuits when cached is set (no cached → honor behavior)', () => {
        const r = decide('cancel', 1500, 1400, undefined);
        assert.strictEqual(r.action, 'cancel');
        assert.strictEqual(r.promptExpect, null);
    });
});

suite('resetSearchDuringSyncState', () => {
    test('is exported and callable; idempotent', () => {
        // Pure smoke — module state is private, but we assert the function exists
        // and doesn't throw when invoked multiple times.
        assert.strictEqual(typeof resetSearchDuringSyncState, 'function');
        resetSearchDuringSyncState();
        resetSearchDuringSyncState();
    });
});
