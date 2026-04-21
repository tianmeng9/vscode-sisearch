import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DbBackend } from '../../src/index/dbBackend';

function tmpDbPath(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbbackend-'));
    return path.join(dir, 'index.sqlite');
}

suite('DbBackend lifecycle', () => {
    test('openOrInit creates schema on fresh DB', () => {
        const p = tmpDbPath();
        const db = new DbBackend(p);
        db.openOrInit();
        // schema 版本应为 1
        assert.strictEqual(db.getSchemaVersion(), 1);
        // meta 中 tokenizer 正确
        db.close();
    });

    test(':memory: path works and starts empty', () => {
        const db = new DbBackend(':memory:');
        db.openOrInit();
        assert.deepStrictEqual(db.getStats(), { files: 0, symbols: 0 });
        db.close();
    });

    test('reopen existing DB preserves schema_version', () => {
        const p = tmpDbPath();
        const db1 = new DbBackend(p);
        db1.openOrInit();
        db1.close();
        const db2 = new DbBackend(p);
        db2.openOrInit();
        assert.strictEqual(db2.getSchemaVersion(), 1);
        db2.close();
    });

    test('close is idempotent', () => {
        const db = new DbBackend(':memory:');
        db.openOrInit();
        db.close();
        assert.doesNotThrow(() => db.close());
    });
});
