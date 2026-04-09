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
}

/** Message types from sidebar webview to extension */
export type SidebarMessage =
    | { command: 'search'; query: string; options: SearchOptions; mode: SearchMode }
    | { command: 'selectHistory'; id: string }
    | { command: 'deleteHistory'; id: string };

/** Message types from extension to sidebar webview */
export type SidebarUpdate =
    | { command: 'updateHistory'; entries: { id: string; query: string; count: number; active: boolean }[] }
    | { command: 'searchStarted' }
    | { command: 'searchComplete'; count: number };

/** Message types from extension to results panel webview */
export type ResultsPanelUpdate =
    | { command: 'showResults'; results: ResultsPanelEntry[]; query: string }
    | { command: 'appendResults'; results: ResultsPanelEntry[]; query: string }
    | { command: 'highlightEntry'; index: number }
    | { command: 'clearHighlights' };

/** Message types from results panel webview to extension */
export type ResultsPanelMessage =
    | { command: 'jumpToFile'; filePath: string; lineNumber: number }
    | { command: 'requestPreview'; filePath: string; lineNumber: number }
    | { command: 'highlightText'; text: string }
    | { command: 'clearAllHighlights' };

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
};
