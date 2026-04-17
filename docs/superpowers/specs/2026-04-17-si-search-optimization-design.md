# SI Search 全面优化设计文档

> 日期: 2026-04-17
> 状态: 待实施
> 范围: Sync 性能 + 存储优化 + 代码架构 + UI 体验 + 测试覆盖

---

## 1. 背景与目标

SI Search 是一个 VS Code 扩展，为 C/C++ 开发者提供 Source Insight 风格的代码搜索。核心策略是 tree-sitter 符号索引 + ripgrep 全文搜索的两级搜索。

### 当前问题

1. **Sync 性能**：`synchronize()` 串行解析每个文件（读取 → tree-sitter 解析 → stat），10000 文件需要 2-3 分钟
2. **存储效率**：单个 `index.json` 在大项目中达 50-80MB，JSON 序列化/反序列化各需 2-5 秒
3. **UI 阻塞**：所有解析在 Extension Host 主线程执行，大量文件时卡死 VS Code
4. **代码结构**：`extension.ts`(368行) 和 `symbolIndex.ts`(344行) 职责过重
5. **测试不足**：仅 3 个测试文件，核心模块（索引、解析、存储）无测试
6. **手动触发**：文件变更后需手动触发 Sync

### 优化目标

| 指标 | 当前 | 目标 |
|------|------|------|
| 10K 文件全量 Sync | ~120s | <35s (3-4x 提升) |
| 增量 Sync（10 个变更文件） | ~2s | <200ms |
| 索引保存（10K 文件） | ~3s (JSON) | <300ms (MessagePack) |
| 索引加载 | ~3s | <300ms |
| 索引文件大小 | ~50MB | <20MB |
| UI 卡顿 | 频繁 | 无（主线程不做解析） |
| 5000+ 搜索结果渲染 | 1-3s 卡顿 | 即时（虚拟滚动） |
| 测试覆盖 | 3 个文件 | 10+ 个文件，覆盖所有核心模块 |

---

## 2. Sync 核心 — Worker 线程池并行解析

### 架构

```
主线程(调度器):    扫描文件 → 分类 → 分发批次 → 收集结果 → 更新索引 → 持久化
                          ↓           ↑
Worker池(N线程):  [Worker1: 批次1 解析] → 返回符号
                  [Worker2: 批次2 解析] → 返回符号
                  [Worker3: 批次3 解析] → 返回符号
                  [Worker4: 批次4 解析] → 返回符号
```

### 设计决策

1. **Worker 池大小**：`Math.max(1, os.cpus().length - 1)`，保留 1 核给主线程和 VS Code
2. **批次策略**：每批 50 个文件路径发给 Worker，Worker 内部串行解析
3. **Parser 复用**：每个 Worker 初始化时创建 1 个 Parser 实例，通过 `setLanguage()` 切换 C/C++，整个生命周期复用
4. **文件读取位置**：Worker 内部直接用 `fs.readFileSync` 读取（比通过主线程消息传递文件内容更高效）
5. **错误隔离**：单个 Worker 崩溃不影响其他 Worker，主线程捕获错误后重启 Worker
6. **取消支持**：主线程通过 Worker `terminate()` 支持取消

### 新文件

```
src/sync/
├── syncOrchestrator.ts   # 主线程：四阶段调度器
├── workerPool.ts         # Worker 线程池管理
├── parseWorker.ts        # Worker 入口：加载 WASM + 解析循环
└── batchClassifier.ts    # 文件分类：并发 stat + mtime 比对
```

### Worker 消息协议

```typescript
// 主线程 → Worker
type WorkerRequest =
  | { type: 'init'; wasmDir: string; extensionPath: string }
  | { type: 'parseBatch'; files: Array<{ absPath: string; relativePath: string }> }
  | { type: 'shutdown' };

// Worker → 主线程
type WorkerResponse =
  | { type: 'ready' }
  | { type: 'batchResult'; symbols: SymbolEntry[]; errors: string[] }
  | { type: 'error'; message: string };
```

---

## 3. 流式解析管道 + 后台自动 Sync

### 四阶段流水线

不再瀑布式执行（先全部扫描 → 再全部分类 → 再全部解析 → 最后保存），改为流式管道：

```
Scanner ──文件URI流──> Classifier ──变更文件流──> WorkerPool ──符号流──> Indexer
  │                      │                         │                    │
  │ findFiles分页         │ 并发stat                │ 并行解析            │ 增量更新Map
  │ 每100个yield         │ Promise.all(64)         │ 批次50文件          │ 每批写WAL
```

**Scanner 分页**：包装 `vscode.workspace.findFiles`，按目录前缀分批扫描，每批完成即推入 Classifier。

**Classifier 并发 stat**：当前逐个 `await stat()`。改为 `Promise.all` 并发 64 个 stat 请求。

**流式进度**：每批完成就更新进度条，用户能看到实时进度和预估剩余时间。

### 后台自动 Sync

```
FileWatcher.onDidChange → markDirty → 延迟5秒防抖 → 自动 syncDirty()
                                                        ↓
                                                   Worker池增量解析
                                                        ↓
                                                   更新内存索引 + WAL追加
```

