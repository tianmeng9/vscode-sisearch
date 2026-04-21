import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import type { SymbolEntry, IndexedFile, SymbolKind } from './indexTypes';
import type { SearchOptions, SearchResult } from '../types';
import { encodeSymbolKind, decodeSymbolKind } from './symbolKindCodec';
import { escapeFtsLiteral, extractLiteralTokens } from './ftsQueryBuilder';
import { LineContentReader } from './lineContentReader';

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
    DELETE FROM symbols_fts WHERE rowid = OLD.id;
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

    private ensureMeta(): void {
        const upsert = this.db!.prepare('INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)');
        upsert.run('schema_version', String(CURRENT_SCHEMA_VERSION));
        upsert.run('created_at', String(Date.now()));
        upsert.run('tokenizer', 'unicode61');
    }
}
