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

export interface DbBackendOptions {
    /** Open in read-only mode. Skips DDL, pragmas (except a safe subset), and schema probing. File must exist. */
    readonly?: boolean;
}

export class DbBackend {
    private db: Database.Database | null = null;
    private lineReader = new LineContentReader();
    private readonly readonlyMode: boolean;

    constructor(
        private readonly dbPath: string,
        options: DbBackendOptions = {}
    ) {
        this.readonlyMode = options.readonly === true;
    }

    openOrInit(): void {
        if (this.db) { return; }
        const isMemory = this.dbPath === ':memory:';

        if (this.readonlyMode) {
            // Readonly: trust the file; fail fast if absent. No quick_check,
            // no DDL, no meta write, no journal_mode (writes not allowed).
            this.db = new Database(this.dbPath, { readonly: true, fileMustExist: true });
            this.db.pragma('cache_size = -65536');
            this.db.pragma('temp_store = MEMORY');
            return;
        }

        if (!isMemory && fs.existsSync(this.dbPath)) {
            // 已有文件先 quick_check,损坏就 quarantine
            try {
                const probe = new Database(this.dbPath, { readonly: true });
                const r = probe.pragma('quick_check', { simple: true });
                probe.close();
                if (r !== 'ok') { this.quarantineAndReplace(); }
            } catch {
                this.quarantineAndReplace();
            }
        }
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
        this.verifySchemaVersion();
    }

    integrityCheck(): string {
        if (!this.db) { return 'not opened'; }
        return this.db.pragma('integrity_check', { simple: true }) as string;
    }

    private quarantineAndReplace(): void {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const quarantinePath = `${this.dbPath}.corrupt-${ts}`;
        try { fs.renameSync(this.dbPath, quarantinePath); } catch { /* ignore */ }
        try { fs.unlinkSync(this.dbPath + '-wal'); } catch { /* ignore */ }
        try { fs.unlinkSync(this.dbPath + '-shm'); } catch { /* ignore */ }
    }

