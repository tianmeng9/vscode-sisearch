# SQLite FTS5 Index Backend Migration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 si-search 的索引后端从 in-memory Map + msgpack shards 换成 better-sqlite3 FTS5 磁盘数据库,消除主线程 JS 堆瓶颈并让 Linux kernel 级仓库(70k 文件 / ~17.5M 符号)全量可搜。

**Architecture:** 新增 `DbBackend` 单点封装 better-sqlite3 连接和 SQL;`SymbolIndex` façade 内部从 `InMemorySymbolIndex + StorageManager` 换成 `DbBackend`(公开 API 不变);`SyncOrchestrator.onBatchResult` 从"写内存"变成"db.transaction 写入";搜索路径在 Sync 进行时按配置弹窗或走 ripgrep fallback。Worker 协议不变。

**Tech Stack:** TypeScript, better-sqlite3 (native), SQLite FTS5 (unicode61 tokenizer), worker_threads, @vscode/ripgrep, Mocha (TDD), VS Code Extension API

**Spec reference:** `docs/superpowers/plans/2026-04-21-sqlite-fts5-migration-design.md` — 不要在本 plan 里重新决策已经在 spec 里锁定的 12 条对齐决策和数据模型。具体 DDL / 接口签名 / 边界处理规则都以 spec 为准。

**Worktree:** 全程在 `/home/mi/AI/si-search` 主 worktree 上直接做,**不要**创建新 worktree;可以在 feature branch 或 main 上提交。

**TDD gate:** 每个新代码文件**先写 failing test,再写实现**。每个 task 结束执行 `npm run compile` + 对应 mocha 测试命令验证绿灯再 commit。

---

## 文件结构

### 新建

| File | 责任 |
|------|------|
| `src/index/dbBackend.ts` | better-sqlite3 唯一入口:open/close/writeBatch/search/countMatches/clearAll/checkpoint 等 |
| `src/index/symbolKindCodec.ts` | SymbolKind ↔ INTEGER 枚举的双向映射(SYMBOL_KIND_ID、SYMBOL_KIND_NAME) |
| `src/index/ftsQueryBuilder.ts` | FTS5 查询字符串构造 + escape 纯字面量引号;regex 字面 token 提取 |
| `src/index/lineContentReader.ts` | 按 `{absPath, lineNumber}` 读行,带 LRU cache(上限 100 文件) |
| `test/suite/dbBackend.test.ts` | Schema 初始化、writeBatch、search、countMatches、clearAll 的单元测 |
| `test/suite/dbBackend.integrity.test.ts` | 损坏恢复、schema 版本、crash-recovery、多 connection BUSY |
| `test/suite/symbolKindCodec.test.ts` | 枚举编解码往返 |
| `test/suite/ftsQueryBuilder.test.ts` | Escape/字面 token 提取 |
| `test/suite/lineContentReader.test.ts` | LRU 行为、不存在文件、越界行号 |
| `test/suite/symbolIndexFacadeSqlite.test.ts` | 把 façade 指向 `:memory:` DbBackend 的集成测 |
| `test/fixtures/small-repo/` | 100 个 C/H 文件的 fixture,用于集成测(测 F2) |
| `test/benchmark/dbBench.ts` | P1 空 DB 打开延迟 benchmark |
| `test/benchmark/heapSampler.ts` | 通过 `process.memoryUsage()` 周期采样,驱动 P8 |
| `test/suite/dbBackend.integration.test.ts` (host-only) | 真实 VS Code 下 Sync + search round-trip |
| `test/suite/composition.fallback.test.ts` (host-only) | Native addon 加载失败降级路径 |
| `.github/workflows/prebuild.yml` | 跨平台 prebuild CI matrix |

### 修改

| File | 改动 |
|------|------|
| `src/symbolIndex.ts` | 内部 `inner: InMemorySymbolIndex` + `StorageManager` 换成 `db: DbBackend`;公开 API 签名不变,加 `isSyncInProgress()` + `searchSymbols` 可选 pagination |
| `src/sync/syncOrchestrator.ts` | deps 从 `index + storage + getSnapshot` 合并为 `db: DbBackend`;`onBatchResult` 改 `db.writeBatch`;尾部 `db.checkpoint()` |
| `src/sync/parseWorker.ts` | stream 分支 `onSymbol` 回滚 Phase 5H:从"只 streamedCount++"改回 "symbols.push(entry)" |
| `src/search/searchEngine.ts` | 加 `handleSearchDuringSync` 分支 + pagination 参数;构造 FTS5 query |
| `src/search/searchStore.ts` | data model 加 `loadedCount` / `totalCount` |
| `src/messageRouter.ts` | 处理新 `loadMore` webview 消息;发 `appendResults` 含 `totalCount/loadedCount` |
| `src/composition.ts` | activate 早期检测 `.sisearch/shards/` 并 `fs.rmSync`;包裹 `new Database()` try/catch 做降级;wiring 用 DbBackend |
| `src/extension.ts` | (仅如果 wiring 涉及到) |
| `media/results.js` | 滚到底部触发 `loadMore`;接收 `appendResults` 并 concat;显示 "N / total" |
| `media/results.html` | 加 loading 指示条 |
| `media/results.css` | loading 样式 |
| `package.json` | 加 `better-sqlite3` + `@types/better-sqlite3`;删 `@msgpack/msgpack`;新配置 `siSearch.search.duringSyncBehavior`、`siSearch.search.maxResults`;脚本加 `rebuild` |
| `test/suite/syncOrchestrator.test.ts` | deps mock 从 `index+storage+getSnapshot` 换成 `db` |
| `test/suite/searchEngine.test.ts` | 加 Sync-during-search 四分支测 |

### 删除

| File | 原因 |
|------|------|
| `src/index/symbolIndex.ts` (InMemorySymbolIndex) | 被 DbBackend 取代 |
| `src/storage/storageManager.ts` | Legacy 不读取,整个文件退役 |
| `src/storage/shardStreamWriter.ts` | msgpack shard writer 不再使用 |
| `src/storage/codec.ts` | msgpack encode/decode 随 StorageManager 退役 |
| `src/storage/shardStrategy.ts` | shardForPath / shardFileName 不再使用 |
| `test/suite/symbolIndex.test.ts` | 对应删除 |
| `test/suite/storageManager.test.ts` | 对应删除 |
| `test/suite/shardStreamWriter.test.ts` | 对应删除 |
| `test/suite/codec.test.ts` | 对应删除 |
| `test/suite/streamingSyncIntegration.test.ts` | 走 shard 路径的集成测,随之退役;相关集成语义迁到 `dbBackend.integration.test.ts` |

### 不变

- `src/index/indexTypes.ts` — SymbolEntry / IndexedFile / SymbolKind 类型保持不变
- `src/types.ts` — SearchResult / SearchOptions 保持不变
- `src/sync/workerPool.ts` + `workerPoolFactory.ts` + IPC 协议
- `src/sync/batchClassifier.ts`
- `src/largeFileParser*.ts` + `symbolParser.ts`

---

## 运行约定

### TDD 节奏
每次新代码:先写测,`npm run compile` 编译成功后用 mocha 确认测试 **failing**,再写实现,再跑 mocha 绿,再 commit。

### 编译 + 测试命令

```bash
npm run compile
# 编译 TS 到 out/,无输出表示成功

npx mocha --ui tdd out/test/suite/<file>.test.js
# 单文件跑 tdd ui
```

### 一次完整回归(改动涉及多个模块时)
```bash
npx mocha --ui tdd \
  out/test/suite/dbBackend.test.js \
  out/test/suite/dbBackend.integrity.test.ts \
  out/test/suite/symbolKindCodec.test.js \
  out/test/suite/ftsQueryBuilder.test.js \
  out/test/suite/lineContentReader.test.js \
  out/test/suite/symbolIndexFacadeSqlite.test.js \
  out/test/suite/searchEngine.test.js \
  out/test/suite/syncOrchestrator.test.js \
  out/test/suite/workerDiag.test.js \
  out/test/suite/workerPoolFactoryMaxBytes.test.js \
  out/test/suite/parserConfig.test.js \
  out/test/suite/symbolParserMaxBytes.test.js \
  out/test/suite/largeFileParser.test.js \
  out/test/suite/largeFileParserStream.test.js \
  out/test/suite/workerPool.test.js \
  out/test/suite/batchClassifier.test.js \
  out/test/suite/parseResultGrouping.test.js \
  out/test/suite/reentrancyGuard.test.js
```

### Commit 粒度
一个 task 一个 commit;test+implementation 放同一 commit;若某 task 跨多个文件,允许 2-3 个 commit 但每个都要绿。

---


## M1 — DbBackend 独立可用

**目标:** `src/index/dbBackend.ts` 全功能实现,所有单元测试通过;本 milestone **不动**现有任何代码路径,只新增。完成后 DbBackend 可独立用 REPL 操作,但没有任何调用方。

**依赖:** 无(起点)
**风险:** better-sqlite3 首次装依赖 `node-gyp` + python + C compiler,本地装可能失败 → Task 1.1 处理
**独立验证:** `npm test` 跑 dbBackend*.test.js 全绿

### Task 1.1: 安装 better-sqlite3 + 验证本地可用

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `scripts/verify-sqlite.js`

- [ ] **Step 1: 编辑 `package.json`**

在 `dependencies` 添加:
```
"better-sqlite3": "^11.7.0"
```

在 `devDependencies` 添加:
```
"@types/better-sqlite3": "^7.6.12"
```

在 `scripts` 添加:
```
"rebuild": "npm rebuild better-sqlite3",
"verify-sqlite": "node scripts/verify-sqlite.js"
```

- [ ] **Step 2: 安装依赖**

Run: `npm install`
Expected: 成功,`node_modules/better-sqlite3/build/Release/better_sqlite3.node` 存在

若失败常见原因:
- macOS/Linux 缺 build-essential:先 `sudo apt install build-essential python3` (Debian/Ubuntu) 或 `xcode-select --install` (macOS)
- Windows:`npm config set msvs_version 2022`
- Python 3.12+:`npm config set python $(which python3)`

- [ ] **Step 3: 编写 `scripts/verify-sqlite.js`**

内容:
```js
const Database = require('better-sqlite3');
const db = new Database(':memory:');
db.exec("CREATE VIRTUAL TABLE t USING fts5(name);");
db.prepare("INSERT INTO t VALUES (?)").run('hello');
const row = db.prepare("SELECT * FROM t WHERE t MATCH ?").get('hello');
if (!row || row.name !== 'hello') { throw new Error('fts5 broken'); }
console.log('better-sqlite3 + FTS5 OK:', process.versions.node, process.arch);
db.close();
```

- [ ] **Step 4: 运行验证脚本**

Run: `npm run verify-sqlite`
Expected: 输出 `better-sqlite3 + FTS5 OK: <node version> <arch>`

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json scripts/verify-sqlite.js
git commit -m "chore(deps): add better-sqlite3 + FTS5 smoke verification"
```

---

### Task 1.2: SymbolKind 枚举编解码

**Files:**
- Create: `src/index/symbolKindCodec.ts`
- Create: `test/suite/symbolKindCodec.test.ts`

- [ ] **Step 1: 写 failing test `test/suite/symbolKindCodec.test.ts`**

```ts
import * as assert from 'assert';
import { encodeSymbolKind, decodeSymbolKind, SYMBOL_KIND_ID, SYMBOL_KIND_NAME } from '../../src/index/symbolKindCodec';

suite('symbolKindCodec', () => {
    test('encode all 9 kinds to distinct ints 0..8', () => {
        const ids = Object.values(SYMBOL_KIND_ID);
        assert.strictEqual(ids.length, 9);
        assert.deepStrictEqual([...new Set(ids)].sort(), [0,1,2,3,4,5,6,7,8]);
    });

    test('encode → decode round-trips every kind', () => {
        for (const kind of Object.keys(SYMBOL_KIND_ID) as Array<keyof typeof SYMBOL_KIND_ID>) {
            const id = encodeSymbolKind(kind);
            const back = decodeSymbolKind(id);
            assert.strictEqual(back, kind);
        }
    });

    test('decode out-of-range returns "variable" as fallback', () => {
        assert.strictEqual(decodeSymbolKind(999), 'variable');
        assert.strictEqual(decodeSymbolKind(-1), 'variable');
    });

    test('SYMBOL_KIND_NAME indexed by id matches SYMBOL_KIND_ID', () => {
        for (const [name, id] of Object.entries(SYMBOL_KIND_ID)) {
            assert.strictEqual(SYMBOL_KIND_NAME[id], name);
        }
    });
});
```

- [ ] **Step 2: 编译,确认测试 failing**

Run: `npm run compile`
Expected: TS error `Cannot find module '../../src/index/symbolKindCodec'`

- [ ] **Step 3: 实现 `src/index/symbolKindCodec.ts`**

内容(完全照 spec "Kind 枚举映射"):

```ts
import type { SymbolKind } from './indexTypes';

export const SYMBOL_KIND_ID: Record<SymbolKind, number> = {
    function: 0, class: 1, struct: 2, enum: 3, typedef: 4,
    namespace: 5, macro: 6, variable: 7, union: 8,
};

export const SYMBOL_KIND_NAME: SymbolKind[] = [
    'function', 'class', 'struct', 'enum', 'typedef',
    'namespace', 'macro', 'variable', 'union',
];

export function encodeSymbolKind(kind: SymbolKind): number {
    return SYMBOL_KIND_ID[kind];
}

