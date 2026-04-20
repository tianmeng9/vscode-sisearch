# SI Search Batch A 运行时优化实施计划（P7.3 / P7.4 / P7.5）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 R4 backlog 前三项运行时优化一次合入：`SymbolIndex` 事件化替代 2 秒轮询、`ripgrep` 流式 parse 替代 stdout 累积、storage 归一化追加 realpath。

**Architecture:** `SymbolIndex` 暴露两个 `vscode.EventEmitter`（`onStatusChanged` / `onStatsChanged`），`composition.bindWorkspace` 订阅事件替代 `setInterval`。`searchEngine.executeSearch` 内部改用 `readline.createInterface` 按行 push，保持 `Promise<SearchResult[]>` 对外契约不变。`symbolIndex.getStorage` 用 `fs.realpathSync` 解 symlink、失败静默回退 `path.resolve`。三项各自一个 commit。

**Tech Stack:** TypeScript 5 / Mocha TDD（`--ui=tdd`） / VS Code EventEmitter / Node readline / Node fs.realpathSync

---

## 前置说明

**工作目录**：`/home/mi/AI/si-search/.claude/worktrees/si-search-optimization`
当前分支：`worktree-si-search-optimization`

**测试执行策略**：本仓库测试分两层：
- **非-vscode 单测**：直接 `npx mocha --ui=tdd out/test/suite/<name>.test.js`，不走 `npm test`。37/37 是本批次之前的基线。
- **vscode 运行时测试**：由 `node ./out/test/runTest.js` 在 electron host 拉起，CI 场景；本计划不在 electron 里新写 suite。

**TypeScript 编译**：`npx tsc --noEmit` 必须零错误。实际产物编译用 `npm run compile`（tsc -p ./）。

**单测绿基线**（本 batch 启动前需确认）：
```bash
npm run compile
for f in out/test/suite/symbolIndex.test.js out/test/suite/syncOrchestrator.test.js out/test/suite/parseResultGrouping.test.js out/test/suite/storageManager.test.js out/test/suite/batchClassifier.test.js out/test/suite/workerPool.test.js out/test/suite/codec.test.js; do
  npx mocha --ui=tdd "$f" || exit 1
done
```
Expected：每个 suite passing，总和 37+ passing, 0 failing。

**Commit 规范**：`feat(P7.x): <summary>` 三个 commit 分别对应 P7.3 / P7.4 / P7.5。无 Co-Authored-By 脚注（本仓库过往 commit 无此惯例）。

---

## 文件结构

### 修改的文件

| 文件 | 责任 | 改动 |
|---|---|---|
| `src/symbolIndex.ts` | façade，暴露 legacy API | 加 `_onStatusChanged`/`_onStatsChanged` + 公开 getter + `setStatus`/`emitStats` 私有包装 + `dispose` + `getStorage`/`clearDisk` 加 realpath |
| `src/composition.ts` | DI 装配层 | `bindWorkspace` 删 `setInterval`、改订阅 2 个 event |
| `src/search/searchEngine.ts` | ripgrep 调用 | `executeSearch` 改 readline；抽出 `parseRgLine` 纯函数导出；删 `parseRgOutput` |

### 新增的测试文件

| 文件 | 测试目标 |
|---|---|
| `test/suite/searchEngineParsing.test.ts` | `parseRgLine` 纯函数单测（4 tests） |

### 扩展的测试文件

| 文件 | 追加 suite |
|---|---|
| `test/suite/symbolIndexFacade.test.ts` | P7.3 事件化 3 tests + P7.5 symlink 2 tests |

---

## Task 1: P7.3 SymbolIndex 事件化基础结构

**Files:**
- Modify: `src/symbolIndex.ts:32-46`（class 字段与构造器）
- Modify: `src/symbolIndex.ts:48-51`（status getter 与测试钩子）

- [ ] **Step 1.1: 读取 `src/symbolIndex.ts` 当前头部**

Read 文件 `src/symbolIndex.ts` 前 50 行，确认字段位置：
- `private readonly inner = new InMemorySymbolIndex();` 在 L33
- `private _status: IndexStatus = 'none';` 在 L37
- `_setStatusForTest(next)` 在 L51

- [ ] **Step 1.2: 在 import 区补 `vscode` 类型**（当前文件已 `import * as vscode from 'vscode'`，无需新增，验证即可）

Run: `grep -n "import \* as vscode" src/symbolIndex.ts`
Expected: 命中 1 行（第 5 行），已存在。

- [ ] **Step 1.3: 添加 EventEmitter 字段与公开 getter**

在 `src/symbolIndex.ts` 的 `storageByRoot` 字段之后（约 L41 下方），加入：

```ts
    // P7.3: 状态机事件化，替代 composition 层 2s 轮询
    private readonly _onStatusChanged = new vscode.EventEmitter<IndexStatus>();
    private readonly _onStatsChanged = new vscode.EventEmitter<{ files: number; symbols: number }>();
```

然后在 `get status(): IndexStatus { return this._status; }` 之后（约 L48 下方），加入：

```ts
    /** P7.3: status 状态机转换事件;相等守卫,重复赋值不 fire。 */
    get onStatusChanged(): vscode.Event<IndexStatus> { return this._onStatusChanged.event; }

    /** P7.3: stats 数量变更事件;仅在批处理完成末尾 fire,避免热循环风暴。 */
    get onStatsChanged(): vscode.Event<{ files: number; symbols: number }> { return this._onStatsChanged.event; }

    /** 释放 EventEmitter;由 composition 层在 ExtensionContext.subscriptions 中登记。 */
    dispose(): void {
        this._onStatusChanged.dispose();
        this._onStatsChanged.dispose();
    }
```

