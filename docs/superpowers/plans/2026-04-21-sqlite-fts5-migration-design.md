# SQLite FTS5 索引后端迁移 — Design Spec

> **Status:** Draft — awaiting user review
> **Date:** 2026-04-21
> **Scope:** Level 3 架构级重构,把 si-search 的"In-memory index + msgpack shards"替换为 better-sqlite3 FTS5 磁盘后端
> **Previous work:** Phase 4/5A-5H(docs/superpowers/plans/2026-04-20-streaming-shard-write-plan.md 的延续)已修复崩溃 + trade-off "1 MB+ 不入索引"。本 spec 的目标是去掉这个 trade-off。

---

## 目标 / Non-goals

### 目标
1. **消除主线程 JS 堆瓶颈**:把索引从内存搬到磁盘 SQLite,让扩展能吃下 Linux kernel 规模(70k 文件 / ~17.5M 符号)
2. **全量符号可搜**(SI 风格):回滚 Phase 5H 的"stream 路径符号不入索引",AMD GPU 寄存器头的宏都能搜到
3. **搜索分页 / 虚拟滚动**:10k+ 结果能流畅加载
4. **Sync 并发策略**:Sync 期间搜索有明确 UX(弹窗 + 配置)
5. **面向 Marketplace 发布**:跨平台 prebuild CI 落地

### Non-goals(首版明确不做)
- 搜索结果按 bm25 相关度排序(FTS5 支持,但首版保持 `ORDER BY file, line`)
- 跨 workspace 符号联邦搜索
- 索引跨 Git 分支感知
- LSP / cpptools 集成
- trigram tokenizer 作为 opt-in(首版只用 unicode61)
- 多窗口并发 Sync 冲突处理(首版接受报错)
- Schema 跨版本迁移(首版没有存量用户,直接重建)

---

## 已对齐的设计决策

| # | 决策 | 选项 |
|---|------|------|
| 1 | SQLite 绑定 | **better-sqlite3**(native addon) |
| 2 | 索引范围 | **全量**(SI 风格),Phase 5H 回滚 |
| 3 | 并发模型 | 主线程统一 DB 句柄;worker 只返回 symbols |
| 4 | 目标规模 | Linux kernel 70k 文件 / ~17.5M 符号 |
| 5 | 部署 | Marketplace 跨平台 prebuild (Win/macOS/Linux × x64/arm64) |
| 6 | 搜索 UX | 10k+ 分页 + 虚拟滚动 |
| 7 | 向后兼容 | 不需要;旧 shards 静默删除 |
| 8 | 启动行为 | 不自动 Sync,仅打开 DB + 读 meta |
| 9 | Worker→DB 数据流 | **B1 Batch 事务**(onBatchResult 内 `db.transaction()`) |
| 10 | Sync 中搜索 | 弹窗 + 配置(`prompt-grep-fallback`/`prompt-cancel`/`grep-fallback`/`cancel`) |
| 11 | 旧 shards 处理 | **静默删除**,UI 显示"索引需重建" |
| 12 | FTS5 tokenizer | **unicode61**(词级,默认) |

---

## 架构 Before → After

### Before(当前)

```
┌─────────── VS Code Extension Host (V8 JS heap) ────────────┐
│  SymbolIndex (façade)                                       │
│    ├── InMemorySymbolIndex                                  │
│    │     ├── symbolsByFile: Map<file, SymbolEntry[]>        │
│    │     └── nameIndex:     Map<name, SymbolEntry[]>        │
│    └── StorageManager                                       │
│          ├── saveFull/saveDirty → .sisearch/shards/*.msgpack│
│          └── load → decodeMessagePackMulti → Maps           │
│  SyncOrchestrator                                           │
│    └── onBatchResult(batch):                                │
│          inner.update(file, symbols)  ← 全量累积到 JS 堆    │
└─────────────────────────────────────────────────────────────┘
```

**痛点**:JS 堆容量上限 ~2-4 GB;Linux drivers 级别数据集会 OOM(Phase 5A-5H 实证)。

### After(目标)

