// src/editorDecorations.ts
import * as vscode from 'vscode';
import { SearchResult } from './types';

/** 管理源文件上的装饰：关键字高亮 + gutter 跳转图标 */
export class EditorDecorations {
    private keywordDecorationType: vscode.TextEditorDecorationType;
    private gutterDecorationType: vscode.TextEditorDecorationType;
    private activeResults: SearchResult[] = [];
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

    clearDecorations(): void {
        this.activeResults = [];
        for (const editor of vscode.window.visibleTextEditors) {
            editor.setDecorations(this.keywordDecorationType, []);
            editor.setDecorations(this.gutterDecorationType, []);
        }
    }

    private applyDecorations(): void {
        for (const editor of vscode.window.visibleTextEditors) {
            const filePath = editor.document.uri.fsPath;
            const matchingResults = this.activeResults.filter(r => r.filePath === filePath);

            if (matchingResults.length === 0) {
                editor.setDecorations(this.keywordDecorationType, []);
                editor.setDecorations(this.gutterDecorationType, []);
                continue;
            }

            const keywordRanges: vscode.DecorationOptions[] = [];
            const gutterRanges: vscode.DecorationOptions[] = [];

            for (const result of matchingResults) {
                const lineIdx = result.lineNumber - 1;
                if (lineIdx < 0 || lineIdx >= editor.document.lineCount) { continue; }

                // 关键字高亮
                if (result.matchStart >= 0 && result.matchLength > 0) {
                    const lineLen = editor.document.lineAt(lineIdx).text.length;
                    const endCol = Math.min(result.matchStart + result.matchLength, lineLen);
                    const startPos = new vscode.Position(lineIdx, result.matchStart);
                    const endPos = new vscode.Position(lineIdx, endCol);
                    keywordRanges.push({ range: new vscode.Range(startPos, endPos) });
                }

                // Gutter 跳转图标
                gutterRanges.push({
                    range: new vscode.Range(lineIdx, 0, lineIdx, 0),
                });
            }

            editor.setDecorations(this.keywordDecorationType, keywordRanges);
            editor.setDecorations(this.gutterDecorationType, gutterRanges);
        }
    }

    dispose(): void {
        this.keywordDecorationType.dispose();
        this.gutterDecorationType.dispose();
        for (const d of this.disposables) { d.dispose(); }
    }
}
