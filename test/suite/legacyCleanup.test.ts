// test/suite/legacyCleanup.test.ts
// 契约:cleanupLegacyShards(workspaceRoot) 静默删除遗留的 msgpack 分片目录
//   - 删除 <workspaceRoot>/.sisearch/shards/
//   - 保留 <workspaceRoot>/.sisearch/ 本身(SQLite db 可能位于此)
//   - 目录不存在时不抛
//   - .sisearch 目录不存在时不抛
//   - 任何底层错误应被吞掉(best-effort,绝不抛出)

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { cleanupLegacyShards } from '../../src/legacyCleanup';

function makeTmpWorkspace(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'm6-legacy-'));
}

function rmRoot(root: string): void {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
}

suite('cleanupLegacyShards', () => {
    test('deletes .sisearch/shards/ when present', () => {
        const root = makeTmpWorkspace();
        try {
            const shardsDir = path.join(root, '.sisearch', 'shards');
            fs.mkdirSync(shardsDir, { recursive: true });
            fs.writeFileSync(path.join(shardsDir, '00.msgpack'), Buffer.from([0x00]));
            fs.writeFileSync(path.join(shardsDir, '01.msgpack'), Buffer.from([0x01]));

            cleanupLegacyShards(root);

            assert.strictEqual(fs.existsSync(shardsDir), false, 'shards dir should be removed');
        } finally {
            rmRoot(root);
        }
    });

    test('keeps .sisearch/ directory itself (only shards/ subtree is removed)', () => {
        const root = makeTmpWorkspace();
        try {
            const sisearchDir = path.join(root, '.sisearch');
            const shardsDir = path.join(sisearchDir, 'shards');
            fs.mkdirSync(shardsDir, { recursive: true });
            fs.writeFileSync(path.join(shardsDir, '00.msgpack'), Buffer.from([0x00]));
            // simulate sqlite db sibling
            fs.writeFileSync(path.join(sisearchDir, 'index.db'), Buffer.from([0x00]));

            cleanupLegacyShards(root);

            assert.strictEqual(fs.existsSync(sisearchDir), true, '.sisearch/ should be kept');
            assert.strictEqual(
                fs.existsSync(path.join(sisearchDir, 'index.db')),
                true,
                'sibling index.db should not be touched',
            );
            assert.strictEqual(fs.existsSync(shardsDir), false, 'shards/ should be gone');
        } finally {
            rmRoot(root);
        }
    });

    test('no-op when .sisearch/shards/ does not exist', () => {
        const root = makeTmpWorkspace();
        try {
            // only create .sisearch/ without shards/
            fs.mkdirSync(path.join(root, '.sisearch'), { recursive: true });
            assert.doesNotThrow(() => cleanupLegacyShards(root));
            assert.strictEqual(fs.existsSync(path.join(root, '.sisearch')), true);
        } finally {
            rmRoot(root);
        }
    });

    test('no-op when .sisearch/ itself does not exist', () => {
        const root = makeTmpWorkspace();
        try {
            assert.doesNotThrow(() => cleanupLegacyShards(root));
            assert.strictEqual(fs.existsSync(path.join(root, '.sisearch')), false);
        } finally {
            rmRoot(root);
        }
    });

    test('never throws even when workspaceRoot does not exist', () => {
        const bogus = path.join(os.tmpdir(), 'm6-nonexistent-' + Date.now());
        assert.doesNotThrow(() => cleanupLegacyShards(bogus));
    });
});
