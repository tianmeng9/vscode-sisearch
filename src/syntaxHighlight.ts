import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

// shiki 是 ESM-only，需要动态 import
let shikiModule: any;
let highlighter: any;
let initPromise: Promise<void> | undefined;
let supportedLangs: string[] | undefined;
let currentThemeId: string | undefined;

async function loadShiki(): Promise<any> {
    if (shikiModule) { return shikiModule; }
    const dynamicImport = new Function('specifier', 'return import(specifier)');
    shikiModule = await dynamicImport('shiki');
    supportedLangs = Object.keys(shikiModule.bundledLanguages);
    return shikiModule;
}

/**
 * 从 VS Code 已安装的扩展中查找当前主题的 JSON 文件，
 * 读取并构造一个 Shiki 兼容的自定义主题对象。
 */
function loadVSCodeThemeData(): any | undefined {
    const themeName = vscode.workspace.getConfiguration('workbench').get<string>('colorTheme', '');
    if (!themeName) { return undefined; }

    // 遍历所有扩展，找到定义了该主题的扩展
    for (const ext of vscode.extensions.all) {
        const contributes = ext.packageJSON?.contributes;
        if (!contributes?.themes) { continue; }

        for (const themeDef of contributes.themes) {
            const label: string = themeDef.label || themeDef.id || '';
            if (label.toLowerCase() !== themeName.toLowerCase() &&
                (themeDef.id || '').toLowerCase() !== themeName.toLowerCase()) {
                continue;
            }

            // 找到了匹配的主题定义
            const themePath = path.join(ext.extensionPath, themeDef.path);
            try {
                const raw = fs.readFileSync(themePath, 'utf-8');
                // 处理 JSONC（去掉注释）
                const cleaned = raw.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
                const themeData = JSON.parse(cleaned);
                return themeData;
            } catch {
                return undefined;
            }
        }
    }
    return undefined;
}

/**
 * 将 VS Code 主题 JSON 转换为 Shiki 自定义主题格式
 */
function convertToShikiTheme(themeData: any, themeName: string): any {
    const colors = themeData.colors || {};
    const tokenColors = themeData.tokenColors || [];
    const type = themeData.type || 'dark';

    return {
        name: 'vscode-current-theme',
        type,
        bg: colors['editor.background'] || (type === 'dark' ? '#1e1e1e' : '#ffffff'),
        fg: colors['editor.foreground'] || (type === 'dark' ? '#d4d4d4' : '#333333'),
        settings: [
            // 默认前景/背景
            {
                settings: {
                    foreground: colors['editor.foreground'] || (type === 'dark' ? '#d4d4d4' : '#333333'),
                    background: colors['editor.background'] || (type === 'dark' ? '#1e1e1e' : '#ffffff'),
                }
            },
            // 原始 tokenColors
            ...tokenColors.map((tc: any) => ({
                scope: tc.scope,
                settings: tc.settings || {},
            })),
        ],
    };
}

async function ensureHighlighter(): Promise<any> {
    if (highlighter) { return highlighter; }
    if (!initPromise) {
        initPromise = (async () => {
            const shiki = await loadShiki();
            // 用一个 fallback 主题初始化
            highlighter = await shiki.createHighlighter({
                themes: ['dark-plus'],
                langs: [],
            });
        })();
    }
    await initPromise;
    return highlighter;
}

/**
 * 确保当前主题已加载到 highlighter
 */
async function ensureCurrentTheme(): Promise<string> {
    const themeName = vscode.workspace.getConfiguration('workbench').get<string>('colorTheme', '');

    if (currentThemeId === themeName && highlighter) {
        return 'vscode-current-theme';
    }

    const themeData = loadVSCodeThemeData();
    if (themeData) {
        const shikiTheme = convertToShikiTheme(themeData, themeName);
        const hl = await ensureHighlighter();
        try {
            await hl.loadTheme(shikiTheme);
            currentThemeId = themeName;
            return 'vscode-current-theme';
        } catch (e) {
            console.error('[SI Search] Failed to load custom theme:', e);
        }
    }

    // 回退到 dark-plus
    currentThemeId = undefined;
    return 'dark-plus';
}

function mapLanguageId(languageId: string): string | undefined {
    if (!supportedLangs) { return undefined; }
    if (supportedLangs.includes(languageId)) {
        return languageId;
    }
    const map: Record<string, string> = {
        'typescriptreact': 'tsx',
        'javascriptreact': 'jsx',
        'shellscript': 'bash',
        'plaintext': 'text',
    };
    const mapped = map[languageId];
    if (mapped && supportedLangs.includes(mapped)) {
        return mapped;
    }
    return undefined;
}

export interface TokenizedLine {
    num: number;
    content: string;
    html?: string;
}

export interface TokenizeResult {
    lines: TokenizedLine[];
    bg?: string;
}

export async function tokenizeFile(
    fileContent: string,
    languageId: string,
): Promise<TokenizeResult> {
    const rawLines = fileContent.split('\n');

    try {
        await loadShiki();
        const lang = mapLanguageId(languageId);
        if (!lang) {
            return { lines: rawLines.map((content, i) => ({ num: i + 1, content })) };
        }

        const hl = await ensureHighlighter();

        // 按需加载语言
        const loaded = hl.getLoadedLanguages();
        if (!loaded.includes(lang)) {
            await hl.loadLanguage(lang);
        }

        // 加载当前 VS Code 主题
        const theme = await ensureCurrentTheme();

        const { tokens: tokenLines, bg } = hl.codeToTokens(fileContent, { lang, theme });

        const result: TokenizedLine[] = [];
        for (let i = 0; i < rawLines.length; i++) {
            const lineTokens = tokenLines[i];
            if (!lineTokens || lineTokens.length === 0) {
                result.push({ num: i + 1, content: rawLines[i] });
                continue;
            }

            let html = '';
            for (const token of lineTokens) {
                let escaped = escapeHtml(token.content);
                if (token.color) {
                    html += `<span style="color:${token.color}">${escaped}</span>`;
                } else {
                    html += escaped;
                }
            }
            result.push({ num: i + 1, content: rawLines[i], html });
        }
        return { lines: result, bg };
    } catch (e) {
        console.error('[SI Search] tokenize error:', e);
        return { lines: rawLines.map((content, i) => ({ num: i + 1, content })) };
    }
}

function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
