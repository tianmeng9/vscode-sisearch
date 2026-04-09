import * as vscode from 'vscode';

// shiki 是 ESM-only，需要动态 import
let shikiModule: any;
let highlighter: any;
let initPromise: Promise<void> | undefined;
let supportedLangs: string[] | undefined;

async function loadShiki(): Promise<any> {
    if (shikiModule) { return shikiModule; }
    // 使用 Function 构造器绕过 TypeScript 将 import() 编译为 require()
    const dynamicImport = new Function('specifier', 'return import(specifier)');
    shikiModule = await dynamicImport('shiki');
    supportedLangs = Object.keys(shikiModule.bundledLanguages);
    return shikiModule;
}

function getThemeName(): string {
    const kind = vscode.window.activeColorTheme?.kind;
    // ColorThemeKind: 1=Light, 2=Dark, 3=HighContrast, 4=HighContrastLight
    if (kind === 1 || kind === 4) {
        return 'github-light';
    }
    return 'github-dark';
}

async function ensureHighlighter(): Promise<any> {
    if (highlighter) { return highlighter; }
    if (!initPromise) {
        initPromise = (async () => {
            const shiki = await loadShiki();
            highlighter = await shiki.createHighlighter({
                themes: ['github-dark', 'github-light'],
                langs: [],  // 按需加载语言
            });
        })();
    }
    await initPromise;
    return highlighter;
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

export async function tokenizeFile(
    fileContent: string,
    languageId: string,
): Promise<TokenizedLine[]> {
    const rawLines = fileContent.split('\n');

    try {
        await loadShiki();
        const lang = mapLanguageId(languageId);
        if (!lang) {
            return rawLines.map((content, i) => ({ num: i + 1, content }));
        }

        const hl = await ensureHighlighter();

        // 按需加载语言
        const loadedLangs = hl.getLoadedLanguages();
        if (!loadedLangs.includes(lang)) {
            await hl.loadLanguage(lang);
        }

        const theme = getThemeName();
        const { tokens: tokenLines } = hl.codeToTokens(fileContent, {
            lang,
            theme,
        });

        const result: TokenizedLine[] = [];
        for (let i = 0; i < rawLines.length; i++) {
            const lineTokens = tokenLines[i];
            if (!lineTokens || lineTokens.length === 0) {
                result.push({ num: i + 1, content: rawLines[i] });
                continue;
            }

            let html = '';
            for (const token of lineTokens) {
                const escaped = escapeHtml(token.content);
                if (token.color) {
                    html += `<span style="color:${token.color}">${escaped}</span>`;
                } else {
                    html += escaped;
                }
            }
            result.push({ num: i + 1, content: rawLines[i], html });
        }
        return result;
    } catch (e) {
        console.error('[SI Search] tokenize error:', e);
        return rawLines.map((content, i) => ({ num: i + 1, content }));
    }
}

function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