    private verifySchemaVersion(): void {
        const version = this.getSchemaVersion();
        if (version > CURRENT_SCHEMA_VERSION) {
            const msg = `sisearch DB schema version ${version} is newer than this extension supports (${CURRENT_SCHEMA_VERSION}). ` +
                        `Please upgrade the extension or delete .sisearch/index.sqlite and re-sync.`;
            throw new Error(msg);
        }
        // 版本更低(或 0)静默重建 —— DDL 的 CREATE TABLE IF NOT EXISTS 已兼容,需要补 meta
        if (version < CURRENT_SCHEMA_VERSION) {
            this.db!.exec('DELETE FROM symbols; DELETE FROM files;');
            this.db!.prepare("UPDATE meta SET value=? WHERE key='schema_version'").run(String(CURRENT_SCHEMA_VERSION));
        }
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

    /**
     * Tunes pragmas for bulk write workload. Called by dbWriterWorker once at
     * startup. synchronous=OFF trades crash safety for ~3x write throughput;
     * since the recovery path is "user re-syncs", the trade is acceptable.
     * cache_size raised to 256 MB — per-connection, allocated lazily as pages
     * are touched, so cost is bounded by actual working set.
     */
    pragmaForSyncMode(): void {
        if (!this.db) { return; }
        this.db.pragma('synchronous = OFF');
        this.db.pragma('cache_size = -262144');  // 256 MB
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

    search(
        query: string,
        options: SearchOptions,
        pagination: SearchPagination = { limit: 200, offset: 0 }
    ): SearchResult[] {
        if (!this.db || !query) { return []; }

        const rows = this.selectForQuery(query, options, pagination);
        const out: SearchResult[] = [];
        for (const row of rows) {
            // row: { name, relativePath, lineNumber, column }
            // lineContent 在 façade 层再填;在 DbBackend 层返回空占位
            const absPath = row.relativePath;   // 替换真实 absPath 在 façade 侧
            const lineContent = '';
            out.push({
                filePath: absPath,
                relativePath: row.relativePath,
                lineNumber: row.lineNumber,
                lineContent,
                matchStart: 0,
                matchLength: row.name.length,
            });
        }
        return out;
    }

    countMatches(query: string, options: SearchOptions): number {
        if (!this.db || !query) { return 0; }
        return this.selectCountForQuery(query, options);
    }

    private selectForQuery(
        query: string, options: SearchOptions, p: SearchPagination
    ): Array<{ name: string; relativePath: string; lineNumber: number; column: number }> {
        // 精确 + case-sensitive → 直接 name=?
        if (options.wholeWord && options.caseSensitive && !options.regex) {
            return this.db!.prepare(
                `SELECT s.name, f.relative_path AS relativePath, s.line_number AS lineNumber, s.column
                 FROM symbols s JOIN files f ON f.id = s.file_id
                 WHERE s.name = ?
                 ORDER BY f.relative_path, s.line_number
                 LIMIT ? OFFSET ?`
            ).all(query, p.limit, p.offset) as any;
        }
        // 精确 + case-insensitive → FTS5 MATCH(unicode61 自带 case fold)
        if (options.wholeWord && !options.regex) {
            const fts = escapeFtsLiteral(query);
            return this.db!.prepare(
                `SELECT s.name, f.relative_path AS relativePath, s.line_number AS lineNumber, s.column
                 FROM symbols_fts JOIN symbols s ON s.id = symbols_fts.rowid
                                  JOIN files f ON f.id = s.file_id
                 WHERE symbols_fts MATCH ?
                 ORDER BY f.relative_path, s.line_number
                 LIMIT ? OFFSET ?`
            ).all(fts, p.limit, p.offset) as any;
        }
        // regex → 提取 literal token 粗过滤 + RegExp 精过滤
        if (options.regex) {
            const tokens = extractLiteralTokens(query);
            const flags = options.caseSensitive ? '' : 'i';
            let re: RegExp;
            try { re = new RegExp(query, flags); } catch { return []; }
            let rows: any[];
            if (tokens.length === 0) {
                rows = this.db!.prepare(
                    `SELECT s.name, f.relative_path AS relativePath, s.line_number AS lineNumber, s.column
                     FROM symbols s JOIN files f ON f.id = s.file_id
                     LIMIT 10000`
                ).all();
            } else {
                const fts = tokens.map(escapeFtsLiteral).join(' OR ');
                rows = this.db!.prepare(
                    `SELECT s.name, f.relative_path AS relativePath, s.line_number AS lineNumber, s.column
                     FROM symbols_fts JOIN symbols s ON s.id = symbols_fts.rowid
                                      JOIN files f ON f.id = s.file_id
                     WHERE symbols_fts MATCH ?`
                ).all(fts);
            }
            const filtered = rows.filter((r: any) => re.test(r.name));
            // Apply sort + pagination
            filtered.sort((a: any, b: any) =>
                a.relativePath.localeCompare(b.relativePath) || a.lineNumber - b.lineNumber);
            return filtered.slice(p.offset, p.offset + p.limit);
        }
        // substring
        const tokens = extractLiteralTokens(query);
        const like = '%' + query.replace(/[%_]/g, '\\$&') + '%';
        if (tokens.length === 0) {
            // 无可用 token,直接 LIKE 扫全表(上限 10k)
            return this.db!.prepare(
                `SELECT s.name, f.relative_path AS relativePath, s.line_number AS lineNumber, s.column
                 FROM symbols s JOIN files f ON f.id = s.file_id
                 WHERE s.name ${options.caseSensitive ? 'GLOB' : 'LIKE'} ? ESCAPE '\\'
                 ORDER BY f.relative_path, s.line_number
                 LIMIT ? OFFSET ?`
            ).all(options.caseSensitive ? `*${query}*` : like, p.limit, p.offset) as any;
        }
        const fts = tokens.map(escapeFtsLiteral).join(' OR ');
        return this.db!.prepare(
            `SELECT s.name, f.relative_path AS relativePath, s.line_number AS lineNumber, s.column
             FROM symbols_fts JOIN symbols s ON s.id = symbols_fts.rowid
                              JOIN files f ON f.id = s.file_id
             WHERE symbols_fts MATCH ? AND s.name ${options.caseSensitive ? 'GLOB' : 'LIKE'} ? ESCAPE '\\'
             ORDER BY f.relative_path, s.line_number
             LIMIT ? OFFSET ?`
        ).all(fts, options.caseSensitive ? `*${query}*` : like, p.limit, p.offset) as any;
    }

    private selectCountForQuery(query: string, options: SearchOptions): number {
        // 用 search() 的同构查询,但换 SELECT COUNT(*),不带 LIMIT/OFFSET
        if (options.wholeWord && options.caseSensitive && !options.regex) {
            const r = this.db!.prepare('SELECT COUNT(*) AS c FROM symbols WHERE name = ?').get(query) as { c: number };
            return r.c;
        }
        if (options.wholeWord && !options.regex) {
            const r = this.db!.prepare('SELECT COUNT(*) AS c FROM symbols_fts WHERE symbols_fts MATCH ?')
                             .get(escapeFtsLiteral(query)) as { c: number };
            return r.c;
        }
        if (options.regex) {
            // regex 没法预估,走 full scan 上限 10000 再 filter
            const tokens = extractLiteralTokens(query);
            let re: RegExp;
            try { re = new RegExp(query, options.caseSensitive ? '' : 'i'); } catch { return 0; }
            let rows: any[];
            if (tokens.length === 0) {
                rows = this.db!.prepare('SELECT name FROM symbols LIMIT 10000').all();
            } else {
                rows = this.db!.prepare('SELECT s.name FROM symbols_fts JOIN symbols s ON s.id = symbols_fts.rowid WHERE symbols_fts MATCH ?')
                             .all(tokens.map(escapeFtsLiteral).join(' OR '));
            }
            return rows.filter((r: any) => re.test(r.name)).length;
        }
        const tokens = extractLiteralTokens(query);
        const like = '%' + query.replace(/[%_]/g, '\\$&') + '%';
        if (tokens.length === 0) {
            const r = this.db!.prepare(
                `SELECT COUNT(*) AS c FROM symbols WHERE name ${options.caseSensitive ? 'GLOB' : 'LIKE'} ? ESCAPE '\\'`
            ).get(options.caseSensitive ? `*${query}*` : like) as { c: number };
            return r.c;
        }
        const fts = tokens.map(escapeFtsLiteral).join(' OR ');
        const r = this.db!.prepare(
            `SELECT COUNT(*) AS c FROM symbols_fts JOIN symbols s ON s.id = symbols_fts.rowid
             WHERE symbols_fts MATCH ? AND s.name ${options.caseSensitive ? 'GLOB' : 'LIKE'} ? ESCAPE '\\'`
        ).get(fts, options.caseSensitive ? `*${query}*` : like) as { c: number };
        return r.c;
    }

    private ensureMeta(): void {
        const upsert = this.db!.prepare('INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)');
        upsert.run('schema_version', String(CURRENT_SCHEMA_VERSION));
        upsert.run('created_at', String(Date.now()));
        upsert.run('tokenizer', 'unicode61');
    }
}
