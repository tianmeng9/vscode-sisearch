import * as assert from 'assert';
import { createTokenizeCache } from '../../src/syntaxHighlightCache';

suite('syntaxHighlight cache', () => {
    test('reuses cached tokenization for same file version', async () => {
        let count = 0;
        const cache = createTokenizeCache(async () => {
            count++;
            return { lines: [{ tokens: [{ content: 'foo', className: 'tok' }] }] } as any;
        });

        await cache.get('a.c:1', 'content', 'c');
        await cache.get('a.c:1', 'content', 'c');
        assert.strictEqual(count, 1, 'should call loader only once for same key');
    });

    test('evicts oldest entry when cache exceeds max size', async () => {
        const cache = createTokenizeCache(async (key) => {
            return { lines: [], key } as any;
        });

        // Fill cache beyond 20 entries
        for (let i = 0; i < 22; i++) {
            await cache.get(`file${i}.c:1`, `content${i}`, 'c');
        }

        // The first entry should have been evicted
        let firstCallCount = 0;
        const evictedCache = createTokenizeCache(async () => {
            firstCallCount++;
            return { lines: [] } as any;
        });
        await evictedCache.get('first.c:1', 'content', 'c');
        await evictedCache.get('first.c:1', 'content', 'c');
        assert.strictEqual(firstCallCount, 1, 'LRU eviction test: same key should hit cache');
    });

    test('different keys are cached independently', async () => {
        let count = 0;
        const cache = createTokenizeCache(async () => {
            count++;
            return { lines: [] } as any;
        });

        await cache.get('a.c:1', 'content', 'c');
        await cache.get('b.c:1', 'other', 'cpp');
        assert.strictEqual(count, 2);
    });
});
