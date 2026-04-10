import * as vscode from 'vscode';

export interface HistoryItem {
    id: string;
    query: string;
    count: number;
    active: boolean;
}

export class HistoryTreeItem extends vscode.TreeItem {
    constructor(public readonly entry: HistoryItem) {
        super(`"${entry.query}" (${entry.count})`, vscode.TreeItemCollapsibleState.None);
        this.description = entry.active ? '●' : '';
        this.contextValue = 'historyItem';
        this.command = {
            command: 'siSearch.selectHistoryItem',
            title: 'Show Results',
            arguments: [entry.id],
        };
        if (entry.active) {
            this.iconPath = new vscode.ThemeIcon('search', new vscode.ThemeColor('charts.green'));
        } else {
            this.iconPath = new vscode.ThemeIcon('history');
        }
    }
}

export class HistoryTreeProvider implements vscode.TreeDataProvider<HistoryTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<HistoryTreeItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private items: HistoryItem[] = [];

    update(entries: HistoryItem[]): void {
        this.items = entries;
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: HistoryTreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(): HistoryTreeItem[] {
        return this.items.map(e => new HistoryTreeItem(e));
    }
}