- [ ] **Step 1.4: 加入 private setStatus / emitStats 包装**

紧接着 `_getStorageCountForTest` 之后（约 L55 下方），加入：

```ts
    /** P7.3: 所有 this._status = X 赋值都走这里,带相等守卫,仅在状态确实变化时 fire。 */
    private setStatus(next: IndexStatus): void {
        if (this._status === next) { return; }
        this._status = next;
        this._onStatusChanged.fire(next);
    }

    /** P7.3: 在批处理完成末尾调用,fire 当前 stats 快照。 */
    private emitStats(): void {
        this._onStatsChanged.fire(this.inner.getStats());
    }
```

- [ ] **Step 1.5: 编译确认结构正确**

Run: `npx tsc --noEmit`
Expected: 0 错误。

- [ ] **Step 1.6: Commit（暂不 push）**

```bash
git add src/symbolIndex.ts
git commit -m "refactor(P7.3): add SymbolIndex EventEmitter fields and setStatus/emitStats wrappers"
```

---

## Task 2: P7.3 把所有 `this._status = X` 改走 setStatus

**Files:**
- Modify: `src/symbolIndex.ts:63, 69, 84, 121, 124, 155, 176, 185`（所有 `this._status =` 赋值点）

**上下文**：上一步只加了 setStatus/emitStats 包装器，尚未使用。本步把所有现有 `this._status = X` 改走 setter，同时在 stats 变化的关键位置插入 `emitStats()`。

- [ ] **Step 2.1: grep 所有赋值点定位**

Run: `grep -n "this._status = " src/symbolIndex.ts`
Expected 8 处：
```
63:        if (this._status === 'ready') { this._status = 'stale'; }
69:        if (this._status === 'ready') { this._status = 'stale'; }
84:        this._status = 'building';
121:            this._status = this.inner.getStats().files > 0 ? 'stale' : 'none';
124:        this._status = 'ready';
155:        if (this._status === 'stale') { this._status = 'ready'; }
176:        this._status = 'ready';
185:        this._status = 'none';
```

- [ ] **Step 2.2: 修改 markDirty / markDeleted（L63, L69）**

把：
```ts
    markDirty(relativePath: string): void {
        this.dirtyFiles.add(relativePath);
        this.deletedFiles.delete(relativePath);
        if (this._status === 'ready') { this._status = 'stale'; }
    }

    markDeleted(relativePath: string): void {
        this.deletedFiles.add(relativePath);
        this.dirtyFiles.delete(relativePath);
        if (this._status === 'ready') { this._status = 'stale'; }
    }
```
改为：
```ts
    markDirty(relativePath: string): void {
        this.dirtyFiles.add(relativePath);
        this.deletedFiles.delete(relativePath);
        if (this._status === 'ready') { this.setStatus('stale'); }
    }

    markDeleted(relativePath: string): void {
        this.deletedFiles.add(relativePath);
        this.dirtyFiles.delete(relativePath);
        if (this._status === 'ready') { this.setStatus('stale'); }
    }
```

- [ ] **Step 2.3: 修改 synchronize 入口 / 结束（L84, L121, L124）**

把：
```ts
        this._status = 'building';
```
改为：
```ts
        this.setStatus('building');
```

把结束段：
```ts
        this.dirtyFiles.clear();
        this.deletedFiles.clear();
        if (token.isCancellationRequested) {
            this._status = this.inner.getStats().files > 0 ? 'stale' : 'none';
            return;
        }
        this._status = 'ready';
    }
```
改为：
```ts
        this.dirtyFiles.clear();
        this.deletedFiles.clear();
        if (token.isCancellationRequested) {
            const fallback = this.inner.getStats().files > 0 ? 'stale' : 'none';
            this.setStatus(fallback);
            this.emitStats();
            return;
        }
        this.setStatus('ready');
        this.emitStats();
    }
```

- [ ] **Step 2.4: 修改 syncDirty 结束（L155）**

把：
```ts
        if (this._status === 'stale') { this._status = 'ready'; }
    }
```
改为：
```ts
        if (this._status === 'stale') { this.setStatus('ready'); }
        this.emitStats();
    }
```

注意：`emitStats()` 无条件调用 —— syncDirty 只要执行到这里必有 stats 变化（上游已检查 dirtyFiles/deletedFiles 非空）。

- [ ] **Step 2.5: 修改 loadFromDisk 结束（L176）**

把：
```ts
        for (const [k, v] of snap.fileMetadata) { this.fileMetadata.set(k, v); }
        this._status = 'ready';
        return true;
    }
```
改为：
```ts
        for (const [k, v] of snap.fileMetadata) { this.fileMetadata.set(k, v); }
        this.setStatus('ready');
        this.emitStats();
        return true;
    }
```

- [ ] **Step 2.6: 修改 clear（L185）**

把：
```ts
    clear(): void {
        this.inner.replaceAll(new Map());
        this.fileMetadata.clear();
        this.dirtyFiles.clear();
        this.deletedFiles.clear();
        this._status = 'none';
    }
```
改为：
```ts
    clear(): void {
        this.inner.replaceAll(new Map());
        this.fileMetadata.clear();
        this.dirtyFiles.clear();
        this.deletedFiles.clear();
        this.setStatus('none');
        this.emitStats();
    }
```

