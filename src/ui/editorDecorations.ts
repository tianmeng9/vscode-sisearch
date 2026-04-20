// src/ui/editorDecorations.ts
import * as vscode from 'vscode';
import { SearchResult } from '../types';

export interface ManualHighlight {
    text: string;
    color: string;
}

/** 管理源文件上的装饰：关键字高亮 + gutter 跳转图标 + 手动高亮 */
export class EditorDecorations {
    private keywordDecorationType: vscode.TextEditorDecorationType;
    private gutterDecorationType: vscode.TextEditorDecorationType;
    private manualHighlightTypes: vscode.TextEditorDecorationType[] = [];
    private activeResults: SearchResult[] = [];
    private manualHighlights: ManualHighlight[] = [];
    private boxMode: boolean = true;
    private disposables: vscode.Disposable[] = [];

    constructor(private readonly extensionUri: vscode.Uri) {
        this.keywordDecorationType = vscode.window.createTextEditorDecorationType({
            backgroundColor: 'rgba(255, 200, 0, 0.3)',
            borderRadius: '2px',
        });

        this.gutterDecorationType = vscode.window.createTextEditorDecorationType({
            gutterIconPath: vscode.Uri.joinPath(extensionUri, 'media', 'gutter-jump.svg'),
            gutterIconSize: 'contain',
        });

        // 编辑器切换时重新应用装饰
        this.disposables.push(
            vscode.window.onDidChangeActiveTextEditor(() => this.applyDecorations()),
            vscode.window.onDidChangeVisibleTextEditors(() => this.applyDecorations())
        );
    }

    updateResults(results: SearchResult[]): void {
        this.activeResults = results;
        this.applyDecorations();
    }

    updateManualHighlights(highlights: ManualHighlight[], boxMode: boolean): void {
        this.manualHighlights = highlights;
        this.boxMode = boxMode;
        this.rebuildManualHighlightTypes();
        this.applyDecorations();
    }

    clearDecorations(): void {
        this.activeResults = [];
        this.manualHighlights = [];
        this.disposeManualHighlightTypes();
        for (const editor of vscode.window.visibleTextEditors) {
            editor.setDecorations(this.keywordDecorationType, []);
            editor.setDecorations(this.gutterDecorationType, []);
        }
    }

    private disposeManualHighlightTypes(): void {
        for (const dt of this.manualHighlightTypes) {
            // 先清空所有编辑器上的装饰
            for (const editor of vscode.window.visibleTextEditors) {
                editor.setDecorations(dt, []);
            }
            dt.dispose();
        }
        this.manualHighlightTypes = [];
    }

    private rebuildManualHighlightTypes(): void {
        this.disposeManualHighlightTypes();

        for (const h of this.manualHighlights) {
            const dt = this.boxMode
                ? vscode.window.createTextEditorDecorationType({
                    borderWidth: '2px',
                    borderStyle: 'solid',
                    borderColor: h.color,
                    borderRadius: '3px',
                    overviewRulerColor: h.color,
                    overviewRulerLane: vscode.OverviewRulerLane.Center,
                })
                : vscode.window.createTextEditorDecorationType({
                    backgroundColor: h.color,
                    color: '#1e1e1e',
                    borderRadius: '3px',
                    overviewRulerColor: h.color,
                    overviewRulerLane: vscode.OverviewRulerLane.Center,
                });
            this.manualHighlightTypes.push(dt);
        }
    }

    private applyDecorations(): void {
        for (const editor of vscode.window.visibleTextEditors) {
            const filePath = editor.document.uri.fsPath;
            const docText = editor.document.getText();

            // 搜索结果的关键字高亮 + gutter
            const matchingResults = this.activeResults.filter(r => r.filePath === filePath);
            if (matchingResults.length === 0) {
                editor.setDecorations(this.keywordDecorationType, []);
                editor.setDecorations(this.gutterDecorationType, []);
            } else {
                const keywordRanges: vscode.DecorationOptions[] = [];
                const gutterRanges: vscode.DecorationOptions[] = [];

                for (const result of matchingResults) {
                    const lineIdx = result.lineNumber - 1;
                    if (lineIdx < 0 || lineIdx >= editor.document.lineCount) { continue; }

                    if (result.matchStart >= 0 && result.matchLength > 0) {
                        const lineLen = editor.document.lineAt(lineIdx).text.length;
                        const endCol = Math.min(result.matchStart + result.matchLength, lineLen);
                        const startPos = new vscode.Position(lineIdx, result.matchStart);
                        const endPos = new vscode.Position(lineIdx, endCol);
                        keywordRanges.push({ range: new vscode.Range(startPos, endPos) });
                    }

                    // hover tooltip 里嵌可点击的 command: 链接 —— VS Code 要求
                    // MarkdownString.isTrusted=true 才会执行 command: URI。
                    const args = encodeURIComponent(JSON.stringify({ filePath, lineNumber: result.lineNumber }));
                    const hoverMsg = new vscode.MarkdownString(
                        `[$(arrow-left) Jump to Search Result](command:siSearch.jumpToResult?${args} "Back to results panel")` +
                        `  \n*or press* \`Alt+J\``,
                        true,
                    );
                    hoverMsg.isTrusted = true;
                    hoverMsg.supportThemeIcons = true;

                    gutterRanges.push({
                        range: new vscode.Range(lineIdx, 0, lineIdx, 0),
                        hoverMessage: hoverMsg,
                    });
                }

                editor.setDecorations(this.keywordDecorationType, keywordRanges);
                editor.setDecorations(this.gutterDecorationType, gutterRanges);
            }

            // 手动高亮：在整个文档中查找每个高亮文本的所有出现位置
            for (let i = 0; i < this.manualHighlights.length; i++) {
                const h = this.manualHighlights[i];
                const dt = this.manualHighlightTypes[i];
                if (!dt) { continue; }

                const ranges: vscode.DecorationOptions[] = [];
                const searchText = h.text;
                const lowerDocText = docText.toLowerCase();
                const lowerSearch = searchText.toLowerCase();
                let startIdx = 0;

                while (true) {
                    const idx = lowerDocText.indexOf(lowerSearch, startIdx);
                    if (idx === -1) { break; }

                    const startPos = editor.document.positionAt(idx);
                    const endPos = editor.document.positionAt(idx + searchText.length);
                    ranges.push({ range: new vscode.Range(startPos, endPos) });
                    startIdx = idx + 1;
                }

                editor.setDecorations(dt, ranges);
            }
        }
    }

    dispose(): void {
        this.keywordDecorationType.dispose();
        this.gutterDecorationType.dispose();
        this.disposeManualHighlightTypes();
        for (const d of this.disposables) { d.dispose(); }
    }
}
