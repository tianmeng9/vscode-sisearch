// src/index/indexTypes.ts
// 索引、WAL、分片、Worker 协议相关类型

import type { SearchResult, SearchOptions } from '../types';

export type { SearchOptions, SearchResult };

export type SymbolKind = 'function' | 'class' | 'struct' | 'enum' | 'typedef' | 'namespace' | 'macro' | 'variable' | 'union';

export interface SymbolEntry {
    name: string;
    kind: SymbolKind;
    filePath: string;
    relativePath: string;
    lineNumber: number;
    endLineNumber: number;
    column: number;
    lineContent: string;
}

export interface IndexedFile {
    relativePath: string;
    mtime: number;
    size: number;
    symbolCount: number;
}

export type IndexStatus = 'none' | 'building' | 'ready' | 'stale';

export interface SyncProgress {
    phase: 'scanning' | 'classifying' | 'parsing' | 'saving';
    current: number;
    total: number;
    currentFile?: string;
    etaSeconds?: number;
}

/** Worker → Main thread 消息 */
export interface WorkerResultMessage {
    type: 'result';
    relativePath: string;
    symbols: SymbolEntry[];
    mtime: number;
    size: number;
}

export interface WorkerErrorMessage {
    type: 'error';
    relativePath: string;
    error: string;
}

export type WorkerMessage = WorkerResultMessage | WorkerErrorMessage;

/** Main thread → Worker 消息 */
export interface WorkerParseRequest {
    type: 'parse';
    files: Array<{ absolutePath: string; relativePath: string; mtime: number; size: number }>;
    extensionPath: string;
}

export interface WorkerInitRequest {
    type: 'init';
    extensionPath: string;
}