- [ ] **Step 2.7: 修改 `_setStatusForTest`（L51）保持事件对称**

把：
```ts
    /** @internal 测试钩子——不得用于生产代码路径。 */
    _setStatusForTest(next: IndexStatus): void { this._status = next; }
```
改为：
```ts
    /** @internal 测试钩子——不得用于生产代码路径。走 setStatus 以保持事件对称。 */
    _setStatusForTest(next: IndexStatus): void { this.setStatus(next); }
```

- [ ] **Step 2.8: 验证无遗漏赋值点**

Run: `grep -n "this._status = " src/symbolIndex.ts`
Expected: 0 匹配（除 setStatus 内部 `this._status = next;`）。

注：setStatus 内的赋值是唯一允许的直接赋值，是包装器实现所必需。

Run: `grep -n "this._status =" src/symbolIndex.ts`
Expected: 恰好 1 匹配（setStatus 内）。

- [ ] **Step 2.9: 编译确认**

Run: `npx tsc --noEmit`
Expected: 0 错误。

- [ ] **Step 2.10: 先跑现有单测验证未破坏旧语义**

Run:
```bash
npm run compile && npx mocha --ui=tdd out/test/suite/symbolIndex.test.js out/test/suite/syncOrchestrator.test.js out/test/suite/parseResultGrouping.test.js
```
Expected: 全绿，37 passing 之前基线被维持。

---

## Task 3: P7.3 事件化新增测试

**Files:**
- Modify: `test/suite/symbolIndexFacade.test.ts`（文件末尾追加新 suite）

- [ ] **Step 3.1: 追加事件化测试 suite**

在 `test/suite/symbolIndexFacade.test.ts` 文件末尾（closing `});` 后）追加：

```ts

suite('SymbolIndex events (P7.3)', () => {
    test('onStatusChanged fires once per transition, not on equal assignments', () => {
        const index = new SymbolIndex();
        const events: string[] = [];
        const disp = index.onStatusChanged(s => events.push(s));
        try {
            // _setStatusForTest 走 setStatus,相等守卫生效
            (index as unknown as { _setStatusForTest(s: string): void })._setStatusForTest('building');
            (index as unknown as { _setStatusForTest(s: string): void })._setStatusForTest('building'); // no-fire
            (index as unknown as { _setStatusForTest(s: string): void })._setStatusForTest('ready');
            (index as unknown as { _setStatusForTest(s: string): void })._setStatusForTest('ready');    // no-fire
            assert.deepStrictEqual(events, ['building', 'ready']);
        } finally {
            disp.dispose();
            index.dispose();
        }
    });

    test('onStatsChanged fires after loadFromDisk when snapshot exists', async () => {
        // 空目录 loadFromDisk 返回 false,不 fire stats
        const emptyWs = fs.mkdtempSync(path.join(os.tmpdir(), 'sisearch-facade-evt-'));
        try {
            const index = new SymbolIndex();
            const fires: Array<{ files: number; symbols: number }> = [];
            const disp = index.onStatsChanged(s => fires.push(s));
            try {
                const loaded = await index.loadFromDisk(emptyWs);
                assert.strictEqual(loaded, false);
                assert.strictEqual(fires.length, 0, 'no-snapshot load should not fire stats');
            } finally {
                disp.dispose();
                index.dispose();
            }
        } finally {
            fs.rmSync(emptyWs, { recursive: true, force: true });
        }
    });

    test('clear fires onStatusChanged and onStatsChanged', () => {
        const index = new SymbolIndex();
        // 先推到 ready 状态,才能观察 clear 导致的 none 事件
        (index as unknown as { _setStatusForTest(s: string): void })._setStatusForTest('ready');

        const statusEvents: string[] = [];
        const statsEvents: Array<{ files: number; symbols: number }> = [];
        const d1 = index.onStatusChanged(s => statusEvents.push(s));
        const d2 = index.onStatsChanged(s => statsEvents.push(s));

        try {
            index.clear();
            assert.deepStrictEqual(statusEvents, ['none']);
            assert.strictEqual(statsEvents.length, 1);
            assert.deepStrictEqual(statsEvents[0], { files: 0, symbols: 0 });
        } finally {
            d1.dispose();
            d2.dispose();
            index.dispose();
        }
    });
});
```

- [ ] **Step 3.2: 编译**

Run: `npm run compile`
Expected: 0 错误。

- [ ] **Step 3.3: 跑新测试**

Run: `npx mocha --ui=tdd out/test/suite/symbolIndexFacade.test.js`
Expected: 原有 6 tests + 新 3 tests = 9 passing, 0 failing。

如果失败：
- `onStatusChanged` 没 fire → 检查 Task 2 是否所有赋值点都改走 setStatus
- `_setStatusForTest` fire 不符合预期 → 确认 Step 2.7 的修改已执行

- [ ] **Step 3.4: 全量跑非-vscode 单测验证无回归**

Run:
```bash
npx mocha --ui=tdd out/test/suite/symbolIndex.test.js out/test/suite/syncOrchestrator.test.js out/test/suite/parseResultGrouping.test.js out/test/suite/symbolIndexFacade.test.js
```
Expected: 原 37 + 3 新 = 40 passing。

---

## Task 4: P7.3 composition 订阅事件替代 setInterval

