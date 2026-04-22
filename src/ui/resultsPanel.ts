import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ResultsPanelEntry, ResultsPanelMessage, PreviewResponse } from '../types';

export class ResultsPanel {
    private panel: vscode.WebviewPanel | undefined;
    private onMessageCallback?: (msg: ResultsPanelMessage) => void;

    constructor(private readonly extensionUri: vscode.Uri) {}

    onMessage(callback: (msg: ResultsPanelMessage) => void): void {
        this.onMessageCallback = callback;
    }

    show(): void {
        if (this.panel) {
            this.panel.reveal(vscode.ViewColumn.One);
            return;
        }
        this.panel = vscode.window.createWebviewPanel(
            'siSearch.resultsPanel',
            'SI Search Results',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
            }
        );

        this.panel.webview.html = this.getHtml(this.panel.webview);

        this.panel.webview.onDidReceiveMessage((msg: ResultsPanelMessage) => {
            this.onMessageCallback?.(msg);
        });

        this.panel.onDidDispose(() => {
            this.panel = undefined;
        });

        this.sendHighlightConfig();
    }

    hide(): void {
        this.panel?.dispose();
    }

    toggle(): void {
        if (this.panel) { this.hide(); } else { this.show(); }
    }

    isVisible(): boolean {
        return this.panel !== undefined;
    }

    showResults(
        results: ResultsPanelEntry[],
        query: string,
        pagination?: { totalCount: number; loadedCount: number },
    ): void {
        this.show();
        const config = vscode.workspace.getConfiguration('siSearch');
        const colors = config.get<string[]>('highlightColors', []);
        const box = config.get<boolean>('highlightBox', true);
        this.postMessage({
            command: 'showResults',
            results,
            query,
            highlightColors: colors,
            highlightBox: box,
            totalCount: pagination?.totalCount ?? results.length,
            loadedCount: pagination?.loadedCount ?? results.length,
        });
    }

    appendResults(
        results: ResultsPanelEntry[],
        totalCount: number,
        loadedCount: number,
    ): void {
        // If panel isn't open, nothing to append to;guard silently.
        this.panel?.webview.postMessage({
            command: 'appendResults',
            results,
            totalCount,
            loadedCount,
        });
    }

    highlightEntry(index: number): void {
        this.postMessage({ command: 'highlightEntry', index });
    }

    sendPreviewData(data: PreviewResponse): void {
        this.postMessage(data);
    }

    triggerHighlightSelection(): void {
        this.postMessage({ command: 'doHighlightSelection' });
    }

    private sendHighlightConfig(): void {
        const config = vscode.workspace.getConfiguration('siSearch');
        const colors = config.get<string[]>('highlightColors', []);
        const box = config.get<boolean>('highlightBox', true);
        this.postMessage({ command: 'setHighlightColors', colors, box });
    }

    postMessage(msg: unknown): void {
        this.panel?.webview.postMessage(msg);
    }

    private getHtml(webview: vscode.Webview): string {
        const mediaPath = vscode.Uri.joinPath(this.extensionUri, 'media');
        const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaPath, 'results.css'));
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaPath, 'results.js'));
        const nonce = getNonce();

        const htmlPath = path.join(this.extensionUri.fsPath, 'media', 'results.html');
        let html = fs.readFileSync(htmlPath, 'utf-8');

        html = html.replace(/\{\{cspSource\}\}/g, webview.cspSource);
        html = html.replace(/\{\{nonce\}\}/g, nonce);
        html = html.replace(/\{\{cssUri\}\}/g, cssUri.toString());
        html = html.replace(/\{\{scriptUri\}\}/g, scriptUri.toString());

        return html;
    }
}

function getNonce(): string {
    let text = '';
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return text;
}