```
┌──────────── VS Code Extension Host ─────────────────────────┐
│  SymbolIndex (façade)                                       │
│    └── DbBackend                                            │
│          ├── better-sqlite3 handle: .sisearch/index.sqlite │
│          ├── preparedStmts: insertSymbol, upsertFile, ...  │
│          └── (optional) LRU<fileId, lineContent[]>          │
│  SyncOrchestrator                                           │
│    └── onBatchResult(batch):                                │
│          db.transaction(() => {                             │
│             for (s in symbols) insertSymbol.run(s);         │
│             for (f in metadata) upsertFile.run(f);          │
│          })()                                               │
│  SearchEngine                                               │
│    └── query:                                               │
│          if syncGuard.isInProgress:                         │
│             prompt → cancel | grep-fallback                │
│          else:                                              │
│             FTS5 query with pagination                      │
└─────────────────────────────────────────────────────────────┘

┌──────────── Worker Threads (不变) ──────────────────────────┐
│  parseWorker × 8                                            │
│    └── batchResult{ symbols, metadata, errors }            │
└─────────────────────────────────────────────────────────────┘
```

### 变动清单

**删除:**
- `src/index/symbolIndex.ts`(InMemorySymbolIndex)
- `src/storage/storageManager.ts`(整个文件,legacy shards 不读取直接删除)
- `src/storage/shardStreamWriter.ts`
- `src/storage/codec.ts`(msgpack encode/decode 不再使用)
- `.sisearch/shards/` 目录(用户首次运行新版时静默清)

**新增:**
- `src/index/dbBackend.ts`(唯一 DB 入口)
- 依赖 **新增** `better-sqlite3` + `@types/better-sqlite3`;**删除** `@msgpack/msgpack`(随 codec.ts 一起退役)
- 配置 `siSearch.search.duringSyncBehavior`、`siSearch.search.maxResults`
- `.github/workflows/prebuild.yml`(M8)
- 测试:`dbBackend.test.ts`、`dbBackend.integrity.test.ts`、`dbBackend.integration.test.ts`、`composition.fallback.test.ts`

**改动:**
- `src/symbolIndex.ts` façade:内部换 DbBackend,公开 API **全部保持不变**
- `src/sync/syncOrchestrator.ts`:deps 从 `index + storage + getSnapshot` 合并为 `db`
- `src/sync/parseWorker.ts`:Phase 5H 回滚 — stream 路径 onSymbol push 回 symbols
- `src/search/searchEngine.ts`:加 `handleSearchDuringSync` 分支 + pagination 参数
- `src/search/searchStore.ts`:data model 加 `loadedCount` / `totalCount`
- `media/results.js`:支持 `loadMore` 消息 + 滚动触发

**保持不变:**
- `SearchResult` / `SearchOptions` 字段
- `ParseBatchResult` / Worker IPC 协议
- `WorkerPool.parse` 签名
- `SyncProgress` / `IndexStatus` 枚举
- `IndexedFile` / `SymbolEntry` 类型定义
- 虚拟滚动 DOM 层(现有 `media/results.js` 的 rerenderContent)

---

## 数据模型

### Schema(完整 DDL)

```sql
-- 1. Meta 表
CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
-- 预置:
--   schema_version = '1'
--   created_at     = unix timestamp ms
--   workspace_root = 绝对路径
--   tokenizer      = 'unicode61'

-- 2. files 表(规范化路径)
CREATE TABLE files (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    relative_path  TEXT NOT NULL UNIQUE,
    mtime_ms       INTEGER NOT NULL,
    size_bytes     INTEGER NOT NULL,
    symbol_count   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_files_relative ON files(relative_path);

-- 3. FTS5 倒排索引(contentless 节省空间)
CREATE VIRTUAL TABLE symbols_fts USING fts5(
    name,
    tokenize='unicode61 remove_diacritics 2',
    content=''
);

-- 4. symbols 本体
CREATE TABLE symbols (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL,
    kind         INTEGER NOT NULL,     -- enum int (function=0, class=1, ...)
    file_id      INTEGER NOT NULL,
    line_number  INTEGER NOT NULL,
    column       INTEGER NOT NULL,
    FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
);
CREATE INDEX idx_symbols_file_id ON symbols(file_id);
CREATE INDEX idx_symbols_name    ON symbols(name);

-- 5. 同步 FTS5 的 triggers
CREATE TRIGGER symbols_fts_insert AFTER INSERT ON symbols BEGIN
    INSERT INTO symbols_fts(rowid, name) VALUES (NEW.id, NEW.name);
END;
CREATE TRIGGER symbols_fts_delete AFTER DELETE ON symbols BEGIN
    -- contentless FTS5 要用特殊 INSERT 语法删除倒排项,不能用 DELETE FROM
    INSERT INTO symbols_fts(symbols_fts, rowid, name) VALUES ('delete', OLD.id, OLD.name);
END;
```

