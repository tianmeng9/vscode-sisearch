// test/mocks/vscode.js
// 最小 vscode API mock,用于在裸 Node(非 electron)下跑单测。
// 仅覆盖现有 src/** 在 require 时实际命中的 API。
// 若测试走到未覆盖的 vscode API,会抛 "not mocked" 提醒补充。

'use strict';

class EventEmitter {
    constructor() {
        this._listeners = [];
        this.event = (listener) => {
            this._listeners.push(listener);
            return {
                dispose: () => {
                    const i = this._listeners.indexOf(listener);
                    if (i >= 0) { this._listeners.splice(i, 1); }
                },
            };
        };
    }
    fire(payload) {
        // 复制快照防止监听器在 fire 回调中修改列表导致跳项
        for (const l of this._listeners.slice()) { l(payload); }
    }
    dispose() { this._listeners.length = 0; }
}

const Uri = {
    file: (p) => ({ fsPath: p, scheme: 'file', path: p }),
    parse: (s) => ({ fsPath: s, scheme: 'file', path: s }),
};

const workspace = {
    findFiles: async () => [],
    fs: {
        stat: async () => ({ mtime: 0, size: 0 }),
        readFile: async () => new Uint8Array(),
    },
    getConfiguration: () => ({
        get: (_k, def) => def,
        update: async () => {},
    }),
    workspaceFolders: undefined,
    onDidChangeConfiguration: () => ({ dispose() {} }),
    onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
};

const window = {
    showInformationMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    createStatusBarItem: () => ({ text: '', tooltip: '', show() {}, hide() {}, dispose() {} }),
};

const commands = {
    registerCommand: () => ({ dispose() {} }),
    executeCommand: async () => undefined,
};

module.exports = {
    EventEmitter,
    Uri,
    workspace,
    window,
    commands,
    StatusBarAlignment: { Left: 1, Right: 2 },
    ViewColumn: { Active: -1, One: 1, Two: 2 },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
};