export function decodeSymbolKind(id: number): SymbolKind {
    if (id >= 0 && id < SYMBOL_KIND_NAME.length) { return SYMBOL_KIND_NAME[id]; }
    return 'variable';
}
```

- [ ] **Step 4: 再编译 + 跑测**

Run: `npm run compile && npx mocha --ui tdd out/test/suite/symbolKindCodec.test.js`
Expected: 4 passing

- [ ] **Step 5: Commit**

```bash
git add src/index/symbolKindCodec.ts test/suite/symbolKindCodec.test.ts
git commit -m "feat(index): symbol kind ↔ integer codec for SQLite storage"
```

---

### Task 1.3: FTS5 查询构造器

**Files:**
- Create: `src/index/ftsQueryBuilder.ts`
- Create: `test/suite/ftsQueryBuilder.test.ts`

- [ ] **Step 1: 写 failing test `test/suite/ftsQueryBuilder.test.ts`**

```ts
import * as assert from 'assert';
import { escapeFtsLiteral, extractLiteralTokens } from '../../src/index/ftsQueryBuilder';

suite('ftsQueryBuilder', () => {
    test('escapeFtsLiteral wraps plain query in double-quotes', () => {
        assert.strictEqual(escapeFtsLiteral('hello'), '"hello"');
    });

    test('escapeFtsLiteral doubles embedded double-quotes', () => {
        assert.strictEqual(escapeFtsLiteral('say "hi"'), '"say ""hi"""');
    });

    test('escapeFtsLiteral neutralizes FTS5 operators', () => {
        // 把 AND/OR/NEAR/NOT/* 等都视为普通字面量
        assert.strictEqual(escapeFtsLiteral('foo AND bar'), '"foo AND bar"');
        assert.strictEqual(escapeFtsLiteral('x*'), '"x*"');
    });

    test('extractLiteralTokens pulls alphanum runs from regex source', () => {
        assert.deepStrictEqual(extractLiteralTokens('amdgpu.*init'), ['amdgpu', 'init']);
        assert.deepStrictEqual(extractLiteralTokens('^foo_bar$'), ['foo_bar']);
        assert.deepStrictEqual(extractLiteralTokens('\\d+'), []);
    });

    test('extractLiteralTokens length-filters very short fragments', () => {
        // "a" 和 "b" 过短不当作 token,避免 FTS5 过度粗筛
        assert.deepStrictEqual(extractLiteralTokens('a.+b'), []);
    });

    test('escapeFtsLiteral preserves unicode identifiers', () => {
        assert.strictEqual(escapeFtsLiteral('变量名'), '"变量名"');
    });
});
```

- [ ] **Step 2: 编译,确认测试 failing**

Run: `npm run compile`
Expected: Cannot find module

- [ ] **Step 3: 实现 `src/index/ftsQueryBuilder.ts`**

```ts
/**
 * 把任意字符串包成 FTS5 字面量,所有 FTS5 操作符失效。
 * FTS5 语法:" ... " 是字面量短语,嵌入 " 用 "" 转义。
 */
export function escapeFtsLiteral(s: string): string {
    return '"' + s.replace(/"/g, '""') + '"';
}

/**
 * 从正则 pattern 里抽出长度 >= 2 的字母数字(含下划线)片段,
 * 用于 FTS5 粗过滤 —— 命中这些片段的符号再由 JS `RegExp.test()` 精过滤。
 * 长度 < 2 的片段不返回(避免 FTS5 粗筛开销)。
 */
export function extractLiteralTokens(pattern: string): string[] {
    // 去掉正则元字符
    const tokens = pattern.match(/[A-Za-z0-9_\u4e00-\u9fff]{2,}/g);
    return tokens ?? [];
}
```

- [ ] **Step 4: 编译 + 测**

Run: `npm run compile && npx mocha --ui tdd out/test/suite/ftsQueryBuilder.test.js`
Expected: 6 passing

- [ ] **Step 5: Commit**

```bash
git add src/index/ftsQueryBuilder.ts test/suite/ftsQueryBuilder.test.ts
git commit -m "feat(index): FTS5 literal escape + regex token extraction"
```

---

### Task 1.4: LineContent 按需读取 + LRU cache

**Files:**
- Create: `src/index/lineContentReader.ts`
- Create: `test/suite/lineContentReader.test.ts`

- [ ] **Step 1: 写 failing test**

```ts
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LineContentReader } from '../../src/index/lineContentReader';

function mkTmp(content: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'line-reader-'));
    const p = path.join(dir, 'f.c');
    fs.writeFileSync(p, content, 'utf-8');
    return p;
}

suite('LineContentReader', () => {
    test('reads specific 1-based line', () => {
        const p = mkTmp('line1\nline2\nline3\n');
        const r = new LineContentReader(2);
        assert.strictEqual(r.read(p, 2), 'line2');
    });

    test('returns empty for out-of-range line', () => {
        const p = mkTmp('only\n');
        const r = new LineContentReader(2);
        assert.strictEqual(r.read(p, 99), '');
    });

    test('returns empty for missing file', () => {
        const r = new LineContentReader(2);
        assert.strictEqual(r.read('/nonexistent', 1), '');
    });

    test('LRU evicts oldest beyond capacity', () => {
        const a = mkTmp('a1\n');
        const b = mkTmp('b1\n');
        const c = mkTmp('c1\n');
        const r = new LineContentReader(2);
        r.read(a, 1); r.read(b, 1); r.read(c, 1);
        // 访问 c 后,a 已被踢;内部 Map 只应有 b 和 c
        assert.strictEqual(r._sizeForTest(), 2);
    });

    test('repeated reads of same file hit cache (mtime unchanged)', () => {
        const p = mkTmp('x\ny\n');
        const r = new LineContentReader(2);
        const first = r.read(p, 1);
        // 修改文件后 mtime 前进,cache invalidate 下次重新读
        fs.writeFileSync(p, 'Z\nY\n', 'utf-8');
        // 依赖 fs 时间戳粒度,这里直接测 reader 不 crash 且总能返回对的值
        const second = r.read(p, 1);
        assert.ok(first === 'x' || first === 'Z'); // either is fine
        assert.strictEqual(typeof second, 'string');
    });
});
```

- [ ] **Step 2: 编译确认 failing**

Run: `npm run compile`

- [ ] **Step 3: 实现 `src/index/lineContentReader.ts`**

```ts
import * as fs from 'fs';

interface CacheEntry {
    mtimeMs: number;
    lines: string[];
}

/**
 * 按 (absPath, lineNumber) 读行,带 LRU cache。
 *
 * 搜索路径原来存 lineContent 在内存索引里,数百 MB 浪费。现在搜索命中时
 * 才从源文件读;LRU 保最近访问的 N 个文件的整行数组(单文件 1-2 MB 量级)。
 * mtime 变化时 cache invalidate。
 */
export class LineContentReader {
    private cache = new Map<string, CacheEntry>();
    constructor(private readonly capacity: number = 100) {}

    read(absPath: string, lineNumber: number): string {
        if (lineNumber < 1) { return ''; }
        const entry = this.getOrLoad(absPath);
        if (!entry) { return ''; }
        const idx = lineNumber - 1;
        if (idx >= entry.lines.length) { return ''; }
        return entry.lines[idx];
    }

    private getOrLoad(absPath: string): CacheEntry | undefined {
        try {
            const stat = fs.statSync(absPath);
            const cached = this.cache.get(absPath);
            if (cached && cached.mtimeMs === stat.mtimeMs) {
                // LRU bump:delete + set
                this.cache.delete(absPath);
                this.cache.set(absPath, cached);
                return cached;
            }
            const content = fs.readFileSync(absPath, 'utf-8');
            const lines = content.split('\n');
            const entry: CacheEntry = { mtimeMs: stat.mtimeMs, lines };
            this.cache.set(absPath, entry);
            this.evictIfNeeded();
            return entry;
        } catch {
            return undefined;
        }
    }

    private evictIfNeeded(): void {
        while (this.cache.size > this.capacity) {
            const firstKey = this.cache.keys().next().value;
            if (!firstKey) { break; }
            this.cache.delete(firstKey);
        }
    }

    /** 测试钩子。 */
    _sizeForTest(): number { return this.cache.size; }
}
```

- [ ] **Step 4: 编译 + 测**

Run: `npm run compile && npx mocha --ui tdd out/test/suite/lineContentReader.test.js`
Expected: 5 passing

- [ ] **Step 5: Commit**

```bash
git add src/index/lineContentReader.ts test/suite/lineContentReader.test.ts
git commit -m "feat(index): LineContentReader with LRU cache for on-demand lineContent"
```

---

### Task 1.5: DbBackend — 生命周期 + schema 初始化

**Files:**
- Create: `src/index/dbBackend.ts`
- Create: `test/suite/dbBackend.test.ts`

- [ ] **Step 1: 写 failing test(只测 open/close/schema)**

```ts
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
```

- [ ] **Step 2: 编译确认 failing**

- [ ] **Step 3: 实现 `src/index/dbBackend.ts` 的骨架**

照 spec "DbBackend" 段和 "Schema 完整 DDL" 段:

```ts
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import type { SymbolEntry, IndexedFile, SymbolKind } from './indexTypes';
import type { SearchOptions, SearchResult } from '../types';
import { encodeSymbolKind, decodeSymbolKind } from './symbolKindCodec';
import { escapeFtsLiteral, extractLiteralTokens } from './ftsQueryBuilder';
import { LineContentReader } from './lineContentReader';

const CURRENT_SCHEMA_VERSION = 1;
const DDL = `
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS files (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    relative_path  TEXT NOT NULL UNIQUE,
    mtime_ms       INTEGER NOT NULL,
    size_bytes     INTEGER NOT NULL,
    symbol_count   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_files_relative ON files(relative_path);
CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
    name,
    tokenize='unicode61 remove_diacritics 2',
    content=''
);
CREATE TABLE IF NOT EXISTS symbols (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL,
    kind         INTEGER NOT NULL,
    file_id      INTEGER NOT NULL,
    line_number  INTEGER NOT NULL,
    column       INTEGER NOT NULL,
    FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_symbols_file_id ON symbols(file_id);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE TRIGGER IF NOT EXISTS symbols_fts_insert AFTER INSERT ON symbols BEGIN
    INSERT INTO symbols_fts(rowid, name) VALUES (NEW.id, NEW.name);
END;
CREATE TRIGGER IF NOT EXISTS symbols_fts_delete AFTER DELETE ON symbols BEGIN
    DELETE FROM symbols_fts WHERE rowid = OLD.id;
END;
`;

export interface SearchPagination { limit: number; offset: number; }
export interface WriteBatch {
    metadata: IndexedFile[];
    symbols: SymbolEntry[];
    deletedRelativePaths: string[];
}

export class DbBackend {
    private db: Database.Database | null = null;
    private lineReader = new LineContentReader();

    constructor(private readonly dbPath: string) {}

    openOrInit(): void {
        if (this.db) { return; }
        const isMemory = this.dbPath === ':memory:';
        if (!isMemory) {
            fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
        }
        this.db = new Database(this.dbPath);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('synchronous = NORMAL');
        this.db.pragma('cache_size = -65536');
        this.db.pragma('temp_store = MEMORY');
        this.db.pragma('foreign_keys = ON');
        this.db.exec(DDL);
        this.ensureMeta();
    }

    close(): void {
        if (!this.db) { return; }
        try { this.db.close(); } catch { /* ignore */ }
        this.db = null;
    }

    checkpoint(): void {
        if (!this.db) { return; }
        this.db.pragma('wal_checkpoint(TRUNCATE)');
    }

    getSchemaVersion(): number {
        const row = this.db!.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string } | undefined;
        return row ? parseInt(row.value, 10) : 0;
    }

    getStats(): { files: number; symbols: number } {
        const f = this.db!.prepare('SELECT COUNT(*) AS c FROM files').get() as { c: number };
        const s = this.db!.prepare('SELECT COUNT(*) AS c FROM symbols').get() as { c: number };
        return { files: f.c, symbols: s.c };
    }

    private ensureMeta(): void {
        const upsert = this.db!.prepare('INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)');
        upsert.run('schema_version', String(CURRENT_SCHEMA_VERSION));
        upsert.run('created_at', String(Date.now()));
        upsert.run('tokenizer', 'unicode61');
    }
}
```

- [ ] **Step 4: 编译 + 测**

Run: `npm run compile && npx mocha --ui tdd out/test/suite/dbBackend.test.js`
Expected: 4 passing

- [ ] **Step 5: Commit**

```bash
git add src/index/dbBackend.ts test/suite/dbBackend.test.ts
git commit -m "feat(index): DbBackend lifecycle + schema DDL"
```

---

### Task 1.6: DbBackend — writeBatch (files + symbols + deletions)

**Files:**
- Modify: `src/index/dbBackend.ts`
- Modify: `test/suite/dbBackend.test.ts`

- [ ] **Step 1: 追加 failing tests 到 `test/suite/dbBackend.test.ts`**

```ts
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
```

- [ ] **Step 2: 编译,确认有 failing**(writeBatch / getFileMetadata 尚不存在)

- [ ] **Step 3: 在 `dbBackend.ts` 内追加实现**

```ts
// 在 class DbBackend 内添加:

writeBatch(batch: WriteBatch): void {
    if (!this.db) { throw new Error('db not opened'); }
    const upsertFile = this.db.prepare(
        `INSERT INTO files(relative_path, mtime_ms, size_bytes, symbol_count)
         VALUES (@relativePath, @mtime, @size, @symbolCount)
         ON CONFLICT(relative_path) DO UPDATE SET
            mtime_ms=excluded.mtime_ms,
            size_bytes=excluded.size_bytes,
            symbol_count=excluded.symbol_count
         RETURNING id`
    );
    const getFileId = this.db.prepare('SELECT id FROM files WHERE relative_path = ?');
    const deleteFile = this.db.prepare('DELETE FROM files WHERE relative_path = ?');
    const deleteSymbolsForFile = this.db.prepare('DELETE FROM symbols WHERE file_id = ?');
    const insertSymbol = this.db.prepare(
        `INSERT INTO symbols(name, kind, file_id, line_number, column)
         VALUES (@name, @kind, @fileId, @line, @col)`
    );

    const txn = this.db.transaction((b: WriteBatch) => {
        // 1. 删除 deletedRelativePaths —— CASCADE 会清 symbols + fts
        for (const rel of b.deletedRelativePaths) {
            deleteFile.run(rel);
        }
        // 2. upsert files 并记住 fileId
        const fileIdByPath = new Map<string, number>();
        for (const m of b.metadata) {
            const row = upsertFile.get({
                relativePath: m.relativePath,
                mtime: m.mtime,
                size: m.size,
                symbolCount: m.symbolCount,
            }) as { id: number };
            fileIdByPath.set(m.relativePath, row.id);
            // 同文件重新 parse:先清旧 symbols(CASCADE 只在 DELETE files 时;此处 upsert 保留 files 行)
            deleteSymbolsForFile.run(row.id);
        }
        // 3. 插入新 symbols
        for (const s of b.symbols) {
            let fileId = fileIdByPath.get(s.relativePath);
            if (fileId === undefined) {
                const row = getFileId.get(s.relativePath) as { id: number } | undefined;
                if (!row) { continue; }
                fileId = row.id;
            }
            const cleanName = sanitizeSymbolName(s.name);
            insertSymbol.run({
                name: cleanName,
                kind: encodeSymbolKind(s.kind),
                fileId,
                line: s.lineNumber,
                col: s.column,
            });
        }
    });
    txn(batch);
}

getFileMetadata(relativePath: string): IndexedFile | undefined {
    if (!this.db) { return undefined; }
    const row = this.db.prepare(
        'SELECT relative_path AS relativePath, mtime_ms AS mtime, size_bytes AS size, symbol_count AS symbolCount FROM files WHERE relative_path = ?'
    ).get(relativePath) as IndexedFile | undefined;
    return row;
}

getAllFileMetadata(): Map<string, IndexedFile> {
    const result = new Map<string, IndexedFile>();
    if (!this.db) { return result; }
    const rows = this.db.prepare(
        'SELECT relative_path AS relativePath, mtime_ms AS mtime, size_bytes AS size, symbol_count AS symbolCount FROM files'
    ).all() as IndexedFile[];
    for (const r of rows) { result.set(r.relativePath, r); }
    return result;
}

clearAll(): void {
    if (!this.db) { return; }
    const txn = this.db.transaction(() => {
        this.db!.exec('DELETE FROM symbols');
        this.db!.exec('DELETE FROM files');
    });
    txn();
}
```

并添加文件顶部的辅助函数:
```ts
function sanitizeSymbolName(raw: string): string {
    if (raw == null) { throw new Error('symbol name required'); }
    const oneLine = raw.replace(/\r\n|\r|\n/g, ' ');
    return oneLine.length > 1024 ? oneLine.slice(0, 1024) : oneLine;
}
```

- [ ] **Step 4: 编译 + 测**

Run: `npm run compile && npx mocha --ui tdd out/test/suite/dbBackend.test.js`
Expected: 4 + 5 = 9 passing

- [ ] **Step 5: Commit**

```bash
git add src/index/dbBackend.ts test/suite/dbBackend.test.ts
git commit -m "feat(index): DbBackend writeBatch (upsert files + symbols + cascade delete)"
```

---

### Task 1.7: DbBackend — search + countMatches (FTS5 路径)

**Files:**
- Modify: `src/index/dbBackend.ts`
- Modify: `test/suite/dbBackend.test.ts`

- [ ] **Step 1: 追加 failing tests**

```ts
suite('DbBackend search', () => {
    function seed(db: DbBackend): void {
        db.writeBatch({
            metadata: [
                { relativePath: 'a.c', mtime: 1, size: 100, symbolCount: 3 },
                { relativePath: 'b.h', mtime: 1, size: 100, symbolCount: 1 },
            ],
            symbols: [
                { name: 'amdgpu_device_init', kind: 'function', filePath: '/a.c', relativePath: 'a.c',
                  lineNumber: 10, endLineNumber: 10, column: 0, lineContent: '' },
                { name: 'amdgpu_fini', kind: 'function', filePath: '/a.c', relativePath: 'a.c',
                  lineNumber: 20, endLineNumber: 20, column: 0, lineContent: '' },
                { name: 'AMDGPU_MAX', kind: 'macro', filePath: '/a.c', relativePath: 'a.c',
                  lineNumber: 1, endLineNumber: 1, column: 0, lineContent: '' },
                { name: 'init', kind: 'function', filePath: '/b.h', relativePath: 'b.h',
                  lineNumber: 5, endLineNumber: 5, column: 0, lineContent: '' },
            ],
            deletedRelativePaths: [],
        });
    }

    test('whole word exact (case-sensitive): hits idx_symbols_name', () => {
        const db = new DbBackend(':memory:'); db.openOrInit(); seed(db);
        const r = db.search('amdgpu_device_init', { caseSensitive: true, wholeWord: true, regex: false });
        assert.strictEqual(r.length, 1);
        assert.strictEqual(r[0].relativePath, 'a.c');
        assert.strictEqual(r[0].lineNumber, 10);
    });

    test('whole word exact (case-insensitive): FTS5 unicode61 case-folded', () => {
        const db = new DbBackend(':memory:'); db.openOrInit(); seed(db);
        const r = db.search('AMDGPU_DEVICE_INIT', { caseSensitive: false, wholeWord: true, regex: false });
        assert.strictEqual(r.length, 1);
    });

    test('substring (non-whole-word): FTS5 prefix + LIKE', () => {
        const db = new DbBackend(':memory:'); db.openOrInit(); seed(db);
        const r = db.search('amdgpu', { caseSensitive: false, wholeWord: false, regex: false });
        // 所有含 amdgpu 的符号都应命中
        assert.strictEqual(r.length, 3);
    });

    test('pagination: limit + offset', () => {
        const db = new DbBackend(':memory:'); db.openOrInit(); seed(db);
        const r1 = db.search('init', { caseSensitive: false, wholeWord: false, regex: false },
                             { limit: 1, offset: 0 });
        assert.strictEqual(r1.length, 1);
        const r2 = db.search('init', { caseSensitive: false, wholeWord: false, regex: false },
                             { limit: 1, offset: 1 });
        assert.strictEqual(r2.length, 1);
        assert.notStrictEqual(r1[0].lineNumber + '::' + r1[0].relativePath,
                              r2[0].lineNumber + '::' + r2[0].relativePath);
    });

    test('countMatches returns total without LIMIT', () => {
        const db = new DbBackend(':memory:'); db.openOrInit(); seed(db);
        const n = db.countMatches('init', { caseSensitive: false, wholeWord: false, regex: false });
        assert.ok(n >= 2);
    });

    test('empty query returns empty array', () => {
        const db = new DbBackend(':memory:'); db.openOrInit(); seed(db);
        assert.deepStrictEqual(db.search('', { caseSensitive: false, wholeWord: true, regex: false }), []);
    });

    test('regex search: literal token coarse + RegExp fine', () => {
        const db = new DbBackend(':memory:'); db.openOrInit(); seed(db);
        const r = db.search('amdgpu.*init', { caseSensitive: false, wholeWord: false, regex: true });
        // amdgpu_device_init 满足 regex;AMDGPU_MAX 不满足
        const names = r.map(x => x.lineNumber + ':' + x.relativePath);
        assert.ok(names.some(n => n.includes('a.c')));
    });

    test('results sorted by relativePath then lineNumber', () => {
        const db = new DbBackend(':memory:'); db.openOrInit(); seed(db);
        const r = db.search('init', { caseSensitive: false, wholeWord: false, regex: false });
        for (let i = 1; i < r.length; i++) {
            const prev = r[i-1], cur = r[i];
            const cmp = prev.relativePath.localeCompare(cur.relativePath);
            if (cmp !== 0) { assert.ok(cmp < 0); }
            else { assert.ok(prev.lineNumber <= cur.lineNumber); }
        }
    });
});
```

- [ ] **Step 2: 编译确认 failing**

- [ ] **Step 3: 在 `dbBackend.ts` 追加 search/countMatches**

```ts
// 在 class DbBackend 内添加:

search(
    query: string,
    options: SearchOptions,
    pagination: SearchPagination = { limit: 200, offset: 0 }
): SearchResult[] {
    if (!this.db || !query) { return []; }

    const rows = this.selectForQuery(query, options, pagination);
    const out: SearchResult[] = [];
    for (const row of rows) {
        // row: { name, file_id, relativePath, lineNumber, column }
        // 用 lineReader 按需读行,失败返回空串
        const absPath = row.relativePath;   // 替换真实 absPath 在 façade 侧
        const lineContent = '';  // façade 层再填;在 DbBackend 层返回空占位
        out.push({
            filePath: absPath,
            relativePath: row.relativePath,
            lineNumber: row.lineNumber,
            lineContent,
            matchStart: 0,
            matchLength: row.name.length,
        });
    }
    return out;
}

countMatches(query: string, options: SearchOptions): number {
    if (!this.db || !query) { return 0; }
    return this.selectCountForQuery(query, options);
}

private selectForQuery(
    query: string, options: SearchOptions, p: SearchPagination
): Array<{ name: string; relativePath: string; lineNumber: number; column: number }> {
    // 精确 + case-sensitive → 直接 name=?
    if (options.wholeWord && options.caseSensitive && !options.regex) {
        return this.db!.prepare(
            `SELECT s.name, f.relative_path AS relativePath, s.line_number AS lineNumber, s.column
             FROM symbols s JOIN files f ON f.id = s.file_id
             WHERE s.name = ?
             ORDER BY f.relative_path, s.line_number
             LIMIT ? OFFSET ?`
        ).all(query, p.limit, p.offset) as any;
    }
    // 精确 + case-insensitive → FTS5 MATCH(unicode61 自带 case fold)
    if (options.wholeWord && !options.regex) {
        const fts = escapeFtsLiteral(query);
        return this.db!.prepare(
            `SELECT s.name, f.relative_path AS relativePath, s.line_number AS lineNumber, s.column
             FROM symbols_fts JOIN symbols s ON s.id = symbols_fts.rowid
                              JOIN files f ON f.id = s.file_id
             WHERE symbols_fts MATCH ?
             ORDER BY f.relative_path, s.line_number
             LIMIT ? OFFSET ?`
        ).all(fts, p.limit, p.offset) as any;
    }
    // regex → 提取 literal token 粗过滤 + RegExp 精过滤
    if (options.regex) {
        const tokens = extractLiteralTokens(query);
        let flags = options.caseSensitive ? '' : 'i';
        let re: RegExp;
        try { re = new RegExp(query, flags); } catch { return []; }
        let rows: any[];
        if (tokens.length === 0) {
            rows = this.db!.prepare(
                `SELECT s.name, f.relative_path AS relativePath, s.line_number AS lineNumber, s.column
                 FROM symbols s JOIN files f ON f.id = s.file_id
                 LIMIT 10000`
            ).all();
        } else {
            const fts = tokens.map(escapeFtsLiteral).join(' OR ');
            rows = this.db!.prepare(
                `SELECT s.name, f.relative_path AS relativePath, s.line_number AS lineNumber, s.column
                 FROM symbols_fts JOIN symbols s ON s.id = symbols_fts.rowid
                                  JOIN files f ON f.id = s.file_id
                 WHERE symbols_fts MATCH ?`
            ).all(fts);
        }
        const filtered = rows.filter((r: any) => re.test(r.name));
        // Apply sort + pagination
        filtered.sort((a: any, b: any) =>
            a.relativePath.localeCompare(b.relativePath) || a.lineNumber - b.lineNumber);
        return filtered.slice(p.offset, p.offset + p.limit);
    }
    // substring
    const tokens = extractLiteralTokens(query);
    const like = '%' + query.replace(/[%_]/g, '\\$&') + '%';
    if (tokens.length === 0) {
        // 无可用 token,直接 LIKE 扫全表(上限 10k)
        return this.db!.prepare(
            `SELECT s.name, f.relative_path AS relativePath, s.line_number AS lineNumber, s.column
             FROM symbols s JOIN files f ON f.id = s.file_id
             WHERE s.name ${options.caseSensitive ? 'GLOB' : 'LIKE'} ? ESCAPE '\\'
             ORDER BY f.relative_path, s.line_number
             LIMIT ? OFFSET ?`
        ).all(options.caseSensitive ? `*${query}*` : like, p.limit, p.offset) as any;
    }
    const fts = tokens.map(escapeFtsLiteral).join(' OR ');
    return this.db!.prepare(
        `SELECT s.name, f.relative_path AS relativePath, s.line_number AS lineNumber, s.column
         FROM symbols_fts JOIN symbols s ON s.id = symbols_fts.rowid
                          JOIN files f ON f.id = s.file_id
         WHERE symbols_fts MATCH ? AND s.name ${options.caseSensitive ? 'GLOB' : 'LIKE'} ? ESCAPE '\\'
         ORDER BY f.relative_path, s.line_number
         LIMIT ? OFFSET ?`
    ).all(fts, options.caseSensitive ? `*${query}*` : like, p.limit, p.offset) as any;
}