### Pragmas

```sql
PRAGMA journal_mode = WAL;        -- crash-safe + 读不阻塞写
PRAGMA synchronous = NORMAL;      -- WAL 下 NORMAL 已安全,比 FULL 快 3x
PRAGMA cache_size = -65536;       -- 64 MB cache(负值 = KB,正值 = pages)
PRAGMA temp_store = MEMORY;       -- 临时表放内存,加速大查询
PRAGMA foreign_keys = ON;         -- 启用 ON DELETE CASCADE
```

### Kind 枚举映射

```ts
export const SYMBOL_KIND_ID: Record<SymbolKind, number> = {
    function: 0, class: 1, struct: 2, enum: 3, typedef: 4,
    namespace: 5, macro: 6, variable: 7, union: 8,
};
// reverse map for reads
export const SYMBOL_KIND_NAME: SymbolKind[] = [
    'function', 'class', 'struct', 'enum', 'typedef',
    'namespace', 'macro', 'variable', 'union',
];
```

### 存储占用预估(17.5M 符号)

| 组件 | 大小 |
|------|------|
| files 表 + 索引 | ~6 MB |
| symbols 表 + 两索引 | ~700 MB |
| symbols_fts (contentless) | ~250 MB |
| WAL peak(Sync 中) | ~50-100 MB |
| **总计** | **~1 GB** |

### lineContent 不存储

SI 式设计:索引里只存 `file_id + line_number`,搜索命中时按需从源文件读行。
- 可选 LRU cache `Map<number, string[]>`,key=fileId,value=该文件所有行(按需 lazy 读),bounded ~100 个文件
- 节省 ~1.5 GB 存储
- 首次展示结果多一次 `fs.read` (~100 µs/行,用户无感)

---

## 接口契约(before / after)

### SymbolIndex 公开 API

**全部保持签名不变**,上游(commands、messageRouter、searchEngine)零改动。

```ts
class SymbolIndex {
    constructor(deps: SymbolIndexDeps = {});
    get status(): IndexStatus;
    searchSymbols(query, root, options, pagination?): SearchResult[];
    //                              ^^^^^^^^^^^^ 新增可选参数,不传默认 limit=200,offset=0
    synchronize(...): Promise<void>;
    syncDirty(workspaceRoot): Promise<void>;
    saveToDisk(workspaceRoot): Promise<void>;   // 变成 no-op(每事务已落盘)
    loadFromDisk(workspaceRoot): Promise<boolean>;  // 变成 openDb + 读 meta
    clear(): void;
    clearDisk(workspaceRoot): void;
    getStats(): { files: number; symbols: number };
    markDirty(path): void;
    markDeleted(path): void;
    // 新增
    isSyncInProgress(): boolean;
}

interface SymbolIndexDeps {
    workerPool?: WorkerPool;
    shardCount?: number;           // 保留未使用(兼容旧测试)
    dbPath?: string;               // 新增:测试用 ':memory:'
}
```

### DbBackend(新,`src/index/dbBackend.ts`)

```ts
interface SearchPagination {
    limit: number;    // default 200
    offset: number;   // default 0
}

class DbBackend {
    constructor(dbPath: string);

    // 生命周期
    openOrInit(): void;
    close(): void;
    checkpoint(): void;                 // PRAGMA wal_checkpoint(TRUNCATE)

    // 写入
    writeBatch(batch: {
        metadata: IndexedFile[];
        symbols: SymbolEntry[];
        deletedRelativePaths: string[];
    }): void;

    // 查询
    search(query, options, pagination?): SearchResult[];
    countMatches(query, options): number;
    getStats(): { files: number; symbols: number };
    getFileMetadata(relativePath): IndexedFile | undefined;
    getAllFileMetadata(): Map<string, IndexedFile>;  // classifier 用

    // 运维
    clearAll(): void;
    getSchemaVersion(): number;
    getWorkspaceRoot(): string | undefined;
}
```

**没有 `snapshot()` / `replaceAll()`** —— SQLite 下每次事务即持久化,snapshot 概念消失。

### SyncOrchestrator deps(改)

