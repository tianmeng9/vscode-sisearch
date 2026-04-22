import { spawn } from 'child_process';
import * as path from 'path';
import * as readline from 'readline';
import * as vscode from 'vscode';
import { SearchOptions, SearchResult } from '../types';
import { rgPath } from '@vscode/ripgrep';
import { SymbolIndex } from '../symbolIndex';
import {
    decideSearchDuringSyncAction,
    getCachedChoice,
    getLastSyncPromptAt,
    resetSearchDuringSyncState as _resetSearchDuringSyncState,
    setCachedChoice,
} from './searchDuringSyncState';

/** Re-exported so SymbolIndex.synchronize can clear the decision cache at each sync start. */
export const resetSearchDuringSyncState = _resetSearchDuringSyncState;
/** Re-exported for host-only integration tests. */
export { decideSearchDuringSyncAction as _decideSearchDuringSyncAction_forTest };

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
        let rlClosed = false;

        // P7.4: readline 逐行消费 stdout,避免将全量输出累积到字符串后再 split
        const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
        rl.on('line', line => {
            const parsed = parseRgLine(line, workspaceRoot);
            if (parsed) { results.push(parsed); }
        });
        // stdout EOF 时 readline 自动 emit 'close'。记录此事实,proc.close 分支据此决定
        // 是同步 resolve 还是注册 once('close') 等待。
        rl.once('close', () => { rlClosed = true; });

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
            // stdout EOF 会让 readline 自动 close 并 flush 完所有 'line' 事件。
            // 若 proc.close 到达时 rl 已经关了 → 行已全部 emit,立即 resolve。
            // 否则(proc 先退出、stdout 尚未 EOF 排完)挂 once('close') 等 flush。
            if (rlClosed) {
                resolve(results);
            } else {
                rl.once('close', () => resolve(results));
                rl.close();
            }
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

async function handleSearchDuringSync(
    behavior: string,
    query: string,
    workspaceRoot: string,
    options: SearchOptions,
    includeExtensions: string[],
    excludePatterns: string[],
    signal?: AbortSignal,
): Promise<SearchResult[]> {
    const now = Date.now();
    const decision = decideSearchDuringSyncAction(behavior, now, getLastSyncPromptAt(), getCachedChoice());

    if (decision.action === 'cancel') {
        setCachedChoice('cancel', now);
        return [];
    }
    if (decision.action === 'grep') {
        setCachedChoice('grep', now);
        return executeSearch(query, workspaceRoot, options, includeExtensions, excludePatterns, signal);
    }

    // decision.action === 'prompt'
    const grepBtn = '改用全文搜索';
    const laterBtn = '稍后再试';
    const cancelBtn = '取消';
    let pick: string | undefined;
    try {
        pick = await vscode.window.showInformationMessage(
            '索引正在 Sync 中,符号搜索暂不可用',
            decision.promptExpect === 'grep-fallback' ? grepBtn : laterBtn,
            cancelBtn,
        );
    } catch {
        pick = undefined;
    }
    const after = Date.now();
    if (pick === grepBtn) {
        setCachedChoice('grep', after);
        return executeSearch(query, workspaceRoot, options, includeExtensions, excludePatterns, signal);
    }
    setCachedChoice('cancel', after);
    return [];
}

export async function executeSearchWithIndex(
    query: string,
    workspaceRoot: string,
    options: SearchOptions,
    includeExtensions: string[],
    excludePatterns: string[],
    index: SymbolIndex | null,
    offset: number = 0,
    signal?: AbortSignal,
): Promise<{ results: SearchResult[]; totalCount: number }> {
    const limit = vscode.workspace
        .getConfiguration('siSearch.search')
        .get<number>('maxResults', 200);

    // M5.2: if sync is running, FTS5 table may be partial — branch on config.
    if (index && index.isSyncInProgress()) {
        const behavior = vscode.workspace
            .getConfiguration('siSearch.search')
            .get<string>('duringSyncBehavior', 'prompt-grep-fallback');
        const results = await handleSearchDuringSync(
            behavior, query, workspaceRoot, options, includeExtensions, excludePatterns, signal,
        );
        return { results, totalCount: results.length };
    }

    if (index && (index.status === 'ready' || index.status === 'stale')) {
        const results = index.searchSymbols(query, workspaceRoot, options, { limit, offset });
        if (results.length > 0) {
            const totalCount = index.countMatches(query, workspaceRoot, options);
            return { results, totalCount };
        }
    }
    // Fallback to ripgrep
    const fallback = await executeSearch(query, workspaceRoot, options, includeExtensions, excludePatterns, signal);
    return { results: fallback, totalCount: fallback.length };
}