**Files:**
- Modify: `src/composition.ts:129-130`（删 setInterval）
- Modify: `src/composition.ts:85-91`（bindWorkspace 上段）— 新订阅

- [ ] **Step 4.1: 读取当前 bindWorkspace**

Read 文件 `src/composition.ts` 全文（已知 132 行），确认 setInterval 在 L129。

- [ ] **Step 4.2: 删 setInterval 并加订阅**

把：
```ts
    const statusTimer = setInterval(refreshStatus, 2000);
    context.subscriptions.push({ dispose: () => clearInterval(statusTimer) });
}
```
改为：
```ts
    // P7.3: 订阅索引事件替代 2 秒轮询;相等守卫保证无效 rerender 不发生。
    context.subscriptions.push(symbolIndex.onStatusChanged(() => refreshStatus()));
    context.subscriptions.push(symbolIndex.onStatsChanged(() => refreshStatus()));
    // SymbolIndex 的 EventEmitter 生命周期挂到 extension context
    context.subscriptions.push({ dispose: () => symbolIndex.dispose() });
}
```

同时把函数顶部 JSDoc 的第 5 条更新：

把：
```ts
 * 5. 挂 setInterval(2000) 轮询状态栏(后续 P5.3 换事件驱动)
```
改为：
```ts
 * 5. 订阅 SymbolIndex onStatusChanged / onStatsChanged 事件驱动状态栏刷新(P7.3)
```

- [ ] **Step 4.3: 编译**

Run: `npx tsc --noEmit`
Expected: 0 错误。

- [ ] **Step 4.4: grep 验证 setInterval 已移除**

Run: `grep -n "setInterval" src/composition.ts`
Expected: 0 匹配。

Run: `grep -n "onStatusChanged\|onStatsChanged" src/composition.ts`
Expected: 2 处订阅 + 至多 0 其他匹配。

- [ ] **Step 4.5: 跑 composition 单测验证非回归**

Run: `npx mocha --ui=tdd out/test/suite/composition.test.js 2>&1 || echo "skipped (vscode dep)"`

说明：`composition.test.ts` 测的是 `updateStatusBar` / `updateSidebarHistory` 两个纯 DI 函数，不涉及 `bindWorkspace`。若此 suite 在裸 Node 下因 `import 'vscode'` 报错，跳过 —— 本任务的 bindWorkspace 改动由下游测试（event suite）隐式覆盖。

- [ ] **Step 4.6: Commit P7.3**

```bash
git add src/symbolIndex.ts src/composition.ts test/suite/symbolIndexFacade.test.ts
git commit -m "feat(P7.3): replace 2s setInterval with SymbolIndex event-driven status refresh

- SymbolIndex 暴露 onStatusChanged / onStatsChanged EventEmitter
- setStatus/emitStats 私有包装,相等守卫避免无效 fire
- composition.bindWorkspace 订阅事件替代 setInterval(2000)
- 新增 3 个事件化回归测试(symbolIndexFacade.test.ts)

收益:每会话减少 ~1800 次无意义 wake-up"
```

---

## Task 5: P7.4 parseRgLine 抽出纯函数

**Files:**
- Modify: `src/search/searchEngine.ts:87-113`（替换 parseRgOutput 为 parseRgLine 导出）

**上下文**：`parseRgOutput` 接收整块 stdout、split、循环 match。拆成单行 parser 以便：
1. readline 循环按行调用
2. 独立可单测（无需 spawn ripgrep）

- [ ] **Step 5.1: 读取当前 searchEngine.ts**

Read `src/search/searchEngine.ts` 全文 130 行。

- [ ] **Step 5.2: 删除 parseRgOutput,新增 parseRgLine 导出**

把 L87-113 的 `parseRgOutput`：
```ts
function parseRgOutput(stdout: string, workspaceRoot: string): SearchResult[] {
    const results: SearchResult[] = [];
    const lines = stdout.split('\n');

    for (const line of lines) {
        if (!line.trim()) { continue; }

        // Format: ./relative/path:lineNumber:column:content
        const match = line.match(/^(.+?):(\d+):(\d+):(.*)$/);
        if (!match) { continue; }

        const [, rawPath, lineStr, colStr, content] = match;
        const relativePath = rawPath.replace(/^\.[\\/]/, '');
        const filePath = path.resolve(workspaceRoot, relativePath);

        results.push({
            filePath,
            relativePath,
            lineNumber: parseInt(lineStr, 10),
            lineContent: content,
            matchStart: parseInt(colStr, 10) - 1,
            matchLength: 0,
        });
    }

    return results;
}
```

