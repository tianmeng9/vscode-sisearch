// src/largeFileParserStream.ts
// Phase 5B:大文件流式正则扫描。永不整文件 readFileSync,用 createReadStream + 行缓冲。
//
// 契约:
//   - 输入:filePath(存在于磁盘),relativePath(给 SymbolEntry 用)
//   - 输出:与 extractSymbolsByRegex 等价的 SymbolEntry[] —— 至少覆盖 single-line 规则
//     (#define)以及同行 { 的 struct/union/enum/class/namespace 和简单单行函数定义。
//   - 内存:峰值仅取决于最大单行长度 + 小常量(不取决于文件总大小)
//
// 策略:
//   - 使用 readline(按 \n 切行),每读一行:
//     (a) 对 single-line rule 在该行上跑正则
//     (b) 维护一个 "最近 N 行" 小窗口,对跨行 rule(struct/class/函数)拼窗口扫描
//   - 行号:从 1 开始,每次 readline 事件 lineNumber++
//   - 去重:同行 + 同名 + 同 kind 只记一次
//
// 为什么不用 'readline' + Buffer wrangling?readline 默认按 UTF-8 解码每一行成 string,
// 每行都是独立小 string,不会整 concat。GC 友好。

import * as fs from 'fs';
import * as readline from 'readline';
import type { SymbolEntry, SymbolKind } from './types';

const KEYWORDS = new Set([
    'if', 'for', 'while', 'switch', 'return', 'sizeof', 'typeof', 'do', 'else',
    'case', 'break', 'continue', 'goto', 'default', 'typedef', 'struct', 'union',
    'enum', 'class', 'namespace', 'template', 'static', 'inline', 'extern', 'const',
    'volatile', 'register', 'auto', 'signed', 'unsigned', 'void', 'int', 'char',
    'short', 'long', 'float', 'double', 'bool',
]);

// 单行规则 —— 每行独立跑,不需要跨行上下文。
// 宏定义规则就是单行的;其他规则要求 '{' 紧跟在声明后,大多数 Linux kernel 头
// 都是 `struct foo {` 一行式,满足这个假设。跨行极少(后续可改 window 扫描)。
interface SingleLineRule {
    kind: SymbolKind;
    regex: RegExp;
    nameGroup: number;
}

