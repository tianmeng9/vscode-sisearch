import * as vscode from 'vscode';
import { SearchStore } from '../search/searchStore';

export class SearchResultCodeLensProvider implements vscode.CodeLensProvider {
    private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
    public readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

    constructor(private readonly store: SearchStore) {
        store.onChange(() => this._onDidChangeCodeLenses.fire());
    }

    provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
        const filePath = document.uri.fsPath;
        const results = this.store.getActiveResults();
        const matchingResults = results.filter(r => r.filePath === filePath);

        const lenses: vscode.CodeLens[] = [];
        const seenLines = new Set<number>();

        for (const result of matchingResults) {
            const lineIdx = result.lineNumber - 1;
            if (lineIdx < 0 || lineIdx >= document.lineCount || seenLines.has(lineIdx)) {
                continue;
            }
            seenLines.add(lineIdx);

            const range = new vscode.Range(lineIdx, 0, lineIdx, 0);
            const lens = new vscode.CodeLens(range, {
                title: '$(arrow-left) Jump to Search Result',
                command: 'siSearch.jumpToResult',
                tooltip: 'Jump back to search results panel',
            });
            lenses.push(lens);
        }

        return lenses;
    }
}
