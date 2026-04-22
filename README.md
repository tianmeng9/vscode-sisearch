# SI Search

A Source Insight-style code search extension for VS Code, designed for C/C++ developers working on large-scale codebases.

SI Search builds a **symbol index** using tree-sitter parsing and stores it in an on-disk SQLite FTS5 database. This lets symbol lookup stay instant even on workspaces as large as the Linux kernel (70k+ files, tens of millions of symbols), without holding the index in the extension host's JS heap. When the index has no match for a query, SI Search falls back to ripgrep full-text search seamlessly.

## Features

### Symbol Index (Sync)

SI Search uses [tree-sitter](https://tree-sitter.github.io/) (WASM) to parse all C/C++ source files in your workspace and extract symbol definitions:

- **Functions** &mdash; `int main()`, `void foo()`
- **Structs** &mdash; `struct device`
- **Enums** &mdash; `enum state`
- **Typedefs** &mdash; `typedef unsigned int uint32_t`
- **Macros** &mdash; `#define MAX_SIZE 1024`, `#define INIT(x) ...`
- **Classes** (C++) &mdash; `class Widget`
- **Namespaces** (C++) &mdash; `namespace std`
- **Unions** &mdash; `union data`

The index is persisted to disk as a SQLite database at `.sisearch/index.sqlite` in the workspace root and reopened instantly on VS Code restart&mdash;no re-scanning needed.

Press `Ctrl+Shift+S` or click the sync button in the Search panel title bar to build/update the index.

### Two-Tier Search Strategy

1. **Index search** (instant) &mdash; When the symbol index is ready, queries run against the SQLite FTS5 database. Exact name lookup (whole word) uses a B-tree index; substring search uses FTS5 MATCH + `LIKE`/`GLOB` for case-insensitive/case-sensitive filtering; regex extracts literal tokens for FTS5 pre-filtering and then runs `RegExp.test` in JS.
2. **Ripgrep fallback** &mdash; If the index has no results (e.g., searching for a string literal rather than a symbol name), SI Search falls back to ripgrep full-text search.

This hybrid approach gives you the speed of a pre-built index with the coverage of full-text search.

### Search Results Panel

- **Virtual scrolling + pagination** &mdash; Results render through a virtual-scroll list and load incrementally (200 rows at a time by default) so 10k+ results stay responsive.
- **Find in results** &mdash; Press `Ctrl+F` (`Cmd+F`) inside the results panel to open a find widget styled like VS Code's native editor find. It searches within the currently loaded results and supports **Match Case** (`Alt+C`), **Match Whole Word** (`Alt+W`), and **Use Regular Expression** (`Alt+R`) toggles. Enter / Shift+Enter cycle through matches, `F3` / `Shift+F3` work too, Esc closes the widget.
- **Syntax-highlighted preview** &mdash; Hover over any result's code portion to see a multi-line preview with full syntax highlighting (powered by [shiki](https://shiki.matsu.io/)), matching your current VS Code color theme.
- **Jump to source** &mdash; Click the arrow icon on any result to open the file at the exact line.
- **Result navigation** &mdash; Step through results one by one with `Ctrl+Shift+F4` / `Ctrl+Shift+F3`.
- **Gutter indicators** &mdash; Source files that contain search results show blue triangle markers in the editor gutter.
- **CodeLens links** &mdash; "Jump to Search Result" CodeLens appears on matched lines, allowing quick navigation back to the results panel.

### Search Filters (Include / Exclude)

Click the `⋯` button next to the regex toggle to reveal **files to include** and **files to exclude** input fields — just like VS Code's native search.

- **Files to include** &mdash; Comma-separated glob patterns (e.g. `*.c, src/**`). When specified, these **replace** the `includeFileExtensions` setting for that search.
- **Files to exclude** &mdash; Comma-separated glob patterns (e.g. `**/test/**, **/build/**`). These are **merged with** the `excludePatterns` setting.
- Press `Enter` in any of the three inputs (search, include, exclude) to trigger the search.

### Manual Highlights

- Press `Ctrl+Shift+F8` to highlight the selected text (or trigger a selection prompt in the results panel).
- Multiple highlight colors cycle automatically.
- Highlights appear both in the results panel and in all open editors.
- The Highlights tree view in the sidebar shows all active highlights with remove buttons.

### Incremental File Watching

SI Search monitors your workspace for file changes:

- **Modified/created files** are marked as dirty; the status bar shows "stale".
- **Deleted files** are removed from the index (rows delete from `files`; FTS5 entries drop via `ON DELETE CASCADE` + delete trigger).
- Re-sync (`Ctrl+Shift+S`) only re-parses changed files, not the entire workspace.

### Sync-Time Search Behavior

Search requests that arrive while Sync is in progress can behave four different ways; configure with `siSearch.search.duringSyncBehavior` (see [Configuration](#configuration)).

## Architecture

```
                                     ┌─ Worker Pool (N × parseWorker, tree-sitter WASM)
 File System ──▶ SyncOrchestrator ──▶│
                                     └─ DbWriterClient ──▶ dbWriterWorker (owns write handle)
                                                                    │
                                                                    ▼
                                                          .sisearch/index.sqlite
                                                          (SQLite WAL + FTS5)
                                                                    ▲
                                           DbBackend (readonly handle)
                                                                    │
 User query ──▶ SearchEngine ──▶ SymbolIndex ──▶ DbBackend.search ──┘
                      │
                      └─ (no index hits) ──▶ ripgrep fallback
```

**Key components:**

| Component | File | Purpose |
|-----------|------|---------|
| SymbolParser | `src/symbolParser.ts` | Tree-sitter WASM init, grammar loading, S-expression symbol extraction. |
| ParseWorker | `src/sync/parseWorker.ts` | `worker_threads` worker running the parser per batch of files. |
| WorkerPool | `src/sync/workerPool.ts` | Pool (default `os.cpus().length`) dispatching parse jobs. |
| SyncOrchestrator | `src/sync/syncOrchestrator.ts` | Classifier → parse → write pipeline; progress reporting. |
| DbBackend | `src/index/dbBackend.ts` | SQLite FTS5 wrapper; schema bootstrap + readonly search/count; corrupt DB quarantine & auto-reinit. |
| DbWriterWorker | `src/index/dbWriterWorker.ts` | Worker thread owning the write connection. Batches become `db.transaction()` calls. |
| DbWriterClient | `src/index/dbWriterClient.ts` | Main-thread handle to the writer worker; back-pressure (`awaitBackpressure(hwm)`), drain/checkpoint with timeouts. |
| SymbolIndex | `src/symbolIndex.ts` | Façade wiring DbBackend + writer worker + line-content LRU; public API (`searchSymbols` / `countMatches` / `synchronize` / `syncDirty` / `clear`). |
| SearchEngine | `src/search/searchEngine.ts` | Ripgrep wrapper + `executeSearchWithIndex` hybrid dispatcher + sync-time UX. |
| FileWatcher | `src/fileWatcher.ts` | VS Code `FileSystemWatcher` wrapper; tracks dirty/deleted files. |
| SyntaxHighlight | `src/syntaxHighlight.ts` | Shiki-based tokenization for hover preview with VS Code theme integration. |

## Commands

| Command | Title | Default Keybinding |
|---------|-------|--------------------|
| `siSearch.focusSearchPanel` | SI Search: Focus Search Panel | `Ctrl+/` (`Cmd+/` on macOS) |
| `siSearch.toggleResultsPanel` | SI Search: Toggle Results Panel | `Ctrl+Shift+/` (`Cmd+Shift+/`) |
| `siSearch.syncIndex` | SI Search: Synchronize Files | `Ctrl+Shift+S` (`Cmd+Shift+S`) |
| `siSearch.clearIndex` | SI Search: Clear Symbol Index | &mdash; |
| `siSearch.nextResult` | SI Search: Next Result | `Ctrl+Shift+F4` (`Cmd+Shift+F4`) |
| `siSearch.previousResult` | SI Search: Previous Result | `Ctrl+Shift+F3` (`Cmd+Shift+F3`) |
| `siSearch.highlightSelection` | SI Search: Highlight Selection | `Ctrl+Shift+F8` (`Cmd+Shift+F8`) |
| `siSearch.clearAllHighlights` | SI Search: Clear All Highlights | &mdash; |
| `siSearch.jumpToResult` | SI Search: Jump to Result from Source | `Alt+J` |
| `siSearch.findInResults` | SI Search: Find in Results | `Ctrl+F` (`Cmd+F`) when the results panel is focused |
| `siSearch.clearResults` | Clear Search Results | &mdash; |
| `siSearch.removeHighlight` | Remove Highlight | &mdash; |

## Configuration

All settings are under the `siSearch.*` namespace in VS Code settings.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `siSearch.includeFileExtensions` | `string[]` | `[".c", ".h", ".cpp", ".hpp", ".cc", ".cxx", ".hxx", ".inl"]` | File extensions to include in search and symbol indexing. |
| `siSearch.includePaths` | `string[]` | `[]` | Subdirectories to include in symbol indexing (e.g. `["src/wifi", "src/drivers"]`). Empty means entire workspace. |
| `siSearch.excludePatterns` | `string[]` | `["**/build/**", "**/.git/**", "**/node_modules/**"]` | Glob patterns to exclude from search. |
| `siSearch.highlightColors` | `string[]` | `["cyan", "pink", "lightgreen", "magenta", "cornflowerblue", "orange", "green", "red"]` | Color palette for manual highlight marking. Colors cycle in order. |
| `siSearch.highlightBox` | `boolean` | `true` | `true` = border-only box; `false` = solid background fill. |
| `siSearch.navigationWrap` | `boolean` | `true` | Wrap around to the first/last result when navigating past the end/beginning. |
| `siSearch.autoSync` | `boolean` | `true` | Automatically re-sync dirty files after a debounce window. |
| `siSearch.autoSyncDelay` | `number` | `5000` | Debounce (ms) between the last file change and auto-sync kicking off. |
| `siSearch.autoSyncOnSave` | `boolean` | `false` | Trigger sync immediately on file save (bypassing the debounce). |
| `siSearch.parser.maxFileSizeBytes` | `number` | `1048576` (1 MB) | Files larger than this threshold are parsed through a regex-based streaming extractor instead of the tree-sitter AST parser (tree-sitter WASM has a 2 GB heap ceiling that large generated headers can blow past). The streamed symbols are fully indexed. Set to `0` to disable. |
| `siSearch.search.duringSyncBehavior` | `string` | `"prompt-grep-fallback"` | What happens when a search runs while Sync is in progress. Enum: `prompt-grep-fallback` (ask; default action is ripgrep), `prompt-cancel` (ask; default is cancel), `grep-fallback` (silently use ripgrep), `cancel` (silently return no results). A 1-second dedup window suppresses repeated prompts. |
| `siSearch.search.maxResults` | `number` | `200` | Page size for the initial search and each incremental load. Range `50–10000`. The results panel loads more rows automatically as you scroll. |

### Example `.vscode/settings.json`

```jsonc
{
    // Only index files under these subdirectories (empty = entire workspace)
    "siSearch.includePaths": ["src/wifi", "src/drivers"],

    // File extensions for search and indexing
    "siSearch.includeFileExtensions": [".c", ".h", ".cpp", ".hpp"],

    // Glob patterns excluded from all searches
    "siSearch.excludePatterns": ["**/build/**", "**/.git/**", "**/node_modules/**"],

    // Keep the ripgrep fallback prompt; don't auto-trigger grep during sync
    "siSearch.search.duringSyncBehavior": "prompt-cancel",

    // Bigger pages for large workspaces
    "siSearch.search.maxResults": 500
}
```

## Search Options

The search input supports three toggle options:

- **Case Sensitive** (`Aa`) &mdash; Match exact letter casing. Substring mode uses SQLite `GLOB` (ASCII-binary); whole-word mode uses plain `=` equality.
- **Whole Word** (`W`) &mdash; Match the whole symbol name only. Uses B-tree equality against `symbols.name` rather than FTS5 (FTS5's `unicode61` tokenizer keeps underscore-joined C identifiers intact, which would make sub-token matches silently miss).
- **Regex** (`.*`) &mdash; Interpret the query as a JavaScript regular expression. Literal tokens (length ≥ 2 alphanumeric runs) are extracted from the pattern and used as an FTS5 pre-filter, then `RegExp.test` runs on the candidate names.

## Sidebar Views

SI Search contributes two views to its own activity bar container:

| View | ID | Description |
|------|----|-------------|
| Search | `siSearch.searchPanel` | Webview with search input, options, and search history list. |
| Highlights | `siSearch.highlightsView` | Tree view showing all active manual highlights with per-item remove buttons. |

## Status Bar

The status bar item (bottom-left) shows the current index state:

| State | Display | Meaning |
|-------|---------|---------|
| None | `$(database) Index: None` | No index built yet. Click to sync. |
| Building | `$(sync~spin) Index: Syncing...` | Index build in progress. |
| Ready | `$(database) 15,234 symbols` | Index ready with symbol count. |
| Stale | `$(database) 15,234 symbols (stale)` | Files changed since last sync. Click to re-sync. |

## How It Works

### Symbol Parsing

SI Search loads tree-sitter WASM grammars for C and C++ at runtime. For each source file, it runs tree-sitter S-expression queries to extract symbol definitions:

```scheme
;; Example: extract function names
(function_definition
  declarator: (function_declarator
    declarator: (identifier) @name)) @def
```

Each extracted symbol records: name, kind, file path, line number, column.

Large/generated C headers (above `siSearch.parser.maxFileSizeBytes`) bypass tree-sitter WASM and go through a regex-based streaming extractor instead. This path is memory-flat (line-by-line `readline`) and still feeds the SQLite index, so macros from multi-megabyte register headers are fully searchable.

### SQLite FTS5 Index

The index lives in `{workspaceRoot}/.sisearch/index.sqlite` as a SQLite database with:

- `meta` — schema version, created-at timestamp, workspace root, tokenizer name.
- `files` — one row per indexed file (`relative_path` UNIQUE, `mtime_ms`, `size_bytes`, `symbol_count`). Indexed on `relative_path`.
- `symbols` — one row per symbol (`name`, `kind` as enum int, `file_id`, `line_number`, `column`). Foreign key to `files` with `ON DELETE CASCADE`. Indexed on `file_id` and `name`.
- `symbols_fts` — FTS5 virtual table using `unicode61 remove_diacritics 2` tokenizer. Stored as `content=''` (contentless FTS5 — only the inverted index, half the disk footprint).
- Two triggers on `symbols` keep FTS5 in sync:
  - `AFTER INSERT`: `INSERT INTO symbols_fts(rowid, name) VALUES (NEW.id, NEW.name)`
  - `AFTER DELETE`: `INSERT INTO symbols_fts(symbols_fts, rowid, name) VALUES ('delete', OLD.id, OLD.name)` (contentless-FTS5 delete protocol).

Pragmas at open:

```
journal_mode = WAL        crash-safe, readers don't block writers
synchronous  = NORMAL     WAL-safe, ~3× faster than FULL
cache_size   = -65536     64 MB SQLite page cache
temp_store   = MEMORY     keep temp tables off disk
foreign_keys = ON         enforce the CASCADE delete on files
```

The writer-worker additionally sets `synchronous=OFF` and a larger cache (`-262144`, 256 MB) for Sync throughput; readers keep NORMAL.

### Concurrency: Writer Worker + Main-Thread Reader

SQLite write locks are exclusive, so SI Search isolates writes in a dedicated `worker_threads` worker (`dbWriterWorker.ts`) that owns the only write connection. The main thread holds a **readonly** connection (`DbBackend` with `{readonly:true, fileMustExist:true}`) for search queries.

During Sync:

1. `SyncOrchestrator` classifies files (new, dirty, deleted, unchanged).
2. Parse jobs go through `WorkerPool`; each completed batch is a `ParseBatchResult` posted back to the main thread.
3. `onBatchResult` forwards the batch to `DbWriterClient.postBatch`, which sends it to the worker.
4. The worker runs one `db.transaction(() => { insertSymbol × N; upsertFile × M; deleteFileByPath × K })()` per batch.
5. FTS5 triggers keep the inverted index consistent inside the same transaction.

Back-pressure: `DbWriterClient.awaitBackpressure(hwm=20)` polls the in-flight batch counter with a 20 ms sleep when pending > 20; this keeps the worker's message queue bounded so the terminating `drain`/`checkpoint` don't sit behind a flood of batches.

At Sync end the orchestrator awaits `drain()` then `checkpoint()` (both with a 60-second safety timeout, so a stalled worker can't lock the UI on "Saving Index").

### Pagination & Virtual Scrolling

`executeSearchWithIndex` returns `{results, totalCount}`:
- `results` is `DbBackend.search(query, options, {limit, offset})` (paged, bounded to `maxResults` per page).
- `totalCount` is `DbBackend.countMatches(query, options)` (a single `COUNT(*)` against the same WHERE).

The webview receives a `showResults` for page 0 and posts `loadMore` as the user scrolls near the bottom. The extension replies with `appendResults` carrying the next page. Both messages include `loadedCount / totalCount` so the results panel's footer label stays consistent. When the user scrolls past the loaded region, a bottom spacer reserves the row height for not-yet-loaded rows so the scrollbar thumb reflects the true total.

### Incremental Sync

During sync, SI Search compares each file's `mtime_ms` and `size_bytes` against `files`. Only new, modified, or deleted files are processed; deletions cascade to `symbols` (and, via the trigger, to `symbols_fts`). This makes re-syncing a large codebase (e.g., Linux kernel) take seconds rather than minutes.

### Sync-Time Search UX

When a search is dispatched while `SymbolIndex.isSyncInProgress()` returns true, `executeSearchWithIndex` branches on `siSearch.search.duringSyncBehavior`:
- `cancel` — return no results silently.
- `grep-fallback` — silently run ripgrep on the workspace.
- `prompt-grep-fallback` / `prompt-cancel` — show a VS Code information message with "Use Grep" / "Cancel" buttons. A 1-second dedup window suppresses repeats.

### Resilience

- **Corrupt database** — at open, `DbBackend.openOrInit` runs `PRAGMA quick_check`. Failures move the file aside as `.sisearch/index.sqlite.corrupt-<ts>` and re-initialize a fresh schema.
- **Schema version skew** — a newer on-disk schema than the extension expects throws `DbSchemaTooNewError` with a descriptive message. Older schemas are silently rebuilt.
- **Missing native addon** — if `better-sqlite3` fails to load (e.g. no prebuild for this platform/arch), the extension still activates: `siSearch.nativeOk` context key becomes `false`, Sync/Clear commands hide, and all searches automatically route to ripgrep.
- **Legacy `.sisearch/shards/`** — old msgpack shards from pre-SQLite builds are removed on activation.

### Diagnostic Logging

Set `SISEARCH_WORKER_DIAG=1` before launching VS Code to record a JSON-Lines trace of the writer worker's IPC channel (postBatch / ack / drain / checkpoint / timeout) plus every search query on the main thread. Logs go to `$TMPDIR/sisearch-writer-<pid>-main.log` and `-worker.log`. After a crash or hang:

```bash
ls -t /tmp/sisearch-writer-*.log | head -2 | xargs tail -40
```

The diagnostic path is a compile-time no-op when the environment variable is unset (cheap `process.env` read), so production use is unaffected.

## Requirements

- VS Code 1.85.0 or later.
- `better-sqlite3` native addon. Prebuilt binaries for Linux / macOS / Windows × x64 / arm64 are shipped in the VSIX; if your platform isn't covered, the extension falls back to ripgrep-only mode with a status-bar warning.
- The ripgrep binary and all tree-sitter WASM grammars are bundled.

## Build from Source

### Prerequisites

- [Node.js](https://nodejs.org/) 18+ and npm
- [VS Code](https://code.visualstudio.com/) 1.85.0+
- A C/C++ toolchain for `better-sqlite3` to compile against (node-gyp; Python 3.8+; a working `gcc`/`clang`/MSVC). Only needed when no prebuild matches your Node/Electron ABI.

### Install Dependencies

```bash
npm install
```

### Rebuild Native Addon for VS Code (Electron) ABI

VS Code runs extensions inside Electron, which has a different Node ABI than plain Node. Before `F5` debugging or packaging:

```bash
npm run rebuild-electron
```

To run node-only unit tests (see below), rebuild for plain Node instead:

```bash
npm rebuild better-sqlite3
```

### Compile

```bash
npm run compile
```

This runs `tsc -p ./` to compile TypeScript to `out/`.

### Watch Mode (for development)

```bash
npm run watch
```

### Run Tests

Node-runnable unit tests:

```bash
npm run compile
npx mocha --ui tdd out/test/suite/*.test.js
```

Host-only integration tests (launch a VS Code instance):

```bash
npm run test:host
```

### Package as VSIX

```bash
npx @vscode/vsce package
```

### Install VSIX

```bash
code --install-extension sisearch-<version>.vsix
```

Or in VS Code: `Ctrl+Shift+P` → `Extensions: Install from VSIX...`

## Known Limitations

- Symbol indexing currently supports **C and C++ only**. Other languages fall back to ripgrep full-text search.
- The hover preview renders code using the current VS Code theme via shiki. Some custom themes may not render perfectly.
- The `.sisearch/` directory is created in the workspace root. Add it to your `.gitignore` if needed.
- Multi-window concurrent Sync against the same workspace is not specifically handled; SQLite's `BUSY` timeout kicks in and one window will surface an error. Sync from one window at a time.
- `regex` searches on patterns with no literal token (e.g., `.+`) fall back to scanning up to 10,000 symbol names and filtering in JS.

## License

MIT
