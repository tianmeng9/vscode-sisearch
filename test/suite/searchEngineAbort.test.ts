// test/suite/searchEngineAbort.test.ts
// R6 V1: executeSearch AbortSignal 三阶段行为验证。
// 需要真实 ripgrep 进程,所以在 tmp 目录铺几个 .c 文件让 rg 有活干。

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { rgPath } from '@vscode/ripgrep';
import { executeSearch } from '../../src/search/searchEngine';

/** 搭建一个临时 workspace,铺 N 个 .c 文件,每文件 1 行命中 "needle"。 */
function makeWorkspace(fileCount: number): string {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sisearch-abort-'));
    for (let i = 0; i < fileCount; i++) {
        fs.writeFileSync(path.join(ws, `f${i}.c`), `int needle_${i}(void) { return ${i}; }\n`);
    }
    return ws;
}

suite('executeSearch AbortSignal (R6 V1)', function () {
    const defaultOptions = { caseSensitive: false, wholeWord: false, regex: false };

    // R7 §3.3: CI 镜像可能无 ripgrep 二进制 —— 在 suite 入口检测 rgPath 可用性,
    // 缺失或不可执行时整 suite skip,避免 CI 红。本地开发因 @vscode/ripgrep 自带 rg
    // 几乎必然通过。
    suiteSetup(function () {
        try {
            fs.accessSync(rgPath, fs.constants.X_OK);
        } catch {
            this.skip();
        }
    });

    test('rejects with AbortError when signal already aborted before spawn', async () => {
        const ws = makeWorkspace(3);
        try {
            const ctrl = new AbortController();
            ctrl.abort();

            await assert.rejects(
                () => executeSearch('needle', ws, defaultOptions, ['.c'], [], ctrl.signal),
                (err: Error) => err.name === 'AbortError',
                'should reject with AbortError when signal aborted pre-spawn',
            );
        } finally {
            fs.rmSync(ws, { recursive: true, force: true });
        }
    });

    test('rejects with AbortError when signal aborts mid-stream', async () => {
        // 铺足够多的文件让 rg 确实运行一段时间,给 abort 窗口
        const ws = makeWorkspace(200);
        try {
            const ctrl = new AbortController();
            const p = executeSearch('needle', ws, defaultOptions, ['.c'], [], ctrl.signal);
            // 同步入 microtask 之后立即 abort,此时 proc 已 spawn
            queueMicrotask(() => ctrl.abort());

            await assert.rejects(
                p,
                (err: Error) => err.name === 'AbortError',
                'should reject with AbortError when signal aborts after spawn',
            );
        } finally {
            fs.rmSync(ws, { recursive: true, force: true });
        }
    });

    test('resolves normally when signal is provided but never aborted', async () => {
        const ws = makeWorkspace(5);
        try {
            const ctrl = new AbortController();
            const results = await executeSearch('needle', ws, defaultOptions, ['.c'], [], ctrl.signal);
            assert.strictEqual(results.length, 5, 'each of 5 files has one needle match');
        } finally {
            fs.rmSync(ws, { recursive: true, force: true });
        }
    });

    test('resolves normally when signal is omitted (backward compat)', async () => {
        const ws = makeWorkspace(3);
        try {
            const results = await executeSearch('needle', ws, defaultOptions, ['.c'], []);
            assert.strictEqual(results.length, 3);
        } finally {
            fs.rmSync(ws, { recursive: true, force: true });
        }
    });
});
