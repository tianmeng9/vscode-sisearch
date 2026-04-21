// scripts/verify-sqlite.js
// 本地快速验证 better-sqlite3 + FTS5 能跑起来。
// 在 npm install 之后手动或通过 npm run verify-sqlite 执行。
//
// 也作为 Level 3 迁移(docs/superpowers/plans/2026-04-21-sqlite-fts5-migration-plan.md M1.1)
// 的冒烟测试,确保在切换 DbBackend 之前 native binding 已经可用。

const Database = require('better-sqlite3');

const db = new Database(':memory:');
db.exec("CREATE VIRTUAL TABLE t USING fts5(name);");
db.prepare("INSERT INTO t(name) VALUES (?)").run('hello');
const row = db.prepare("SELECT name FROM t WHERE t MATCH ?").get('hello');

if (!row || row.name !== 'hello') {
    console.error('FTS5 smoke test failed:', row);
    process.exit(1);
}

console.log('better-sqlite3 + FTS5 OK:', process.versions.node, process.arch);
db.close();
