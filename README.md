# SI Search

A Source Insight-style code search extension for VS Code, designed for C/C++ developers working on large-scale codebases.

SI Search builds a **symbol index** using tree-sitter parsing, enabling instant symbol lookup across your entire workspace. When the index doesn't cover a query, it falls back to ripgrep full-text search seamlessly.

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

The index is persisted to disk (`.sisearch/index.json` in the workspace root) and automatically restored on VS Code restart&mdash;no re-scanning needed.

Press `Ctrl+Shift+S` or click the sync button in the Search panel title bar to build/update the index.

### Two-Tier Search Strategy

1. **Index search** (instant) &mdash; When the symbol index is ready, queries are matched against the in-memory index with O(1) exact lookup or fast substring/regex scan.
2. **Ripgrep fallback** &mdash; If the index has no results (e.g., searching for a string literal rather than a symbol name), SI Search automatically falls back to ripgrep full-text search.

This hybrid approach gives you the speed of pre-built indexes with the coverage of full-text search.

### Search Results Panel

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
- **Deleted files** are removed from the index.
- Re-sync (`Ctrl+Shift+S`) only re-parses changed files, not the entire workspace.

## Architecture

```
File System ── SymbolParser (web-tree-sitter WASM) ── SymbolIndex (Memory + Disk)
                                                            |
                                                       SearchEngine
                                                      /           \
                                              Index Search    Ripgrep Fallback

File Watcher ── marks dirty/deleted files ── SymbolIndex
```

**Key components:**

