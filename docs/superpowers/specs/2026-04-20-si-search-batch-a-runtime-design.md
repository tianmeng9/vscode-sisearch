# SI Search Batch A 运行时优化设计（P7.3 + P7.4 + P7.5）

> **背景**：本 spec 属于 R4 审计报告列出的「合入后 backlog」第一批。Batch A 聚焦运行时性能/正确性三项独立工单，可组成一个 PR 合入。
>
> **不在范围**：P7.6（ESLint/esbuild）、P7.8（多根 workspace）由 Batch B 覆盖；P7.7（ui/* 单测）、P7.9（catch → telemetry）由 Batch C 覆盖。

---

## 一、目标与非目标

### 目标
1. **P7.3**：状态栏刷新由 2 秒 `setInterval` 轮询改为 `SymbolIndex` EventEmitter 事件驱动。
2. **P7.4**：ripgrep 搜索输出由一次性 `stdout +=` 累积改为 `readline` 按行流式 parse，避免大结果集（>20MB）内存峰值。
3. **P7.5**：`getStorage()` 路径归一化追加 `fs.realpathSync`，消除 symlink workspace 双写 `.sisearch` 风险。

### 非目标
- 不改变 `executeSearch` 对外签名（保持 `Promise<SearchResult[]>`）
- 不改 `resultsPanel` / `searchStore` 增量消费语义
- 不启用 webview 增量渲染
- 不改现有 37 个非-vscode 单测语义

---

## 二、当前实现现状

| 工单 | 文件:行 | 现状 |
|---|---|---|
| P7.3 | `src/composition.ts:129` | `const statusTimer = setInterval(refreshStatus, 2000);` 每 2 秒无条件刷新 |
| P7.4 | `src/search/searchEngine.ts:21` | `proc.stdout.on('data', data => { stdout += data.toString(); })` 一次性累积大字符串 |
| P7.4 | `src/search/searchEngine.ts:89` | `stdout.split('\n')` 整块切分 |
| P7.5 | `src/symbolIndex.ts:205` | `const normalized = path.resolve(workspaceRoot);` 仅做 `..` 归一化，不解 symlink |

---

## 三、架构设计

### 3.1 P7.3 SymbolIndex 事件化

**事件粒度（已对齐）**：双事件。
- `onStatusChanged: Event<IndexStatus>` —— 低频，只在 status 状态机转换时 fire（相等性守卫）
- `onStatsChanged: Event<{files, symbols}>` —— 高频，在 loadFromDisk/synchronize/syncDirty/applyParseResult 完成后 fire

**组件关系**：

```
InMemorySymbolIndex (inner)
        │
        ▼
SymbolIndex (façade)
  ├─ _onStatusChanged: EventEmitter<IndexStatus>
  ├─ _onStatsChanged:  EventEmitter<{files, symbols}>
  ├─ private setStatus(next)       // 封装所有 this._status = X 赋值点，相等守卫
  ├─ private emitStats()            // 封装 fileMetadata/inner 变更后 fire
  └─ 公开 getter onStatusChanged / onStatsChanged 暴露 Event<T>

composition.bindWorkspace
  ├─ symbolIndex.onStatusChanged(refreshStatus)   // 订阅
  ├─ symbolIndex.onStatsChanged(refreshStatus)    // 订阅
  └─ context.subscriptions.push(disposable)       // 挂 dispose
  （删除 setInterval + clearInterval）
```

**emit 点清单**：

| 触发位置 | 事件 |
|---|---|
| `markDirty`/`markDeleted` 从 ready → stale 切换 | onStatusChanged |
| `synchronize` 入口 `_status = 'building'` | onStatusChanged |
| `synchronize` 完成 `_status = 'ready'`/`'stale'`/`'none'` | onStatusChanged |
| `synchronize` 完成后（进度归零前） | onStatsChanged |
| `syncDirty` 完成（`_status = 'ready'` 前后）| onStatusChanged + onStatsChanged |
| `loadFromDisk` 成功 | onStatusChanged + onStatsChanged |
| `clear` | onStatusChanged + onStatsChanged |
| `_setStatusForTest` | onStatusChanged（测试钩子保持行为对称）|

**相等守卫**：
```ts
private setStatus(next: IndexStatus): void {
    if (this._status === next) { return; }  // 不 fire 相等赋值
    this._status = next;
    this._onStatusChanged.fire(next);
}
```

stats fire 无需守卫（调用方已用 immer-lite 差异，retain 频率足够低）。

**初始态**：SymbolIndex 构造时 `_status='none'` 不 fire（无订阅者）。bindWorkspace 订阅后立即 `refreshStatus()` 手动同步一次当前态，随后依赖 `loadFromDisk` 的事件。

### 3.2 P7.4 ripgrep 流式 parse

**数据流**：

```
spawn(rgPath, args)
        │
        ├─ proc.stdout  ──┐
        │                  ▼
        │        readline.createInterface({ input })
        │                  │
        │                  ├─ on('line', line => { parseRgLine(line, ws, results); })
        │                  └─ on('close', () => { /* finalize */ })
        │
        ├─ proc.stderr  ──► stderr += data.toString()  (保留,量小)
        │
        └─ proc.on('close', code => {
              if (code > 1) reject
              else resolve(results)
            })
