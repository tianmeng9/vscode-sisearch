import * as vscode from 'vscode';

export interface HighlightItem {
    text: string;
    color: string;
}

export class HighlightTreeItem extends vscode.TreeItem {
    constructor(public readonly entry: HighlightItem, public readonly index: number) {
        super(entry.text, vscode.TreeItemCollapsibleState.None);
        this.contextValue = 'highlightItem';
        this.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.blue'));
        this.tooltip = `Highlight: ${entry.text} (${entry.color})`;
    }
}

export class HighlightsTreeProvider implements vscode.TreeDataProvider<HighlightTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<HighlightTreeItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private items: HighlightItem[] = [];

    update(highlights: HighlightItem[]): void {
        this.items = highlights;
        this._onDidChangeTreeData.fire();
    }

    getItems(): HighlightItem[] {
        return [...this.items];
    }

    getTreeItem(element: HighlightTreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(): HighlightTreeItem[] {
        return this.items.map((h, i) => new HighlightTreeItem(h, i));
    }
}
