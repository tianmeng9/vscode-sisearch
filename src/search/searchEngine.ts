import { spawn } from 'child_process';
import * as path from 'path';
import * as readline from 'readline';
import { SearchOptions, SearchResult } from '../types';
import { rgPath } from '@vscode/ripgrep';
import { SymbolIndex } from '../symbolIndex';

export async function executeSearch(
    query: string,
    workspaceRoot: string,
    options: SearchOptions,
    includeExtensions: string[],
    excludePatterns: string[],
    signal?: AbortSignal,
): Promise<SearchResult[]> {
    return new Promise((resolve, reject) => {
        // 外部在 spawn 前已 abort:不起 rg,立即 reject
        if (signal?.aborted) {
            reject(new DOMException('executeSearch aborted', 'AbortError'));
            return;
        }

        const args = buildRgArgs(query, options, includeExtensions, excludePatterns);
        const proc = spawn(rgPath, args, { cwd: workspaceRoot });

        const results: SearchResult[] = [];
        let stderr = '';
        let aborted = false;

        // P7.4: readline 逐行消费 stdout,避免将全量输出累积到字符串后再 split
        const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
        rl.on('line', line => {
            const parsed = parseRgLine(line, workspaceRoot);
            if (parsed) { results.push(parsed); }
        });

        proc.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

        // S6: 取消支持 — abort 时 kill 子进程 + 关 readline + 标记 aborted 让 close 分支走 reject
        const onAbort = () => {
            if (aborted) { return; }
            aborted = true;
            try { proc.kill('SIGTERM'); } catch { /* process may already be dead */ }
            rl.close();
        };
        if (signal) {
            signal.addEventListener('abort', onAbort, { once: true });
        }
        const cleanup = () => {
            if (signal) { signal.removeEventListener('abort', onAbort); }
        };

        proc.on('close', (code) => {
            cleanup();
            if (aborted) {
                reject(new DOMException('executeSearch aborted', 'AbortError'));
                return;
            }
            // ripgrep exits with 1 when no matches — not an error
            if (code !== null && code > 1) {
                reject(new Error(`ripgrep failed (code ${code}): ${stderr}`));
                return;
            }
            // 等待 readline 把 buffer 里最后一行也 emit 完,再 resolve
            rl.once('close', () => resolve(results));
            rl.close();
        });

        proc.on('error', (err) => {
            cleanup();
            rl.close();
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
        // P7.4 后续:防御超长单行(minified/build artifact)撑爆 readline 行缓冲。
        // 命中 4096 字节以上的行,rg 输出 `[Omitted long line with N matches]`,parseRgLine 返回 null。
        '--max-columns', '4096',
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

/**
 * P7.4: 纯函数,解析单行 ripgrep 输出。
 * 格式: `./relative/path:lineNumber:column:content`
 * 返回 null 表示该行不是 match(空行或格式不符,例如 stderr 泄漏)。
 */
export function parseRgLine(line: string, workspaceRoot: string): SearchResult | null {
    if (!line.trim()) { return null; }

    const match = line.match(/^(.+?):(\d+):(\d+):(.*)$/);
    if (!match) { return null; }

    const [, rawPath, lineStr, colStr, content] = match;
    const relativePath = rawPath.replace(/^\.[\\/]/, '');
    const filePath = path.resolve(workspaceRoot, relativePath);

    return {
        filePath,
        relativePath,
        lineNumber: parseInt(lineStr, 10),
        lineContent: content,
        matchStart: parseInt(colStr, 10) - 1,
        matchLength: 0,
    };
}

export async function executeSearchWithIndex(
    query: string,
    workspaceRoot: string,
    options: SearchOptions,
    includeExtensions: string[],
    excludePatterns: string[],
    index: SymbolIndex | null,
    signal?: AbortSignal,
): Promise<SearchResult[]> {
    if (index && (index.status === 'ready' || index.status === 'stale')) {
        const results = index.searchSymbols(query, workspaceRoot, options);
        if (results.length > 0) { return results; }
    }
    // Fallback to ripgrep
    return executeSearch(query, workspaceRoot, options, includeExtensions, excludePatterns, signal);
}
