// src/search/searchDuringSyncState.ts
// M5.2: Sync-during-search decision function + module-level frequency cache.
//
// Split out of searchEngine.ts so it can be unit-tested under plain Node
// (searchEngine.ts imports `vscode`, which in node-only tests is only resolvable
// after mocks/register.js runs as a --require hook — the default test runner
// doesn't install that hook, so VSCODE_ONLY_TESTS covers anything that imports
// searchEngine at module load time).
//
// This file must remain vscode-free.

export type CachedChoice = 'cancel' | 'grep' | undefined;

// Module-level state: 1-second debounce so a burst of webview search requests
// during sync doesn't spam prompts. Cleared from SymbolIndex.synchronize so
// each new sync gets a fresh decision from the user.
let lastSyncPromptAt = 0;
let cachedChoice: CachedChoice;

export function getLastSyncPromptAt(): number { return lastSyncPromptAt; }
export function getCachedChoice(): CachedChoice { return cachedChoice; }
export function setCachedChoice(next: CachedChoice, at: number): void {
    cachedChoice = next;
    lastSyncPromptAt = at;
}

/**
 * Clear the in-flight Sync-during-search cached choice / prompt timestamp.
 * Called from SymbolIndex.synchronize at the start of every new sync.
 */
export function resetSearchDuringSyncState(): void {
    lastSyncPromptAt = 0;
    cachedChoice = undefined;
}

/**
 * Pure decision function for Sync-during-search behavior.
 *
 * - action='cancel' → caller returns [] immediately
 * - action='grep'   → caller runs executeSearch ripgrep fallback
 * - action='prompt' → caller shows a VS Code info message, then branches on the picked button
 *
 * promptExpect hints the primary button label when prompting.
 */
export function decideSearchDuringSyncAction(
    behavior: string,
    now: number,
    lastPromptAt: number,
    cached: CachedChoice,
): { action: 'cancel' | 'grep' | 'prompt'; promptExpect: 'grep-fallback' | 'cancel' | null } {
    // 1-second debounce: reuse cached choice to absorb in-flight request bursts.
    if (now - lastPromptAt < 1000 && cached) {
        return { action: cached === 'grep' ? 'grep' : 'cancel', promptExpect: null };
    }
    if (behavior === 'cancel') { return { action: 'cancel', promptExpect: null }; }
    if (behavior === 'grep-fallback') { return { action: 'grep', promptExpect: null }; }
    if (behavior === 'prompt-cancel') { return { action: 'prompt', promptExpect: 'cancel' }; }
    // Default & 'prompt-grep-fallback'
    return { action: 'prompt', promptExpect: 'grep-fallback' };
}