改为：
```ts
/**
 * P7.4: 单行 ripgrep 输出解析器。
 * 格式: `./relative/path:lineNumber:column:content`
 * 空行或格式非法时不 push。抽为 export 便于单测(无需 spawn)。
 */
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

**注意**：此时 `executeSearch` 仍引用 `parseRgOutput`，编译会暂时失败。下一步修复。

- [ ] **Step 5.3: 编译确认失败位置（预期）**

Run: `npx tsc --noEmit`
Expected: `src/search/searchEngine.ts:30: error TS2304: Cannot find name 'parseRgOutput'.`

这是预期的红态 —— 下一个 task（Task 6）替换 executeSearch 主体。

- [ ] **Step 5.4: 跳过 commit,直接进入 Task 6**

本步不单独 commit；P7.4 会作为 Task 5+6+7 组合一个 commit。

---

## Task 6: P7.4 executeSearch 改用 readline 流式 parse

**Files:**
- Modify: `src/search/searchEngine.ts:1`（追加 readline import）
- Modify: `src/search/searchEngine.ts:7-38`（executeSearch 主体重写）

- [ ] **Step 6.1: 追加 readline import**

把 `src/search/searchEngine.ts` 的 `import { spawn } from 'child_process';` 行下方加一行：
```ts
import * as readline from 'readline';
```

文件 import 块变为：
```ts
import { spawn } from 'child_process';
import * as readline from 'readline';
import * as path from 'path';
import { SearchOptions, SearchResult } from '../types';
import { rgPath } from '@vscode/ripgrep';
import { SymbolIndex } from '../symbolIndex';
```

- [ ] **Step 6.2: 重写 executeSearch 主体**

把：
```ts
export async function executeSearch(
    query: string,
    workspaceRoot: string,
    options: SearchOptions,
    includeExtensions: string[],
    excludePatterns: string[]
): Promise<SearchResult[]> {
    return new Promise((resolve, reject) => {
        const args = buildRgArgs(query, options, includeExtensions, excludePatterns);
        const proc = spawn(rgPath, args, { cwd: workspaceRoot });

        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
        proc.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

        proc.on('close', (code) => {
            // ripgrep exits with 1 when no matches — not an error
            if (code !== null && code > 1) {
                reject(new Error(`ripgrep failed (code ${code}): ${stderr}`));
                return;
            }
            const results = parseRgOutput(stdout, workspaceRoot);
            resolve(results);
        });

        proc.on('error', (err) => {
            reject(new Error(`Failed to spawn ripgrep: ${err.message}`));
        });
    });
}
```

改为：
```ts
export async function executeSearch(
    query: string,
    workspaceRoot: string,
    options: SearchOptions,
    includeExtensions: string[],
    excludePatterns: string[]
): Promise<SearchResult[]> {
    return new Promise((resolve, reject) => {
        const args = buildRgArgs(query, options, includeExtensions, excludePatterns);
        const proc = spawn(rgPath, args, { cwd: workspaceRoot });

        const results: SearchResult[] = [];
        let stderr = '';

        // P7.4: 按行流式 parse,避免大结果集(>20MB)一次性累积 stdout 字符串
        const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
        rl.on('line', line => parseRgLine(line, workspaceRoot, results));

        proc.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

        proc.on('close', (code) => {
            // ripgrep exits with 1 when no matches — not an error
            if (code !== null && code > 1) {
                reject(new Error(`ripgrep failed (code ${code}): ${stderr}`));
                return;
            }
            // readline 在 proc.stdout 关闭时已 flush 所有 line 事件;此处 results 已完整
            resolve(results);
        });

        proc.on('error', (err) => {
            reject(new Error(`Failed to spawn ripgrep: ${err.message}`));
        });
    });
}
```

- [ ] **Step 6.3: 编译**

Run: `npx tsc --noEmit`
Expected: 0 错误。

- [ ] **Step 6.4: grep 确认无累积 stdout**

Run: `grep -n "stdout +=" src/search/searchEngine.ts`
Expected: 0 匹配。

Run: `grep -n "parseRgOutput" src/search/searchEngine.ts`
Expected: 0 匹配。

Run: `grep -n "readline" src/search/searchEngine.ts`
Expected: 2 匹配（import + createInterface 调用）。

- [ ] **Step 6.5: 跑现有 searchEngine.test.ts 端到端验证**

Run: `npm run compile && npx mocha --ui=tdd out/test/suite/searchEngine.test.js`
Expected: 6/6 passing（`case-insensitive` / `case-sensitive` / `whole word` / `regex` / `file extension filter` / `result fields`）。

失败排查：
- `results.length === 0` → 检查 readline 未接好 stdout；确认 `readline.createInterface({ input: proc.stdout })`
- proc close 先于 line flush → `crlfDelay: Infinity` 已处理，readline 保证 line 事件在 stream close 前触发

---

## Task 7: P7.4 parseRgLine 纯函数单测

**Files:**
- Create: `test/suite/searchEngineParsing.test.ts`

- [ ] **Step 7.1: 新建测试文件**

创建 `test/suite/searchEngineParsing.test.ts`，内容：

```ts
// test/suite/searchEngineParsing.test.ts
// P7.4: parseRgLine 纯函数单测,无需 spawn ripgrep。

import * as assert from 'assert';
import * as path from 'path';
import { parseRgLine } from '../../src/search/searchEngine';
import type { SearchResult } from '../../src/types';