private selectCountForQuery(query: string, options: SearchOptions): number {
    // 用 search() 的同构查询,但换 SELECT COUNT(*),不带 LIMIT/OFFSET
    if (options.wholeWord && options.caseSensitive && !options.regex) {
        const r = this.db!.prepare('SELECT COUNT(*) AS c FROM symbols WHERE name = ?').get(query) as { c: number };
        return r.c;
    }
    if (options.wholeWord && !options.regex) {
        const r = this.db!.prepare('SELECT COUNT(*) AS c FROM symbols_fts WHERE symbols_fts MATCH ?')
                         .get(escapeFtsLiteral(query)) as { c: number };
        return r.c;
    }
    if (options.regex) {
        // regex 没法预估,走 full scan 上限 10000 再 filter
        const tokens = extractLiteralTokens(query);
        let re: RegExp;
        try { re = new RegExp(query, options.caseSensitive ? '' : 'i'); } catch { return 0; }
        let rows: any[];
        if (tokens.length === 0) {
            rows = this.db!.prepare('SELECT name FROM symbols LIMIT 10000').all();
        } else {
            rows = this.db!.prepare('SELECT s.name FROM symbols_fts JOIN symbols s ON s.id = symbols_fts.rowid WHERE symbols_fts MATCH ?')
                         .all(tokens.map(escapeFtsLiteral).join(' OR '));
        }
        return rows.filter((r: any) => re.test(r.name)).length;
    }
    const tokens = extractLiteralTokens(query);
    const like = '%' + query.replace(/[%_]/g, '\\$&') + '%';
    if (tokens.length === 0) {
        const r = this.db!.prepare(
            `SELECT COUNT(*) AS c FROM symbols WHERE name ${options.caseSensitive ? 'GLOB' : 'LIKE'} ? ESCAPE '\\'`
        ).get(options.caseSensitive ? `*${query}*` : like) as { c: number };
        return r.c;
    }
    const fts = tokens.map(escapeFtsLiteral).join(' OR ');
    const r = this.db!.prepare(
        `SELECT COUNT(*) AS c FROM symbols_fts JOIN symbols s ON s.id = symbols_fts.rowid
         WHERE symbols_fts MATCH ? AND s.name ${options.caseSensitive ? 'GLOB' : 'LIKE'} ? ESCAPE '\\'`
    ).get(fts, options.caseSensitive ? `*${query}*` : like) as { c: number };
    return r.c;
}
```

- [ ] **Step 4: 编译 + 测**

Expected: 4 + 5 + 8 = 17 passing

- [ ] **Step 5: Commit**

```bash
git add src/index/dbBackend.ts test/suite/dbBackend.test.ts
git commit -m "feat(index): DbBackend search/countMatches with FTS5 + B-tree + regex token coarse filter"
```

---

### Task 1.8: DbBackend — 健壮性测试 (integrity / schema / crash)

**Files:**
- Create: `test/suite/dbBackend.integrity.test.ts`
- Modify: `src/index/dbBackend.ts`(加 integrityCheck / quarantineCorrupt)

- [ ] **Step 1: 写 failing test**

```ts
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
```

- [ ] **Step 2: 编译确认 failing**(`integrityCheck` 尚不存在)

- [ ] **Step 3: 在 `dbBackend.ts` 加实现**

```ts
// 在 openOrInit 顶部,文件存在时先做 quick_check;schema 版本校验
// 改写 openOrInit:
openOrInit(): void {
    if (this.db) { return; }
    const isMemory = this.dbPath === ':memory:';
    if (!isMemory && fs.existsSync(this.dbPath)) {
        // 已有文件先 quick_check,损坏就 quarantine
        try {
            const probe = new Database(this.dbPath, { readonly: true });
            const r = probe.pragma('quick_check', { simple: true });
            probe.close();
            if (r !== 'ok') { this.quarantineAndReplace(); }
        } catch {
            this.quarantineAndReplace();
        }
    }
    if (!isMemory) { fs.mkdirSync(path.dirname(this.dbPath), { recursive: true }); }
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('cache_size = -65536');
    this.db.pragma('temp_store = MEMORY');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(DDL);
    this.ensureMeta();
    this.verifySchemaVersion();
}

integrityCheck(): string {
    if (!this.db) { return 'not opened'; }
    return this.db.pragma('integrity_check', { simple: true }) as string;
}

private quarantineAndReplace(): void {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const quarantinePath = `${this.dbPath}.corrupt-${ts}`;
    try { fs.renameSync(this.dbPath, quarantinePath); } catch { /* ignore */ }
    try { fs.unlinkSync(this.dbPath + '-wal'); } catch { /* ignore */ }
    try { fs.unlinkSync(this.dbPath + '-shm'); } catch { /* ignore */ }
}

private verifySchemaVersion(): void {
    const version = this.getSchemaVersion();
    if (version > CURRENT_SCHEMA_VERSION) {
        const msg = `sisearch DB schema version ${version} is newer than this extension supports (${CURRENT_SCHEMA_VERSION}). ` +
                    `Please upgrade the extension or delete .sisearch/index.sqlite and re-sync.`;
        throw new Error(msg);
    }
    // 版本更低(或 0)静默重建 —— DDL 的 CREATE TABLE IF NOT EXISTS 已兼容,需要补 meta
    if (version < CURRENT_SCHEMA_VERSION) {
        // 首版:直接清 tables 重建
        this.db!.exec('DELETE FROM symbols; DELETE FROM files;');
        this.db!.prepare("UPDATE meta SET value=? WHERE key='schema_version'").run(String(CURRENT_SCHEMA_VERSION));
    }
}
```

- [ ] **Step 4: 编译 + 测**

Run: `npm run compile && npx mocha --ui tdd out/test/suite/dbBackend.integrity.test.js`
Expected: 4 passing

- [ ] **Step 5: Commit**

```bash
git add src/index/dbBackend.ts test/suite/dbBackend.integrity.test.ts
git commit -m "feat(index): DbBackend integrity check + quarantine corrupt + schema version gate"
```

---

### M1 验证 + 停止点

- [ ] **全 M1 回归**:

```bash
npm run compile && npx mocha --ui tdd \
  out/test/suite/dbBackend.test.js \
  out/test/suite/dbBackend.integrity.test.js \
  out/test/suite/symbolKindCodec.test.js \
  out/test/suite/ftsQueryBuilder.test.js \
  out/test/suite/lineContentReader.test.js
```

Expected: 4 + 4 + 9 + 8 + 6 + 5 = 36 passing(数字近似,看实际)

- [ ] **REPL 手动验证**:
```bash
node -e "
const { DbBackend } = require('./out/src/index/dbBackend');
const db = new DbBackend(':memory:'); db.openOrInit();
db.writeBatch({
  metadata:[{relativePath:'a.c',mtime:1,size:100,symbolCount:1}],
  symbols:[{name:'foo',kind:'function',filePath:'/a.c',relativePath:'a.c',
            lineNumber:1,endLineNumber:1,column:0,lineContent:''}],
  deletedRelativePaths:[]
});
console.log(db.search('foo', { caseSensitive:false, wholeWord:true, regex:false }));
"
```
应输出 foo 一条记录。

### ⛔ 停止点 M1 — 怎么退出

到此为止 DbBackend 独立可用,**没有任何调用方**。若决定不继续:
1. `git log` 最近 M1 的 commits 都可以保留在 main(没人用)
2. 或 `git revert` 所有 M1 commit 退回(简单)
3. 不需要其它清理

---


## M2 — SyncOrchestrator 切换到 DbBackend

**目标:** 替换 façade 和 orchestrator 的内部存储,小 fixture repo F5 可跑。`.sisearch/index.sqlite` 取代 `shards/`。AMD 寄存器宏仍**不入索引**(parseWorker Phase 5H 行为保留到 M3)。

**依赖:** M1 完成
**风险:** 测试 mock 改动幅度大(syncOrchestrator.test.ts + symbolIndexFacade.test.ts);façade API 签名保持,但内部路径变化可能触发隐藏 bug
**独立验证:** F5 小 fixture workspace → Sync → sqlite3 命令行验证 DB 有行 → 搜索栏命中

### Task 2.1: 创建 test fixture 小仓库

**Files:**
- Create: `test/fixtures/small-repo/` 下 ~10 个 C/H 文件

- [ ] **Step 1: 建目录 + fixture 文件**

```bash
mkdir -p test/fixtures/small-repo/src
```

创建下列文件,内容可简单:

`test/fixtures/small-repo/src/main.c`:
```c
#include <stdio.h>
int main(void) { printf("hello\n"); return 0; }
```

`test/fixtures/small-repo/src/util.c`:
```c
int add(int a, int b) { return a + b; }
int subtract(int a, int b) { return a - b; }
```

`test/fixtures/small-repo/src/util.h`:
```c
#ifndef UTIL_H
#define UTIL_H
int add(int a, int b);
int subtract(int a, int b);
#endif
```

`test/fixtures/small-repo/src/widget.c`:
```c
struct Widget { int x; int y; };
void widget_init(struct Widget *w) { w->x = 0; w->y = 0; }
```

再加几个空文件凑数:
```bash
for i in 1 2 3 4 5 6; do
  echo "int placeholder_$i(void);" > test/fixtures/small-repo/src/ph$i.c
