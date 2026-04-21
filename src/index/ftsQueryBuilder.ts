/**
 * 把任意字符串包成 FTS5 字面量,所有 FTS5 操作符失效。
 * FTS5 语法:" ... " 是字面量短语,嵌入 " 用 "" 转义。
 */
export function escapeFtsLiteral(s: string): string {
    return '"' + s.replace(/"/g, '""') + '"';
}

/**
 * 从正则 pattern 里抽出长度 >= 2 的字母数字(含下划线)片段,
 * 用于 FTS5 粗过滤 —— 命中这些片段的符号再由 JS `RegExp.test()` 精过滤。
 * 长度 < 2 的片段不返回(避免 FTS5 粗筛开销)。
 */
export function extractLiteralTokens(pattern: string): string[] {
    // 去掉正则元字符
    const tokens = pattern.match(/[A-Za-z0-9_\u4e00-\u9fff]{2,}/g);
    return tokens ?? [];
}
