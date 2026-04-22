// src/types.ts

/** A single search match result */
export interface SearchResult {
    /** Absolute file path */
    filePath: string;
    /** Relative file path from workspace root */
    relativePath: string;
    /** 1-based line number */
    lineNumber: number;
    /** The full text content of the matched line */
    lineContent: string;
    /** Column offset of match start (0-based) */
    matchStart: number;
    /** Length of the match */
    matchLength: number;
}

/** Search options toggled by the user */
export interface SearchOptions {
    caseSensitive: boolean;
    wholeWord: boolean;
    regex: boolean;
}

/** How to add results to the results panel */
export type SearchMode = 'append' | 'replace';

/** One entry in the search history sidebar */
export interface SearchHistoryEntry {
    id: string;
    query: string;
    options: SearchOptions;
    results: SearchResult[];
    timestamp: number;
    /** Total matches for this query on the backend side, before pagination.
     *  Undefined = legacy entry;reader should treat absence as results.length. */
    totalCount?: number;
    /** Number of results currently loaded in `results`. Undefined = results.length. */
    loadedCount?: number;
}

/** Message types from sidebar webview to extension */
export type SidebarMessage =
    | { command: 'search'; query: string; options: SearchOptions; mode: SearchMode; filesToInclude?: string[]; filesToExclude?: string[] }
    | { command: 'selectHistory'; id: string }
    | { command: 'deleteHistory'; id: string }
    | { command: 'clearAllHighlights' };

/** Message types from extension to sidebar webview */
export type SidebarUpdate =
    | { command: 'updateHistory'; entries: { id: string; query: string; count: number; active: boolean }[] }
    | { command: 'searchStarted' }
    | { command: 'searchComplete'; count: number };

/** Message types from extension to results panel webview */
export type ResultsPanelUpdate =
    | { command: 'showResults'; results: ResultsPanelEntry[]; query: string; totalCount?: number; loadedCount?: number }
    | { command: 'appendResults'; results: ResultsPanelEntry[]; query: string; totalCount?: number; loadedCount?: number }
    | { command: 'highlightEntry'; index: number }
    | { command: 'clearHighlights' }
    | { command: 'openFind' };

/** Message types from results panel webview to extension */
export type ResultsPanelMessage =
    | { command: 'jumpToFile'; filePath: string; lineNumber: number }
    | { command: 'requestPreview'; filePath: string; lineNumber: number }
    | { command: 'highlightText'; text: string }
    | { command: 'clearAllHighlights' }
    | { command: 'syncManualHighlights'; highlights: { text: string; color: string }[]; boxMode: boolean }
    | { command: 'loadMore' };

/** A single entry rendered in the results panel */
export interface ResultsPanelEntry {
    filePath: string;
    relativePath: string;
    lineNumber: number;
    lineContent: string;
    matchStart: number;
    matchLength: number;
    /** Global index across all results for navigation */
    globalIndex: number;
}

/** Preview data sent to results panel for hover */
export type PreviewResponse = {
    command: 'previewData';
    filePath: string;
    lineNumber: number;
    lines: { num: number; content: string; html?: string }[];
    bg?: string;
    tabSize?: number;
};

// ── Symbol Index Types ──────────────────────────────────────────

export type SymbolKind = 'function' | 'class' | 'struct' | 'enum' | 'typedef' | 'namespace' | 'macro' | 'variable' | 'union';

export interface SymbolEntry {
    name: string;
    kind: SymbolKind;
    filePath: string;
    relativePath: string;
    lineNumber: number;      // 1-based
    endLineNumber: number;
    column: number;           // 0-based
    lineContent: string;
}

export interface IndexedFile {
    relativePath: string;
    mtime: number;
    size: number;
    symbolCount: number;
}

export interface SerializedIndex {
    version: number;
    createdAt: number;
    workspaceRoot: string;
    files: IndexedFile[];
    symbols: SymbolEntry[];
}

export type IndexStatus = 'none' | 'building' | 'ready' | 'stale';

export interface SyncProgress {
    phase: 'scanning' | 'parsing' | 'saving';
    current: number;
    total: number;
    currentFile?: string;
}
