import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DbBackend } from '../../src/index/dbBackend';

function tmpDir(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'dbi-')); }

suite('DbBackend integrity', () => {
    test('integrityCheck returns "ok" on fresh DB', () => {
        const d = tmpDir(); const p = path.join(d, 'i.sqlite');
        const db = new DbBackend(p); db.openOrInit();
        assert.strictEqual(db.integrityCheck(), 'ok');
        db.close();
    });

    test('openOrInit on corrupt file quarantines and reinitializes', () => {
        const d = tmpDir(); const p = path.join(d, 'i.sqlite');
        // 写几个垃圾字节
        fs.writeFileSync(p, Buffer.from('DEFINITELY NOT SQLITE'));
        const db = new DbBackend(p);
        db.openOrInit();
        // 应该能打开(被重建过)
        assert.strictEqual(db.getSchemaVersion(), 1);
        // quarantine 文件应存在
        const dirs = fs.readdirSync(d);
        assert.ok(dirs.some(f => f.startsWith('i.sqlite.corrupt-')), `expected corrupt file in ${dirs}`);
        db.close();
    });

    test('schema_version higher than current throws descriptive error', () => {
        const d = tmpDir(); const p = path.join(d, 'i.sqlite');
        // 准备一个合法 DB 但 schema_version = 999
        {
            const db = new DbBackend(p); db.openOrInit();
            // @ts-ignore private
            (db as any).db.prepare("UPDATE meta SET value='999' WHERE key='schema_version'").run();
            db.close();
        }
        const db2 = new DbBackend(p);
        assert.throws(() => db2.openOrInit(), /schema version/i);
    });

    test('clearAll resets counts without affecting schema', () => {
        const db = new DbBackend(':memory:'); db.openOrInit();
        db.writeBatch({
            metadata: [{ relativePath: 'a.c', mtime: 1, size: 1, symbolCount: 1 }],
            symbols: [{ name: 'x', kind: 'function', filePath: '/a', relativePath: 'a.c',
                        lineNumber: 1, endLineNumber: 1, column: 0, lineContent: '' }],
            deletedRelativePaths: [],
        });
        db.clearAll();
        assert.deepStrictEqual(db.getStats(), { files: 0, symbols: 0 });
        assert.strictEqual(db.getSchemaVersion(), 1);
        db.close();
    });
});