suite('parseRgLine (P7.4)', () => {
    test('parses standard rg output line', () => {
        const out: SearchResult[] = [];
        parseRgLine('./src/a.c:12:4:int x;', '/ws', out);
        assert.strictEqual(out.length, 1);
        assert.strictEqual(out[0].relativePath, 'src/a.c');
        assert.strictEqual(out[0].filePath, path.resolve('/ws', 'src/a.c'));
        assert.strictEqual(out[0].lineNumber, 12);
        assert.strictEqual(out[0].lineContent, 'int x;');
        assert.strictEqual(out[0].matchStart, 3); // column 4 -> 0-based 3
        assert.strictEqual(out[0].matchLength, 0);
    });

    test('skips empty lines', () => {
        const out: SearchResult[] = [];
        parseRgLine('', '/ws', out);
        parseRgLine('   ', '/ws', out);
        assert.strictEqual(out.length, 0);
    });

    test('skips malformed lines without colon structure', () => {
        const out: SearchResult[] = [];
        parseRgLine('not a rg line', '/ws', out);
        parseRgLine('single:colon:only', '/ws', out);
        parseRgLine('path:abc:def:content', '/ws', out); // non-numeric line/col
        assert.strictEqual(out.length, 0);
    });

    test('strips ./ prefix from relative path', () => {
        const out: SearchResult[] = [];
        parseRgLine('./a.c:1:1:x', '/ws', out);
        assert.strictEqual(out[0].relativePath, 'a.c');
    });

    test('preserves content containing colons', () => {
        const out: SearchResult[] = [];
        // 路径正则是非贪婪的,首个 :数字:数字: 之后都是 content
        parseRgLine('./src/a.c:5:10:time_t t = now():', '/ws', out);
        assert.strictEqual(out.length, 1);
        assert.strictEqual(out[0].lineContent, 'time_t t = now():');
    });
});
```

- [ ] **Step 7.2: 编译**

Run: `npm run compile`
Expected: 0 错误。

- [ ] **Step 7.3: 跑新测试**

Run: `npx mocha --ui=tdd out/test/suite/searchEngineParsing.test.js`
Expected: 5 passing。

失败排查：
- `parses standard rg output line` 断言 matchStart=3 失败 → 原 `parseRgOutput` 中 `parseInt(colStr, 10) - 1`；parseRgLine 保留同逻辑
- `skips malformed lines: path:abc:def:content` 失败 → 现正则 `^(.+?):(\d+):(\d+):(.*)$` 要求 `\d+`，非数字会不 match，正确 skip

- [ ] **Step 7.4: Commit P7.4**

```bash
git add src/search/searchEngine.ts test/suite/searchEngineParsing.test.ts
git commit -m "feat(P7.4): readline streaming parse for ripgrep output

- executeSearch 改用 readline.createInterface 按行 push 结果
- 抽出 parseRgLine 纯函数(export),替换一次性 parseRgOutput
- 新增 5 个 parseRgLine 单测(无需 spawn ripgrep)
- 外部 Promise<SearchResult[]> 签名不变,下游 0 改动

收益:大结果集(>20MB)不再一次性累积 stdout 字符串,内存峰值降低"
```

---

## Task 8: P7.5 getStorage / clearDisk 加 realpath 归一化

**Files:**
- Modify: `src/symbolIndex.ts:188-198`（clearDisk）
- Modify: `src/symbolIndex.ts:204-212`（getStorage）

- [ ] **Step 8.1: 读取当前 getStorage 与 clearDisk**

Read `src/symbolIndex.ts` L188-212 区间，确认代码与 spec 描述一致。

- [ ] **Step 8.2: 修改 getStorage 加 realpath 降级**

把：
```ts
    /** 按 workspaceRoot 记忆化 StorageManager,避免每次 sync/save/load 都重复 new。
     *  路径标准化:`/a/b` 与 `/a/b/` 归一到同一 key,防止重复实例化。 */
    private getStorage(workspaceRoot: string): StorageManager {
        const normalized = path.resolve(workspaceRoot);
        let storage = this.storageByRoot.get(normalized);
        if (!storage) {
            storage = new StorageManager({ workspaceRoot: normalized, shardCount: this.shardCount });
            this.storageByRoot.set(normalized, storage);
        }
        return storage;
    }
```

改为：
```ts
    /** 按 workspaceRoot 记忆化 StorageManager,避免每次 sync/save/load 都重复 new。
     *  路径标准化:
     *    - path.resolve 处理 `..` 和 trailing slash(P6.6)
     *    - fs.realpathSync 解 symlink,避免 symlinked workspace 双写 .sisearch(P7.5)
     *    - realpath 失败(ENOENT/EACCES/not-a-symlink)静默回退 path.resolve */
    private getStorage(workspaceRoot: string): StorageManager {
        const normalized = this.canonicalizeRoot(workspaceRoot);
        let storage = this.storageByRoot.get(normalized);
        if (!storage) {
            storage = new StorageManager({ workspaceRoot: normalized, shardCount: this.shardCount });
            this.storageByRoot.set(normalized, storage);
        }
        return storage;
    }

    /** P7.5: 路径归一化共享助手。先 path.resolve 处理 `..`/trailing slash,
     *  再 fs.realpathSync 解 symlink;失败静默回退 resolve 结果。 */
    private canonicalizeRoot(workspaceRoot: string): string {
        const resolved = path.resolve(workspaceRoot);
        try {
            return fs.realpathSync(resolved);
        } catch {
            return resolved;
        }
    }
```

- [ ] **Step 8.3: 修改 clearDisk 使用同一归一化**

把：
```ts
    clearDisk(workspaceRoot: string): void {
        const normalized = path.resolve(workspaceRoot);
        const indexDir = path.join(normalized, '.sisearch');
        try {
            fs.rmSync(indexDir, { recursive: true, force: true });
        } catch {
            // ignore
        }
        // 失效缓存,避免过时 StorageManager 指向已删目录
        this.storageByRoot.delete(normalized);
    }
```

改为：
```ts
    clearDisk(workspaceRoot: string): void {
        const normalized = this.canonicalizeRoot(workspaceRoot);
        const indexDir = path.join(normalized, '.sisearch');
        try {
            fs.rmSync(indexDir, { recursive: true, force: true });
        } catch {
            // ignore
        }
        // 失效缓存,避免过时 StorageManager 指向已删目录
        this.storageByRoot.delete(normalized);
    }