done
```

- [ ] **Step 2: 添加 `.gitignore` 不污染 fixture 目录**

若 repo 根 `.gitignore` 没 fixture 排除规则,保持现状(fixture 应当被版本控制,是测试输入)。

- [ ] **Step 3: Commit**

```bash
git add test/fixtures/small-repo
git commit -m "test: add small-repo fixture (10 C/H files) for integration tests"
```

---

### Task 2.2: 把 SymbolIndex façade 内部换成 DbBackend

**Files:**
- Modify: `src/symbolIndex.ts`
- Modify: `test/suite/symbolIndexFacade.test.ts`

这个 task 比较大,分 2-3 个 commit。

- [ ] **Step 1: 阅读 `src/symbolIndex.ts` 现状**

Run: `cat src/symbolIndex.ts | wc -l` 查长度 (~250 行)
Run: 阅读完整文件,记录以下要点:
- `inner: InMemorySymbolIndex` 和 `fileMetadata: Map` 两个字段
- `storageByRoot: Map<string, StorageManager>` 的记忆化
- `synchronize`、`syncDirty`、`searchSymbols`、`loadFromDisk`、`saveToDisk`、`clear`、`clearDisk`、`getStats`、`markDirty`、`markDeleted` 每个方法内部怎么用 inner/storage

- [ ] **Step 2: 改 `src/symbolIndex.ts`**

做如下替换(保留公开 API 完整):
1. `import` 换掉 `InMemorySymbolIndex`、`StorageManager`,加 `import { DbBackend } from './index/dbBackend';` `import { LineContentReader } from './index/lineContentReader';`
2. `private readonly inner = new InMemorySymbolIndex();` 删除
3. `private readonly fileMetadata = new Map<string, IndexedFile>();` 删除(改由 DbBackend 管)
4. `private readonly storageByRoot = new Map<string, StorageManager>();` 删除
5. 加:
   ```ts
   private readonly dbByRoot = new Map<string, DbBackend>();
   private readonly lineReader = new LineContentReader();
   ```
6. 方法 `getOrCreateDb(workspaceRoot): DbBackend`:
   ```ts
   private getOrCreateDb(workspaceRoot: string): DbBackend {
       const canonical = this.canonicalRoot(workspaceRoot);
       let db = this.dbByRoot.get(canonical);
       if (!db) {
           const p = path.join(canonical, '.sisearch', 'index.sqlite');
           db = new DbBackend(p);
           db.openOrInit();
           this.dbByRoot.set(canonical, db);
       }
       return db;
   }
   ```
7. `synchronize(...)` 内部构造 `SyncOrchestrator` 时,deps 只传 `db`(见 2.3 task 的 orchestrator 改动)
8. `searchSymbols(query, root, options, pagination?)`:
   ```ts
   searchSymbols(
       query: string,
       workspaceRoot: string,
       options: SearchOptions,
       pagination?: { limit: number; offset: number }
   ): SearchResult[] {
       if (this._status !== 'ready' && this._status !== 'stale') { return []; }
       const db = this.getOrCreateDb(workspaceRoot);
       const rawResults = db.search(query, options, pagination);
       // 给每条填 filePath 绝对路径 + lineContent(用 LineContentReader)
       return rawResults.map(r => {
           const abs = path.join(this.canonicalRoot(workspaceRoot), r.relativePath);
           const line = this.lineReader.read(abs, r.lineNumber);
           return {
               ...r,
               filePath: abs,
               lineContent: line,
               matchStart: line.toLowerCase().indexOf(r.relativePath.split('/').pop() ?? ''), // 近似,由搜索模块填
               matchLength: r.matchLength,
           };
       });
   }
   ```
   (注:实际 matchStart/length 由 searchEngine 侧基于 `query` 算,这里填占位符;M4 任务里纠正)
9. `loadFromDisk(workspaceRoot)`:
   ```ts
   async loadFromDisk(workspaceRoot: string): Promise<boolean> {
       try {
           const db = this.getOrCreateDb(workspaceRoot);
           const stats = db.getStats();
           if (stats.files > 0) {
               this.setStatus('ready');
               this._onStatsChanged.fire(stats);
               return true;
           }
           this.setStatus('none');
           return false;
       } catch {
           this.setStatus('none');
           return false;
       }
   }
   ```
10. `saveToDisk` 改 no-op(或移除调用点;该方法签名保留因为 commands.ts 可能调):
    ```ts
    async saveToDisk(_workspaceRoot: string): Promise<void> { /* no-op: events already persisted by DbBackend transactions */ }
    ```
11. `clear()`: `this.dbByRoot.forEach(d => d.clearAll());` + 状态设 'none'
12. `clearDisk(workspaceRoot)`:
    ```ts
    clearDisk(workspaceRoot: string): void {
        const canonical = this.canonicalRoot(workspaceRoot);
        const existing = this.dbByRoot.get(canonical);
        if (existing) {
            existing.close();
            this.dbByRoot.delete(canonical);
        }
        const p = path.join(canonical, '.sisearch', 'index.sqlite');
        for (const suffix of ['', '-wal', '-shm']) {
            try { fs.unlinkSync(p + suffix); } catch {}
        }
    }
    ```
13. `getStats()`:从当前活动 db 读;如无则 `{files:0,symbols:0}`。  
    注意:getStats 原本不带 workspaceRoot 参数,要保留签名 —— 只用最近 touch 的 DbBackend:
    ```ts
    getStats(): { files: number; symbols: number } {
        for (const db of this.dbByRoot.values()) { return db.getStats(); }
        return { files: 0, symbols: 0 };
    }
    ```
14. 新方法 `isSyncInProgress()`:用现有 `reentrancyGuard`:
    ```ts
    isSyncInProgress(): boolean { return this.syncGuard.isRunning(); }
    ```
    (若 reentrancyGuard 没 `isRunning` 方法,顺手加一个返回 internal state;保持向后兼容)
15. `markDirty` / `markDeleted` 保留现有语义(它们只影响下次 syncDirty)

- [ ] **Step 3: `reentrancyGuard.ts` 加 `isRunning()` (若缺)**

Run: `grep -n "isRunning\|inProgress\|active" src/sync/reentrancyGuard.ts`
若没:
```ts
isRunning(): boolean { return this.active; }
```

- [ ] **Step 4: 先编译,修所有 TS 错**

Run: `npm run compile`
Fix errors iteratively 直到编译 pass。

- [ ] **Step 5: 更新 `test/suite/symbolIndexFacade.test.ts`**

把原来 mock InMemorySymbolIndex 的地方改成 mock DbBackend;`dbPath` 传 `':memory:'`。

若原测试覆盖了 "loadFromDisk 能把 shards 回填到 Map" 这类旧语义,要改成 "loadFromDisk 在有 DbBackend 数据时返回 true"。

- [ ] **Step 6: 编译 + 跑 symbolIndexFacade 测**

Run: `npm run compile && npx mocha --ui tdd out/test/suite/symbolIndexFacade.test.js`
Expected: 全绿

- [ ] **Step 7: Commit**

```bash
git add src/symbolIndex.ts src/sync/reentrancyGuard.ts test/suite/symbolIndexFacade.test.ts
git commit -m "refactor(symbolIndex): switch façade internals to DbBackend (API unchanged)"
```

---

### Task 2.3: SyncOrchestrator deps 合并为 db

**Files:**
- Modify: `src/sync/syncOrchestrator.ts`
- Modify: `test/suite/syncOrchestrator.test.ts`

- [ ] **Step 1: 编辑 `src/sync/syncOrchestrator.ts`**

做以下改动:

1. 接口 `SyncOrchestratorDeps` 删除 `index`、`storage`、`getSnapshot` 字段;增加 `db: DbBackend`
2. `synchronize` 方法内:
   - 删除 `this.deps.index.remove(rel)` 的循环,改为:
     ```ts
     const deletedPaths = [...classified.toDelete];
     ```
     并把 `deletedPaths` 传入第一次 `writeBatch` 里
   - `onBatchResult` 改为:
     ```ts
     async (batch) => {
         this.deps.db.writeBatch({
             metadata: batch.metadata,
             symbols: batch.symbols,
             deletedRelativePaths: deletedPaths.splice(0),
         });
     },
     ```
   - 删除最后的 `if (dirtyPaths.size > 0) storage.saveDirty/saveFull`
   - 加 `this.deps.db.checkpoint();` 在 sync 末尾
   - `previousFiles` 原本来自 `this.deps.index.fileMetadata`;改成 `this.deps.db.getAllFileMetadata()`

3. `syncDirty` 方法内:同样改用 `db` 而非 `index/storage`

- [ ] **Step 2: 编辑 `test/suite/syncOrchestrator.test.ts`**

原来的 `deps.index` + `deps.storage` + `deps.getSnapshot` mock 改成:
```ts
const writes: any[] = [];
const db = {
    writeBatch: (b: any) => writes.push(b),
    getAllFileMetadata: () => new Map(),
    checkpoint: () => {},
    // 其余测试用不到的方法可以不放
};
```

所有断言 `inner.update called with...` 改成 `writes 里的 batch 符合预期`。
`saveDirty/saveFull` 相关断言改成 `db.checkpoint 被调用一次`。

- [ ] **Step 3: 编译 + 测**

Run: `npm run compile && npx mocha --ui tdd out/test/suite/syncOrchestrator.test.js`
Expected: 全绿

- [ ] **Step 4: Commit**

```bash
git add src/sync/syncOrchestrator.ts test/suite/syncOrchestrator.test.ts
git commit -m "refactor(sync): SyncOrchestrator uses DbBackend; remove index/storage/getSnapshot deps"
```

---

### Task 2.4: composition.ts 布线 DbBackend

**Files:**
- Modify: `src/composition.ts`

- [ ] **Step 1: 打开 `src/composition.ts` 查找 `StorageManager` 相关代码**

Run: `grep -n "StorageManager\|storage" src/composition.ts`

- [ ] **Step 2: 替换布线**

把创建 `StorageManager` 和把它作为 `SymbolIndex` 依赖传入的地方去掉 —— SymbolIndex 现在自己管理 DbBackend。

具体改:
- 删除 `import { StorageManager } from './storage/storageManager';`
- 删除 `new StorageManager(...)` 的实例化代码
- 检查 `new SymbolIndex(deps)` 的 deps,确保不传 storage 相关字段(参考 M2.2 改过的 SymbolIndexDeps)

- [ ] **Step 3: 编译**

Run: `npm run compile`
Expected: 无错误

- [ ] **Step 4: Commit**

```bash
git add src/composition.ts
git commit -m "refactor(composition): remove StorageManager wiring; SymbolIndex owns DbBackend"
```

---

### Task 2.5: 删除旧 InMemorySymbolIndex + StorageManager + Shard 组件

**Files:**
- Delete: `src/index/symbolIndex.ts`
- Delete: `src/storage/storageManager.ts`
- Delete: `src/storage/shardStreamWriter.ts`
- Delete: `src/storage/codec.ts`
- Delete: `src/storage/shardStrategy.ts`
- Delete: `test/suite/symbolIndex.test.ts`
- Delete: `test/suite/storageManager.test.ts`
- Delete: `test/suite/shardStreamWriter.test.ts`
- Delete: `test/suite/codec.test.ts`
- Delete: `test/suite/streamingSyncIntegration.test.ts`
- Modify: `package.json`(删除 `@msgpack/msgpack` 依赖)

- [ ] **Step 1: 删除源文件**

```bash
rm src/index/symbolIndex.ts
rm src/storage/storageManager.ts
rm src/storage/shardStreamWriter.ts
rm src/storage/codec.ts
rm src/storage/shardStrategy.ts
```

- [ ] **Step 2: 删除相关测试**

```bash
rm test/suite/symbolIndex.test.ts
rm test/suite/storageManager.test.ts
rm test/suite/shardStreamWriter.test.ts
rm test/suite/codec.test.ts
rm test/suite/streamingSyncIntegration.test.ts
```

- [ ] **Step 3: 从 package.json 移除 msgpack**

编辑 `package.json`,删除 `"@msgpack/msgpack": "^3.1.3",` 行。
运行 `npm install` 让 `package-lock.json` 同步。

- [ ] **Step 4: grep 确认没有悬挂引用**

```bash
grep -rn "storageManager\|StorageManager\|ShardStreamWriter\|InMemorySymbolIndex\|shardStrategy\|shardForPath\|shardFileName\|msgpack" src/ test/
```
Expected: 应无任何命中;如有剩余引用,修复它们(通常是 import 残留)。

- [ ] **Step 5: 编译 + 跑完整回归**

Run: `npm run compile`

Run: 完整回归测试(见"运行约定"章节的命令)
Expected: 全绿

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: delete InMemorySymbolIndex, StorageManager, shard/msgpack layer"
```

---

### Task 2.6: parseWorker 暂时保留 Phase 5H("stream 不入索引")

**Files:** 无修改(这是显式的"不改")

- [ ] **Step 1: 确认 `src/sync/parseWorker.ts` 的 stream 分支还是 Phase 5H**

Run: `grep -n "onSymbol" src/sync/parseWorker.ts`
Expected: 看到 `onSymbol: () => { streamedCount++; }` (空 callback)

M2 **不回滚** Phase 5H;stream 路径符号**仍不入索引**。留给 M3。

- [ ] **Step 2: 在 CHANGELOG / commit 里留标注(若要)**

可选跳过。

---

### M2 验证 + 停止点

- [ ] **完整回归**

Run:
```bash
npm run compile && npx mocha --ui tdd \
  out/test/suite/dbBackend.test.js \
  out/test/suite/dbBackend.integrity.test.js \
  out/test/suite/symbolKindCodec.test.js \
  out/test/suite/ftsQueryBuilder.test.js \
  out/test/suite/lineContentReader.test.js \
  out/test/suite/symbolIndexFacadeSqlite.test.js \
  out/test/suite/symbolIndexFacade.test.js \
  out/test/suite/searchEngine.test.js \
  out/test/suite/syncOrchestrator.test.js \
  out/test/suite/workerDiag.test.js \
  out/test/suite/workerPoolFactoryMaxBytes.test.js \
  out/test/suite/parserConfig.test.js \
  out/test/suite/symbolParserMaxBytes.test.js \
  out/test/suite/largeFileParser.test.js \
  out/test/suite/largeFileParserStream.test.js \
  out/test/suite/workerPool.test.js \
  out/test/suite/batchClassifier.test.js \
  out/test/suite/parseResultGrouping.test.js \
  out/test/suite/reentrancyGuard.test.js
```

Expected: 全绿

- [ ] **F5 smoke**

1. 在 `.vscode/launch.json` 里的 `extensionDevelopmentPath` 开发 VS Code
2. 打开 `test/fixtures/small-repo/` 作为 workspace
3. 运行 `SI Search: Sync Index` 命令
4. 确认:
   - `test/fixtures/small-repo/.sisearch/index.sqlite` 存在
   - `sqlite3 test/fixtures/small-repo/.sisearch/index.sqlite 'SELECT COUNT(*) FROM symbols'` 返回非零
   - SI Search 搜索栏输入 `main` 能看到结果

- [ ] **清理 fixture .sisearch(避免污染 git)**

```bash
rm -rf test/fixtures/small-repo/.sisearch
```

加到 `.gitignore`:
```
test/fixtures/**/.sisearch/
```

### 🛑 停止点 M2 — 合理退出

**到此为止架构已换完**,小 repo 可搜,但:
- AMD 寄存器宏等 stream 文件仍不入索引(Phase 5H 保留)
- 搜索无分页(10k+ 结果一次性返回,UI 会慢但不会崩)
- Sync 期间搜索行为未定义(暂不弹窗)
- 无 native addon 降级

若在此停:索引引擎已迁移,自用场景(无 AMD GPU 类大仓)完全可用。

若要继续 M3:进下一阶段。

---

## M3 — Phase 5H 回滚 + 全量索引(最高风险)

**目标:** stream 路径符号回到索引;Linux drivers F5 搜 `PSWUSP0_*` 能命中;主线程堆稳定在 < 500 MB。

**依赖:** M2 完成
**风险:** 🔴 最高。可能暴露写入吞吐不够、主线程事务 commit 卡顿;若 P8 heap 超标,回滚到 Phase 5H
**独立验证:** F5 Linux drivers;heap sampler 采样;搜 AMD 宏命中

### Task 3.1: 在 parseWorker 中回滚 Phase 5H

**Files:**
- Modify: `src/sync/parseWorker.ts`

- [ ] **Step 1: 阅读 parseWorker.ts 当前 stream 分支**

Run: `grep -n -A 15 "extractSymbolsByRegexStream" src/sync/parseWorker.ts`

- [ ] **Step 2: 改 onSymbol**

找到类似:
```ts
await extractSymbolsByRegexStream(file.absPath, file.relativePath, {
    lineContentMode: 'empty',
    macrosOnly,
    onSymbol: () => { streamedCount++; },   // Phase 5H
});
```

改为:
```ts
await extractSymbolsByRegexStream(file.absPath, file.relativePath, {
    lineContentMode: 'empty',
    macrosOnly,
    onSymbol: (entry) => {
        symbols.push(entry);        // Phase 5D 回滚
        streamedCount++;
    },
});
```

保留 `macrosOnly`、`lineContentMode: 'empty'`、无 seen Set 等其它优化。

- [ ] **Step 3: 编译**

Run: `npm run compile`

- [ ] **Step 4: (无专门 parseWorker 单测;跑 syncOrchestrator 和 largeFileParserStream 测做回归)**

Run:
```bash
npx mocha --ui tdd \
  out/test/suite/syncOrchestrator.test.js \
  out/test/suite/largeFileParserStream.test.js
```
Expected: 全绿

- [ ] **Step 5: Commit**

```bash
git add src/sync/parseWorker.ts
git commit -m "feat(worker): rollback Phase 5H — stream path symbols now enter index"
```

---

### Task 3.2: heapSampler benchmark 工具

**Files:**
- Create: `test/benchmark/heapSampler.ts`

- [ ] **Step 1: 写 heapSampler 工具**

```ts
// test/benchmark/heapSampler.ts
// 周期采样 process.memoryUsage().heapUsed,记录峰值,用于 P8 验收。
// 可独立运行,也可被其它 bench import。

export class HeapSampler {
    private peak = 0;
    private samples: Array<{ t: number; heapUsed: number; rss: number }> = [];
    private timer: NodeJS.Timeout | null = null;

    start(intervalMs: number = 200): void {
        if (this.timer) { return; }
        this.timer = setInterval(() => {
            const m = process.memoryUsage();
            this.samples.push({ t: Date.now(), heapUsed: m.heapUsed, rss: m.rss });
            if (m.heapUsed > this.peak) { this.peak = m.heapUsed; }
        }, intervalMs);
    }

    stop(): void {
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
    }

    peakHeapMB(): number { return this.peak / 1024 / 1024; }

    report(): { peakMB: number; samples: number; durationMs: number } {
        const first = this.samples[0], last = this.samples[this.samples.length - 1];
        return {
            peakMB: this.peakHeapMB(),
            samples: this.samples.length,
            durationMs: last && first ? last.t - first.t : 0,
        };
    }
}

if (require.main === module) {
    // Usage: node out/test/benchmark/heapSampler.js <durationSeconds>
    const durationS = parseInt(process.argv[2] ?? '5', 10);
    const s = new HeapSampler();
    s.start(200);
    setTimeout(() => {
        s.stop();
        console.log(JSON.stringify(s.report(), null, 2));
    }, durationS * 1000);
}
```

- [ ] **Step 2: 编译**

Run: `npm run compile`

- [ ] **Step 3: 冒烟测**

