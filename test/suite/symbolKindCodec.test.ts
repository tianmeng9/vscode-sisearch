import * as assert from 'assert';
import { encodeSymbolKind, decodeSymbolKind, SYMBOL_KIND_ID, SYMBOL_KIND_NAME } from '../../src/index/symbolKindCodec';

suite('symbolKindCodec', () => {
    test('encode all 9 kinds to distinct ints 0..8', () => {
        const ids = Object.values(SYMBOL_KIND_ID);
        assert.strictEqual(ids.length, 9);
        assert.deepStrictEqual([...new Set(ids)].sort(), [0,1,2,3,4,5,6,7,8]);
    });

    test('encode → decode round-trips every kind', () => {
        for (const kind of Object.keys(SYMBOL_KIND_ID) as Array<keyof typeof SYMBOL_KIND_ID>) {
            const id = encodeSymbolKind(kind);
            const back = decodeSymbolKind(id);
            assert.strictEqual(back, kind);
        }
    });

    test('decode out-of-range returns "variable" as fallback', () => {
        assert.strictEqual(decodeSymbolKind(999), 'variable');
        assert.strictEqual(decodeSymbolKind(-1), 'variable');
    });

    test('SYMBOL_KIND_NAME indexed by id matches SYMBOL_KIND_ID', () => {
        for (const [name, id] of Object.entries(SYMBOL_KIND_ID)) {
            assert.strictEqual(SYMBOL_KIND_NAME[id], name);
        }
    });
});
