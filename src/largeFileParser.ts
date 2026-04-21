// src/largeFileParser.ts
// 超阈值大文件的正则回退提取器。
//
// 存在原因:tree-sitter-c/cpp 的 WASM 线性内存硬上限是 2 GB(web-tree-sitter 的
// `WebAssembly.Memory({maximum: 32768})` × 64 KB/page)。AMD GPU 驱动目录下的
// dcn_3_2_0_sh_mask.h ≈ 24 MB,全是 `#define REG_FIELD_XXX_MASK 0x...` 自动生成
// 行。一次 parser.parse(content) 在分配 AST 节点时会把堆打爆,emscripten abort()
// 走到 process.abort() —— 整个 extension host 直接 exit 134。
//
// 契约:当 parseSymbols 探测到 content.length >= maxBytes 时,把文件交给这里,
// 走 O(n) 正则提取粗粒度符号(宏、struct/union/enum/class/namespace、函数定义)。
// 精度换稳定性 —— 宁可少识别一些模板、lambda、尾返回类型的函数,也不允许单文件
// 把宿主进程打掉。

import type { SymbolEntry, SymbolKind } from './types';

interface Rule {
    kind: SymbolKind;
    regex: RegExp;
    nameGroup: number;
}

// 说明:
// - preproc_def / preproc_function_def 统一归为 'macro'
// - 不做平衡括号/大括号,纯正则扫描 —— 行首锚点 ^...\b 降低误判
// - multiline flag 使 ^ 匹配每行开头
const RULES: Rule[] = [
    // #define NAME ...  或 #define NAME(args) ...
    { kind: 'macro', regex: /^[ \t]*#[ \t]*define[ \t]+([A-Za-z_][A-Za-z0-9_]*)/gm, nameGroup: 1 },
    // struct / union / enum / class + 名字 + { —— 要求后面带 { 以避开前置声明
    { kind: 'struct',    regex: /^[ \t]*(?:typedef[ \t]+)?struct[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t\r\n]*\{/gm, nameGroup: 1 },
    { kind: 'union',     regex: /^[ \t]*(?:typedef[ \t]+)?union[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t\r\n]*\{/gm, nameGroup: 1 },
    { kind: 'enum',      regex: /^[ \t]*(?:typedef[ \t]+)?enum(?:[ \t]+class)?[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t\r\n]*\{/gm, nameGroup: 1 },
    { kind: 'class',     regex: /^[ \t]*(?:template[ \t]*<[^>]*>[ \t]*)?class[ \t]+([A-Za-z_][A-Za-z0-9_]*)(?:[ \t]*:[^{\n]*)?[ \t\r\n]*\{/gm, nameGroup: 1 },
    { kind: 'namespace', regex: /^[ \t]*namespace[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t\r\n]*\{/gm, nameGroup: 1 },
];

// 函数定义的启发式:
//  <返回类型标记> <name> ( ... ) [ \n]* {
// 不支持:模板、尾返回类型、函数指针、operator 重载。
// 为尽量少误判,要求:
//   - 行首有可选的存储类说明符 (static/inline/extern/const/...)
//   - 返回类型含字母或 *
//   - 函数体 { 必须紧随参数列表(允许跨几行空白)
const FUNCTION_RE = /^[ \t]*(?:(?:static|inline|extern|const|virtual|explicit|constexpr|[A-Z_]+)[ \t]+)*[A-Za-z_][A-Za-z0-9_:<>, \t\*&]*?[ \t\*&]+([A-Za-z_][A-Za-z0-9_]*)[ \t]*\([^;{}]*\)[ \t\r\n]*\{/gm;

// C 关键字 —— 误命中时用它过滤
const KEYWORDS = new Set([
    'if', 'for', 'while', 'switch', 'return', 'sizeof', 'typeof', 'do', 'else',
    'case', 'break', 'continue', 'goto', 'default', 'typedef', 'struct', 'union',
    'enum', 'class', 'namespace', 'template', 'static', 'inline', 'extern', 'const',
    'volatile', 'register', 'auto', 'signed', 'unsigned', 'void', 'int', 'char',
    'short', 'long', 'float', 'double', 'bool',
]);

/** 把 char offset 转成 (row, col) —— 逐次线性扫描累积换行。输入不可变。 */
function buildLineIndex(content: string): number[] {
    // 每项是该行第一个字符在 content 里的绝对偏移;第 0 行偏移 0。
    const lineStarts: number[] = [0];
    for (let i = 0; i < content.length; i++) {
        if (content.charCodeAt(i) === 10) { lineStarts.push(i + 1); }
    }
    return lineStarts;
}

/** 二分找 offset 所在行(0-based)。 */
function offsetToLine(lineStarts: number[], offset: number): number {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >>> 1;
        if (lineStarts[mid] <= offset) { lo = mid; }
        else { hi = mid - 1; }
    }
    return lo;
}

function getLineContent(content: string, lineStarts: number[], line0: number): string {
    const start = lineStarts[line0];
    const end = line0 + 1 < lineStarts.length ? lineStarts[line0 + 1] - 1 : content.length;
    // 去掉行尾 \r(Windows 换行)
    let slice = content.slice(start, end);
    if (slice.endsWith('\r')) { slice = slice.slice(0, -1); }
    return slice;
}

/**
 * 对给定内容做正则符号提取。纯函数 —— 不访问磁盘、不 require tree-sitter。
 * 粒度远粗于 tree-sitter 的 AST 查询;用于 parseSymbols 的 maxBytes 回退路径。
 */
export function extractSymbolsByRegex(
    filePath: string,
    relativePath: string,
    content: string,
): SymbolEntry[] {
    const lineStarts = buildLineIndex(content);
    const symbols: SymbolEntry[] = [];
    const seen = new Set<string>(); // 同行 + 同名 去重

    const emit = (name: string, kind: SymbolKind, offset: number) => {
        if (KEYWORDS.has(name)) { return; }
        const line0 = offsetToLine(lineStarts, offset);
        const dedupKey = `${line0}:${name}:${kind}`;
        if (seen.has(dedupKey)) { return; }
        seen.add(dedupKey);
        symbols.push({
            name,
            kind,
            filePath,
            relativePath,
            lineNumber: line0 + 1,
            endLineNumber: line0 + 1,
            column: offset - lineStarts[line0],
            lineContent: getLineContent(content, lineStarts, line0),
        });
    };

    for (const rule of RULES) {
        rule.regex.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = rule.regex.exec(content)) !== null) {
            const name = m[rule.nameGroup];
            // name 的 offset:match.index + match[0].indexOf(name, 相对) —— 为简单起见
            // 就用 match.index(行首附近),偏差只影响 column,不影响 line。
            emit(name, rule.kind, m.index);
        }
    }

    FUNCTION_RE.lastIndex = 0;
    let fm: RegExpExecArray | null;
    while ((fm = FUNCTION_RE.exec(content)) !== null) {
        emit(fm[1], 'function', fm.index);
    }

    return symbols;
}