```diff
 interface SyncOrchestratorDeps {
     scanFiles: (root) => Promise<FileCandidate[]>;
     classify:  (args) => Promise<ClassifyResult>;
     workerPool: WorkerPool;
-    index: {
-        update(file, symbols): void;
-        remove(file): void;
-        applyMetadata(metadata): void;
-        fileMetadata: Map<string, IndexedFile>;
-    };
-    storage: {
-        saveFull(snapshot): Promise<void>;
-        saveDirty?(snapshot, dirty): Promise<void>;
-    };
-    getSnapshot: () => IndexSnapshot;
+    db: DbBackend;
     onProgress?: (p: SyncProgress) => void;
 }
```

`onBatchResult` 改:
```ts
async (batch) => {
    this.deps.db.writeBatch({
        metadata: batch.metadata,
        symbols: batch.symbols,
        deletedRelativePaths: pendingDeletes.splice(0),
    });
},
```

Sync 尾部去掉 `saveFull/saveDirty` 调用,改 `this.deps.db.checkpoint()`。

### SearchEngine 改

```ts
async function executeSearchWithIndex(
    query, root, options, extensions, excludes, symbolIndex, context
): Promise<SearchResult[]> {
    if (symbolIndex.isSyncInProgress()) {
        const behavior = vscode.workspace.getConfiguration('siSearch.search')
            .get('duringSyncBehavior', 'prompt-grep-fallback');
        return handleSearchDuringSync(behavior, query, root, options, ...);
    }
    if (symbolIndex.status === 'ready' || symbolIndex.status === 'stale') {
        const results = symbolIndex.searchSymbols(query, root, options);
        if (results.length > 0) return results;
    }
    return executeSearch(query, root, options, extensions, excludes);
}
```

### parseWorker Phase 5H 回滚

```diff
 onSymbol: (entry) => {
-    streamedCount++;       // Phase 5H: 只计数不收集
+    symbols.push(entry);   // Phase 5D: 回到流式收集
+    streamedCount++;
 },
```

### 新配置项

```jsonc
"siSearch.search.duringSyncBehavior": {
    "type": "string",
    "enum": ["prompt-grep-fallback", "prompt-cancel", "grep-fallback", "cancel"],
    "default": "prompt-grep-fallback",
    "description": "Sync 进行中搜索时的行为。prompt-* 会弹窗询问;grep-fallback 回退到 ripgrep;cancel 直接返回空。"
},
"siSearch.search.maxResults": {
    "type": "number",
    "default": 200,
    "minimum": 50,
    "maximum": 10000,
    "description": "单次搜索返回的最大结果数。超过的结果通过虚拟滚动按需加载。"
}
```

### Webview 分页协议

```ts
// 新消息
{ command: 'loadMore', query: string, options: SearchOptions, offset: number }
// ↓
{ command: 'appendResults', results: SearchResult[], totalCount: number, loadedCount: number }
```

---

## 边界情况 & 错误处理

| # | 场景 | 处理 |
|---|------|------|
| 4.1 | 首次启动,DB 不存在 | `openOrInit` 创建文件 + DDL + 预置 meta;状态 `'none'`,不自动 Sync |
| 4.2 | schema 版本不匹配 | 版本高于代码 = 拒绝打开 + 弹窗;版本低 = 静默重建 |
| 4.3 | DB 损坏(quick_check 失败) | 保留为 `.sisearch/index.sqlite.corrupt-<ts>` + 重建 + 状态 'none' |
| 4.4 | 磁盘满(SQLITE_FULL) | 事务 rollback;UI 弹错误;已 commit 部分仍可查 |
| 4.5 | 进程被强杀 | WAL 自动处理,重开 DB 时自动 checkpoint |
| 4.6 | 多窗口同时 Sync | **首版不特别处理**;SQLite BUSY timeout 后报错给用户 |
| 4.7 | Sync 期间搜索 | 按 `duringSyncBehavior` 配置;1 秒内只弹一次 |
| 4.8 | 查询含 FTS5 特殊字符 | 非 regex 模式统一用 `"..."` 字面量引号 escape |
| 4.9 | Regex 搜索 | 提取字面 token 做 FTS5 粗过滤 + JS `RegExp.test()` 精过滤;纯通配 regex 扫 10k 行截断 |
| 4.10 | 符号名含换行/超长 | 清洗 `\r\n` → 空格;截 1024 字符;不拒入库 |
| 4.11 | 用户手动 rm -rf .sisearch | Sync 开始时 `SELECT 1 FROM meta` health-check,失败走 4.3 恢复 |
| 4.12 | 文件路径含特殊字符 | UTF-8 入库;路径分隔符 normalize 为 `/` |
| 4.13 | Workspace 被移动 | `meta.workspace_root` 不匹配时自动更新,不重建 |
| 4.14 | native addon 加载失败 | activate try/catch;状态栏警告;搜索降级到 ripgrep;隐藏 Sync 命令 |
| 4.15 | Sync 中途 cancel | 已写 batch 保留;状态设 `'stale'`;下次 Sync 由 classifier 接续 |
| 4.16 | 进度显示 | 保留 onProgress 接口,加 ETA 字段(EMA 估算) |
| 4.17 | 写后立刻查 | better-sqlite3 同步 API + 事务 commit 立即 durable,无此问题 |