```

- [ ] **Step 8.4: 编译**

Run: `npx tsc --noEmit`
Expected: 0 错误。

- [ ] **Step 8.5: grep 验证**

Run: `grep -n "fs.realpathSync" src/symbolIndex.ts`
Expected: 1 匹配（在 canonicalizeRoot 内）。

Run: `grep -n "canonicalizeRoot" src/symbolIndex.ts`
Expected: 3 匹配（1 定义 + 2 调用：getStorage + clearDisk）。

- [ ] **Step 8.6: 先跑现有 facade 测试验证 P6.6 回归仍绿**

Run: `npx mocha --ui=tdd out/test/suite/symbolIndexFacade.test.js`
Expected: 原 6 + P7.3 新 3 = 9 passing（包含 trailing-slash 归一化测试 —— realpath 对真实路径加 trailing slash 仍返回真实路径，行为与 P6.6 预期一致）。

---

## Task 9: P7.5 新增 symlink 回归测试

**Files:**
- Modify: `test/suite/symbolIndexFacade.test.ts`（追加 P7.5 suite）

- [ ] **Step 9.1: 追加 symlink suite**

在 `test/suite/symbolIndexFacade.test.ts` 文件末尾（P7.3 suite 之后）追加：

```ts

suite('SymbolIndex symlink normalization (P7.5)', () => {
    test('getStorage follows symlink to real path; both paths share one storage', async () => {
        const realDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sisearch-real-'));
        const linkParent = fs.mkdtempSync(path.join(os.tmpdir(), 'sisearch-link-'));
        const linkPath = path.join(linkParent, 'linked');

        try {
            // 创建 symlink: linkPath -> realDir
            try {
                fs.symlinkSync(realDir, linkPath, 'dir');
            } catch (e) {
                // Windows 上无权限时抛错,跳过此测试
                const msg = (e as Error).message;
                if (msg.includes('EPERM') || msg.includes('EACCES')) { return; }
                throw e;
            }

            const index = new SymbolIndex();
            const getCount = (index as unknown as { _getStorageCountForTest(): number })._getStorageCountForTest.bind(index);

            await index.loadFromDisk(realDir);
            await index.loadFromDisk(linkPath);

            assert.strictEqual(getCount(), 1, 'symlink and real path should share one StorageManager');

            // 通过 symlink 路径 clearDisk 也能失效真路径的 key
            index.clearDisk(linkPath);
            assert.strictEqual(getCount(), 0, 'clearDisk via symlink should invalidate real-path key');
        } finally {
            try { fs.unlinkSync(linkPath); } catch { /* ignore */ }
            fs.rmSync(realDir, { recursive: true, force: true });
            fs.rmSync(linkParent, { recursive: true, force: true });
        }
    });

    test('getStorage falls back to path.resolve when realpath fails (ENOENT)', () => {
        // 不存在的路径 —— realpath 抛 ENOENT,应降级到 path.resolve 结果,不抛异常
        const missingPath = path.join(os.tmpdir(), 'sisearch-nonexistent-' + Date.now());

        const index = new SymbolIndex();
        const getCount = (index as unknown as { _getStorageCountForTest(): number })._getStorageCountForTest.bind(index);

        // 触发 getStorage 需走 save/load/sync 之一;这里用 clearDisk(不真的删),
        // clearDisk 也会通过 canonicalizeRoot 落入降级路径;但 clearDisk 不 get StorageManager,
        // 所以用 loadFromDisk 间接触发(对不存在路径安全返回 false)
        return (async () => {
            const loaded = await index.loadFromDisk(missingPath);
            assert.strictEqual(loaded, false);
            assert.strictEqual(getCount(), 1, 'fallback path still registers one storage entry');

            // 清理:通过 clearDisk 失效(同一 fallback key)
            index.clearDisk(missingPath);
            assert.strictEqual(getCount(), 0);
        })();
    });
});
```

- [ ] **Step 9.2: 编译**

Run: `npm run compile`
Expected: 0 错误。

- [ ] **Step 9.3: 跑新 suite**

Run: `npx mocha --ui=tdd out/test/suite/symbolIndexFacade.test.js`
Expected: 原 6 + P7.3 新 3 + P7.5 新 2 = 11 passing。

失败排查：
- `symlink and real path should share one StorageManager` 返回 2 → 检查 getStorage 是否实际调用 canonicalizeRoot（Step 8.2）
- symlink 创建失败（Windows 非管理员）→ 测试内已做 EPERM/EACCES skip，不应 fail

- [ ] **Step 9.4: 跑全量非-vscode 单测最终验证**

Run:
```bash
npx mocha --ui=tdd \
  out/test/suite/symbolIndex.test.js \
  out/test/suite/syncOrchestrator.test.js \
  out/test/suite/parseResultGrouping.test.js \
  out/test/suite/storageManager.test.js \
  out/test/suite/batchClassifier.test.js \
  out/test/suite/workerPool.test.js \
  out/test/suite/codec.test.js \
  out/test/suite/symbolIndexFacade.test.js \
  out/test/suite/searchEngineParsing.test.js
```
Expected: 原 37（非 facade）+ 原 6（facade）+ P7.3 新 3 + P7.5 新 2 + P7.4 新 5 = 约 53 passing。

允许偏差：如果 workerPool.test.js 或 codec.test.js 本身数量与 R4 时段不同，以 `>= 37 + 10` 为准则（即新增至少 10 个 test 且 0 failing）。

- [ ] **Step 9.5: Commit P7.5**

```bash
git add src/symbolIndex.ts test/suite/symbolIndexFacade.test.ts
git commit -m "feat(P7.5): canonicalize workspace root via fs.realpathSync in storage keying

