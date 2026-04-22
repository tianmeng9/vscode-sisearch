# Changelog

## 1.0.1

### Features
- **Find in results** (`Ctrl+F` inside the results panel) — a find widget styled after VS Code's native editor find, with Match Case / Match Whole Word / Regex toggles. Alt+C/W/R shortcuts and F3/Shift+F3 navigation work like they do in the editor. Searches the currently loaded result rows; scroll loads more if needed.

### Fixes
- **Case-sensitive substring search** now uses SQLite `GLOB` (ASCII-binary) instead of `LIKE` with a JS post-filter. The previous implementation truncated at a 10,000-row coarse limit, so the pagination label could stall at e.g. 544/658 for an "AMDGPU"+caseSensitive search. `COUNT(*)` and `SELECT` now operate on the same WHERE and stay consistent.
- **No more ripgrep fallback when loadMore goes past the index edge.** Previously, scrolling past the real match count caused `executeSearchWithIndex` to return 0 rows from the index, which silently fell back to ripgrep full-text. That would flood the panel with thousands of non-symbol text matches and blow up the pagination counter. Fallback now only runs on the initial search (offset=0) when the index genuinely has zero hits.
- **`LIKE COLLATE BINARY` doesn't do case-sensitive matching in SQLite** (SQLite LIKE's case-sensitivity is controlled by `PRAGMA case_sensitive_like`, not COLLATE). Fixed at the same time as the GLOB refactor above.
- **loadMore routing** — the webview's `loadMore` message was being handled on the sidebar channel, so scrolling never fetched more rows. Moved to the results-panel message channel.
- **Webview scroll container** — results.js now reads scroll position from the body (`document.scrollingElement`) instead of `#resultsList`, matching the actual CSS layout.
- **Virtual scroll height** tracks `totalCount` (not just `loadedCount`) so the scrollbar reflects the true dataset size and scrolling into the unloaded region correctly triggers `loadMore`.
- **Sidebar count** now shows `totalCount` (e.g. 25003) instead of the loaded page size (e.g. 200).
- **Sync "Saving Index" hang** — the writer worker's drain command was queued behind ~178 pending batches and timed out after 60 s. Added back-pressure (`awaitBackpressure(20)`) in the batch-write adapter so the worker queue stays bounded.

### Chores
- `@vscode/codicons` moved to `devDependencies`; the codicon font is copied into `media/` at build time and shipped that way. VSIX size drops from ~12.7 MB to ~12.1 MB.
- `writerDiag` back to env-gated via `SISEARCH_WORKER_DIAG=1` (no longer always on).
- Removed `[SI] …` debug `console.log` calls from production paths.
- README `Architecture` / `How It Works` rewritten for the SQLite FTS5 backend; added documentation for `siSearch.search.duringSyncBehavior` and `siSearch.search.maxResults`.

## 1.0.0

Initial Marketplace release.