const SINGLE_LINE_RULES: SingleLineRule[] = [
    { kind: 'macro', regex: /^[ \t]*#[ \t]*define[ \t]+([A-Za-z_][A-Za-z0-9_]*)/, nameGroup: 1 },
    { kind: 'struct',    regex: /^[ \t]*(?:typedef[ \t]+)?struct[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]*\{/, nameGroup: 1 },
    { kind: 'union',     regex: /^[ \t]*(?:typedef[ \t]+)?union[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]*\{/, nameGroup: 1 },
    { kind: 'enum',      regex: /^[ \t]*(?:typedef[ \t]+)?enum(?:[ \t]+class)?[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]*\{/, nameGroup: 1 },
    { kind: 'class',     regex: /^[ \t]*(?:template[ \t]*<[^>]*>[ \t]*)?class[ \t]+([A-Za-z_][A-Za-z0-9_]*)(?:[ \t]*:[^{\n]*)?[ \t]*\{/, nameGroup: 1 },
    { kind: 'namespace', regex: /^[ \t]*namespace[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]*\{/, nameGroup: 1 },
];

// 函数定义 - 单行声明 + 大括号的:`int foo(args) {`
const FUNCTION_ONE_LINE = /^[ \t]*(?:(?:static|inline|extern|const|virtual|explicit|constexpr|[A-Z_]+)[ \t]+)*[A-Za-z_][A-Za-z0-9_:<>, \t\*&]*?[ \t\*&]+([A-Za-z_][A-Za-z0-9_]*)[ \t]*\([^;{}]*\)[ \t]*\{/;

// 函数定义 - 次行 { (`int foo(args)` 下一行独立的 `{`):
//   上一行形如 `<type> name(args)` 而不含 `{` 或 `;`
const FUNCTION_DECL_LINE = /^[ \t]*(?:(?:static|inline|extern|const|virtual|explicit|constexpr|[A-Z_]+)[ \t]+)*[A-Za-z_][A-Za-z0-9_:<>, \t\*&]*?[ \t\*&]+([A-Za-z_][A-Za-z0-9_]*)[ \t]*\([^;{}]*\)[ \t]*$/;
const BRACE_LINE = /^[ \t]*\{[ \t]*$/;

/**
 * stream 版可选参数。
 *
 * lineContentMode:
 *   - 'empty'(默认):SymbolEntry.lineContent = '',省内存 —— 寄存器 header 里的
 *     `#define REG__XXX_MASK 0x00000001UL` 原文对搜索/UI 展示几乎无价值,且 16 MB
 *     文件可以累积出 13 万+ SymbolEntry,每个 200+ 字节的 lineContent 就是 25 MB
 *     常驻堆。多 worker 并发时这是主要 OOM 来源。
 *   - 'full':保留原行(回到老行为),用于小文件或测试对齐。
 *
 * macrosOnly:true 时只跑 #define 规则,跳过 struct/union/enum/class/namespace/
 *   function —— 对 AMD GPU 寄存器 header 这类"全是宏"的机器生成文件,减少 seen
 *   Set 和 symbols 数组规模,内存足迹再降一档。
 */
export interface StreamParseOptions {
    lineContentMode?: 'empty' | 'full';
    macrosOnly?: boolean;
    /**
     * Phase 5D:符号级流式输出。若提供,stream 函数不再把符号累积进本地数组
     * (返回空数组),而是每产出一个 SymbolEntry 就调 onSymbol 一次。
     * parseWorker 用这个 callback 做按量 flush —— 14 MB macrosOnly 单文件不再
     * 在返回那一刻 buffer 15 万 entry + postMessage 克隆 double 持有。
     */
    onSymbol?: (entry: SymbolEntry) => void;
}

export async function extractSymbolsByRegexStream(
    filePath: string,
    relativePath: string,
    options: StreamParseOptions = {},
): Promise<SymbolEntry[]> {
    const lineContentMode = options.lineContentMode ?? 'empty';
    const macrosOnly = options.macrosOnly ?? false;
    const onSymbol = options.onSymbol;
    const symbols: SymbolEntry[] = [];
    // macrosOnly 路径只跑单条 #define 规则,不可能同行重复发射 —— seen 不必用,
    // 省 15 万条 dedup key × ~80 B = 12+ MB 常驻堆(对 14 MB mask header 尤其关键)。
    // 非 macrosOnly 仍然保留去重,避免 struct 和 function 在同一行互相命中。
    const seen: Set<string> | null = macrosOnly ? null : new Set();

    const emit = (name: string, kind: SymbolKind, lineNumber: number, column: number, lineContent: string) => {
        if (KEYWORDS.has(name)) { return; }
        if (seen) {
            const dedupKey = `${lineNumber}:${name}:${kind}`;
            if (seen.has(dedupKey)) { return; }
            seen.add(dedupKey);
        }
        const entry: SymbolEntry = {
            name,
            kind,
            filePath,
            relativePath,
            lineNumber,
            endLineNumber: lineNumber,
            column,
            lineContent: lineContentMode === 'full' ? lineContent : '',
        };
        if (onSymbol) {
            onSymbol(entry);
        } else {
            symbols.push(entry);
        }
    };

    await new Promise<void>((resolve, reject) => {
        const rl = readline.createInterface({
            input: fs.createReadStream(filePath, { encoding: 'utf-8' }),
            crlfDelay: Infinity,
        });

        let lineNumber = 0;
        // 保留上一行给 "次行 {" 的函数检测
        let prevLine: string | null = null;
        let prevLineNumber = 0;

        rl.on('line', (rawLine) => {
            lineNumber++;
            // 去掉可能残留的 \r(crlfDelay: Infinity 通常会处理,但保险)
            const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;

            // 1) single-line rules —— macrosOnly 只跑 kind==='macro' 的那条
            for (const r of SINGLE_LINE_RULES) {
                if (macrosOnly && r.kind !== 'macro') { continue; }
                const m = r.regex.exec(line);
                if (m) {
                    const name = m[r.nameGroup];
                    const col = m.index + m[0].indexOf(name);
                    emit(name, r.kind, lineNumber, col < 0 ? 0 : col, line);
                }
            }

            if (!macrosOnly) {
                // 2) function - 同行 { 形式
                const fmSame = FUNCTION_ONE_LINE.exec(line);
                if (fmSame) {
                    const name = fmSame[1];
                    const col = fmSame.index + fmSame[0].indexOf(name);
                    emit(name, 'function', lineNumber, col < 0 ? 0 : col, line);
                }

                // 3) function - 上一行声明 + 本行独立 `{`
                if (prevLine !== null && BRACE_LINE.test(line)) {
                    const fmDecl = FUNCTION_DECL_LINE.exec(prevLine);
                    if (fmDecl) {
                        const name = fmDecl[1];
                        const col = fmDecl.index + fmDecl[0].indexOf(name);
                        emit(name, 'function', prevLineNumber, col < 0 ? 0 : col, prevLine);
                    }
                }

                prevLine = line;
                prevLineNumber = lineNumber;
            }
        });

        rl.on('close', () => resolve());
        rl.on('error', (err) => reject(err));
    });

    return symbols;
}