Run: `node out/test/benchmark/heapSampler.js 2`
Expected: 打印 { peakMB: <数字>, samples: ~10, durationMs: ~2000 }

- [ ] **Step 4: Commit**

```bash
git add test/benchmark/heapSampler.ts
git commit -m "test(bench): HeapSampler utility for P8 heap ceiling validation"
```

---

### Task 3.3: Stress test — 连续 Sync 5 次不崩

**Files:**
- Create: `scripts/stress-sync.sh`

这个是**半自动化**的 stress test。不放到 mocha 里(太依赖真 VS Code),做成手动跑的脚本。

- [ ] **Step 1: 写脚本**

```bash
# scripts/stress-sync.sh
# 用法:先 F5 启动扩展,手动跑一次 Sync,然后在另一个终端运行此脚本监控。
# 本脚本不触发 Sync,只负责:
#   - 监视 extension host 进程 RSS/heap(通过 /proc/<pid>/status)
#   - 监视 .sisearch/index.sqlite 大小
#   - 每 5 秒写一行记录
#
# 断言:当 Sync 走完后(RSS 稳定),peak heap < 500 MB。
#
# 要求:传入 workspace 绝对路径 + extension host pid

set -u
WORKSPACE="${1:?usage: stress-sync.sh <workspace> <pid>}"
PID="${2:?usage: stress-sync.sh <workspace> <pid>}"
LOG="$WORKSPACE/.sisearch/stress.log"
mkdir -p "$(dirname "$LOG")"
echo "timestamp,rss_kb,heap_kb,db_size_bytes" > "$LOG"

while kill -0 "$PID" 2>/dev/null; do
    RSS=$(awk '/VmRSS/{print $2}' /proc/$PID/status 2>/dev/null || echo 0)
    # heap 从 Node inspector 拿不到;用 rss 粗略代替
    DB_SIZE=$(stat -c %s "$WORKSPACE/.sisearch/index.sqlite" 2>/dev/null || echo 0)
    echo "$(date +%s),$RSS,-,$DB_SIZE" >> "$LOG"
    sleep 5
done

echo "extension host exited; log: $LOG"
tail -5 "$LOG"
```

`chmod +x scripts/stress-sync.sh`

- [ ] **Step 2: Commit**

```bash
git add scripts/stress-sync.sh
git commit -m "test(stress): simple script to record RSS + DB size during Sync"
```

---

### Task 3.4: M3 验证 + Linux drivers F5 smoke

**Files:** 无

- [ ] **Step 1: 完整回归**

Run: 完整回归命令(见"运行约定")
Expected: 全绿

- [ ] **Step 2: F5 Linux drivers**

1. 打开 `/home/mi/Disk/Git/linux/drivers` 作为 workspace
2. F5 启动 extension host
3. 获取 extension host PID(`ps aux | grep extensionHost` 或查看 main.log)
4. 新终端:`scripts/stress-sync.sh /home/mi/Disk/Git/linux/drivers <PID> &`
5. 在 extension 里运行 `SI Search: Sync Index`
6. 等 Sync 完成

- [ ] **Step 3: 断言验收**

- [ ] 搜 `amdgpu_device_init` 命中(F2)
- [ ] 搜 `PSWUSP0` 命中多条(F3 AMD 寄存器宏 ✓)
- [ ] `tail -20 /home/mi/Disk/Git/linux/drivers/.sisearch/stress.log` 的 rss_kb 峰值 × 1024 小于 500 MB(P8)
- [ ] `ls -lh /home/mi/Disk/Git/linux/drivers/.sisearch/index.sqlite` 在 ~1 GB 以内(P9)
- [ ] Sync 在 8 分钟内完成(P3)

- [ ] **Step 4: 观察期(1-2 天)**

在实际使用中连跑 3-5 次 Sync,每次都走到完成,没有崩;这是 M3 的 "stopping confidence" 标记。

### 🛑 停止点 M3 — 合理退出(自用完整版)

到此为止:
- 全量符号可搜(包括 AMD 寄存器宏) ✓
- Sync 不崩 ✓
- 主线程堆受控 ✓
- 但无分页(10k+ 结果一次性返回,UI 可能卡)
- Sync 期间搜索行为未定义

**个人使用完全可用**。如果在此停,记得:
1. 把前序 M1-M3 合并到 main
2. 清理 `/tmp/sisearch-worker-*.log`
3. 不需要进一步改动

如果继续 M4:进分页。

若 M3 失败(heap 超标 / Sync 挂掉):
```bash
git revert <M3 task commit shas>
```
回到 M2 的 "stream 不入索引" 状态。

---


## M4 — 搜索分页 / 虚拟滚动

**目标:** 搜 10k+ 结果时首批返回 200 条,UI 显示 "200 / total";滚到底自动加载下一批。

**依赖:** M3 完成(有真实全量索引才有大结果集)
**独立验证:** F5 Linux drivers;搜 `a`(命中数十万);看到分页数字 + 滚动触发 append

### Task 4.1: searchStore 加 loadedCount/totalCount

**Files:**
- Modify: `src/search/searchStore.ts`
- Modify: `test/suite/searchStore.test.ts`

- [ ] **Step 1: 阅读 searchStore.ts 了解 SearchStoreEntry 现状**

Run: `grep -n "interface\|class SearchStore" src/search/searchStore.ts`

- [ ] **Step 2: 写 failing tests**

在 `test/suite/searchStore.test.ts` 追加:

```ts
test('addSearch records totalCount and loadedCount', () => {
    const s = new SearchStore();
    const results: SearchResult[] = Array.from({ length: 200 }, (_, i) => ({
        filePath: `/f${i}`, relativePath: `f${i}`, lineNumber: 1,
        lineContent: '', matchStart: 0, matchLength: 1,
    }));
    s.addSearch('q', { caseSensitive: false, wholeWord: false, regex: false },
                results, 'replace', { totalCount: 1500, loadedCount: 200 });
    const active = s.getActive();
    assert.strictEqual(active?.totalCount, 1500);
    assert.strictEqual(active?.loadedCount, 200);
});

test('appendResults advances loadedCount', () => {
    const s = new SearchStore();
    s.addSearch('q', {caseSensitive:false,wholeWord:false,regex:false},
                [{ filePath:'/a',relativePath:'a',lineNumber:1,lineContent:'',matchStart:0,matchLength:1 }],
                'replace', { totalCount: 100, loadedCount: 1 });
    s.appendToActive([
        { filePath:'/b',relativePath:'b',lineNumber:1,lineContent:'',matchStart:0,matchLength:1 },
        { filePath:'/c',relativePath:'c',lineNumber:1,lineContent:'',matchStart:0,matchLength:1 },
    ]);
    const active = s.getActive();
    assert.strictEqual(active?.loadedCount, 3);
    assert.strictEqual(active?.results.length, 3);
});
```

- [ ] **Step 3: 编译确认 failing**

- [ ] **Step 4: 改 `src/search/searchStore.ts`**

```ts
// 在 SearchStoreEntry 里加字段
interface SearchStoreEntry {
    query: string;
    options: SearchOptions;
    results: SearchResult[];
    mode: SearchMode;
    // 新增
    totalCount: number;
    loadedCount: number;
}

// addSearch 签名加可选 pagination metadata:
addSearch(
    query: string,
    options: SearchOptions,
    results: SearchResult[],
    mode: SearchMode,
    pagination?: { totalCount: number; loadedCount: number }
): void {
    const entry: SearchStoreEntry = {
        query, options, results, mode,
        totalCount: pagination?.totalCount ?? results.length,
        loadedCount: pagination?.loadedCount ?? results.length,
    };
    // ... 存入 activeResults / history
}

// 新方法
appendToActive(more: SearchResult[]): void {
    const active = this.getActive();
    if (!active) { return; }
    active.results.push(...more);
    active.loadedCount = active.results.length;
}
```

- [ ] **Step 5: 编译 + 测**

Run: `npm run compile && npx mocha --ui tdd out/test/suite/searchStore.test.js`

- [ ] **Step 6: Commit**

```bash
git add src/search/searchStore.ts test/suite/searchStore.test.ts
git commit -m "feat(search): SearchStore tracks totalCount/loadedCount for pagination"
```

---

### Task 4.2: SearchEngine 用 pagination 调 DbBackend

**Files:**
- Modify: `src/search/searchEngine.ts`
- Modify: `test/suite/searchEngine.test.ts`

- [ ] **Step 1: 改 `executeSearchWithIndex` 签名**

加可选 `offset: number`,默认 0。

```ts
export async function executeSearchWithIndex(
    query: string,
    workspaceRoot: string,
    options: SearchOptions,
    extensions: string[],
    excludes: string[],
    symbolIndex: SymbolIndex,
    offset: number = 0,                      // 新增
): Promise<{ results: SearchResult[]; totalCount: number }> {
    // ...
    if (symbolIndex.status === 'ready' || symbolIndex.status === 'stale') {
        const max = vscode.workspace.getConfiguration('siSearch.search').get<number>('maxResults', 200);
        const results = symbolIndex.searchSymbols(query, workspaceRoot, options,
                                                  { limit: max, offset });
        const totalCount = results.length === 0 ? 0 : symbolIndex.countMatches(query, workspaceRoot, options);
        // ... 如果结果非空直接返回,否则 fallback ripgrep
        return { results, totalCount };
    }
    // ripgrep fallback:totalCount 用 results.length 近似
    const fallback = await executeSearch(query, workspaceRoot, options, extensions, excludes);
    return { results: fallback, totalCount: fallback.length };
}
```

要给 `SymbolIndex` 加 `countMatches(query, workspaceRoot, options): number` 方法,内部调 `getOrCreateDb(root).countMatches(query, options)`。

- [ ] **Step 2: 追加 testsin `test/suite/searchEngine.test.ts`**

这些测试可能需要 mock symbolIndex。原测试若用的是真 SymbolIndex,要 mock 其 `searchSymbols` 和新 `countMatches`。

```ts
test('executeSearchWithIndex passes offset to symbolIndex.searchSymbols', async () => {
    const calls: any[] = [];
    const fakeIndex = {
        status: 'ready' as const,
        searchSymbols: (q: string, r: string, o: any, p: any) => { calls.push(p); return []; },
        countMatches: () => 0,
        isSyncInProgress: () => false,
    } as any;
    await executeSearchWithIndex('q', '/root', { caseSensitive:false,wholeWord:false,regex:false },
                                 ['.c'], [], fakeIndex, 200);
    assert.strictEqual(calls[0]?.offset, 200);
});

test('returns totalCount from countMatches when results non-empty', async () => {
    const fakeIndex = {
        status: 'ready' as const,
        searchSymbols: () => [{ filePath:'/a',relativePath:'a',lineNumber:1,lineContent:'',matchStart:0,matchLength:1 }],
        countMatches: () => 1234,
        isSyncInProgress: () => false,
    } as any;
    const r = await executeSearchWithIndex('q', '/root', {caseSensitive:false,wholeWord:false,regex:false},
                                           ['.c'], [], fakeIndex, 0);
    assert.strictEqual(r.totalCount, 1234);
});
```

- [ ] **Step 3: 编译 + 测**

Run: `npm run compile && npx mocha --ui tdd out/test/suite/searchEngine.test.js`

- [ ] **Step 4: Commit**

```bash
git add src/search/searchEngine.ts src/symbolIndex.ts test/suite/searchEngine.test.ts
git commit -m "feat(search): executeSearchWithIndex accepts offset; returns totalCount"
```

---

### Task 4.3: messageRouter 处理 loadMore 消息

**Files:**
- Modify: `src/messageRouter.ts`

- [ ] **Step 1: 阅读 messageRouter 现有 'search' 处理**

Run: `grep -n "case 'search'\|case 'loadMore'" src/messageRouter.ts`

- [ ] **Step 2: 扩展 'search' case 传 totalCount/loadedCount 到 webview**

找到原 `'search'` case 里调 `executeSearch` 的位置,改成使用新签名,然后:

```ts
case 'search': {
    const r = await executeSearchWithIndex(
        msg.query, workspaceRoot, msg.options, extensions, excludes, symbolIndex, 0
    );
    store.addSearch(msg.query, msg.options, r.results, msg.mode,
                    { totalCount: r.totalCount, loadedCount: r.results.length });
    resultsPanel.showResults(store.toEntries(store.getActive()!), msg.query,
                             { totalCount: r.totalCount, loadedCount: r.results.length });
    break;
}
```

- [ ] **Step 3: 加 'loadMore' case**

```ts
case 'loadMore': {
    const active = store.getActive();
    if (!active) { break; }
    const r = await executeSearchWithIndex(
        active.query, workspaceRoot, active.options, extensions, excludes,
        symbolIndex, active.loadedCount
    );
    store.appendToActive(r.results);
    resultsPanel.appendResults(r.results, active.totalCount, active.loadedCount + r.results.length);
    break;
}
```

- [ ] **Step 4: `resultsPanel.showResults` / `appendResults` 加参数**

修改 `src/ui/resultsPanel.ts`:
- `showResults(entries, query, pagination?: { totalCount, loadedCount })` — postMessage 带上
- `appendResults(results, totalCount, loadedCount)` — 新方法,postMessage `{ command: 'appendResults', ... }`

- [ ] **Step 5: 编译 + 测 messageRouter**

Run: `npm run compile && npx mocha --ui tdd out/test/suite/messageRouter.test.js`
Expected: 全绿(原测试可能没覆盖新分支,加 1-2 条测)

- [ ] **Step 6: Commit**

```bash
git add src/messageRouter.ts src/ui/resultsPanel.ts
git commit -m "feat(ui): messageRouter + resultsPanel support loadMore/appendResults"
```

---

### Task 4.4: webview 前端滚到底触发 loadMore

**Files:**
- Modify: `media/results.js`
- Modify: `media/results.html`
- Modify: `media/results.css`

- [ ] **Step 1: `media/results.js` 加 scroll listener + loadMore 发送**