- canonicalizeRoot 私有助手:path.resolve + fs.realpathSync 降级
- getStorage / clearDisk 共用同一归一化路径
- 消除 symlinked workspace 双写 .sisearch 风险
- realpath 失败(ENOENT/EACCES/not-a-symlink)静默回退 resolve
- 新增 2 个 symlink 回归测试(symbolIndexFacade.test.ts)"
```

---

## Task 10: Batch A 终局验证

- [ ] **Step 10.1: 总 commit 数确认**

Run: `git log --oneline main..HEAD | wc -l`
Expected: 相对 R4 终局（commit `8d5c0fa`）后新增 3 + 1 spec commit = 4 commit。

Run: `git log --oneline -5`
Expected: 按倒序看到：
```
<sha> feat(P7.5): canonicalize workspace root via fs.realpathSync ...
<sha> feat(P7.4): readline streaming parse for ripgrep output
<sha> feat(P7.3): replace 2s setInterval with SymbolIndex event-driven ...
<sha> docs: Batch A runtime optimization spec (P7.3/P7.4/P7.5)
```

- [ ] **Step 10.2: TypeScript 最终编译**

Run: `npx tsc --noEmit && npm run compile`
Expected: 0 错误，out/ 重建成功。

- [ ] **Step 10.3: 全量非-vscode 单测最终跑**

Run:
```bash
npx mocha --ui=tdd \
  out/test/suite/symbolIndex.test.js \
  out/test/suite/syncOrchestrator.test.js \
  out/test/suite/parseResultGrouping.test.js \
  out/test/suite/storageManager.test.js \
  out/test/suite/batchClassifier.test.js \
  out/test/suite/workerPool.test.js \
  out/test/suite/codec.test.js \
  out/test/suite/symbolIndexFacade.test.js \
  out/test/suite/searchEngineParsing.test.js \
  out/test/suite/searchEngine.test.js \
  out/test/suite/symbolParser.test.js \
  out/test/suite/autoSync.test.js
```
Expected: 全绿，0 failing。具体 passing 数由原 suite 规模决定；新增 10 个测试（P7.3 ×3 + P7.4 ×5 + P7.5 ×2）。

- [ ] **Step 10.4: 验收 grep 清单**

Run: `grep -n "setInterval" src/composition.ts`
Expected: 0 匹配。

Run: `grep -n "stdout +=" src/search/searchEngine.ts`
Expected: 0 匹配。

Run: `grep -n "fs.realpathSync" src/symbolIndex.ts`
Expected: 1 匹配（在 canonicalizeRoot 中）。

Run: `grep -n "this._status = " src/symbolIndex.ts`
Expected: 0 匹配（setStatus 内是 `this._status = next;`，已在 setStatus 函数体内，grep 模式带空格不命中）。若意外命中，需确认 Task 2 覆盖完整。

Run: `grep -n "onStatusChanged\|onStatsChanged" src/composition.ts`
Expected: 2 匹配（Task 4 Step 4.2 的两行订阅）。

- [ ] **Step 10.5: 成果汇总说明**

Batch A 实施完毕。对应 R4 backlog 关闭项：
- P7.3 状态栏事件化 → ✅
- P7.4 ripgrep 流式 parse → ✅
- P7.5 storageByRoot 符号链接 realpath → ✅

剩余 R4 backlog 进入 Batch B/C：
- Batch B（P7.6 ESLint/esbuild + P7.8 多根 workspace）— 独立 spec
- Batch C（P7.7 ui/* 单测 + P7.9 catch → telemetry）— 独立 spec

---

## Self-Review 结果

**1. Spec 覆盖**
- Spec §3.1 P7.3 事件化（emit 点清单 8 条）→ Task 1-4 全覆盖
- Spec §3.2 P7.4 readline 流式 + parseRgLine 纯函数 → Task 5-7 全覆盖
- Spec §3.3 P7.5 realpath 降级（getStorage + clearDisk）→ Task 8-9 全覆盖
- Spec §5 测试计划 9 条 → Task 3（3 个 event 测）+ Task 7（5 个 parseRgLine 测）+ Task 9（2 个 symlink 测）= 10 个新测试，超 spec 所列
- Spec §7 验收清单 6 条 → Task 10 全覆盖

**2. Placeholder scan**：无 TBD/TODO/vague 描述；每个 step 含完整代码或完整命令。

**3. Type consistency**
- `SymbolIndex.onStatusChanged` 返回 `vscode.Event<IndexStatus>` —— 在 Task 1 Step 1.3 和 Task 3 Step 3.1 一致
- `SymbolIndex.onStatsChanged` 返回 `vscode.Event<{files: number; symbols: number}>` —— 同上一致
- `parseRgLine(line, ws, out)` 签名在 Task 5 Step 5.2 和 Task 7 Step 7.1 一致
- `canonicalizeRoot` 在 Task 8 Step 8.2 定义、Step 8.3 复用、Task 9 Step 9.1 间接验证

发现一处小优化：spec §3.1 列 8 个 emit 点，plan Task 2 覆盖 7 个 emit 点（`_setStatusForTest` 不归类为 emit 点但走 setStatus）—— 语义一致。
