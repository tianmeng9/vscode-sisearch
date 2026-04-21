import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import type { SymbolEntry, IndexedFile, SymbolKind } from './indexTypes';
import type { SearchOptions, SearchResult } from '../types';
import { encodeSymbolKind, decodeSymbolKind } from './symbolKindCodec';
import { escapeFtsLiteral, extractLiteralTokens } from './ftsQueryBuilder';
import { LineContentReader } from './lineContentReader';

function sanitizeSymbolName(raw: string): string {
    if (raw == null) { throw new Error('symbol name required'); }
    const oneLine = raw.replace(/\r\n|\r|\n/g, ' ');
    return oneLine.length > 1024 ? oneLine.slice(0, 1024) : oneLine;
}

const CURRENT_SCHEMA_VERSION = 1;
const DDL = `
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS files (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    relative_path  TEXT NOT NULL UNIQUE,
    mtime_ms       INTEGER NOT NULL,
    size_bytes     INTEGER NOT NULL,
    symbol_count   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_files_relative ON files(relative_path);
CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
    name,
    tokenize='unicode61 remove_diacritics 2',
    content=''
);
CREATE TABLE IF NOT EXISTS symbols (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL,
    kind         INTEGER NOT NULL,
    file_id      INTEGER NOT NULL,
    line_number  INTEGER NOT NULL,
    column       INTEGER NOT NULL,
    FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_symbols_file_id ON symbols(file_id);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE TRIGGER IF NOT EXISTS symbols_fts_insert AFTER INSERT ON symbols BEGIN
    INSERT INTO symbols_fts(rowid, name) VALUES (NEW.id, NEW.name);
END;
CREATE TRIGGER IF NOT EXISTS symbols_fts_delete AFTER DELETE ON symbols BEGIN
    INSERT INTO symbols_fts(symbols_fts, rowid, name) VALUES('delete', OLD.id, OLD.name);
END;
`;

export interface SearchPagination { limit: number; offset: number; }
export interface WriteBatch {
    metadata: IndexedFile[];
    symbols: SymbolEntry[];
    deletedRelativePaths: string[];
}

export class DbBackend {
    private db: Database.Database | null = null;
    private lineReader = new LineContentReader();

    constructor(private readonly dbPath: string) {}

    openOrInit(): void {
        if (this.db) { return; }
        const isMemory = this.dbPath === ':memory:';
        if (!isMemory) {
            fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
        }
        this.db = new Database(this.dbPath);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('synchronous = NORMAL');
        this.db.pragma('cache_size = -65536');
        this.db.pragma('temp_store = MEMORY');
        this.db.pragma('foreign_keys = ON');
        this.db.exec(DDL);
        this.ensureMeta();
    }

    close(): void {
        if (!this.db) { return; }
        try { this.db.close(); } catch { /* ignore */ }
        this.db = null;
    }

    checkpoint(): void {
        if (!this.db) { return; }
        this.db.pragma('wal_checkpoint(TRUNCATE)');
    }

    getSchemaVersion(): number {
        const row = this.db!.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string } | undefined;
        return row ? parseInt(row.value, 10) : 0;
    }

    getStats(): { files: number; symbols: number } {
        const f = this.db!.prepare('SELECT COUNT(*) AS c FROM files').get() as { c: number };
        const s = this.db!.prepare('SELECT COUNT(*) AS c FROM symbols').get() as { c: number };
        return { files: f.c, symbols: s.c };
    }

    writeBatch(batch: WriteBatch): void {
        if (!this.db) { throw new Error('db not opened'); }
        const upsertFile = this.db.prepare(
            `INSERT INTO files(relative_path, mtime_ms, size_bytes, symbol_count)
             VALUES (@relativePath, @mtime, @size, @symbolCount)
             ON CONFLICT(relative_path) DO UPDATE SET
                mtime_ms=excluded.mtime_ms,
                size_bytes=excluded.size_bytes,
                symbol_count=excluded.symbol_count
             RETURNING id`
        );
        const getFileId = this.db.prepare('SELECT id FROM files WHERE relative_path = ?');
        const deleteFile = this.db.prepare('DELETE FROM files WHERE relative_path = ?');
        const deleteSymbolsForFile = this.db.prepare('DELETE FROM symbols WHERE file_id = ?');
        const insertSymbol = this.db.prepare(
            `INSERT INTO symbols(name, kind, file_id, line_number, column)
             VALUES (@name, @kind, @fileId, @line, @col)`
        );

        const txn = this.db.transaction((b: WriteBatch) => {
            // 1. 删除 deletedRelativePaths —— CASCADE 会清 symbols + fts
            for (const rel of b.deletedRelativePaths) {
                deleteFile.run(rel);
            }
            // 2. upsert files 并记住 fileId
            const fileIdByPath = new Map<string, number>();
            for (const m of b.metadata) {
                const row = upsertFile.get({
                    relativePath: m.relativePath,
                    mtime: m.mtime,
                    size: m.size,
                    symbolCount: m.symbolCount,
                }) as { id: number };
                fileIdByPath.set(m.relativePath, row.id);
                // 同文件重新 parse:先清旧 symbols(CASCADE 只在 DELETE files 时;此处 upsert 保留 files 行)
                deleteSymbolsForFile.run(row.id);
            }
            // 3. 插入新 symbols
            for (const s of b.symbols) {
                let fileId = fileIdByPath.get(s.relativePath);
                if (fileId === undefined) {
                    const row = getFileId.get(s.relativePath) as { id: number } | undefined;
                    if (!row) { continue; }
                    fileId = row.id;
                }
                const cleanName = sanitizeSymbolName(s.name);
                insertSymbol.run({
                    name: cleanName,
                    kind: encodeSymbolKind(s.kind),
                    fileId,
                    line: s.lineNumber,
                    col: s.column,
                });
            }
        });
        txn(batch);
    }

    getFileMetadata(relativePath: string): IndexedFile | undefined {
        if (!this.db) { return undefined; }
        const row = this.db.prepare(
            'SELECT relative_path AS relativePath, mtime_ms AS mtime, size_bytes AS size, symbol_count AS symbolCount FROM files WHERE relative_path = ?'
        ).get(relativePath) as IndexedFile | undefined;
        return row;
    }

    getAllFileMetadata(): Map<string, IndexedFile> {
        const result = new Map<string, IndexedFile>();
        if (!this.db) { return result; }
        const rows = this.db.prepare(
            'SELECT relative_path AS relativePath, mtime_ms AS mtime, size_bytes AS size, symbol_count AS symbolCount FROM files'
        ).all() as IndexedFile[];
        for (const r of rows) { result.set(r.relativePath, r); }
        return result;
    }

    clearAll(): void {
        if (!this.db) { return; }
        const txn = this.db.transaction(() => {
            this.db!.exec('DELETE FROM symbols');
            this.db!.exec('DELETE FROM files');
        });
        txn();
    }

    private ensureMeta(): void {
        const upsert = this.db!.prepare('INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)');
        upsert.run('schema_version', String(CURRENT_SCHEMA_VERSION));
        upsert.run('created_at', String(Date.now()));
        upsert.run('tokenizer', 'unicode61');
    }
}