| Component | File | Purpose |
|-----------|------|---------|
| SymbolParser | `src/symbolParser.ts` | Tree-sitter WASM initialization, grammar loading, symbol extraction via S-expression queries |
| SymbolIndex | `src/symbolIndex.ts` | Dual-map in-memory index (`symbolsByFile` + `nameIndex`), full/incremental sync, disk persistence |
| FileWatcher | `src/fileWatcher.ts` | VS Code `FileSystemWatcher` wrapper, tracks dirty/deleted files |
| SearchEngine | `src/searchEngine.ts` | Ripgrep wrapper + `executeSearchWithIndex()` hybrid dispatcher |
| SyntaxHighlight | `src/syntaxHighlight.ts` | Shiki-based tokenization for hover preview, with VS Code theme integration |

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
| `siSearch.highlightBox` | `boolean` | `true` | When `true`, highlights use a border-only box style; when `false`, highlights use solid background fill. |
| `siSearch.navigationWrap` | `boolean` | `true` | Wrap around to the first/last result when navigating past the end/beginning. |
| `siSearch.autoSyncOnSave` | `boolean` | `false` | Automatically re-sync dirty files when saving. |
| `siSearch.parser.maxFileSizeBytes` | `number` | `1048576` (1 MB) | Files larger than this threshold are routed to a fast regex-based streaming extractor instead of the tree-sitter AST parser. See [Large File Handling](#large-file-handling) below. Set to `0` to disable (not recommended; see warning in the setting description). |

### Example `.vscode/settings.json`

```jsonc
{
    // Only index files under these subdirectories (empty = entire workspace)
    "siSearch.includePaths": ["src/wifi", "src/drivers"],

    // File extensions for search and indexing
    "siSearch.includeFileExtensions": [".c", ".h", ".cpp", ".hpp"],

    // Glob patterns excluded from all searches
    "siSearch.excludePatterns": ["**/build/**", "**/.git/**", "**/node_modules/**"]
}
```

## Search Options

The search input supports three toggle options:

- **Case Sensitive** (`Aa`) &mdash; Match exact letter casing.
- **Whole Word** (`W`) &mdash; Match whole words only (maps to ripgrep `--word-regexp` or index exact name match).
- **Regex** (`.*`) &mdash; Interpret the query as a regular expression.

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

Each extracted symbol records: name, kind, file path, line number, column, and the line's text content.

### Large File Handling

Tree-sitter runs inside a WebAssembly runtime with a hard 2 GB linear-memory ceiling. Machine-generated C/C++ headers (e.g., GPU register definitions, protocol schema headers) can be tens of megabytes and contain hundreds of thousands of `#define` directives. Parsing them through tree-sitter can exhaust the WASM heap and abort the extension host with `exit 134 / SIGABRT`.

SI Search routes files by size:

| File size | Path | What happens |
|-----------|------|--------------|
| `< maxFileSizeBytes` (default 1 MB) | **tree-sitter** | Full AST, all symbol kinds, `lineContent` preserved. |
| `≥ maxFileSizeBytes` and `< 10 MB` | **streaming regex** | Line-by-line `readline` + regex extraction for `#define`, `struct`, `union`, `enum`, `class`, `namespace`, simple function definitions. `lineContent` is dropped to keep memory flat. |
| `≥ 10 MB` | **streaming regex, `macrosOnly`** | Only `#define` is extracted. The seen-set for deduplication is also skipped. |

**Important:** Symbols extracted by the streaming path are **counted but not added to the search index**. They are recorded in file metadata (so incremental sync knows the file was processed) but do not appear in search results.

Rationale: on a 33k-file Linux kernel `drivers/` tree, the ~30 register headers that trigger the streaming path contribute roughly 4.5 million machine-generated macro names. Adding them to the main-thread `InMemorySymbolIndex` pushes heap to 2–3 GB and crashes Node's V8 runtime. The default design trades searchability of these headers for stability. Users who need to find a specific register macro can use VS Code's built-in text search (`Ctrl+Shift+F`) or `grep` on the source file.

**Overriding the default:**
- Setting `siSearch.parser.maxFileSizeBytes` to a higher value routes fewer files to the streaming path, but re-exposes you to the WASM-heap crash for any file that actually exceeds tree-sitter's capacity.
- Setting it to `0` disables the streaming path entirely — only use this if you know your workspace has no machine-generated headers.

### Diagnostic Logging

When reproducing a crash, set the environment variable `SISEARCH_WORKER_DIAG=1` before launching VS Code. The parse worker will write a JSON-Lines log to `$TMPDIR/sisearch-worker-<pid>.log` with one line per file entry/read/parse event. After a crash, `tail` the latest log:

```bash
ls -t /tmp/sisearch-worker-*.log | head -1 | xargs tail -20
```

The diagnostic path is a no-op when the environment variable is unset, so production use is unaffected.

### Index Structure

The in-memory index uses two maps for different access patterns:

- **`symbolsByFile`** (`Map<relativePath, SymbolEntry[]>`) &mdash; Enables O(1) per-file removal during incremental updates.
- **`nameIndex`** (`Map<lowerCaseName, SymbolEntry[]>`) &mdash; Enables O(1) exact lookup and fast substring scanning.

### Disk Persistence

The index is serialized to `{workspaceRoot}/.sisearch/index.json` as a JSON file containing:

```json
{
  "version": 1,
  "createdAt": 1712700000000,
  "workspaceRoot": "/path/to/workspace",
  "files": [{ "relativePath": "...", "mtime": ..., "size": ..., "symbolCount": ... }],
  "symbols": [{ "name": "...", "kind": "function", "filePath": "...", ... }]
}
```

On VS Code startup, the index is loaded from disk. The `version` field ensures forward compatibility&mdash;if the format changes, old indexes are discarded and rebuilt.

### Incremental Sync

During sync, SI Search compares each file's `mtime` and `size` against the stored metadata. Only files that are new, modified, or deleted are processed. This makes re-syncing a large codebase (e.g., Linux kernel) take seconds instead of minutes.

## Requirements

- VS Code 1.85.0 or later.
- No external dependencies required. All tree-sitter WASM grammars and the ripgrep binary are bundled with the extension.

## Build from Source

### Prerequisites

- [Node.js](https://nodejs.org/) 18+ and npm
- [VS Code](https://code.visualstudio.com/) 1.85.0+

### Install Dependencies

```bash
npm install
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

### Package as VSIX

```bash
npx @vscode/vsce package
```

This will:
1. Copy WASM files from `node_modules` to `wasm/` (`npm run copy-wasm`)
2. Compile TypeScript (`npm run compile`)
3. Package everything into `sisearch-<version>.vsix`

### Install VSIX

```bash
code --install-extension sisearch-<version>.vsix
```

Or in VS Code: `Ctrl+Shift+P` → `Extensions: Install from VSIX...`

## Known Limitations

- Symbol indexing currently supports **C and C++ only**. Other languages fall back to ripgrep full-text search.
- The hover preview renders code using the current VS Code theme via shiki. Some custom themes may not render perfectly.
- The `.sisearch/` directory is created in the workspace root. Add it to your `.gitignore` if needed.
- **Large machine-generated headers are not symbol-searchable.** Files above `siSearch.parser.maxFileSizeBytes` (default 1 MB) are processed through a regex-based streaming extractor whose output is recorded only in file metadata, not in the searchable index. This protects the extension host from running out of memory on workspaces like the Linux kernel `drivers/` tree where GPU register headers can contribute millions of machine-generated macros. Use VS Code's built-in text search for those files. See [Large File Handling](#large-file-handling) for the full trade-off rationale.

## License

MIT
