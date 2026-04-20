// src/search/navigation.ts
import * as vscode from 'vscode';
import { SearchStore } from './searchStore';
import { SearchResult } from '../types';

/** 打开文件并定位到搜索结果对应的行 */
export async function openResultInEditor(result: SearchResult): Promise<void> {
    const uri = vscode.Uri.file(result.filePath);
    const lineIdx = result.lineNumber - 1;
    const range = new vscode.Range(lineIdx, 0, lineIdx, 0);

    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, {
        selection: range,
        preserveFocus: false,
    });

    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
}

/** 跳转到下一个搜索结果 */
export async function navigateNext(
    store: SearchStore,
    wrap: boolean
): Promise<{ result: SearchResult; index: number } | undefined> {
    const result = store.nextResult(wrap);
    if (!result) { return undefined; }
    await openResultInEditor(result);
    return { result, index: store.getNavigationIndex() };
}

/** 跳转到上一个搜索结果 */
export async function navigatePrevious(
    store: SearchStore,
    wrap: boolean
): Promise<{ result: SearchResult; index: number } | undefined> {
    const result = store.previousResult(wrap);
    if (!result) { return undefined; }
    await openResultInEditor(result);
    return { result, index: store.getNavigationIndex() };
}