### 明确不支持

- 多窗口并发 Sync
- 跨版本 schema 迁移
- NFS / 网络盘
- 符号名 > 1024 字符
- regex 命中 > 10000 结果

---

## 成功标准

### Functional(F1-F12,全部必过)

| # | 验收 |
|---|------|
| F1 | 空仓库 Sync 成功,索引为空 |
| F2 | 100 文件 fixture Sync + 精确查命中 |
| F3 | AMD 寄存器宏可搜(`PSWUSP0_*` 能命中) |
| F4 | 单文件修改后只处理该文件 |
| F5 | 文件删除后符号消失(ON DELETE CASCADE) |
| F6 | 搜索语义一致(FTS5 结果 ⊇ 旧 InMemory,100 条 golden 查询) |
| F7 | 10k+ 结果能分页滚动加载 |
| F8 | `duringSyncBehavior` 四个值都按约定响应 |
| F9 | 旧 shards 目录自动清理 |
| F10 | native addon 加载失败扩展仍激活,搜索走 ripgrep |
| F11 | 损坏 DB 自动 quarantine + 重建 |
| F12 | Workspace 移动后索引可用 |

### Performance(基准 Linux drivers + 模拟 Linux kernel)

| # | 指标 | 目标 |
|---|------|------|
| P1 | 空 DB 打开延迟 | ≤ 50 ms |
| P2 | 扩展激活(有索引) | ≤ 200 ms |
| P3 | Linux drivers Sync 总时长 | ≤ 8 min |
| P4 | 写入吞吐 | ≥ 50k symbols/sec |
| P5 | FTS5 精确查询 P50 | ≤ 5 ms |
| P6 | FTS5 模糊查询 P99(17.5M 符号) | ≤ 50 ms |
| P7 | 分页 LIMIT 200 OFFSET 10000 | ≤ 20 ms |
| P8 | 主线程堆峰值(整个 Sync) | **≤ 500 MB** |
| P9 | 磁盘占用(17.5M 符号) | ≤ 1.2 GB |
| P10 | WAL 文件稳态 | ≤ 100 MB |

### Quality Gate

| # | 标准 |
|---|------|
| Q1 | 单元测试通过;`dbBackend.ts` 覆盖 ≥ 85%,`syncOrchestrator.ts` ≥ 80% |
| Q2 | `@vscode/test-electron` host-only 测试通过;当前 `test/runTest.ts` 只支持 node-runnable,M7 前需要先接通 electron test 驱动 |
| Q3 | `npm run compile` 零 TS error/warning |
| Q4 | 跳过(暂无 lint 配置) |
| Q5 | `npm install && npm rebuild` 本地能通 |
| Q6 | CI prebuild matrix 产出 6 个 artifact(M8) |
| Q7 | VSIX 大小 ≤ 50 MB |
| Q8 | 手动 smoke:F5 Linux drivers 跑通 + 搜 AMD 宏命中 |

### 测试矩阵

| 测试文件 | 动作 |
|----------|------|
| `dbBackend.test.ts` | **新建** |
| `dbBackend.integrity.test.ts` | **新建** |
| `dbBackend.integration.test.ts`(host-only) | **新建** |
| `syncOrchestrator.test.ts` | 重写 deps 部分 |
| `symbolIndex.test.ts`(inner) | **删除** |
| `symbolIndexFacade.test.ts` | 改 mock |
| `storageManager.test.ts` | **删除** |
| `shardStreamWriter.test.ts` | **删除** |
| `codec.test.ts` | **删除**(msgpack codec 随 StorageManager 一起移除) |
| `searchEngine.test.ts` | 加 Sync-during-search 测 |
| `composition.fallback.test.ts`(host-only) | **新建** |
| `searchBench.ts` | 扩(P5/P6/P7) |
| `syncBench.ts` | 扩(P3/P4) |
| `dbBench.ts` | **新建**(P1) |
| `heapSampler.ts` | **新建**(P8 工具) |

