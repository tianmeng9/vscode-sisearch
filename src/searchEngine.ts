import { spawn } from 'child_process';
import * as path from 'path';
import { SearchOptions, SearchResult } from './types';
import { rgPath } from '@vscode/ripgrep';
import { SymbolIndex } from './symbolIndex';

export async function executeSearch(
    query: string,
    workspaceRoot: string,
    options: SearchOptions,
    includeExtensions: string[],
    excludePatterns: string[]
): Promise<SearchResult[]> {
    return new Promise((resolve, reject) => {
        const args = buildRgArgs(query, options, includeExtensions, excludePatterns);
        const proc = spawn(rgPath, args, { cwd: workspaceRoot });

        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
        proc.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

        proc.on('close', (code) => {
            // ripgrep exits with 1 when no matches — not an error
            if (code !== null && code > 1) {
                reject(new Error(`ripgrep failed (code ${code}): ${stderr}`));
                return;
            }
            const results = parseRgOutput(stdout, workspaceRoot);
            resolve(results);
        });

        proc.on('error', (err) => {
            reject(new Error(`Failed to spawn ripgrep: ${err.message}`));
        });
    });
}

function buildRgArgs(
    query: string,
    options: SearchOptions,
    includeExtensions: string[],
    excludePatterns: string[]
): string[] {
    const args: string[] = [
        '--line-number',
        '--column',
        '--no-heading',
        '--color', 'never',
        '--with-filename',
    ];

    if (!options.caseSensitive) {
        args.push('--ignore-case');
    } else {
        args.push('--case-sensitive');
    }

    if (options.wholeWord) {
        args.push('--word-regexp');
    }

    if (!options.regex) {
        args.push('--fixed-strings');
    }

    for (const ext of includeExtensions) {
        // If it looks like a raw extension (e.g. ".c"), wrap as "*{ext}";
        // otherwise treat as a user-supplied glob pattern (e.g. "*.c", "src/**")
        if (ext.startsWith('.') && !ext.includes('*') && !ext.includes('/')) {
            args.push('--glob', `*${ext}`);
        } else {
            args.push('--glob', ext);
        }
    }

    for (const pattern of excludePatterns) {
        args.push('--glob', `!${pattern}`);
    }

    args.push('--', query, '.');

    return args;
}

function parseRgOutput(stdout: string, workspaceRoot: string): SearchResult[] {
    const results: SearchResult[] = [];
    const lines = stdout.split('\n');

    for (const line of lines) {
        if (!line.trim()) { continue; }

        // Format: ./relative/path:lineNumber:column:content
        const match = line.match(/^(.+?):(\d+):(\d+):(.*)$/);
        if (!match) { continue; }

        const [, rawPath, lineStr, colStr, content] = match;
        const relativePath = rawPath.replace(/^\.[\\/]/, '');
        const filePath = path.resolve(workspaceRoot, relativePath);

        results.push({
            filePath,
            relativePath,
            lineNumber: parseInt(lineStr, 10),
            lineContent: content,
            matchStart: parseInt(colStr, 10) - 1,
            matchLength: 0,
        });
    }

    return results;
}

export async function executeSearchWithIndex(
    query: string,
    workspaceRoot: string,
    options: SearchOptions,
    includeExtensions: string[],
    excludePatterns: string[],
    index: SymbolIndex | null,
): Promise<SearchResult[]> {
    if (index && (index.status === 'ready' || index.status === 'stale')) {
        const results = index.searchSymbols(query, workspaceRoot, options);
        if (results.length > 0) { return results; }
    }
    // Fallback to ripgrep
    return executeSearch(query, workspaceRoot, options, includeExtensions, excludePatterns);
}
