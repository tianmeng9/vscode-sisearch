import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ResultsPanelEntry, ResultsPanelMessage, PreviewResponse } from './types';

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

        const colors = vscode.workspace.getConfiguration('siSearch').get<string[]>('highlightColors', []);
        this.postMessage({ command: 'setHighlightColors', colors });
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

    showResults(results: ResultsPanelEntry[], query: string): void {
        this.show();
        const colors = vscode.workspace.getConfiguration('siSearch').get<string[]>('highlightColors', []);
        this.postMessage({ command: 'showResults', results, query, highlightColors: colors });
    }

    appendResults(results: ResultsPanelEntry[], query: string): void {
        this.show();
        this.postMessage({ command: 'appendResults', results, query });
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