---

## Rollout(分阶段 milestones)

### 依赖图

```
M1 DbBackend 独立
  ↓
M2 Orchestrator 切换        (M6 legacy cleanup 可并行)
  ↓
M3 Phase 5H 回滚 + 全量    ← 风险最高,留 1-2 天观察期
  ↓
M4 分页 UI ←────→ M5 Sync-time search UX
  ↓                ↓
       M7 native fallback
  ↓
M8 prebuild CI
  ↓
M9 Marketplace 试打包
```

### 每个 milestone 交付

| M | Scope | 独立验证 |
|---|-------|----------|
| M1 | `dbBackend.ts` + 完整单测 | `npm test` dbBackend 全绿;REPL 手动验证 |
| M2 | façade + orchestrator 切换;删除 InMemorySymbolIndex | 小 fixture F5 Sync + search |
| M3 | parseWorker 回滚 Phase 5H;stream symbols 写入 DB | Linux drivers F5;搜 AMD 宏命中;heap < 500MB |
| M4 | pagination + 虚拟滚动 loadMore | F5 搜 `a*`(10 万条)滚动加载 |
| M5 | duringSyncBehavior 配置 + 弹窗 | F5 Sync 中搜索,弹窗 + 4 分支 |
| M6 | composition.ts 检测 + 清理 legacy shards | 预置 shards 的 fixture F5 |
| M7 | native addon 加载失败降级 | stub throw 后 F5 |
| M8 | `.github/workflows/prebuild.yml` | Push PR,6 个 artifact 产出 |
| M9 | VSIX 打包 + 安装验证 | VM 中 install-extension 成功 |

### 合理停止点

- **停在 M2**:架构已换完,只是 AMD 宏仍搜不到
- **停在 M4**:功能完整,只差 Sync 期间 UX 和 native 降级
- **停在 M7**:所有功能完整,自用足够
- **完整 M9**:发布 ready

### 估算

- 全职 1 人 ~3-4 周
- M3 风险最高,留 1-2 天 stress test 观察期
- M8 CI 第一次配估 2-3 天
- **关键里程碑**:第 1 周末 M1-M2 完成;第 2 周末 M3-M4;第 3 周末 M5-M7;第 4 周 M8-M9 + buffer

### v2 Follow-up(明确推后)

1. bm25 相关度排序
2. 多窗口 lock 文件
3. Git 分支切换时的索引感知
4. macOS codesign 自动化
5. 从 `c_cpp_properties.json` 继承 includePaths
6. trigram tokenizer opt-in
7. LSP 集成

---

## 风险总结

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| better-sqlite3 prebuild 难配 | 中 | 高 | 先验证 M1 本地 rebuild 工作;M8 留 buffer |
| M3 全量索引时写入吞吐不够 | 中 | 中 | batch size 调优;WAL checkpoint 频率;可逃生到"仍不索引寄存器宏"保底 |
| Heap sampler 实现(P8 验收) | 低 | 中 | 1 天预算单独写 |
| host-only test harness 补全 | 中 | 中 | M7 时一并补;预算 +1 天 |
| CI prebuild matrix 初配 | 高 | 中 | M8 本就留 3-5 天;必要时砍到只支持一个平台 |
| FTS5 语法边界 bug | 低 | 低 | fuzz test 覆盖 escape 路径 |

---

## References

- 前序修复记录:`docs/superpowers/plans/2026-04-20-streaming-shard-write-plan.md`(已实施,Phase 4/5A-5H)
- Source Insight 架构分析:本 spec 的"B+ tree on disk + LRU cache"思路参考
- better-sqlite3:<https://github.com/WiseLibs/better-sqlite3>
- SQLite FTS5 文档:<https://sqlite.org/fts5.html>

## Review 记录

- **2026-04-21 self-review**:
  - Placeholder scan:1 处 "待补" 已改为明确的前置条件描述
  - Consistency:StorageManager / codec.ts / msgpack 删除范围统一,测试矩阵同步
  - Scope:9 个 milestone + 数据模型 + 接口契约共享,**不拆分** spec
  - Ambiguity:无
