import * as vscode from 'vscode';

// shiki 是 ESM-only，需要动态 import
let shikiModule: any;
let highlighter: any;
let initPromise: Promise<void> | undefined;
let supportedLangs: string[] | undefined;
let loadedThemes: Set<string> = new Set();

// VS Code 主题名 → Shiki 主题名映射
const THEME_MAP: Record<string, string> = {
    // Monokai 系列
    'monokai': 'monokai',
    'monokai dimmed': 'monokai',
    'monokai pro': 'monokai',
    'monokai pro (filter machine)': 'monokai',
    'monokai pro (filter octagon)': 'monokai',
    'monokai pro (filter ristretto)': 'monokai',
    'monokai pro (filter spectrum)': 'monokai',
    // VS Code 内置
    'dark+ (default dark+)': 'dark-plus',
    'dark+': 'dark-plus',
    'dark (visual studio)': 'dark-plus',
    'visual studio dark': 'dark-plus',
    'default dark+': 'dark-plus',
    'default dark modern': 'dark-plus',
    'light+ (default light+)': 'light-plus',
    'light+': 'light-plus',
    'light (visual studio)': 'light-plus',
    'visual studio light': 'light-plus',
    'default light+': 'light-plus',
    'default light modern': 'light-plus',
    // Dracula
    'dracula': 'dracula',
    'dracula soft': 'dracula-soft',
    // One Dark
    'one dark pro': 'one-dark-pro',
    'atom one dark': 'one-dark-pro',
    'one dark pro darker': 'one-dark-pro',
    'one dark pro mix': 'one-dark-pro',
    // Nord
    'nord': 'nord',
    // Solarized
    'solarized dark': 'solarized-dark',
    'solarized light': 'solarized-light',
    // Material
    'material theme': 'material-theme',
    'material theme darker': 'material-theme-darker',
    'material theme lighter': 'material-theme-lighter',
    'material theme ocean': 'material-theme-ocean',
    'material theme palenight': 'material-theme-palenight',
    // Night Owl
    'night owl': 'night-owl',
    'night owl light': 'night-owl-light',
    // Rose Pine
    'rosé pine': 'rose-pine',
    'rosé pine dawn': 'rose-pine-dawn',
    'rosé pine moon': 'rose-pine-moon',
    // Tokyo Night
    'tokyo night': 'tokyo-night',
    // Catppuccin
    'catppuccin mocha': 'catppuccin-mocha',
    'catppuccin macchiato': 'catppuccin-macchiato',
    'catppuccin frappé': 'catppuccin-frappe',
    'catppuccin latte': 'catppuccin-latte',
    // Vitesse
    'vitesse dark': 'vitesse-dark',
    'vitesse light': 'vitesse-light',
    // Ayu
    'ayu dark': 'ayu-dark',
    'ayu light': 'ayu-light',
    'ayu mirage': 'ayu-mirage',
    // Gruvbox
    'gruvbox dark medium': 'gruvbox-dark-medium',
    'gruvbox dark hard': 'gruvbox-dark-hard',
    'gruvbox light medium': 'gruvbox-light-medium',
    'gruvbox light hard': 'gruvbox-light-hard',
    // GitHub
    'github dark': 'github-dark',
    'github dark default': 'github-dark-default',
    'github dark dimmed': 'github-dark-dimmed',
    'github light': 'github-light',
    'github light default': 'github-light-default',
};

// 所有可能用到的 Shiki 主题名（去重）
const ALL_SHIKI_THEMES = [...new Set(Object.values(THEME_MAP))];

async function loadShiki(): Promise<any> {
    if (shikiModule) { return shikiModule; }
    // 使用 Function 构造器绕过 TypeScript 将 import() 编译为 require()
    const dynamicImport = new Function('specifier', 'return import(specifier)');
    shikiModule = await dynamicImport('shiki');
    supportedLangs = Object.keys(shikiModule.bundledLanguages);
    return shikiModule;
}

function getShikiTheme(): string {
    const colorTheme = vscode.workspace.getConfiguration('workbench').get<string>('colorTheme', '');
    const normalized = colorTheme.toLowerCase().trim();

    // 精确匹配
    if (THEME_MAP[normalized]) {
        return THEME_MAP[normalized];
    }

    // 模糊匹配：检查主题名是否包含某个关键词
    for (const [key, value] of Object.entries(THEME_MAP)) {
        if (normalized.includes(key) || key.includes(normalized)) {
            return value;
        }
    }

    // 回退到 dark/light
    const kind = vscode.window.activeColorTheme?.kind;
    if (kind === 1 || kind === 4) {
        return 'light-plus';
    }
    return 'dark-plus';
}

async function ensureHighlighter(): Promise<any> {
    if (highlighter) { return highlighter; }
    if (!initPromise) {
        initPromise = (async () => {
            const shiki = await loadShiki();
            // 初始化时加载 dark-plus 和 light-plus 作为基础回退
            highlighter = await shiki.createHighlighter({
                themes: ['dark-plus', 'light-plus'],
                langs: [],
            });
            loadedThemes.add('dark-plus');
            loadedThemes.add('light-plus');
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

        // 按需加载主题
        const theme = getShikiTheme();
        if (!loadedThemes.has(theme)) {
            try {
                await hl.loadTheme(theme);
                loadedThemes.add(theme);
            } catch {
                // 主题加载失败，回退
                const kind = vscode.window.activeColorTheme?.kind;
                return doTokenize(hl, fileContent, lang, (kind === 1 || kind === 4) ? 'light-plus' : 'dark-plus', rawLines);
            }
        }

        return doTokenize(hl, fileContent, lang, theme, rawLines);
    } catch (e) {
        console.error('[SI Search] tokenize error:', e);
        return { lines: rawLines.map((content, i) => ({ num: i + 1, content })) };
    }
}

function doTokenize(hl: any, fileContent: string, lang: string, theme: string, rawLines: string[]): TokenizeResult {
    const { tokens: tokenLines, bg, fg } = hl.codeToTokens(fileContent, { lang, theme });

    // 读取空白字符显示配置
    const renderWhitespace = vscode.workspace.getConfiguration('editor').get<string>('renderWhitespace', 'selection');
    const showWhitespace = renderWhitespace === 'all' || renderWhitespace === 'boundary';

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
            if (showWhitespace) {
                escaped = renderWhitespaceChars(escaped);
            }
            if (token.color) {
                html += `<span style="color:${token.color}">${escaped}</span>`;
            } else {
                html += escaped;
            }
        }
        result.push({ num: i + 1, content: rawLines[i], html });
    }
    return { lines: result, bg };
}

function renderWhitespaceChars(html: string): string {
    // 用可见符号替换 tab 和 space，使用淡色样式
    // → 表示 tab，· 表示 space
    html = html.replace(/\t/g, '<span class="whitespace-char">→\t</span>');
    html = html.replace(/ /g, '<span class="whitespace-char">·</span>');
    return html;
}

function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