**设计细节：**

- 防抖窗口 5 秒，多次文件变更合并为一次 syncDirty 调用
- 只解析 dirty 文件，不做全量扫描
- 后台静默执行，只更新状态栏图标
- 手动 Sync 命令仍保留，用于全量重建

**新增配置项：**
- `siSearch.autoSync`：是否启用自动 Sync（默认 `true`）
- `siSearch.autoSyncDelay`：防抖延迟毫秒数（默认 `5000`）

**新文件：**

```
src/sync/autoSync.ts    # 防抖自动 Sync 逻辑
```

---

## 4. 存储层 — MessagePack + WAL + 分片

### 存储结构

```
.sisearch/
├── meta.msgpack          # 索引元数据（版本、创建时间、分片信息）
├── shards/
│   ├── 00.msgpack        # 分片0: 文件路径按哈希分桶
│   ├── 01.msgpack        # 分片1
│   ├── ...
│   └── 0f.msgpack        # 分片15（共16个分片）
└── wal.msgpack           # WAL（Write-Ahead Log）增量日志
```

### 三层存储策略

**1. 分片存储（全量 Sync 后写入）**
- 16 个分片，文件路径通过 FNV-1a 哈希取模 16 决定分桶（自行实现 ~10 行，无外部依赖）
- 每个分片独立序列化/反序列化
- 只有变更过的分片需要重写
- MessagePack 格式

**2. WAL 增量日志（自动 Sync 时追加）**
- 每次 syncDirty 只追加变更记录到 WAL
- 记录类型：`update(file, symbols[])` 或 `delete(file)`
- 追加写入，无需重写整个索引

**3. 压实 Compaction**
- 当 WAL 大小超过分片总大小的 20% 时触发
- 将 WAL 记录合并入分片，清空 WAL
- 在后台 Worker 中执行

### 加载流程

```
启动 → 并行加载16个分片 → 重放 WAL → 索引就绪
```

### 向后兼容

首次升级时自动检测旧 `index.json` 格式，迁移到新格式后删除旧文件。

### 新增依赖

`@msgpack/msgpack`（官方 MessagePack for JS，~15KB gzipped，纯 JS 无 native 依赖）

### 新文件

```
src/storage/
├── storageManager.ts    # 分片读写、WAL管理、压实
├── shardStrategy.ts     # FNV-1a 分片哈希策略
└── codec.ts             # MessagePack 编解码封装
```

---

## 5. 代码架构重构

### 新模块划分

```
src/
├── extension.ts              # ~80行，纯粹的激活/注销入口
├── commands.ts               # ~100行，所有命令注册集中管理
├── messageRouter.ts          # ~80行，Sidebar/ResultsPanel 消息路由
│
├── sync/                     # Sync 子系统
│   ├── syncOrchestrator.ts   # 四阶段流式调度器
│   ├── workerPool.ts         # Worker 线程池管理
│   ├── parseWorker.ts        # Worker 入口
│   ├── batchClassifier.ts    # 并发文件分类
│   └── autoSync.ts           # 防抖自动 Sync
│
├── index/                    # 索引子系统
│   ├── symbolIndex.ts        # ~150行，纯内存索引操作
│   └── indexTypes.ts         # 索引相关类型定义
│
├── storage/                  # 存储子系统
│   ├── storageManager.ts     # 分片读写、WAL、压实
│   ├── shardStrategy.ts      # 分片哈希
│   └── codec.ts              # MessagePack 编解码
│
├── search/                   # 搜索子系统
│   ├── searchEngine.ts       # 混合搜索调度
│   ├── searchStore.ts        # 搜索状态/历史管理
│   └── navigation.ts         # 结果导航
│
├── ui/                       # UI 子系统
│   ├── sidebarProvider.ts    # 侧边栏 Webview
│   ├── resultsPanel.ts       # 结果面板
│   ├── editorDecorations.ts  # 编辑器装饰
│   ├── codeLensProvider.ts   # CodeLens
│   ├── highlightsTree.ts     # 高亮树视图
│   └── syntaxHighlight.ts    # Shiki 语法高亮
│
├── parser/                   # 解析器
│   └── symbolParser.ts       # tree-sitter WASM 封装
│
└── types.ts                  # 公共类型定义
```

### 拆分原则

- 每个目录是一个独立子系统，通过明确接口通信
- 每个文件 < 200 行，单一职责
- `extension.ts` 只做组装（依赖注入），不包含业务逻辑
- 子系统间通过事件（EventEmitter）或直接接口调用解耦

### 关键接口

```typescript
// sync/syncOrchestrator.ts
interface SyncOrchestrator {
  synchronize(options: SyncOptions, token: CancellationToken): AsyncIterable<SyncProgress>;
  cancel(): void;
}

// index/symbolIndex.ts
interface SymbolIndex {
  update(file: string, symbols: SymbolEntry[]): void;
  remove(file: string): void;
  search(query: string, options: SearchOptions): SearchResult[];
  getStats(): { files: number; symbols: number };
}

// storage/storageManager.ts
interface StorageManager {
  load(): Promise<IndexSnapshot>;
  saveFull(snapshot: IndexSnapshot): Promise<void>;
  appendWAL(entries: WALEntry[]): Promise<void>;
  compact(): Promise<void>;
}
```

