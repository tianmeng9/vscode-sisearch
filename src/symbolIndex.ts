import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { SymbolEntry, IndexedFile, SerializedIndex, IndexStatus, SearchResult, SearchOptions, SyncProgress } from './types';
import { parseSymbols } from './symbolParser';

const INDEX_VERSION = 1;
const INDEX_DIR = '.sisearch';
const INDEX_FILE = 'index.json';

export class SymbolIndex {
    private symbolsByFile = new Map<string, SymbolEntry[]>();
    private nameIndex = new Map<string, SymbolEntry[]>();
    private fileMetadata = new Map<string, IndexedFile>();
    private dirtyFiles = new Set<string>();
    private deletedFiles = new Set<string>();
    private _status: IndexStatus = 'none';

    get status(): IndexStatus { return this._status; }

    getStats(): { files: number; symbols: number } {
        let symbols = 0;
        for (const entries of this.symbolsByFile.values()) {
            symbols += entries.length;
        }
        return { files: this.symbolsByFile.size, symbols };
    }

    markDirty(relativePath: string): void {
        this.dirtyFiles.add(relativePath);
        this.deletedFiles.delete(relativePath);
        if (this._status === 'ready') { this._status = 'stale'; }
    }

    markDeleted(relativePath: string): void {
        this.deletedFiles.add(relativePath);
        this.dirtyFiles.delete(relativePath);
        if (this._status === 'ready') { this._status = 'stale'; }
    }

    async synchronize(
        workspaceRoot: string,
        extensions: string[],
        excludePatterns: string[],
        token: vscode.CancellationToken,
        onProgress?: (p: SyncProgress) => void,
    ): Promise<void> {
        this._status = 'building';

        // Phase 1: Scan files
        onProgress?.({ phase: 'scanning', current: 0, total: 0 });

        const includeGlob = `**/*{${extensions.join(',')}}`;
        const excludeGlob = excludePatterns.length
            ? `{${excludePatterns.join(',')}}`
            : undefined;

        const uris = await vscode.workspace.findFiles(includeGlob, excludeGlob);
        if (token.isCancellationRequested) { this._status = this.symbolsByFile.size > 0 ? 'stale' : 'none'; return; }

        // Phase 2: Classify files as added/changed/unchanged/deleted
        const currentFiles = new Map<string, vscode.Uri>();
        for (const uri of uris) {
            const rel = path.relative(workspaceRoot, uri.fsPath);
            currentFiles.set(rel, uri);
        }

        const toProcess: Array<{ relativePath: string; uri: vscode.Uri }> = [];

        for (const [rel, uri] of currentFiles) {
            const existing = this.fileMetadata.get(rel);
            if (!existing) {
                toProcess.push({ relativePath: rel, uri });
                continue;
            }
            try {
                const stat = await vscode.workspace.fs.stat(uri);
                if (stat.mtime !== existing.mtime || stat.size !== existing.size) {
                    toProcess.push({ relativePath: rel, uri });
                }
            } catch {
                toProcess.push({ relativePath: rel, uri });
            }
        }

        // Remove files that no longer exist
        for (const rel of this.fileMetadata.keys()) {
            if (!currentFiles.has(rel)) {
                this.removeFile(rel);
            }
        }

        // Phase 3: Parse changed files
        const total = toProcess.length;
        for (let i = 0; i < total; i++) {
            if (token.isCancellationRequested) { this._status = 'stale'; return; }

            const { relativePath, uri } = toProcess[i];
            if (i % 50 === 0 || i === total - 1) {
                onProgress?.({ phase: 'parsing', current: i + 1, total, currentFile: relativePath });
            }

            try {
                const contentBytes = await vscode.workspace.fs.readFile(uri);
                const content = Buffer.from(contentBytes).toString('utf-8');
                const absPath = path.resolve(workspaceRoot, relativePath);
                const symbols = parseSymbols(absPath, relativePath, content);

                this.removeFile(relativePath);
                this.symbolsByFile.set(relativePath, symbols);
                for (const sym of symbols) {
                    const key = sym.name.toLowerCase();
                    const arr = this.nameIndex.get(key);
                    if (arr) { arr.push(sym); } else { this.nameIndex.set(key, [sym]); }
                }

                const stat = await vscode.workspace.fs.stat(uri);
                this.fileMetadata.set(relativePath, {
                    relativePath,
                    mtime: stat.mtime,
                    size: stat.size,
                    symbolCount: symbols.length,
                });
            } catch {
                // Skip unreadable files
            }
        }

        this.dirtyFiles.clear();
        this.deletedFiles.clear();

        // Phase 4: Save to disk
        onProgress?.({ phase: 'saving', current: 0, total: 1 });
        await this.saveToDisk(workspaceRoot);

        this._status = 'ready';
    }

    async syncDirty(workspaceRoot: string): Promise<void> {
        if (this.dirtyFiles.size === 0 && this.deletedFiles.size === 0) { return; }

        for (const rel of this.deletedFiles) {
            this.removeFile(rel);
        }
        this.deletedFiles.clear();

        for (const rel of this.dirtyFiles) {
            const absPath = path.resolve(workspaceRoot, rel);
            try {
                const uri = vscode.Uri.file(absPath);
                const contentBytes = await vscode.workspace.fs.readFile(uri);
                const content = Buffer.from(contentBytes).toString('utf-8');
                const symbols = parseSymbols(absPath, rel, content);

                this.removeFile(rel);
                this.symbolsByFile.set(rel, symbols);
                for (const sym of symbols) {
                    const key = sym.name.toLowerCase();
                    const arr = this.nameIndex.get(key);
                    if (arr) { arr.push(sym); } else { this.nameIndex.set(key, [sym]); }
                }

                const stat = await vscode.workspace.fs.stat(uri);
                this.fileMetadata.set(rel, {
                    relativePath: rel,
                    mtime: stat.mtime,
                    size: stat.size,
                    symbolCount: symbols.length,
                });
            } catch {
                this.removeFile(rel);
            }
        }
        this.dirtyFiles.clear();

        if (this._status === 'stale') { this._status = 'ready'; }
        await this.saveToDisk(workspaceRoot);
    }