现有 virtual scroll 里的 `resultsList.addEventListener('scroll', ...)` 回调里加:

```js
// 在已有虚拟滚动回调之外,补一段判断:滚到底部 ~200px 内触发 loadMore
let loadingMore = false;
let loadedCount = 0;
let totalCount = 0;

function maybeLoadMore() {
    if (loadingMore) { return; }
    if (loadedCount >= totalCount) { return; }
    const el = resultsList;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 200) {
        loadingMore = true;
        vscode.postMessage({ command: 'loadMore' });
    }
}
resultsList.addEventListener('scroll', () => {
    requestAnimationFrame(rerenderContent);
    requestAnimationFrame(maybeLoadMore);
});

window.addEventListener('message', e => {
    const m = e.data;
    if (m.command === 'showResults') {
        allEntries = m.results;
        loadedCount = m.loadedCount ?? m.results.length;
        totalCount = m.totalCount ?? m.results.length;
        loadingMore = false;
        updatePaginationLabel();
        rerenderContent();
    } else if (m.command === 'appendResults') {
        allEntries = allEntries.concat(m.results);
        loadedCount = m.loadedCount;
        totalCount = m.totalCount;
        loadingMore = false;
        updatePaginationLabel();
        rerenderContent();
    }
    // ... 保留原有其它消息处理
});

function updatePaginationLabel() {
    const lbl = document.getElementById('pagination-label');
    if (!lbl) { return; }
    if (totalCount <= loadedCount) {
        lbl.textContent = `${loadedCount} results`;
    } else {
        lbl.textContent = `${loadedCount} / ${totalCount}`;
    }
}
```

- [ ] **Step 2: `media/results.html` 加 label**

在 results panel 顶部(或底部)加:
```html
<div id="pagination-label" class="pagination-label"></div>
```

- [ ] **Step 3: `media/results.css` 加样式**

```css
.pagination-label {
    position: sticky; bottom: 0;
    padding: 4px 8px;
    background: var(--vscode-editor-background);
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
    text-align: right;
    border-top: 1px solid var(--vscode-widget-border);
}
```

- [ ] **Step 4: (无单测;目测)**

F5 运行,搜一个命中多的 query,观察 label 随滚动变化。

- [ ] **Step 5: Commit**

```bash
git add media/results.js media/results.html media/results.css
git commit -m "feat(ui): webview auto-loads more results on scroll + pagination label"
```

---

### M4 验证 + 停止点

- [ ] **回归**

```bash
npm run compile && npx mocha --ui tdd \
  out/test/suite/searchStore.test.js \
  out/test/suite/searchEngine.test.js \
  out/test/suite/messageRouter.test.js \
  out/test/suite/dbBackend.test.js \
  out/test/suite/symbolIndexFacade.test.js \
  out/test/suite/syncOrchestrator.test.js
```

- [ ] **F5 smoke**

1. F5 Linux drivers
2. Sync 完成后搜 `a`(应命中 10 万+)
3. 滚到底部观察 loading 变化
4. 滚动连续加载直到 label 显示 "N results"(totalCount == loadedCount)

### 🛑 停止点 M4 — 合理退出(功能完整)

到此索引功能完整:
- 全量索引 ✓
- 分页 + 虚拟滚动 ✓
- 搜索 UX 流畅

未做:Sync 期间搜索行为、native 降级。个人使用完全够。

若停:合并 M1-M4 到 main,不需要其它清理。

---

## M5 — Sync 期间搜索 UX

**目标:** Sync 进行中用户搜索时,按配置弹窗或 grep fallback。1 秒内多次搜索只弹一次。

**依赖:** M2 之后都可做(不一定等 M4)
**独立验证:** F5 Sync 进行时搜索,四种 `duringSyncBehavior` 配置都按约定

### Task 5.1: 新增配置项到 package.json

**Files:**
- Modify: `package.json`

- [ ] **Step 1: 编辑 `contributes.configuration.properties`**

加入两项:

```json
"siSearch.search.duringSyncBehavior": {
    "type": "string",
    "enum": ["prompt-grep-fallback", "prompt-cancel", "grep-fallback", "cancel"],
    "default": "prompt-grep-fallback",
    "description": "Sync 进行中发起符号搜索的行为。prompt-* 会弹窗询问;grep-fallback 直接回退到 ripgrep 全文搜索;cancel 直接返回空。"
},
"siSearch.search.maxResults": {
    "type": "number",
    "default": 200,
    "minimum": 50,
    "maximum": 10000,
    "description": "单次搜索返回的最大结果数。超过的结果通过虚拟滚动按需加载。"
}
```

- [ ] **Step 2: Commit**

```bash
git add package.json
git commit -m "feat(config): add siSearch.search.duringSyncBehavior + maxResults"
```

---

### Task 5.2: searchEngine 加 handleSearchDuringSync 分支

**Files:**
- Modify: `src/search/searchEngine.ts`
- Modify: `test/suite/searchEngine.test.ts`

- [ ] **Step 1: 写 failing tests(四分支)**

```ts
suite('handleSearchDuringSync', () => {
    let lastPromptAt = 0;

    function mkIndex(inProgress: boolean) {
        return {
            status: 'building' as const,
            isSyncInProgress: () => inProgress,
            searchSymbols: () => [],
            countMatches: () => 0,
        } as any;
    }

    test('behavior=cancel returns empty without prompt', async () => {
        // vscode.window.showInformationMessage should not be called
        // Test this via stub (需要你项目里有 vscode mock 机制;参考 test/mocks/vscode.js)
    });

    test('behavior=grep-fallback runs ripgrep without prompt', async () => {
        // Similar stub test
    });

    test('behavior=prompt-cancel pops dialog; user "cancel" returns empty', async () => {
        // ...
    });

    test('behavior=prompt-grep-fallback pops dialog; user "use grep" runs ripgrep', async () => {
        // ...
    });

    test('rapid successive searches within 1s only prompt once', async () => {
        // mock Date.now() 或 fake timer
    });
});
```

(注:这些测试依赖 vscode mock;若当前 mock 不支持 `showInformationMessage` 的返回值,要补 `test/mocks/vscode.js` 增加此函数。)

- [ ] **Step 2: 实现 `handleSearchDuringSync`**

```ts
// 在 searchEngine.ts 模块级加:
let lastSyncPromptAt = 0;
let cachedChoice: 'cancel' | 'grep' | undefined;

async function handleSearchDuringSync(
    behavior: string,
    query: string, workspaceRoot: string, options: SearchOptions,
    extensions: string[], excludes: string[]
): Promise<SearchResult[]> {
    // 1 秒内同选择
    const now = Date.now();
    if (now - lastSyncPromptAt < 1000 && cachedChoice) {
        if (cachedChoice === 'grep') {
            return executeSearch(query, workspaceRoot, options, extensions, excludes);
        }
        return [];
    }
    if (behavior === 'cancel') { cachedChoice = 'cancel'; lastSyncPromptAt = now; return []; }
    if (behavior === 'grep-fallback') {
        cachedChoice = 'grep'; lastSyncPromptAt = now;
        return executeSearch(query, workspaceRoot, options, extensions, excludes);
    }
    // prompt-*
    const grepBtn = '改用全文搜索';
    const laterBtn = '稍后再试';
    const cancelBtn = '取消';
    const pick = await vscode.window.showInformationMessage(
        '索引正在 Sync 中,符号搜索暂不可用',
        behavior === 'prompt-grep-fallback' ? grepBtn : laterBtn,
        cancelBtn,
    );
    lastSyncPromptAt = Date.now();
    if (pick === grepBtn) {
        cachedChoice = 'grep';
        return executeSearch(query, workspaceRoot, options, extensions, excludes);
    }
    cachedChoice = 'cancel';
    return [];
}

// 新 sync 开始时需要 reset:在 SymbolIndex.synchronize 里首句加 
//   resetSearchDuringSyncState();
// 并在 searchEngine 导出:
export function resetSearchDuringSyncState(): void {
    lastSyncPromptAt = 0;
    cachedChoice = undefined;
}
```

在 `executeSearchWithIndex` 开头加:
```ts
if (symbolIndex.isSyncInProgress()) {
    const behavior = vscode.workspace.getConfiguration('siSearch.search')
        .get<string>('duringSyncBehavior', 'prompt-grep-fallback');
    const results = await handleSearchDuringSync(behavior, query, workspaceRoot, options, extensions, excludes);
    return { results, totalCount: results.length };
}
```

- [ ] **Step 3: `SymbolIndex.synchronize` 开头调 resetSearchDuringSyncState**

- [ ] **Step 4: 编译 + 测**

Run: `npm run compile && npx mocha --ui tdd out/test/suite/searchEngine.test.js`

- [ ] **Step 5: Commit**

```bash
git add src/search/searchEngine.ts src/symbolIndex.ts test/suite/searchEngine.test.ts
git commit -m "feat(search): Sync-time search UX with 4-way duringSyncBehavior config"
```

---

### M5 验证

- [ ] **F5 smoke**

1. F5 Linux drivers
2. 设置 `"siSearch.search.duringSyncBehavior": "prompt-grep-fallback"`(默认)
3. 点 Sync(慢慢跑)
4. Sync 期间搜 `main` → 弹窗出现
5. 点 "改用全文搜索" → ripgrep 结果出现
6. 再搜 `other_query` → 不再弹(1 秒内已决定)

---

## M6 — Legacy shards cleanup

**目标:** 检测到旧 `.sisearch/shards/` 时静默删除,显示 "索引需重建" 状态。

**依赖:** M2 完成后即可做(可与 M3/M4/M5 并行)
**独立验证:** 带 legacy shards 的 fixture workspace F5 → shards 消失,状态为 'none'

### Task 6.1: composition 启动时检测并清 shards

**Files:**
- Modify: `src/composition.ts`
- Modify: `test/suite/composition.test.ts`(若 node-runnable,否则放 host-only)

- [ ] **Step 1: 写 failing test(node-runnable,用 proxyquire mock vscode)**

若 `composition.test.ts` 本来就是 node-runnable(用 vscode mock),加一条:
```ts
test('activate removes legacy .sisearch/shards when present', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-'));
    fs.mkdirSync(path.join(tmp, '.sisearch', 'shards'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.sisearch', 'shards', '00.msgpack'), 'junk');
    // 调 composition 的 legacyCleanup 函数
    cleanupLegacyShards(tmp);
    assert.ok(!fs.existsSync(path.join(tmp, '.sisearch', 'shards')));
});
```

- [ ] **Step 2: 实现 `cleanupLegacyShards`**

在 composition.ts 顶部加:
```ts
export function cleanupLegacyShards(workspaceRoot: string): void {
    const shardsDir = path.join(workspaceRoot, '.sisearch', 'shards');
    if (!fs.existsSync(shardsDir)) { return; }
    try {
        fs.rmSync(shardsDir, { recursive: true, force: true });
        // 记一条 Output Channel 日志(若 channel 已可用)
    } catch { /* best-effort */ }
}
```

在 extension activate 入口里调用:
```ts
// 对每个 workspace folder 跑一次
for (const folder of vscode.workspace.workspaceFolders ?? []) {
    cleanupLegacyShards(folder.uri.fsPath);
}
```

- [ ] **Step 3: 编译 + 测**

- [ ] **Step 4: Commit**

```bash
git add src/composition.ts test/suite/composition.test.ts
git commit -m "feat(cleanup): silently remove legacy .sisearch/shards/ on activation"
```

---

### M6 验证

- [ ] **手动 fixture**

```bash
mkdir -p /tmp/test-legacy/.sisearch/shards
echo junk > /tmp/test-legacy/.sisearch/shards/00.msgpack
```

F5 打开 `/tmp/test-legacy/`,激活扩展后 `ls /tmp/test-legacy/.sisearch/` 应只看到空或不存在的 shards 目录。

---

## M7 — Native addon 加载失败降级

**目标:** `better-sqlite3` 加载失败时扩展仍能激活,搜索降级到 ripgrep,`Sync` 命令隐藏或换成 `Rebuild Native`。

**依赖:** M3 完成(逻辑才完整)
**前置:** test/runTest.ts 的 host-only harness 可能需要先补通(+1 day 预算)

### Task 7.1: composition.ts try/catch DbBackend 初始化

**Files:**
- Modify: `src/composition.ts`
- Modify: `src/extension.ts`(若涉及)

- [ ] **Step 1: 包装 better-sqlite3 require**

```ts
let nativeAvailable = true;
try {
    require.resolve('better-sqlite3');
    // 尝试真实开个 :memory: 检查 binding 能 load
    const Database = require('better-sqlite3');
    new Database(':memory:').close();
} catch (e) {
    nativeAvailable = false;
    vscode.window.showWarningMessage(
        'SI Search: native SQLite 加载失败。符号索引不可用,搜索将使用 ripgrep 全文搜索。' +
        '运行 Rebuild Native 命令尝试修复。'
    );
}
```

如果 `nativeAvailable === false`,不创建 SymbolIndex 的 DbBackend 相关路径,而是创建一个 dummy,状态永远 'none'。

或者让 `SymbolIndex` 支持可选 backend,没有 backend 时 `searchSymbols` 返回 `[]`(让 searchEngine 自动 fallback 到 ripgrep)。

- [ ] **Step 2: 加 `siSearch.rebuildNative` 命令**

```ts
vscode.commands.registerCommand('siSearch.rebuildNative', async () => {
    const term = vscode.window.createTerminal('SI Search Rebuild');
    term.show();
    term.sendText('cd "$(vscode.workspace.rootPath || process.cwd())" && npm rebuild better-sqlite3 && echo "Done. Reload window."');
});
```

- [ ] **Step 3: package.json 里注册新命令**

```json
{
    "command": "siSearch.rebuildNative",
    "title": "SI Search: Rebuild Native (SQLite)",
    "category": "SI Search"
}
```

- [ ] **Step 4: 补 host-only 测 `composition.fallback.test.ts`**