---

## 6. UI 体验优化

### 6.1 搜索结果虚拟滚动

`results.js` 一次性渲染所有结果 DOM 节点。改为虚拟滚动：

- 只渲染可见区域 + 上下各 10 行缓冲，共 ~50 个 DOM 节点
- 总高度由 spacer div 撑起，transform: translateY 定位
- 滚动时通过 `requestAnimationFrame` 更新可见行
- 保留分组折叠功能

### 6.2 预览缓存

每次 hover 都重新调用 Shiki 高亮整个文件。改为：

- LRU 缓存最近 20 个文件的高亮结果
- 只高亮可见行前后各 50 行，而非整个文件

### 6.3 进度展示优化

- 状态栏实时显示：`$(sync~spin) 1,234 / 10,000 files (12%)`
- Notification 展示预计剩余时间：`Parsing... 1,234/10,000 (~45s remaining)`
- 通过已解析文件的速率计算 ETA

### 6.4 FileWatcher 防抖

- FileWatcher 内部 300ms 防抖
- 收集变更文件后批量 `markDirty()`
- 避免 git checkout 等批量操作时的大量冗余标记

---

## 7. 测试覆盖 + 性能基准

### 7.1 单元测试

| 模块 | 测试内容 | 优先级 |
|------|----------|--------|
| `index/symbolIndex.ts` | 增删改查符号、搜索三种模式、大数据集 | 高 |
| `sync/workerPool.ts` | Worker 创建/销毁、批次分发、错误恢复、取消 | 高 |
| `sync/batchClassifier.ts` | 文件分类、并发 stat | 高 |
| `storage/storageManager.ts` | 分片读写、WAL 追加/重放、压实 | 高 |
| `storage/codec.ts` | MessagePack 编解码往返 | 中 |
| `sync/autoSync.ts` | 防抖逻辑、多次触发合并 | 中 |
| `parser/symbolParser.ts` | C/C++ 各种符号类型、边界情况 | 中 |

### 7.2 性能基准测试

创建 `test/benchmark/` 目录：

1. **Sync 基准**：1000 个 fixture .c 文件，测量全量/增量 Sync 耗时
2. **搜索基准**：10 万符号索引下的精确/子串/正则搜索延迟
3. **存储基准**：MessagePack vs JSON 的序列化/反序列化/文件大小对比
4. **回归守护**：性能退化 >20% 时警告

### 7.3 测试文件结构

```
test/
├── suite/
│   ├── symbolIndex.test.ts
│   ├── workerPool.test.ts
│   ├── batchClassifier.test.ts
│   ├── storageManager.test.ts
│   ├── codec.test.ts
│   ├── autoSync.test.ts
│   ├── searchStore.test.ts       # 已有
│   ├── searchEngine.test.ts      # 已有
│   └── navigation.test.ts        # 已有
├── benchmark/
│   ├── syncBench.ts
│   ├── searchBench.ts
│   ├── storageBench.ts
│   └── fixtures/
└── runTest.ts
```

---

## 8. 新增依赖

| 包 | 用途 | 大小 |
|---|---|---|
| `@msgpack/msgpack` | MessagePack 序列化 | ~15KB gzipped |

Node.js 内置 `worker_threads` 模块，无需额外依赖。

---

## 9. 实施阶段建议

| 阶段 | 内容 | 预计工作量 |
|------|------|-----------|
| Phase 1 | 架构重构：拆分 extension.ts/symbolIndex.ts 为新模块结构 | 中 |
| Phase 2 | Worker 线程池 + Parser 复用 + 并发 stat | 大 |
| Phase 3 | 流式管道 + 后台自动 Sync | 大 |
| Phase 4 | MessagePack + 分片 + WAL 存储层 | 大 |
| Phase 5 | UI 优化：虚拟滚动 + 预览缓存 + 进度 + 防抖 | 中 |
| Phase 6 | 测试覆盖 + 性能基准 | 中 |

Phase 1 先完成，确保重构不引入回归；然后 Phase 2-4 可以并行推进（不同子系统相互独立）；Phase 5-6 收尾。

---

## 10. 风险与应对

| 风险 | 应对 |
|------|------|
| tree-sitter WASM 在 Worker 中的兼容性 | 早期验证 POC，确认 WASM 在 worker_threads 中正常工作 |
| MessagePack 索引格式不可人读 | 保留 `siSearch.clearIndex` 命令支持强制重建 |
| 分片数量选择 | 16 是经验值，可通过配置调整 |
| Worker 内存开销 | 每个 Worker ~20-30MB（WASM runtime），4 个 Worker ~100MB，可接受 |
| 向后兼容 | 首次升级自动迁移旧 index.json，迁移失败则清空重建 |