```

**为何用 readline 而非 split2 第三方库**：Node 内置 `readline` 零依赖、API 稳定、按 `\n` 切分。rg stdout 每行即一条匹配，行末必带换行符。

**竞态处理**：readline 的 `'close'` 事件保证在所有 `'line'` 事件之后触发。但 Promise resolve 点锁定在 `proc.on('close')`（进程级关闭），readline 内部保证 line flush 完成前 stdout 不会结束。双保险设计。

**parseRgLine 纯函数签名**：

```ts
export function parseRgLine(
    line: string,
    workspaceRoot: string,
    out: SearchResult[]
): void {
    if (!line.trim()) { return; }
    const match = line.match(/^(.+?):(\d+):(\d+):(.*)$/);
    if (!match) { return; }
    const [, rawPath, lineStr, colStr, content] = match;
    const relativePath = rawPath.replace(/^\.[\\/]/, '');
    const filePath = path.resolve(workspaceRoot, relativePath);
    out.push({
        filePath,
        relativePath,
        lineNumber: parseInt(lineStr, 10),
        lineContent: content,
        matchStart: parseInt(colStr, 10) - 1,
        matchLength: 0,
    });
}
```

抽为纯函数使 parse 逻辑可在无 spawn 下单测。

### 3.3 P7.5 symlink realpath 归一化

**降级策略（已对齐）**：realpath 失败静默回退 path.resolve 结果。

**实现**：

```ts
private getStorage(workspaceRoot: string): StorageManager {
    const resolved = path.resolve(workspaceRoot);
    let normalized = resolved;
    try {
        normalized = fs.realpathSync(resolved);
    } catch {
        // symlink 未解析(ENOENT/EACCES/not-a-symlink),使用 path.resolve 结果
    }
    let storage = this.storageByRoot.get(normalized);
    if (!storage) {
        storage = new StorageManager({ workspaceRoot: normalized, shardCount: this.shardCount });
        this.storageByRoot.set(normalized, storage);
    }
    return storage;
}
```

`clearDisk` 同样追加 realpath 降级：

```ts
clearDisk(workspaceRoot: string): void {
    const resolved = path.resolve(workspaceRoot);
    let normalized = resolved;
    try { normalized = fs.realpathSync(resolved); } catch { /* fallback */ }
    const indexDir = path.join(normalized, '.sisearch');
    try { fs.rmSync(indexDir, { recursive: true, force: true }); } catch { /* ignore */ }
    this.storageByRoot.delete(normalized);
}
```

**为何用 sync 版本**：
- `getStorage` 是同步方法，入链已有大量同步调用方
- realpath 只在 per-workspace-root 首次命中时执行（记忆化后不重复）
- 不在热路径（搜索、渲染）

---

## 四、组件接口

### SymbolIndex 新增公开 API

```ts
class SymbolIndex {
    private readonly _onStatusChanged = new vscode.EventEmitter<IndexStatus>();
    private readonly _onStatsChanged = new vscode.EventEmitter<{files: number; symbols: number}>();

    get onStatusChanged(): vscode.Event<IndexStatus> { return this._onStatusChanged.event; }
    get onStatsChanged(): vscode.Event<{files: number; symbols: number}> { return this._onStatsChanged.event; }

    dispose(): void {
        this._onStatusChanged.dispose();
        this._onStatsChanged.dispose();
    }
}
```

### composition.bindWorkspace 改动

```ts
// 删
const statusTimer = setInterval(refreshStatus, 2000);
context.subscriptions.push({ dispose: () => clearInterval(statusTimer) });

// 加
context.subscriptions.push(symbolIndex.onStatusChanged(() => refreshStatus()));
context.subscriptions.push(symbolIndex.onStatsChanged(() => refreshStatus()));
// loadFromDisk 已有回调手动 refreshStatus(),保留
```

### searchEngine 内部改动

```ts
// 删
let stdout = '';
proc.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });

// 加
const rl = readline.createInterface({ input: proc.stdout });
const results: SearchResult[] = [];
rl.on('line', line => parseRgLine(line, workspaceRoot, results));

// proc.on('close', ...) 里直接 resolve(results),不再 parseRgOutput(stdout)
```

`parseRgOutput` 函数删除（被 readline+parseRgLine 替代）。

---

## 五、测试计划

### 新增测试

| 文件 | 测试 | 断言 |
|---|---|---|
| `test/suite/symbolIndexFacade.test.ts` | `onStatusChanged fires once per transition, not on equal assignments` | markDirty→ready→stale 触发 1 次，重复相同 status 赋值 0 次 |
| 同上 | `onStatsChanged fires after loadFromDisk` | 监听后预置持久化数据 loadFromDisk，listener 收到 1 次非零 stats |
| 同上 | `onStatsChanged fires after clear` | stats === {files:0, symbols:0} |
| 同上 | `getStorage follows symlink to real path` | 真目录 + symlink 两条路径 loadFromDisk → `_getStorageCountForTest() === 1` |
| 同上 | `getStorage falls back to path.resolve when realpath fails` | 传入不存在路径（ENOENT），count 仍正确 |
| `test/suite/searchEngineParsing.test.ts`（新）| `parseRgLine parses standard rg output` | 一行 `./a.c:12:4:int x;` → 正确 SearchResult |
| 同上 | `parseRgLine skips empty lines` | 空行不 push |
| 同上 | `parseRgLine skips malformed lines` | 无冒号行不 push |
| 同上 | `parseRgLine strips ./ prefix` | 相对路径前缀去除 |

### 不变性验证
- 37/37 现有非-vscode 单测保持绿
- TypeScript `tsc --noEmit` 零错误

---

## 六、风险与缓解

| 风险 | 缓解 |
|---|---|
| EventEmitter 未 dispose 导致内存泄漏 | `context.subscriptions.push(emitter disposable)` + SymbolIndex 新增 dispose() |
| 事件风暴（每次 syncDirty 多次 emit）| onStatusChanged 用相等守卫；onStatsChanged 只在最外层 synchronize/syncDirty/applyParseResult 末尾 fire，不在内循环 |
| readline 在进程早退场景下丢 line | proc.on('close') 在 readline close 后触发，readline 已在 close 前 flush 所有 line |
| realpath 在 Windows junction point 行为差异 | Node fs.realpathSync 对 Windows junction 已做标准化；极端情况降级路径仍可用 |
| symlink 循环链 | fs.realpathSync 抛 ELOOP，被 catch 接住，降级到 path.resolve |

---

## 七、验收清单

| 项 | 通过标准 |
|---|---|
| 编译 | `npx tsc --noEmit` 零错误 |
| 单测 | 原 37 全绿 + 新 ~9 全绿 = 46 全绿 |
| grep 验证 | `grep -n 'setInterval' src/composition.ts` 空 |
| grep 验证 | `grep -n 'stdout +=' src/search/searchEngine.ts` 空 |
| grep 验证 | `grep -n 'fs.realpathSync' src/symbolIndex.ts` 至少 2 处（getStorage + clearDisk）|
| Commit 结构 | 3 个 commit：`feat(p7.3): ...` / `feat(p7.4): ...` / `feat(p7.5): ...` |
| 下游影响 | `executeSearch` 签名未变，messageRouter.ts 0 改动 |

---

## 八、Commit 分组规划

**Commit 1 (P7.3)**：
- src/symbolIndex.ts 加事件
- src/composition.ts 订阅事件、删 setInterval
- test/suite/symbolIndexFacade.test.ts 加 3 个事件测试

**Commit 2 (P7.4)**：
- src/search/searchEngine.ts readline + parseRgLine
- test/suite/searchEngineParsing.test.ts 新建 4 个 parse 测试

**Commit 3 (P7.5)**：
- src/symbolIndex.ts getStorage/clearDisk 加 realpath 降级
- test/suite/symbolIndexFacade.test.ts 加 2 个 symlink 测试

---

## 九、完成定义（Definition of Done）

本 Batch A 完成的标志：
1. 三个 commit 按规划合入
2. 所有验收清单通过
3. R4 提到的三项 backlog（P7.3/P7.4/P7.5）状态转为 ✅ 关闭
4. 下一批次（Batch B：P7.6+P7.8）可开始独立 brainstorm
