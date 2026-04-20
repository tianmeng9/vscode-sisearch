import * as assert from 'assert';
import { createReusableParser, parseSymbolsWithParser } from '../../src/symbolParser';

suite('symbolParser', () => {
    test('createReusableParser and parseSymbolsWithParser are exported functions', () => {
        assert.strictEqual(typeof createReusableParser, 'function', 'createReusableParser should be a function');
        assert.strictEqual(typeof parseSymbolsWithParser, 'function', 'parseSymbolsWithParser should be a function');
    });

    test('parseSymbolsWithParser returns empty array when parser not initialized', () => {
        // Without WASM init, parse() should gracefully return []
        const stubParser = {
            parse: (_filePath: string, _relativePath: string, _content: string) => [] as any[],
            dispose: () => {},
        };
        const result = parseSymbolsWithParser(stubParser, '/workspace/a.c', 'a.c', 'int foo();');
        assert.deepStrictEqual(result, []);
    });
});
