// test/mocks/register.js
// 通过 Module._resolveFilename hook 将裸 require('vscode') 指向 test/mocks/vscode.js
// 使用方式:mocha --require ./test/mocks/register.js ...

'use strict';
const Module = require('module');
const path = require('path');

const vscodeMockPath = path.resolve(__dirname, 'vscode.js');
const origResolve = Module._resolveFilename;

Module._resolveFilename = function patched(request, parent, ...rest) {
    if (request === 'vscode') { return vscodeMockPath; }
    return origResolve.call(this, request, parent, ...rest);
};
