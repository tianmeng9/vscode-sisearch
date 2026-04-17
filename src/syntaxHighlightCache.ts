// src/syntaxHighlightCache.ts
// LRU tokenize cache — no vscode dependency, testable in plain Node

import type { TokenizeResult } from './syntaxHighlight';

const LRU_MAX = 20;

type TokenizeLoader = (key: string, content: string, languageId: string) => Promise<TokenizeResult>;

export interface TokenizeCache {
    get(key: string, content: string, languageId: string): Promise<TokenizeResult>;
}

/**
 * 创建一个 LRU 预览 tokenize 缓存。
 * key 通常为 `${filePath}:${version}` 以便文件变更后自动失效。
 */
export function createTokenizeCache(loader: TokenizeLoader): TokenizeCache {
    const cache = new Map<string, TokenizeResult>();

    return {
        async get(key: string, content: string, languageId: string): Promise<TokenizeResult> {
            const existing = cache.get(key);
            if (existing) {
                // LRU: move to end
                cache.delete(key);
                cache.set(key, existing);
                return existing;
            }
            const result = await loader(key, content, languageId);
            cache.set(key, result);
            if (cache.size > LRU_MAX) {
                const oldestKey = cache.keys().next().value!;
                cache.delete(oldestKey);
            }
            return result;
        },
    };
}
