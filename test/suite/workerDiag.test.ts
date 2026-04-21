// test/suite/workerDiag.test.ts
// workerDiag 契约:
//   1. formatDiagLine 输出一行 JSON,含 timestamp/event/pid,+ 可选 payload,以 \n 结尾
//   2. appendDiag 同步落盘 + 自动建目录 + 吞异常(诊断失败不能影响主流程)

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { formatDiagLine, appendDiag, resolveDiagLogPath } from '../../src/sync/workerDiag';

suite('workerDiag', () => {
    test('formatDiagLine produces single-line JSON with required fields', () => {
        const line = formatDiagLine('file:entered', { relativePath: 'a/b.c', sizeBytes: 1024 });
        assert.ok(line.endsWith('\n'), 'must end with newline for JSONL');
        assert.strictEqual(line.indexOf('\n'), line.length - 1, 'no embedded newline');
        const parsed = JSON.parse(line);
        assert.strictEqual(parsed.event, 'file:entered');
        assert.strictEqual(parsed.relativePath, 'a/b.c');
        assert.strictEqual(parsed.sizeBytes, 1024);
        assert.strictEqual(typeof parsed.t, 'number');
        assert.strictEqual(typeof parsed.pid, 'number');
    });

    test('appendDiag writes line to log file and creates parent dir', () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sisearch-diag-'));
        const logPath = path.join(tmp, 'nested/dir/worker-crash.log');
        appendDiag(logPath, 'worker:start', { extensionPath: '/ext' });
        appendDiag(logPath, 'file:entered', { relativePath: 'x.c' });
        const content = fs.readFileSync(logPath, 'utf-8');
        const lines = content.trim().split('\n');
        assert.strictEqual(lines.length, 2);
        assert.strictEqual(JSON.parse(lines[0]).event, 'worker:start');
        assert.strictEqual(JSON.parse(lines[1]).event, 'file:entered');
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    test('appendDiag swallows errors silently (ENOENT on un-writable path)', () => {
        // 故意传一个不可写的路径 —— 若内部没吞异常,这个调用会抛出并让测试失败。
        assert.doesNotThrow(() => {
            appendDiag('/dev/null/impossible/path.log', 'file:error', { err: 'test' });
        });
    });

    test('resolveDiagLogPath returns tmpdir path with current pid', () => {
        const p = resolveDiagLogPath();
        assert.ok(p.startsWith(os.tmpdir()), `must live under tmpdir, got ${p}`);
        assert.ok(p.includes(String(process.pid)), `must include pid ${process.pid}, got ${p}`);
        assert.ok(p.endsWith('.log'), 'must end with .log');
    });
});
