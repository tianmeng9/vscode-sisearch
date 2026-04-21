import * as path from 'path';
import { SymbolEntry, SymbolKind } from './types';
import { extractSymbolsByRegex } from './largeFileParser';

/**
 * parseSymbols 选项。
 *
 * maxBytes:文件字节数阈值,超过则走 largeFileParser 正则回退,不进 tree-sitter。
 *   - 0 或 undefined:不启用阈值(始终走 tree-sitter) —— 用户明示承担 WASM 爆堆风险。
 *   - 正整数:content.length >= maxBytes 时走回退。
 *
 * 背景:web-tree-sitter WASM 线性内存硬上限 2 GB。AMD GPU 驱动 24 MB 级自动生成
 * 头文件一次 parse 会打穿内存上限并 process.abort() —— 整个 extension host 挂掉。
 */
export interface ParseOptions {
    maxBytes?: number;
}

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
// 每语言一个持久 Parser。per-file `new ParserClass()` 会让 web-tree-sitter 的
// WASM malloc/free 持续累积碎片，33k 文件规模会让 `parser.parse()` 里的 tree
// alloc 最终失败，V8 作为 abort 触发 extension host exit 134（Crashpad
// "last resort; GC in old space requested" 签名）。Parser 可反复 `parse()`，
// 只要释放返回的 Tree；切语言用 setLanguage，代价极低。
let parserC: any = null;
let parserCpp: any = null;
// 测试钩子：统计 Parser 构造次数。生产路径不读。
let parsersCreatedCount = 0;

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

    // 持久 Parser：每语言一个，整个 worker 生命周期复用。
    parserC = new ParserClass();
    parserC.setLanguage(langC);
    parsersCreatedCount++;

    parserCpp = new ParserClass();
    parserCpp.setLanguage(langCpp);
    parsersCreatedCount++;

    parserReady = true;
}

export function parseSymbols(
    filePath: string,
    relativePath: string,
    content: string,
    options?: ParseOptions,
): SymbolEntry[] {
    // 大文件闸门 —— 在任何 tree-sitter 调用之前拦截。maxBytes>0 且 content 超阈值则
    // 不走 parser.parse(),直接交给 O(n) 正则回退,避免 WASM 线性内存爆堆 abort()。
    const maxBytes = options?.maxBytes ?? 0;
    if (maxBytes > 0 && content.length >= maxBytes) {
        return extractSymbolsByRegex(filePath, relativePath, content);
    }

    if (!parserReady || !parserC || !parserCpp || !TreeSitter) { return []; }

    const ext = path.extname(filePath).toLowerCase();
    let parser: any;
    let query: any;

    if (C_EXTENSIONS.has(ext)) {
        parser = parserC;
        query = queryC;
    } else if (CPP_EXTENSIONS.has(ext)) {
        parser = parserCpp;
        query = queryCpp;
    } else {
        return [];
    }

    // 复用持久 Parser。tree 一定要 delete() —— 不 delete 会让 WASM 堆
    // 永久膨胀；但 parser 不能 delete，它要服务下一个文件。
    const tree = parser.parse(content);
    if (!tree) {
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
    // parser 不 delete：见 parserC/parserCpp 的注释。
    return symbols;
}

export function disposeParser(): void {
    parserC?.delete();
    parserCpp?.delete();
    parserC = null;
    parserCpp = null;
    queryC?.delete();
    queryCpp?.delete();
    queryC = null;
    queryCpp = null;
    langC = null;
    langCpp = null;
    TreeSitter = null;
    ParserClass = null;
    parserReady = false;
}

/** @internal 测试钩子：返回至今为止创建过的 Parser 实例数（initParser +2，其它为 0）。 */
export function _getParserStatsForTest(): { parsersCreated: number } {
    return { parsersCreated: parsersCreatedCount };
}
