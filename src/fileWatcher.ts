import * as vscode from 'vscode';
import * as path from 'path';
import { SymbolIndex } from './symbolIndex';

export interface AutoSyncHandle {
    markDirty(path: string): void;
    markDeleted(path: string): void;
}

export class FileWatcher implements vscode.Disposable {
    private watcher: vscode.FileSystemWatcher | undefined;
    private disposables: vscode.Disposable[] = [];

    constructor(
        private index: SymbolIndex,
        private workspaceRoot: string,
        extensions: string[],
        private autoSync?: AutoSyncHandle,
    ) {
        const pattern = `**/*{${extensions.join(',')}}`;
        this.watcher = vscode.workspace.createFileSystemWatcher(pattern);

        this.disposables.push(
            this.watcher.onDidChange(uri => {
                const rel = path.relative(this.workspaceRoot, uri.fsPath);
                this.index.markDirty(rel);
                this.autoSync?.markDirty(rel);
            }),
            this.watcher.onDidCreate(uri => {
                const rel = path.relative(this.workspaceRoot, uri.fsPath);
                this.index.markDirty(rel);
                this.autoSync?.markDirty(rel);
            }),
            this.watcher.onDidDelete(uri => {
                const rel = path.relative(this.workspaceRoot, uri.fsPath);
                this.index.markDeleted(rel);
                this.autoSync?.markDeleted(rel);
            }),
        );
    }

    dispose(): void {
        this.watcher?.dispose();
        for (const d of this.disposables) { d.dispose(); }
    }
}