    searchSymbols(query: string, workspaceRoot: string, options: SearchOptions): SearchResult[] {
        if (this._status !== 'ready' && this._status !== 'stale') { return []; }

        const results: SearchResult[] = [];

        if (options.wholeWord && !options.regex) {
            // Exact match via nameIndex
            const key = options.caseSensitive ? query : query.toLowerCase();
            const candidates = options.caseSensitive
                ? this.getExactCaseSensitive(query)
                : (this.nameIndex.get(key) || []);

            for (const sym of candidates) {
                results.push(this.symbolToResult(sym));
            }
        } else if (options.regex) {
            // Regex match across all symbol names
            try {
                const flags = options.caseSensitive ? '' : 'i';
                const re = new RegExp(query, flags);
                for (const [name, syms] of this.nameIndex) {
                    if (re.test(name)) {
                        for (const sym of syms) {
                            results.push(this.symbolToResult(sym));
                        }
                    }
                }
            } catch {
                return [];
            }
        } else {
            // Substring match
            const lowerQuery = query.toLowerCase();
            for (const [name, syms] of this.nameIndex) {
                if (name.includes(lowerQuery)) {
                    for (const sym of syms) {
                        if (options.caseSensitive && !sym.name.includes(query)) { continue; }
                        results.push(this.symbolToResult(sym));
                    }
                }
            }
        }

        return results;
    }

    async saveToDisk(workspaceRoot: string): Promise<void> {
        const dir = path.join(workspaceRoot, INDEX_DIR);
        const filePath = path.join(dir, INDEX_FILE);

        const allSymbols: SymbolEntry[] = [];
        for (const syms of this.symbolsByFile.values()) {
            allSymbols.push(...syms);
        }

        const data: SerializedIndex = {
            version: INDEX_VERSION,
            createdAt: Date.now(),
            workspaceRoot,
            files: Array.from(this.fileMetadata.values()),
            symbols: allSymbols,
        };

        try {
            if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
            fs.writeFileSync(filePath, JSON.stringify(data));
        } catch {
            // Silently fail disk persistence
        }
    }

    async loadFromDisk(workspaceRoot: string): Promise<boolean> {
        const filePath = path.join(workspaceRoot, INDEX_DIR, INDEX_FILE);
        try {
            if (!fs.existsSync(filePath)) { return false; }
            const raw = fs.readFileSync(filePath, 'utf-8');
            const data: SerializedIndex = JSON.parse(raw);

            if (data.version !== INDEX_VERSION) { return false; }

            this.symbolsByFile.clear();
            this.nameIndex.clear();
            this.fileMetadata.clear();

            for (const file of data.files) {
                this.fileMetadata.set(file.relativePath, file);
            }

            for (const sym of data.symbols) {
                const byFile = this.symbolsByFile.get(sym.relativePath);
                if (byFile) { byFile.push(sym); } else { this.symbolsByFile.set(sym.relativePath, [sym]); }

                const key = sym.name.toLowerCase();
                const byName = this.nameIndex.get(key);
                if (byName) { byName.push(sym); } else { this.nameIndex.set(key, [sym]); }
            }

            this._status = 'ready';
            return true;
        } catch {
            return false;
        }
    }

    clear(): void {
        this.symbolsByFile.clear();
        this.nameIndex.clear();
        this.fileMetadata.clear();
        this.dirtyFiles.clear();
        this.deletedFiles.clear();
        this._status = 'none';
    }

    clearDisk(workspaceRoot: string): void {
        const filePath = path.join(workspaceRoot, INDEX_DIR, INDEX_FILE);
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
    }

    // ── Private helpers ──

    private removeFile(relativePath: string): void {
        const oldSymbols = this.symbolsByFile.get(relativePath);
        if (oldSymbols) {
            for (const sym of oldSymbols) {
                const key = sym.name.toLowerCase();
                const arr = this.nameIndex.get(key);
                if (arr) {
                    const filtered = arr.filter(s => s.relativePath !== relativePath);
                    if (filtered.length > 0) { this.nameIndex.set(key, filtered); }
                    else { this.nameIndex.delete(key); }
                }
            }
            this.symbolsByFile.delete(relativePath);
        }
        this.fileMetadata.delete(relativePath);
    }

    private getExactCaseSensitive(name: string): SymbolEntry[] {
        const key = name.toLowerCase();
        const candidates = this.nameIndex.get(key);
        if (!candidates) { return []; }
        return candidates.filter(s => s.name === name);
    }

    private symbolToResult(sym: SymbolEntry): SearchResult {
        return {
            filePath: sym.filePath,
            relativePath: sym.relativePath,
            lineNumber: sym.lineNumber,
            lineContent: sym.lineContent,
            matchStart: sym.column,
            matchLength: sym.name.length,
        };
    }
}
