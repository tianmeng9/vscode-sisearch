import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { SidebarMessage } from './types';

export class SidebarProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'siSearch.searchPanel';
    private view?: vscode.WebviewView;
    private onMessageCallback?: (msg: SidebarMessage) => void;

    constructor(private readonly extensionUri: vscode.Uri) {}

    onMessage(callback: (msg: SidebarMessage) => void): void {
        this.onMessageCallback = callback;
    }

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this.view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
        };

        webviewView.webview.html = this.getHtml(webviewView.webview);

        webviewView.webview.onDidReceiveMessage((msg: SidebarMessage) => {
            this.onMessageCallback?.(msg);
        });
    }

    postMessage(msg: unknown): void {
        this.view?.webview.postMessage(msg);
    }

    private getHtml(webview: vscode.Webview): string {
        const mediaPath = vscode.Uri.joinPath(this.extensionUri, 'media');
        const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaPath, 'sidebar.css'));
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaPath, 'sidebar.js'));
        const nonce = getNonce();

        const htmlPath = path.join(this.extensionUri.fsPath, 'media', 'sidebar.html');
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