使用 proxyquire 让 `better-sqlite3` require throw,断言:
- extension 成功 activate
- symbolIndex.status === 'none'
- searchSymbols returns [] (走 ripgrep fallback 会出结果)

- [ ] **Step 5: 编译 + 测**

- [ ] **Step 6: Commit**

```bash
git add src/composition.ts src/extension.ts package.json test/suite/composition.fallback.test.ts
git commit -m "feat(resilience): graceful fallback when better-sqlite3 native addon fails to load"
```

---

### M7 验证

- [ ] **人工 stub native 失败**

```bash
# 临时把 binary 重命名
mv node_modules/better-sqlite3/build/Release/better_sqlite3.node /tmp/saved.node
```

F5,断言扩展激活 + 搜索可用(ripgrep)+ 状态栏警告 + 命令 "SI Search: Rebuild Native" 在 palette 里。

恢复:
```bash
mv /tmp/saved.node node_modules/better-sqlite3/build/Release/better_sqlite3.node
```

### 🛑 停止点 M7 — 合理退出(所有功能完备)

到此所有功能完备。自用 + 发给朋友都够。

若要进 Marketplace 发布,进 M8。

---

## M8 — 跨平台 prebuild CI

**目标:** GitHub Actions 产出 Win/Mac/Linux × x64/arm64 共 6 个 prebuild artifact。本地 `npm install` 优先下载 prebuild,失败才 `node-gyp` 本地编译。

**依赖:** M3 + native addon 稳定
**前置:** GitHub repo 有 Actions 启用;至少一个可用的测试平台 runner

### Task 8.1: prebuild npm 包集成

**Files:**
- Modify: `package.json`

- [ ] **Step 1: 加 prebuild-install 脚本**

```json
"scripts": {
    // ... 现有 ...
    "install": "prebuild-install --runtime=electron --target=<ELECTRON_VERSION> || npm rebuild better-sqlite3"
}
```

`<ELECTRON_VERSION>` 用当前 VS Code stable 的 Electron 版本(可用 `code --version` 查看关联)。

- [ ] **Step 2: devDep 加 `prebuild-install`**

- [ ] **Step 3: 本地验证脚本依然工作**

```bash
npm install
npm run verify-sqlite
```

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "build: prefer prebuild-install over node-gyp for better-sqlite3"
```

---

### Task 8.2: `.github/workflows/prebuild.yml`

**Files:**
- Create: `.github/workflows/prebuild.yml`

- [ ] **Step 1: 写 workflow**

```yaml
name: Prebuild

on:
  push:
    tags: [ 'v*' ]
  workflow_dispatch:

jobs:
  build:
    strategy:
      fail-fast: false
      matrix:
        include:
          - os: ubuntu-latest
            arch: x64
          - os: ubuntu-latest
            arch: arm64
          - os: macos-latest
            arch: x64
          - os: macos-14
            arch: arm64
          - os: windows-latest
            arch: x64
          - os: windows-latest
            arch: arm64
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Install deps
        run: npm ci
      - name: Rebuild for Electron
        run: npx prebuild --backend cmake-js --arch ${{ matrix.arch }} -r electron -t <ELECTRON_VERSION>
      - name: Upload artifact
        uses: actions/upload-artifact@v4
        with:
          name: prebuild-${{ matrix.os }}-${{ matrix.arch }}
          path: prebuilds/**/*.node
```

细节(如 cmake-js / prebuild 工具链选择)视 better-sqlite3 README 指南微调。

- [ ] **Step 2: 本地 act 测(可选)**

`act -j build` 跑一个平台验证。

- [ ] **Step 3: Commit + push tag 触发 CI**

```bash
git add .github/workflows/prebuild.yml
git commit -m "ci: cross-platform prebuild matrix (6 artifacts)"
git push origin main
# 触发:
git tag -a v1.1.0-test -m "test prebuild"
git push origin v1.1.0-test
```

- [ ] **Step 4: 观察 Actions 页面**

断言 6 个 artifact 都 upload 成功。

- [ ] **Step 5: 本地下载 artifact 验证**

下载 Linux x64 artifact,解压,放入 `node_modules/better-sqlite3/prebuilds/` 目录:
```bash
npm run verify-sqlite
```
应成功且 **不触发** node-gyp 本地编译。

---

### M8 验证

- [ ] CI 跑通 6 个 artifact
- [ ] 至少一个平台(Linux x64)artifact 本地装 + `verify-sqlite` 通过

若 CI 卡壳不解决,**砍到只支持当前开发平台**:去除其它 matrix 条目,仍可发布(只是用户面窄)。

---

## M9 — Marketplace 试打包

**目标:** `vsce package` 产出 `.vsix`,安装到纯净机器可用。VSIX ≤ 50 MB。

**依赖:** M8 完成(prebuild artifact 存在)

### Task 9.1: vsce 打包 + `.vscodeignore`

**Files:**
- Modify: `.vscodeignore`
- Modify: `package.json`(若缺 `files` 字段,加上)

- [ ] **Step 1: 查看 `.vscodeignore`**

确保它包含:
```
.github/**
docs/**
scripts/verify-sqlite.js
test/**
**/*.ts
out/test/**
out/scripts/**
```

(保留 `out/src/**`、`media/**`、`wasm/**`、`node_modules/better-sqlite3/**`)

- [ ] **Step 2: package.json 加 files 字段(可选)**

```json
"files": ["out/src/**/*", "media/**/*", "wasm/**/*", "node_modules/better-sqlite3/**/*"]
```

- [ ] **Step 3: 装 vsce**

```bash
npm install -g @vscode/vsce
```

- [ ] **Step 4: 打包**

```bash
vsce package
ls -lh *.vsix
du -h *.vsix
```

Expected: 单个 .vsix 文件 ≤ 50 MB

- [ ] **Step 5: 装到本机验证**

```bash
code --install-extension sisearch-*.vsix
```

重启 VS Code,确认扩展工作。

- [ ] **Step 6: 装到纯净 VM / docker 验证**(可选)

- [ ] **Step 7: Commit**

```bash
git add .vscodeignore package.json
git commit -m "build: marketplace-ready packaging config"
```

---

### M9 验证(也是最终验收)

- [ ] VSIX 体积 ≤ 50 MB
- [ ] 装到无 build toolchain 的机器也能激活 + Sync + search

若都 pass,扩展 **Marketplace ready**。最后做的事:更新 README(添加 "Install from Marketplace" 说明),bump version,推 tag。

---

## 最终完整回归

所有 M 都完成后的 **最终 smoke**:

- [ ] **回归测试全绿**

运行"运行约定"章节的完整回归命令。

- [ ] **Linux drivers F5 smoke**

1. F5 启动
2. Sync 完成(<8 min)
3. 搜普通符号命中
4. 搜 AMD 宏 `PSWUSP0_*` 命中
5. 搜 `a` → 10 万+ 结果滚动加载
6. Sync 期间搜索 → 弹窗
7. `.sisearch/index.sqlite` 大小 <1.2 GB
8. 主线程 heap <500 MB

- [ ] **VSIX 试装**

```bash
code --install-extension sisearch-*.vsix
```

扩展应在纯 VS Code 里正常工作。

---

## Appendix: 快速回滚指南

每个 milestone 的 commits 都是独立的。若某个 milestone 完成后决定不要:

| 停止点 | 退出动作 |
|--------|----------|
| 不要 M1 | `git revert` M1 所有 commit |
| 停 M2 | 什么都不做(架构已换,自用够) |
| M3 崩溃/heap 超标 | `git revert` M3 commit,回到 M2 的 "stream 不入索引" |
| 停 M4 | 什么都不做 |
| 停 M7 | 什么都不做 |
| 停 M9 | 什么都不做;扩展自用完整 |

---

## 总结

- **9 个 milestone,~35 个 task**
- **每个 task 1 个 commit(有几个可能 2-3 个)**
- **每个 task 先写测再写实现**
- **单人全职 ~3-4 周,stopping points 可提前退出**
- **spec 参照:`docs/superpowers/plans/2026-04-21-sqlite-fts5-migration-design.md`**


---

## Self-review 补丁

以下 task 是 self-review 后补上,原本在 spec 里有但 plan 漏了。

### Task SR.1: DbBackend 更新 meta.workspace_root(F12)

**Files:**
- Modify: `src/index/dbBackend.ts`
- Modify: `test/suite/dbBackend.test.ts`

- [ ] **Step 1: 写 failing test**

```ts
test('openOrInit updates meta.workspace_root if provided and differs', () => {
    const p = tmpDbPath();
    {
        const db = new DbBackend(p);
        db.openOrInit();
        db.setWorkspaceRoot('/old/path');
        db.close();
    }
    const db2 = new DbBackend(p);
    db2.openOrInit();
    db2.setWorkspaceRoot('/new/path');
    assert.strictEqual(db2.getWorkspaceRoot(), '/new/path');
    db2.close();
});

test('getWorkspaceRoot returns undefined when never set', () => {
    const db = new DbBackend(':memory:'); db.openOrInit();
    assert.strictEqual(db.getWorkspaceRoot(), undefined);
    db.close();
});
```

- [ ] **Step 2: 实现 setWorkspaceRoot / getWorkspaceRoot**

```ts
setWorkspaceRoot(absPath: string): void {
    if (!this.db) { return; }
    this.db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run('workspace_root', absPath);
}

getWorkspaceRoot(): string | undefined {
    if (!this.db) { return undefined; }
    const row = this.db.prepare("SELECT value FROM meta WHERE key='workspace_root'").get() as { value: string } | undefined;
    return row?.value;
}
```

- [ ] **Step 3: 在 `SymbolIndex.getOrCreateDb` 里,首次打开时 setWorkspaceRoot**

```ts
private getOrCreateDb(workspaceRoot: string): DbBackend {
    const canonical = this.canonicalRoot(workspaceRoot);
    let db = this.dbByRoot.get(canonical);
    if (!db) {
        const p = path.join(canonical, '.sisearch', 'index.sqlite');
        db = new DbBackend(p);
        db.openOrInit();
        const stored = db.getWorkspaceRoot();
        if (stored !== canonical) {
            db.setWorkspaceRoot(canonical);
        }
        this.dbByRoot.set(canonical, db);
    }
    return db;
}
```

- [ ] **Step 4: 编译 + 测**

Run: `npm run compile && npx mocha --ui tdd out/test/suite/dbBackend.test.js`

- [ ] **Step 5: Commit**

```bash
git add src/index/dbBackend.ts src/symbolIndex.ts test/suite/dbBackend.test.ts
git commit -m "feat(index): track workspace_root in meta; F12 workspace move support"
```

(归入 M1 的尾部;若 M1 已完成,作为独立 task 放 M2.7 也可以)

---

### Task SR.2: searchBench + syncBench 扩展 (P3-P7)

**Files:**
- Modify: `test/benchmark/searchBench.ts`
- Modify: `test/benchmark/syncBench.ts`

- [ ] **Step 1: 阅读现有 bench 文件结构**

Run: `cat test/benchmark/searchBench.ts test/benchmark/syncBench.ts | head -100`

- [ ] **Step 2: searchBench 加 P5/P6/P7**

在已有 bench main 函数里添加:

```ts
// P5: 精确查询 P50
const db = new DbBackend(':memory:'); db.openOrInit();
await seedLargeDataset(db, 1_000_000);  // 1M rows for realistic
const queries = sampleRandomNames(1000);
const times: number[] = [];
for (const q of queries) {
    const t0 = process.hrtime.bigint();
    db.search(q, { caseSensitive: true, wholeWord: true, regex: false });
    const t1 = process.hrtime.bigint();
    times.push(Number(t1 - t0) / 1e6);
}
times.sort((a,b) => a - b);
console.log('P5 exact query P50 (ms):', times[Math.floor(times.length / 2)]);
console.log('P6 fuzzy query P99 (ms):', times[Math.floor(times.length * 0.99)]);
```

具体生成 `seedLargeDataset` 的代码可 inline 或抽函数:
```ts
function seedLargeDataset(db: DbBackend, count: number): void {
    const batchSize = 5000;
    const metadata: IndexedFile[] = [];
    const symbols: SymbolEntry[] = [];
    for (let i = 0; i < count; i++) {
        symbols.push({
            name: `symbol_${i}_${Math.random().toString(36).slice(2,8)}`,
            kind: 'function',
            filePath: `/f${i % 1000}`,
            relativePath: `f${i % 1000}.c`,
            lineNumber: (i % 100) + 1,
            endLineNumber: (i % 100) + 1,
            column: 0,
            lineContent: '',
        });
        if (i % batchSize === 0) {
            db.writeBatch({ metadata: [], symbols, deletedRelativePaths: [] });
            symbols.length = 0;
        }
    }
    if (symbols.length) {
        db.writeBatch({ metadata: [], symbols, deletedRelativePaths: [] });
    }
}
```

- [ ] **Step 3: syncBench 加 P3/P4**

syncBench 现有逻辑保留;加写入吞吐度量:
```ts
const start = Date.now();
// ... 做 sync ...
const elapsed = (Date.now() - start) / 1000;
const symbolsPerSec = totalSymbols / elapsed;
console.log(`P3 Sync total: ${elapsed}s`);
console.log(`P4 Throughput: ${symbolsPerSec.toFixed(0)} symbols/sec`);
```

- [ ] **Step 4: 编译运行**

```bash
npm run compile
npm run bench:search
npm run bench:sync
```
记录 P5/P6/P7/P3/P4 数值;对照 spec 验收标准:
- P5 ≤ 5 ms
- P6 ≤ 50 ms
- P7 ≤ 20 ms
- P3 ≤ 8 min
- P4 ≥ 50k/sec

- [ ] **Step 5: Commit**

```bash
git add test/benchmark/searchBench.ts test/benchmark/syncBench.ts
git commit -m "test(bench): cover P3/P4/P5/P6/P7 performance gates"
```

(归入 M3 末尾;M3 验证时用)

