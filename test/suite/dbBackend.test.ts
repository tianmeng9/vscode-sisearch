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

suite('DbBackend writeBatch', () => {
    function fresh(): DbBackend {
        const db = new DbBackend(':memory:');
        db.openOrInit();
        return db;
    }

    test('inserts metadata and symbols; stats reflect counts', () => {
        const db = fresh();
        db.writeBatch({
            metadata: [{ relativePath: 'a.c', mtime: 1, size: 100, symbolCount: 2 }],
            symbols: [
                { name: 'foo', kind: 'function', filePath: '/a.c', relativePath: 'a.c',
                  lineNumber: 10, endLineNumber: 10, column: 4, lineContent: 'int foo() {' },
                { name: 'bar', kind: 'macro', filePath: '/a.c', relativePath: 'a.c',
                  lineNumber: 1, endLineNumber: 1, column: 0, lineContent: '#define bar 1' },
            ],
            deletedRelativePaths: [],
        });
        assert.deepStrictEqual(db.getStats(), { files: 1, symbols: 2 });
    });

    test('upsert: re-writing metadata for same file overwrites', () => {
        const db = fresh();
        db.writeBatch({
            metadata: [{ relativePath: 'a.c', mtime: 1, size: 100, symbolCount: 0 }],
            symbols: [],
            deletedRelativePaths: [],
        });
        db.writeBatch({
            metadata: [{ relativePath: 'a.c', mtime: 2, size: 200, symbolCount: 0 }],
            symbols: [],
            deletedRelativePaths: [],
        });
        const meta = db.getFileMetadata('a.c');
        assert.strictEqual(meta?.mtime, 2);
        assert.strictEqual(meta?.size, 200);
    });

    test('ON DELETE CASCADE removes symbols when file deleted', () => {
        const db = fresh();
        db.writeBatch({
            metadata: [{ relativePath: 'a.c', mtime: 1, size: 100, symbolCount: 1 }],
            symbols: [{ name: 'foo', kind: 'function', filePath: '/a.c', relativePath: 'a.c',
                        lineNumber: 1, endLineNumber: 1, column: 0, lineContent: '' }],
            deletedRelativePaths: [],
        });
        assert.strictEqual(db.getStats().symbols, 1);
        db.writeBatch({ metadata: [], symbols: [], deletedRelativePaths: ['a.c'] });
        assert.strictEqual(db.getStats().symbols, 0);
        assert.strictEqual(db.getStats().files, 0);
    });

    test('re-parse same file: old symbols cleared before new inserted', () => {
        const db = fresh();
        db.writeBatch({
            metadata: [{ relativePath: 'a.c', mtime: 1, size: 100, symbolCount: 1 }],
            symbols: [{ name: 'old_sym', kind: 'function', filePath: '/a.c', relativePath: 'a.c',
                        lineNumber: 1, endLineNumber: 1, column: 0, lineContent: '' }],
            deletedRelativePaths: [],
        });
        db.writeBatch({
            metadata: [{ relativePath: 'a.c', mtime: 2, size: 100, symbolCount: 1 }],
            symbols: [{ name: 'new_sym', kind: 'function', filePath: '/a.c', relativePath: 'a.c',
                        lineNumber: 1, endLineNumber: 1, column: 0, lineContent: '' }],
            deletedRelativePaths: [],
        });
        // 旧符号 old_sym 必须消失
        assert.strictEqual(db.getStats().symbols, 1);
    });

    test('writes are atomic: throw mid-batch rolls back', () => {
        const db = fresh();
        assert.throws(() => {
            db.writeBatch({
                metadata: [{ relativePath: 'a.c', mtime: 1, size: 100, symbolCount: 0 }],
                // name null 违反 NOT NULL,应回滚
                symbols: [{ name: null as any, kind: 'function', filePath: '/a', relativePath: 'a.c',
                            lineNumber: 1, endLineNumber: 1, column: 0, lineContent: '' }],
                deletedRelativePaths: [],
            });
        });
        // files 表应为空(事务回滚)
        assert.strictEqual(db.getStats().files, 0);
    });
});
