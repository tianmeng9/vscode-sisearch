import * as path from 'path';
import { SymbolEntry, SymbolKind } from './types';

// web-tree-sitter 0.21+ 是 ESM-only，VS Code 扩展编译为 CJS，
// TypeScript 会把 import() 降级为 require()，所以用 Function 绕过。
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const dynamicImport = new Function('specifier', 'return import(specifier)') as (s: string) => Promise<any>;

let TreeSitter: any = null;
let ParserClass: any = null;
let parserReady = false;
let langC: any = null;
let langCpp: any = null;
let queryC: any = null;
let queryCpp: any = null;

const C_EXTENSIONS = new Set(['.c', '.h']);
const CPP_EXTENSIONS = new Set(['.cpp', '.hpp', '.cc', '.cxx', '.hxx', '.inl']);

const QUERY_SOURCE_C = `
(function_definition declarator: (function_declarator declarator: (identifier) @name)) @def
(struct_specifier name: (type_identifier) @name) @def
(enum_specifier name: (type_identifier) @name) @def
(type_definition declarator: (type_identifier) @name) @def
(preproc_def name: (identifier) @name) @def
(preproc_function_def name: (identifier) @name) @def
(union_specifier name: (type_identifier) @name) @def
`;

const QUERY_SOURCE_CPP = QUERY_SOURCE_C + `
(class_specifier name: (type_identifier) @name) @def
(namespace_definition name: (namespace_identifier) @name) @def
`;

const NODE_TYPE_TO_KIND: Record<string, SymbolKind> = {
    'function_definition': 'function',
    'struct_specifier': 'struct',
    'enum_specifier': 'enum',
    'type_definition': 'typedef',
    'preproc_def': 'macro',
    'preproc_function_def': 'macro',
    'class_specifier': 'class',
    'namespace_definition': 'namespace',
    'union_specifier': 'union',
};

/**
 * 创建 Query 对象，自动适配 0.20 和 0.26 两种 API：
 *  - 0.20: language.query(source)
 *  - 0.26: new Query(language, source)
 */
function createQuery(language: any, source: string): any {
    if (typeof language.query === 'function') {
        return language.query(source);
    }
    return new TreeSitter.Query(language, source);
}

export async function initParser(extensionPath: string): Promise<void> {
    if (parserReady) { return; }

    TreeSitter = await dynamicImport('web-tree-sitter');

    const wasmDir = path.join(extensionPath, 'wasm');
    ParserClass = TreeSitter.Parser ?? TreeSitter.default?.Parser ?? TreeSitter.default;
    const LanguageClass = TreeSitter.Language ?? TreeSitter.default?.Language ?? ParserClass?.Language;

    await ParserClass.init({
        locateFile: () => path.join(wasmDir, 'web-tree-sitter.wasm'),
    });

    langC = await LanguageClass.load(path.join(wasmDir, 'tree-sitter-c.wasm'));
    langCpp = await LanguageClass.load(path.join(wasmDir, 'tree-sitter-cpp.wasm'));

    queryC = createQuery(langC, QUERY_SOURCE_C);
    queryCpp = createQuery(langCpp, QUERY_SOURCE_CPP);

    parserReady = true;
}

export function parseSymbols(filePath: string, relativePath: string, content: string): SymbolEntry[] {
    if (!parserReady || !langC || !langCpp || !TreeSitter) { return []; }

    const ext = path.extname(filePath).toLowerCase();
    let lang: any;
    let query: any;

    if (C_EXTENSIONS.has(ext)) {
        lang = langC;
        query = queryC;
    } else if (CPP_EXTENSIONS.has(ext)) {
        lang = langCpp;
        query = queryCpp;
    } else {
        return [];
    }

    const parser = new ParserClass();
    parser.setLanguage(lang);
    const tree = parser.parse(content);
    if (!tree) {
        parser.delete();
        return [];
    }

    const lines = content.split('\n');
    const symbols: SymbolEntry[] = [];
    const matches = query.matches(tree.rootNode);

    for (const match of matches) {
        const nameCapture = match.captures.find((c: any) => c.name === 'name');
        const defCapture = match.captures.find((c: any) => c.name === 'def');
        if (!nameCapture || !defCapture) { continue; }

        const parentType = defCapture.node.type;
        const kind = NODE_TYPE_TO_KIND[parentType];
        if (!kind) { continue; }

        const startRow = nameCapture.node.startPosition.row;
        const endRow = defCapture.node.endPosition.row;
        const lineContent = startRow < lines.length ? lines[startRow] : '';

        symbols.push({
            name: nameCapture.node.text,
            kind,
            filePath,
            relativePath,
            lineNumber: startRow + 1,
            endLineNumber: endRow + 1,
            column: nameCapture.node.startPosition.column,
            lineContent,
        });
    }

    tree.delete();
    parser.delete();
    return symbols;
}

export function disposeParser(): void {
    queryC?.delete();
    queryCpp?.delete();
    queryC = null;
    queryCpp = null;
    langC = null;
    langCpp = null;
    TreeSitter = null;
    parserReady = false;
}
