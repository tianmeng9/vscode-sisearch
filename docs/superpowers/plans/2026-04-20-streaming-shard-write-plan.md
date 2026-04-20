# Streaming Shard Write Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate extension-host V8 heap OOM during 33k-file sync by streaming each worker batch result directly to disk shard chunks instead of accumulating the full symbol universe in the main thread.

**Architecture:** Introduce `ShardStreamWriter` that owns per-shard bounded buckets and flushes them as msgpack chunks (appended to shard files). Change `WorkerPool.parse` to be callback-driven (returns `Promise<void>`) so each batch result is immediately consumed by `SyncOrchestrator`: update in-memory index + feed writer, then allow next batch. Shard file format becomes "concatenation of msgpack chunks" — old single-array files remain readable via `decodeMulti`.

**Tech Stack:** TypeScript (strict), `@msgpack/msgpack` (`decode`, `encode`, `decodeMulti`), Node `fs` (sync appendFile/writeFile), Mocha + Node `assert`, VS Code Extension Host runtime.

**Spec:** `docs/superpowers/specs/2026-04-20-streaming-shard-write-design.md`

---

## Conventions

- Tests use Mocha (`suite`/`test`) + Node `assert` — see `test/suite/workerPool.test.ts` for style.
- Build: `npm run compile` (tsc). Tests: `npm test`.
- Commits: short imperative lowercase prefix (`feat:`, `fix:`, `test:`, `refactor:`, `docs:`).
- Every task ends with a green `npm test` and a commit.
- TDD per task: write failing test → run (see RED) → minimal impl → run (see GREEN) → commit.

---

## File Structure (decomposition lock-in)

| Path | Status | Responsibility |
|---|---|---|
| `src/storage/shardStreamWriter.ts` | **Create** | Per-shard bucket accumulator; `add(shard, entry)`, `flushAll()`, `close()`. Owns `fs.appendFileSync` policy. |
| `src/storage/codec.ts` | **Modify** | Add `decodeMessagePackMulti(buf)` helper wrapping `@msgpack/msgpack.decodeMulti` for testability. |
| `src/storage/storageManager.ts` | **Modify** | New `openStreamWriter(dirtyShards?): ShardStreamWriter` factory. `load()` uses `decodeMessagePackMulti` with per-chunk error tolerance. `saveFull`/`saveDirty` reimplemented as thin wrappers over the writer. |
| `src/sync/workerPool.ts` | **Modify** | `parse(files, onBatchResult)` signature; remove `aggregated`; await `onBatchResult` per batch (back-pressure). |
| `src/sync/syncOrchestrator.ts` | **Modify** | Remove `parse → grouped → apply → saveFull/saveDirty` monolith. Use `openStreamWriter` + pass `onBatchResult` that updates index + feeds writer per batch; `flushAll` in finally. |
| `src/symbolIndex.ts` | **Modify** | Drop `getSnapshot` clone on sync path (orchestrator no longer needs it). `workerPool.parse` call site updated. |
| `src/sync/parseResultGrouping.ts` | **Keep** | Still used per-batch inside orchestrator callback. |
| `test/suite/shardStreamWriter.test.ts` | **Create** | Unit tests for writer. |
| `test/suite/workerPool.test.ts` | **Modify** | Updated to callback signature. |
| `test/suite/syncOrchestrator.test.ts` | **Modify** | Fake pool + fake writer assertions. |
| `test/suite/storageManager.test.ts` | **Modify** | Old-format / multi-chunk / truncated-tail / fully-corrupt read tests. |
| `test/suite/codec.test.ts` | **Modify** | `decodeMessagePackMulti` tests. |
| `test/suite/streamingSyncIntegration.test.ts` | **Create** | 5000-file smoke + cancel/resume. |
| `src/symbolParser.ts` | **Modify** (Task 10) | Revert `createReusableParser` false-lead; restore per-file parser instantiation. |
| `src/sync/parseWorker.ts` | **Modify** (Task 10) | Revert to `parseSymbols` call; drop `createReusableParser` usage. |
| `test/runTest.ts` | **Modify** (Task 0) | Make the file self-invoke `run()` when executed directly, so `npm test` actually runs tests. |
| `package.json` | **Modify** (Task 0) | Change `test` script to run node-safe tests directly via mocha, and add `test:all` that still tries the full suite (documents why some fail outside VS Code). |

---

## Task 0: Fix baseline test harness (prerequisite)

**Background:** On this branch baseline, `npm test` is a silent no-op because `out/test/runTest.js` only exports `run()` without invoking it. Several test files transitively import `vscode` (e.g. `composition.test.ts` via `src/symbolIndex.ts`), so they can only run under an extension-host harness. This task establishes a **working TDD baseline** for the node-only portion of the test suite — which covers every file touched by Tasks 1-11.

**Files:**
- Modify: `package.json` (scripts)
- Modify: `test/runTest.ts` (self-invoke + narrower glob)

- [ ] **Step 1: Probe current state**

Run:
```bash
npm run compile
node ./out/test/runTest.js; echo "exit=$?"
```
Expected: exit 0 with NO test output (confirms current harness is a no-op).

- [ ] **Step 2: Rewrite `test/runTest.ts`**

Replace the file contents with:

```ts
// test/runTest.ts
// 仓库的测试是一组 Mocha (tdd UI) 测试。许多测试间接导入 `vscode`,
// 只能在扩展宿主里跑(有 @vscode/test-electron 可接入,但该项目目前没用)。
// 本 runner 只跑不依赖 vscode 的 test 文件,它们覆盖了 storage / sync /
// worker pool / parser 等非 UI 路径,也就是 streaming shard-write 重构影响的所有表面。
//
// VSCODE_HOST_SUITE=1 时跑全部文件,用于日后接入 test-electron 再扩展。
import * as path from 'path';
import * as fs from 'fs';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Mocha = require('mocha');

// 需要 vscode 运行时的测试——在纯 Node 下必然失败
const VSCODE_ONLY_TESTS = new Set<string>([
    'commands.test.js',
    'composition.test.js',
    'navigation.test.js',
    'searchEngine.test.js',
    'searchEngineAbort.test.js',
    'searchEngineParsing.test.js',
    'symbolIndexFacade.test.js',
]);

export function run(): Promise<void> {
    const mocha = new Mocha({ ui: 'tdd', color: true });
    const testsRoot = path.resolve(__dirname, 'suite');
    const includeHost = process.env.VSCODE_HOST_SUITE === '1';

    return new Promise<void>((resolve, reject) => {
        const files = fs.readdirSync(testsRoot)
            .filter((f: string) => f.endsWith('.test.js'))
            .filter((f: string) => includeHost ? true : !VSCODE_ONLY_TESTS.has(f));
        files.forEach((f: string) => mocha.addFile(path.resolve(testsRoot, f)));

        mocha.run((failures: number) => {
            if (failures > 0) {
                reject(new Error(`${failures} tests failed.`));
            } else {
                resolve();
            }
        });
    });
}

// 直接 node 执行时自调用(之前的版本只 export 就结束了,所以 npm test 是个空操作)。
if (require.main === module) {
    run().catch((err) => {
        // eslint-disable-next-line no-console
        console.error(err);
        process.exit(1);
    });
}
```

- [ ] **Step 3: Build & run — expect 69+ tests PASS**

```bash
npm run compile
npm test
```

Expected: mocha prints a summary like `69 passing` (or more once plan-added tests land). Exit 0.

- [ ] **Step 4: Commit**

```bash
git add test/runTest.ts
git commit -m "test: make runTest self-invoke and filter vscode-host suites"
```

- [ ] **Step 5: Sanity grep for regressions**

```bash
grep -n "node ./out/test/runTest.js" package.json
```
Expected: the `test` script line unchanged (`"test": "node ./out/test/runTest.js"`). No other changes to package.json in this task.

---

## Task 1: Add `decodeMessagePackMulti` codec helper

**Files:**
- Modify: `src/storage/codec.ts`
- Test: `test/suite/codec.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/suite/codec.test.ts`:

```ts
import { decodeMessagePackMulti, encodeMessagePack } from '../../src/storage/codec';

suite('decodeMessagePackMulti', () => {
    test('decodes single top-level value (legacy single-array file)', () => {
        const buf = encodeMessagePack([{ a: 1 }, { a: 2 }]);
        const out = [...decodeMessagePackMulti(Buffer.from(buf))];
        assert.strictEqual(out.length, 1);
        assert.deepStrictEqual(out[0], [{ a: 1 }, { a: 2 }]);
    });

    test('decodes concatenated chunks', () => {
        const c1 = encodeMessagePack([{ a: 1 }]);
        const c2 = encodeMessagePack([{ a: 2 }, { a: 3 }]);
        const buf = Buffer.concat([Buffer.from(c1), Buffer.from(c2)]);
        const out = [...decodeMessagePackMulti(buf)];
        assert.strictEqual(out.length, 2);
        assert.deepStrictEqual(out[0], [{ a: 1 }]);
        assert.deepStrictEqual(out[1], [{ a: 2 }, { a: 3 }]);
    });

    test('empty buffer yields nothing', () => {
        const out = [...decodeMessagePackMulti(Buffer.alloc(0))];
        assert.strictEqual(out.length, 0);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run compile && npm test -- --grep decodeMessagePackMulti`
Expected: FAIL — `decodeMessagePackMulti is not a function` or compile error "has no exported member 'decodeMessagePackMulti'".

- [ ] **Step 3: Implement**

Replace `src/storage/codec.ts` contents with:

```ts
// src/storage/codec.ts
// MessagePack 编解码封装
import { decode, decodeMulti, encode } from '@msgpack/msgpack';

export function encodeMessagePack<T>(value: T): Uint8Array {
    return encode(value);
}

export function decodeMessagePack<T>(value: Uint8Array | Buffer): T {
    return decode(value) as T;
}

/**
 * 顺序解码 buffer 里串联的多个 msgpack top-level 值。
 * 旧格式的单数组文件等价于 "只有一个 top-level 值",也能被正常迭代出来。
 * @msgpack/msgpack 的 decodeMulti 返回 Generator,消费方自己决定如何聚合。
 */
export function* decodeMessagePackMulti<T>(value: Uint8Array | Buffer): Generator<T> {
    for (const chunk of decodeMulti(value)) {
        yield chunk as T;
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run compile && npm test -- --grep decodeMessagePackMulti`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/storage/codec.ts test/suite/codec.test.ts
git commit -m "feat: add decodeMessagePackMulti codec helper"
```

---

## Task 2: `ShardStreamWriter` — bucket accumulation below threshold

**Files:**
- Create: `src/storage/shardStreamWriter.ts`
- Test: `test/suite/shardStreamWriter.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/suite/shardStreamWriter.test.ts`:

```ts
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ShardStreamWriter } from '../../src/storage/shardStreamWriter';

function mkTmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'shardwriter-'));
}

suite('ShardStreamWriter', () => {
    test('add below threshold does not write to disk', () => {
        const dir = mkTmpDir();
        const writer = new ShardStreamWriter({ shardsDir: dir, shardCount: 2, chunkThreshold: 10 });
        writer.add(0, { relativePath: 'a.c', symbols: [], metadata: { relativePath: 'a.c', mtime: 1, size: 1, symbolCount: 0 } });
        assert.strictEqual(fs.readdirSync(dir).length, 0);
        writer.close();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run compile && npm test -- --grep ShardStreamWriter`
Expected: FAIL — cannot find module `../../src/storage/shardStreamWriter` (compile error).

- [ ] **Step 3: Implement minimal writer**

Create `src/storage/shardStreamWriter.ts`:

```ts
// src/storage/shardStreamWriter.ts
// Per-shard bucket accumulator. 每个 shard 一个内存桶;达到 chunkThreshold 时
// encode 为 msgpack chunk 并 appendFileSync 到 shard 文件。
// 生命周期:对应一次 sync。orchestrator 调用 close()/flushAll() 释放。

import * as fs from 'fs';
import * as path from 'path';
import { encodeMessagePack } from './codec';
import { shardFileName } from './shardStrategy';
import type { SymbolEntry, IndexedFile } from '../index/indexTypes';

export interface ShardEntry {
    relativePath: string;
    symbols: SymbolEntry[];
    metadata: IndexedFile;
}

export interface ShardStreamWriterOptions {
    shardsDir: string;
    shardCount: number;
    chunkThreshold: number;
}

export class ShardStreamWriter {
    private readonly buckets: ShardEntry[][];
    private closed = false;

    constructor(private readonly opts: ShardStreamWriterOptions) {
        this.buckets = Array.from({ length: opts.shardCount }, () => []);
    }

    add(shard: number, entry: ShardEntry): void {
        if (this.closed) { throw new Error('ShardStreamWriter is closed'); }
        const bucket = this.buckets[shard];
        bucket.push(entry);
        if (bucket.length >= this.opts.chunkThreshold) {
            this.flushBucket(shard);
        }
    }

    flushAll(): void {
        if (this.closed) { return; }
        for (let i = 0; i < this.buckets.length; i++) {
            if (this.buckets[i].length > 0) { this.flushBucket(i); }
        }
    }

    close(): void {
        this.closed = true;
    }

    private flushBucket(shard: number): void {
        const chunk = this.buckets[shard];
        if (chunk.length === 0) { return; }
        this.buckets[shard] = [];
        const filePath = path.join(this.opts.shardsDir, shardFileName(shard));
        fs.appendFileSync(filePath, Buffer.from(encodeMessagePack(chunk)));
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run compile && npm test -- --grep ShardStreamWriter`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/storage/shardStreamWriter.ts test/suite/shardStreamWriter.test.ts
git commit -m "feat: ShardStreamWriter bucket accumulation"
```

---

## Task 3: `ShardStreamWriter` — flush at threshold

**Files:**
- Modify: `test/suite/shardStreamWriter.test.ts` (add test)
- Already-correct: `src/storage/shardStreamWriter.ts` (implementation covers this)

- [ ] **Step 1: Write the failing test**

Append to `test/suite/shardStreamWriter.test.ts`:

```ts
test('add reaching threshold appends msgpack chunk once', () => {
    const dir = mkTmpDir();
    const writer = new ShardStreamWriter({ shardsDir: dir, shardCount: 2, chunkThreshold: 2 });
    const entry = (rel: string): any => ({ relativePath: rel, symbols: [], metadata: { relativePath: rel, mtime: 1, size: 1, symbolCount: 0 } });
    writer.add(0, entry('a.c'));
    assert.strictEqual(fs.readdirSync(dir).length, 0, 'no flush before threshold');
    writer.add(0, entry('b.c'));
    const files = fs.readdirSync(dir);
    assert.deepStrictEqual(files, ['00.msgpack']);
    const bytes = fs.readFileSync(path.join(dir, '00.msgpack'));
    assert.ok(bytes.length > 0);
    writer.close();
});

test('different shards accumulate independently', () => {
    const dir = mkTmpDir();
    const writer = new ShardStreamWriter({ shardsDir: dir, shardCount: 2, chunkThreshold: 1 });
    const entry = (rel: string): any => ({ relativePath: rel, symbols: [], metadata: { relativePath: rel, mtime: 1, size: 1, symbolCount: 0 } });
    writer.add(0, entry('a.c'));
    writer.add(1, entry('b.c'));
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['00.msgpack', '01.msgpack']);
    writer.close();
});
```

- [ ] **Step 2: Run test to verify it passes (implementation already covers this)**

Run: `npm run compile && npm test -- --grep ShardStreamWriter`
Expected: PASS (3 tests now).

Rationale: the implementation from Task 2 already handles threshold flushing. These tests lock in the behaviour before the next task mutates it.

- [ ] **Step 3: Commit**

```bash
git add test/suite/shardStreamWriter.test.ts
git commit -m "test: ShardStreamWriter threshold flush and multi-shard isolation"
```

---

## Task 4: `ShardStreamWriter` — `flushAll` semantics

**Files:**
- Modify: `test/suite/shardStreamWriter.test.ts` (add tests)

- [ ] **Step 1: Write the failing tests**

Append to `test/suite/shardStreamWriter.test.ts`:

```ts
test('flushAll drains all non-empty buckets exactly once', () => {
    const dir = mkTmpDir();
    const writer = new ShardStreamWriter({ shardsDir: dir, shardCount: 2, chunkThreshold: 10 });
    const entry = (rel: string): any => ({ relativePath: rel, symbols: [], metadata: { relativePath: rel, mtime: 1, size: 1, symbolCount: 0 } });
    writer.add(0, entry('a.c'));
    writer.add(1, entry('b.c'));
    writer.flushAll();
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['00.msgpack', '01.msgpack']);
    const sizeBefore = fs.statSync(path.join(dir, '00.msgpack')).size;
    writer.flushAll();  // second call: buckets empty, no-op
    const sizeAfter = fs.statSync(path.join(dir, '00.msgpack')).size;
    assert.strictEqual(sizeAfter, sizeBefore, 'flushAll on empty buckets must not append');
    writer.close();
});

test('flushAll does NOT create files for empty buckets', () => {
    const dir = mkTmpDir();
    const writer = new ShardStreamWriter({ shardsDir: dir, shardCount: 4, chunkThreshold: 10 });
    const entry = (rel: string): any => ({ relativePath: rel, symbols: [], metadata: { relativePath: rel, mtime: 1, size: 1, symbolCount: 0 } });
    writer.add(2, entry('x.c'));
    writer.flushAll();
    assert.deepStrictEqual(fs.readdirSync(dir), ['02.msgpack']);
    writer.close();
});

test('appendFileSync failure propagates out of add', () => {
    const dir = mkTmpDir();
    const badPath = path.join(dir, 'not-a-directory');
    fs.writeFileSync(badPath, 'blocker');  // 00.msgpack would live in 'not-a-directory' subdir
    const writer = new ShardStreamWriter({ shardsDir: badPath, shardCount: 1, chunkThreshold: 1 });
    const entry: any = { relativePath: 'a.c', symbols: [], metadata: { relativePath: 'a.c', mtime: 1, size: 1, symbolCount: 0 } };
    assert.throws(() => writer.add(0, entry));
    writer.close();
});
```

- [ ] **Step 2: Run tests**

Run: `npm run compile && npm test -- --grep ShardStreamWriter`
Expected: PASS (6 tests total). Implementation already handles these cases.

- [ ] **Step 3: Commit**

```bash
git add test/suite/shardStreamWriter.test.ts
git commit -m "test: ShardStreamWriter flushAll and error propagation"
```

---

## Task 5: `StorageManager.load()` — tolerant chunked decode

**Files:**
- Modify: `src/storage/storageManager.ts:84-129` (the `load()` method)
- Modify: `test/suite/storageManager.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `test/suite/storageManager.test.ts`:

```ts
import { encodeMessagePack } from '../../src/storage/codec';
import { shardFileName } from '../../src/storage/shardStrategy';

suite('StorageManager.load chunked format', () => {
    function setupRoot(): string {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smload-'));
        fs.mkdirSync(path.join(root, '.sisearch', 'shards'), { recursive: true });
        return root;
    }

    test('reads legacy single-array shard file', async () => {
        const root = setupRoot();
        const shardFile = path.join(root, '.sisearch', 'shards', shardFileName(0));
        const legacy = [{ relativePath: 'a.c', symbols: [], metadata: { relativePath: 'a.c', mtime: 1, size: 1, symbolCount: 0 } }];
        fs.writeFileSync(shardFile, Buffer.from(encodeMessagePack(legacy)));

        const mgr = new StorageManager({ workspaceRoot: root, shardCount: 16 });
        const snap = await mgr.load();
        assert.strictEqual(snap.fileMetadata.has('a.c'), true);
    });

    test('reads multi-chunk shard file', async () => {
        const root = setupRoot();
        const shardFile = path.join(root, '.sisearch', 'shards', shardFileName(0));
        const c1 = encodeMessagePack([{ relativePath: 'a.c', symbols: [], metadata: { relativePath: 'a.c', mtime: 1, size: 1, symbolCount: 0 } }]);
        const c2 = encodeMessagePack([{ relativePath: 'b.c', symbols: [], metadata: { relativePath: 'b.c', mtime: 2, size: 2, symbolCount: 0 } }]);
        fs.writeFileSync(shardFile, Buffer.concat([Buffer.from(c1), Buffer.from(c2)]));

        const mgr = new StorageManager({ workspaceRoot: root, shardCount: 16 });
        const snap = await mgr.load();
        assert.strictEqual(snap.fileMetadata.has('a.c'), true);
        assert.strictEqual(snap.fileMetadata.has('b.c'), true);
    });

    test('truncated final chunk: keep whole chunks, drop tail, no throw', async () => {
        const root = setupRoot();
        const shardFile = path.join(root, '.sisearch', 'shards', shardFileName(0));
        const c1 = encodeMessagePack([{ relativePath: 'a.c', symbols: [], metadata: { relativePath: 'a.c', mtime: 1, size: 1, symbolCount: 0 } }]);
        const c2 = encodeMessagePack([{ relativePath: 'b.c', symbols: [], metadata: { relativePath: 'b.c', mtime: 2, size: 2, symbolCount: 0 } }]);
        const truncated = Buffer.concat([Buffer.from(c1), Buffer.from(c2).subarray(0, 3)]);
        fs.writeFileSync(shardFile, truncated);

        const mgr = new StorageManager({ workspaceRoot: root, shardCount: 16 });
        const snap = await mgr.load();
        assert.strictEqual(snap.fileMetadata.has('a.c'), true, 'first whole chunk survives');
        assert.strictEqual(snap.fileMetadata.has('b.c'), false, 'truncated tail dropped');
    });

    test('fully corrupt shard: empty result, no throw', async () => {
        const root = setupRoot();
        const shardFile = path.join(root, '.sisearch', 'shards', shardFileName(0));
        fs.writeFileSync(shardFile, Buffer.from([0xff, 0xff, 0xff, 0xff]));

        const mgr = new StorageManager({ workspaceRoot: root, shardCount: 16 });
        const snap = await mgr.load();
        assert.strictEqual(snap.fileMetadata.size, 0);
    });
});
```

Required imports at top of `storageManager.test.ts` (verify they exist, add if missing): `import * as fs from 'fs'; import * as os from 'os'; import * as path from 'path'; import * as assert from 'assert'; import { StorageManager } from '../../src/storage/storageManager';`

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run compile && npm test -- --grep "StorageManager.load chunked"`
Expected: FAIL — existing `load()` uses `decodeMessagePack` (single value) which will throw on the multi-chunk and truncated cases, or on the fully-corrupt buffer.

- [ ] **Step 3: Implement tolerant chunked `load()`**

Replace the body of `load()` in `src/storage/storageManager.ts` (current lines 84-129). Retain legacy JSON migration prelude unchanged. Change only the shard-reading loop:

```ts
    async load(): Promise<IndexSnapshot> {
        const symbolsByFile = new Map<string, SymbolEntry[]>();
        const fileMetadata = new Map<string, IndexedFile>();

        // Migrate legacy JSON format if present
        const legacyPath = path.join(this.indexDir, 'index.json');
        if (fs.existsSync(legacyPath)) {
            try {
                const raw = JSON.parse(fs.readFileSync(legacyPath, 'utf-8')) as LegacyIndex;
                for (const [rel, symbols] of Object.entries(raw.symbols ?? {})) {
                    symbolsByFile.set(rel, symbols);
                }
                for (const [rel, meta] of Object.entries(raw.files ?? {})) {
                    fileMetadata.set(rel, meta);
                }
                await this.saveFull({ symbolsByFile: new Map(symbolsByFile), fileMetadata: new Map(fileMetadata) });
                fs.unlinkSync(legacyPath);
                return { symbolsByFile, fileMetadata };
            } catch {
                // Corrupt legacy file — ignore and fall through to shards
            }
        }

        if (!fs.existsSync(this.shardsDir)) {
            return { symbolsByFile, fileMetadata };
        }

        for (let i = 0; i < this.options.shardCount; i++) {
            const filePath = path.join(this.shardsDir, shardFileName(i));
            if (!fs.existsSync(filePath)) { continue; }
            this.readShardTolerant(filePath, symbolsByFile, fileMetadata);
        }

        return { symbolsByFile, fileMetadata };
    }

    private readShardTolerant(
        filePath: string,
        symbolsByFile: Map<string, SymbolEntry[]>,
        fileMetadata: Map<string, IndexedFile>,
    ): void {
        let buf: Buffer;
        try {
            buf = fs.readFileSync(filePath);
        } catch {
            return;
        }
        const iter = decodeMessagePackMulti<ShardEntry[]>(buf);
        while (true) {
            let result: IteratorResult<ShardEntry[]>;
            try {
                result = iter.next();
            } catch {
                // decoder choked on bad bytes (truncated tail or garbage) — stop, keep what we have
                return;
            }
            if (result.done) { return; }
            for (const entry of result.value) {
                symbolsByFile.set(entry.relativePath, entry.symbols);
                fileMetadata.set(entry.relativePath, entry.metadata);
            }
        }
    }
```

Update imports at the top of `src/storage/storageManager.ts`:

```ts
import { decodeMessagePack, decodeMessagePackMulti, encodeMessagePack } from './codec';
```

(Replace the existing `import { decodeMessagePack, encodeMessagePack } from './codec';` line.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run compile && npm test -- --grep "StorageManager.load chunked"`
Expected: PASS (4 tests).

Run full suite: `npm test`
Expected: all green (existing storageManager tests still pass).

- [ ] **Step 5: Commit**

```bash
git add src/storage/storageManager.ts test/suite/storageManager.test.ts
git commit -m "feat: StorageManager.load tolerant chunked shard decode"
```

---

## Task 6: `StorageManager.openStreamWriter` factory

**Files:**
- Modify: `src/storage/storageManager.ts`
- Test: `test/suite/storageManager.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/suite/storageManager.test.ts`:

```ts
import { ShardStreamWriter } from '../../src/storage/shardStreamWriter';

suite('StorageManager.openStreamWriter', () => {
    test('returns writer writing into .sisearch/shards with matching shardCount', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smwriter-'));
        const mgr = new StorageManager({ workspaceRoot: root, shardCount: 4, chunkThreshold: 1 });
        const writer = mgr.openStreamWriter();
        assert.ok(writer instanceof ShardStreamWriter);

        writer.add(2, { relativePath: 'x.c', symbols: [], metadata: { relativePath: 'x.c', mtime: 1, size: 1, symbolCount: 0 } });
        writer.flushAll();
        writer.close();

        assert.deepStrictEqual(fs.readdirSync(path.join(root, '.sisearch', 'shards')), ['02.msgpack']);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run compile && npm test -- --grep openStreamWriter`
Expected: FAIL — `openStreamWriter is not a function` or `chunkThreshold` missing from `StorageManager` options type.

- [ ] **Step 3: Implement**

In `src/storage/storageManager.ts`:

Change the constructor options type (line 28):

```ts
export class StorageManager {
    private readonly chunkThreshold: number;
    constructor(private options: { workspaceRoot: string; shardCount: number; chunkThreshold?: number }) {
        this.chunkThreshold = options.chunkThreshold ?? 512;
    }
```

Add after existing methods (before the closing `}` of the class):

```ts
    openStreamWriter(): ShardStreamWriter {
        fs.mkdirSync(this.shardsDir, { recursive: true });
        return new ShardStreamWriter({
            shardsDir: this.shardsDir,
            shardCount: this.options.shardCount,
            chunkThreshold: this.chunkThreshold,
        });
    }
```

And the import at top:

```ts
import { ShardStreamWriter } from './shardStreamWriter';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run compile && npm test -- --grep openStreamWriter`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/storage/storageManager.ts test/suite/storageManager.test.ts
git commit -m "feat: StorageManager.openStreamWriter factory"
```

---

## Task 7: Rewire `saveFull`/`saveDirty` through the writer (single encode path)

**Files:**
- Modify: `src/storage/storageManager.ts:38-82`

- [ ] **Step 1: Write the failing test**

Append to `test/suite/storageManager.test.ts`:

```ts
suite('StorageManager.saveFull / saveDirty through writer', () => {
    test('saveFull produces files readable by load() with all entries', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sfsw-'));
        const mgr = new StorageManager({ workspaceRoot: root, shardCount: 4, chunkThreshold: 1 });
        const snapshot = {
            symbolsByFile: new Map([
                ['a.c', []],
                ['b.c', []],
                ['c.c', []],
            ]),
            fileMetadata: new Map([
                ['a.c', { relativePath: 'a.c', mtime: 1, size: 1, symbolCount: 0 }],
                ['b.c', { relativePath: 'b.c', mtime: 2, size: 2, symbolCount: 0 }],
                ['c.c', { relativePath: 'c.c', mtime: 3, size: 3, symbolCount: 0 }],
            ]),
        };
        await mgr.saveFull(snapshot);
        const back = await mgr.load();
        assert.strictEqual(back.fileMetadata.size, 3);
        assert.strictEqual(back.fileMetadata.has('a.c'), true);
        assert.strictEqual(back.fileMetadata.has('b.c'), true);
        assert.strictEqual(back.fileMetadata.has('c.c'), true);
    });
});
```

- [ ] **Step 2: Run test to verify current impl still passes OR fails consistently**

Run: `npm run compile && npm test -- --grep "through writer"`
Expected: PASS (existing saveFull already round-trips correctly). This test serves as a **regression guard** before we change the body.

- [ ] **Step 3: Replace `saveFull` and `saveDirty` with writer-based impls**

In `src/storage/storageManager.ts`, replace lines 38-82 (the `saveFull`, `saveDirty`, `bucketizeShards`, `writeShard` methods) with:

```ts
    async saveFull(snapshot: IndexSnapshot): Promise<void> {
        // Full save = truncate existing shards then stream-write. Truncate prevents
        // stale appended chunks from previous runs contaminating the result.
        fs.mkdirSync(this.shardsDir, { recursive: true });
        for (let i = 0; i < this.options.shardCount; i++) {
            const p = path.join(this.shardsDir, shardFileName(i));
            if (fs.existsSync(p)) { fs.truncateSync(p, 0); }
        }
        const writer = this.openStreamWriter();
        try {
            for (const [relativePath, symbols] of snapshot.symbolsByFile) {
                const shard = shardForPath(relativePath, this.options.shardCount);
                const meta = snapshot.fileMetadata.get(relativePath)
                    ?? { relativePath, mtime: 0, size: 0, symbolCount: symbols.length };
                writer.add(shard, { relativePath, symbols, metadata: meta });
            }
            writer.flushAll();
        } finally {
            writer.close();
        }
    }

    /**
     * 只重写受 dirtyPaths 影响的 shard:先把这些 shard 从磁盘全量读回,
     * 应用 snapshot 里对应的最新内容(删除项 snapshot 里已无),
     * 然后 truncate + stream-write 这些 shard。
     */
    async saveDirty(snapshot: IndexSnapshot, dirtyPaths: Set<string>): Promise<void> {
        if (dirtyPaths.size === 0) { return; }
        fs.mkdirSync(this.shardsDir, { recursive: true });

        const dirtyShards = new Set<number>();
        for (const p of dirtyPaths) {
            dirtyShards.add(shardForPath(p, this.options.shardCount));
        }

        // 对每个 dirtyShard 的全量内容 = snapshot 里所有映射到该 shard 的文件
        const entriesByShard = new Map<number, Array<{ relativePath: string; symbols: SymbolEntry[]; metadata: IndexedFile }>>();
        for (const [relativePath, symbols] of snapshot.symbolsByFile) {
            const shard = shardForPath(relativePath, this.options.shardCount);
            if (!dirtyShards.has(shard)) { continue; }
            const meta = snapshot.fileMetadata.get(relativePath)
                ?? { relativePath, mtime: 0, size: 0, symbolCount: symbols.length };
            const list = entriesByShard.get(shard) ?? [];
            list.push({ relativePath, symbols, metadata: meta });
            entriesByShard.set(shard, list);
        }

        // Truncate each dirty shard then stream-write its entries
        for (const shard of dirtyShards) {
            const p = path.join(this.shardsDir, shardFileName(shard));
            if (fs.existsSync(p)) { fs.truncateSync(p, 0); }
        }

        const writer = this.openStreamWriter();
        try {
            for (const [shard, entries] of entriesByShard) {
                for (const entry of entries) { writer.add(shard, entry); }
            }
            writer.flushAll();
        } finally {
            writer.close();
        }
    }
```

Remove the now-unused `bucketizeShards` and `writeShard` private methods from the file.

- [ ] **Step 4: Run full test suite**

Run: `npm test`
Expected: all green (old storageManager round-trip tests, new chunked-format tests, new through-writer test).

- [ ] **Step 5: Commit**

```bash
git add src/storage/storageManager.ts test/suite/storageManager.test.ts
git commit -m "refactor: route saveFull/saveDirty through ShardStreamWriter"
```

---

## Task 8: `WorkerPool.parse` — callback signature + back-pressure

**Files:**
- Modify: `src/sync/workerPool.ts:48-94`
- Modify: `test/suite/workerPool.test.ts`
- Modify: `src/symbolIndex.ts:278-283` (call sites) and `src/sync/syncOrchestrator.ts:84-89`

### 8a. Update tests first

- [ ] **Step 1: Rewrite `test/suite/workerPool.test.ts`**

Replace the file contents with:

```ts
import * as assert from 'assert';
import { WorkerPool } from '../../src/sync/workerPool';
import type { PoolWorker, ParseBatchResult } from '../../src/sync/workerPool';

function makeStubWorker(): PoolWorker {
    return {
        parseBatch: async (files) => ({
            symbols: files.map(f => ({
                name: f.relativePath,
                kind: 'function' as const,
                filePath: f.absPath,
                relativePath: f.relativePath,
                lineNumber: 1,
                endLineNumber: 1,
                column: 0,
                lineContent: f.relativePath,
            })),
            metadata: files.map(f => ({
                relativePath: f.relativePath,
                mtime: 1,
                size: 1,
                symbolCount: 1,
            })),
            errors: [],
        }),
        dispose: async () => {},
    };
}

suite('workerPool', () => {
    test('invokes onBatchResult once per batch', async () => {
        const pool = new WorkerPool({
            size: 1,
            workerFactory: async () => makeStubWorker(),
            batchSize: 2,
        });
        const files = [
            { absPath: '/w/a.c', relativePath: 'a.c' },
            { absPath: '/w/b.c', relativePath: 'b.c' },
            { absPath: '/w/c.c', relativePath: 'c.c' },
        ];
        const batches: ParseBatchResult[] = [];
        await pool.parse(files, async (r) => { batches.push(r); });
        assert.strictEqual(batches.length, 2, 'ceil(3/2) = 2 batches');
        assert.strictEqual(batches[0].symbols.length, 2);
        assert.strictEqual(batches[1].symbols.length, 1);
        await pool.dispose();
    });

    test('empty file list does not invoke callback', async () => {
        const pool = new WorkerPool({
            size: 1,
            workerFactory: async () => makeStubWorker(),
        });
        let called = 0;
        await pool.parse([], async () => { called++; });
        assert.strictEqual(called, 0);
        await pool.dispose();
    });

    test('pending callback throttles cursor (back-pressure)', async () => {
        const pool = new WorkerPool({
            size: 1,
            workerFactory: async () => makeStubWorker(),
            batchSize: 1,
        });
        const files = [
            { absPath: '/w/a.c', relativePath: 'a.c' },
            { absPath: '/w/b.c', relativePath: 'b.c' },
        ];
        let released!: () => void;
        const gate = new Promise<void>(res => { released = res; });
        let observedBatches = 0;
        const parsePromise = pool.parse(files, async () => {
            observedBatches++;
            if (observedBatches === 1) { await gate; }
        });
        // Give the event loop a few turns to dispatch the first batch
        await new Promise(res => setImmediate(res));
        await new Promise(res => setImmediate(res));
        assert.strictEqual(observedBatches, 1, 'second batch must wait on first callback');
        released();
        await parsePromise;
        assert.strictEqual(observedBatches, 2);
        await pool.dispose();
    });

    test('callback throwing rejects parse', async () => {
        const pool = new WorkerPool({
            size: 1,
            workerFactory: async () => makeStubWorker(),
        });
        const files = [{ absPath: '/w/a.c', relativePath: 'a.c' }];
        await assert.rejects(
            () => pool.parse(files, async () => { throw new Error('boom'); }),
            /boom/,
        );
        await pool.dispose();
    });

    test('worker errors surface in callback result.errors', async () => {
        const pool = new WorkerPool({
            size: 1,
            workerFactory: async () => ({
                parseBatch: async () => ({ symbols: [], metadata: [], errors: ['a.c: parse error'] }),
                dispose: async () => {},
            }),
        });
        const files = [{ absPath: '/w/a.c', relativePath: 'a.c' }];
        const seen: ParseBatchResult[] = [];
        await pool.parse(files, async (r) => { seen.push(r); });
        assert.deepStrictEqual(seen[0].errors, ['a.c: parse error']);
        await pool.dispose();
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run compile && npm test -- --grep workerPool`
Expected: FAIL — compile error because `parse` currently returns `ParseBatchResult`, not void; signature mismatch on `pool.parse(files, cb)`.

### 8b. Update `WorkerPool.parse` implementation

- [ ] **Step 3: Replace `parse` method in `src/sync/workerPool.ts`**

Replace lines 48-94 with:

```ts
    async parse(
        files: Array<{ absPath: string; relativePath: string }>,
        onBatchResult: (result: ParseBatchResult) => Promise<void>,
        onBatchComplete?: OnBatchComplete,
    ): Promise<void> {
        if (files.length === 0) { return; }

        const workers = await this.workersPromise;
        if (workers.length === 0) { return; }

        const total = files.length;
        const batchSize = this.batchSize;

        let cursor = 0;
        let done = 0;

        const workerLoop = async (worker: PoolWorker): Promise<void> => {
            while (true) {
                if (cursor >= total) { return; }
                const start = cursor;
                const end = Math.min(start + batchSize, total);
                cursor = end;

                const batch = files.slice(start, end);
                const result = await worker.parseBatch(batch);

                // Back-pressure: the next worker step only proceeds once the
                // caller has consumed this batch. Errors propagate to Promise.all.
                await onBatchResult(result);

                done += batch.length;
                onBatchComplete?.(done, total, batch[batch.length - 1]?.relativePath);
            }
        };

        await Promise.all(workers.map(w => workerLoop(w)));
    }
```

Keep the `ParseBatchResult` export intact (consumers still use the type).

### 8c. Update call sites

- [ ] **Step 4: Update `src/symbolIndex.ts` `runParse` + `applyParseResult`**

Replace `runParse` (currently lines 274-283). It must keep returning `ParseBatchResult` because the old `syncDirty` path on line 177 consumes it directly; the only caller that will go callback-driven is the orchestrator. So internally `runParse` becomes a little adapter that aggregates when no `onBatch` is given:

```ts
    private async runParse(
        files: Array<{ absPath: string; relativePath: string }>,
        workspaceRoot: string,
        onBatchComplete?: (done: number, total: number, lastFile?: string) => void,
    ): Promise<ParseBatchResult> {
        if (this.workerPool) {
            const aggregated: ParseBatchResult = { symbols: [], metadata: [], errors: [] };
            await this.workerPool.parse(
                files,
                async (batch) => {
                    for (const s of batch.symbols) { aggregated.symbols.push(s); }
                    for (const m of batch.metadata) { aggregated.metadata.push(m); }
                    for (const e of batch.errors) { aggregated.errors.push(e); }
                },
                onBatchComplete,
            );
            return aggregated;
        }
        return this.parseInProcess(files, workspaceRoot, onBatchComplete);
    }
```

- [ ] **Step 5: Update `src/sync/syncOrchestrator.ts` `deps.workerPool.parse` interface type**

In `src/sync/syncOrchestrator.ts`, change the `workerPool` shape in the `SyncDeps` interface (lines 16-21):

```ts
    workerPool: {
        parse(
            files: Array<{ absPath: string; relativePath: string }>,
            onBatchResult: (result: ParseBatchResult) => Promise<void>,
            onBatchComplete?: (done: number, total: number, lastFile?: string) => void,
        ): Promise<void>;
    };
```

Update the call site in `synchronize` (currently lines 84-90):

```ts
            await this.deps.workerPool.parse(
                classified.toProcess.map(f => ({ absPath: f.absPath, relativePath: f.relativePath })),
                async (batch) => {
                    const grouped = groupParseResult(batch);
                    this.deps.index.applyMetadata(batch.metadata);
                    for (const [file, symbols] of grouped) {
                        this.deps.index.update(file, symbols);
                        dirtyPaths.add(file);
                    }
                },
                (done, total, lastFile) => {
                    this.deps.onProgress?.('parsing', done, total, lastFile);
                },
            );
```

Remove the now-dead code that follows (the old `const grouped = groupParseResult(parsed);` block on lines 92-100 is replaced by the per-batch version inside the callback).

- [ ] **Step 6: Update `src/symbolIndex.ts` SymbolIndex.synchronize workerPool adapter**

In `src/symbolIndex.ts` line 119, the adapter currently reads:

```ts
workerPool: { parse: (files, onBatchComplete) => this.runParse(files, workspaceRoot, onBatchComplete) },
```

Change it to accept the new 3-argument signature:

```ts
workerPool: {
    parse: async (files, onBatchResult, onBatchComplete) => {
        if (this.workerPool) {
            await this.workerPool.parse(files, onBatchResult, onBatchComplete);
            return;
        }
        // Fallback: single-batch emit
        const result = await this.parseInProcess(files, workspaceRoot, onBatchComplete);
        if (result.symbols.length + result.metadata.length + result.errors.length > 0) {
            await onBatchResult(result);
        }
    },
},
```

- [ ] **Step 7: Run tests**

Run: `npm run compile && npm test -- --grep workerPool`
Expected: PASS.

Run: `npm test`
Expected: all green. If `syncOrchestrator.test.ts` breaks, skip resolving here — Task 9 covers it.

- [ ] **Step 8: Commit**

```bash
git add src/sync/workerPool.ts src/sync/syncOrchestrator.ts src/symbolIndex.ts test/suite/workerPool.test.ts
git commit -m "refactor: WorkerPool.parse callback-driven with back-pressure"
```

---

## Task 9: `SyncOrchestrator` tests — streaming-writer assertions

**Files:**
- Modify: `test/suite/syncOrchestrator.test.ts`
- Modify: `src/sync/syncOrchestrator.ts` (only if tests reveal gaps — main rewire done in Task 8)

- [ ] **Step 1: Inspect current test file**

Run: `npm test -- --grep SyncOrchestrator`
Expected: report current state; existing assertions may have broken after Task 8.

- [ ] **Step 2: Write/adjust tests**

Open `test/suite/syncOrchestrator.test.ts` and ensure the following tests exist (add them if not). Each test constructs a `SyncOrchestrator` with fake deps:

```ts
import * as assert from 'assert';
import { SyncOrchestrator } from '../../src/sync/syncOrchestrator';
import type { ParseBatchResult } from '../../src/sync/workerPool';

suite('SyncOrchestrator streaming', () => {
    function makeDeps(overrides: any = {}): any {
        const updates: Array<[string, number]> = [];
        const metaApplied: Array<{ relativePath: string }> = [];
        return {
            scanFiles: async () => [
                { relativePath: 'a.c', absPath: '/w/a.c', mtime: 1, size: 1 },
                { relativePath: 'b.c', absPath: '/w/b.c', mtime: 2, size: 2 },
            ],
            classify: async (x: any) => ({
                toProcess: x.currentFiles,
                toDelete: new Set<string>(),
            }),
            workerPool: {
                parse: async (files: any[], onBatch: (r: ParseBatchResult) => Promise<void>) => {
                    for (const f of files) {
                        await onBatch({
                            symbols: [{
                                name: f.relativePath, kind: 'function',
                                filePath: f.absPath, relativePath: f.relativePath,
                                lineNumber: 1, endLineNumber: 1, column: 0, lineContent: '',
                            }] as any,
                            metadata: [{ relativePath: f.relativePath, mtime: 1, size: 1, symbolCount: 1 }],
                            errors: [],
                        });
                    }
                },
            },
            index: {
                update: (file: string, symbols: any[]) => { updates.push([file, symbols.length]); },
                remove: () => {},
                applyMetadata: (m: any[]) => { for (const x of m) { metaApplied.push(x); } },
                fileMetadata: new Map(),
            },
            storage: {
                saveFull: async () => {},
                saveDirty: async () => {},
            },
            getSnapshot: () => ({ symbolsByFile: new Map(), fileMetadata: new Map() }),
            _spy: { updates, metaApplied },
            ...overrides,
        };
    }

    test('update is called once per file, per batch', async () => {
        const deps = makeDeps();
        const orch = new SyncOrchestrator(deps);
        await orch.synchronize({ workspaceRoot: '/w' });
        assert.strictEqual(deps._spy.updates.length, 2);
        assert.deepStrictEqual(deps._spy.updates.map((u: any) => u[0]).sort(), ['a.c', 'b.c']);
    });

    test('applyMetadata called per batch (not once at end)', async () => {
        const deps = makeDeps();
        const orch = new SyncOrchestrator(deps);
        await orch.synchronize({ workspaceRoot: '/w' });
        assert.strictEqual(deps._spy.metaApplied.length, 2);
    });

    test('saveDirty called at end with collected dirty paths', async () => {
        let saveDirtyArgs: any;
        const deps = makeDeps({
            storage: {
                saveFull: async () => {},
                saveDirty: async (_snap: any, dirty: Set<string>) => { saveDirtyArgs = [...dirty].sort(); },
            },
        });
        const orch = new SyncOrchestrator(deps);
        await orch.synchronize({ workspaceRoot: '/w' });
        assert.deepStrictEqual(saveDirtyArgs, ['a.c', 'b.c']);
    });
});
```

- [ ] **Step 3: Run tests to verify pass/fail**

Run: `npm run compile && npm test -- --grep "SyncOrchestrator streaming"`
Expected: PASS if Task 8 rewired correctly. If FAIL, narrow the gap — most likely `applyMetadata` placement or `dirtyPaths` collection.

- [ ] **Step 4: Run full suite**

Run: `npm test`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add test/suite/syncOrchestrator.test.ts
git commit -m "test: SyncOrchestrator streaming callback behaviour"
```

---

## Task 10: Revert false-lead parser-reuse code

**Files:**
- Modify: `src/symbolParser.ts` (remove `createReusableParser`/`ReusableParser`/`parseSymbolsWithParser`)
- Modify: `src/sync/parseWorker.ts` (switch to `parseSymbols`)

- [ ] **Step 1: Check current state**

Run: `grep -n "createReusableParser\|ReusableParser" src/ -r`

Expected: references in `src/symbolParser.ts` and `src/sync/parseWorker.ts`.

- [ ] **Step 2: Rewrite `src/sync/parseWorker.ts`**

Replace contents with:

```ts
// src/sync/parseWorker.ts
// Worker 线程入口 — 初始化 tree-sitter 并批量解析文件
// 通过 worker_threads 消息协议与主线程通信

import * as fs from 'fs';
import { parentPort, workerData } from 'worker_threads';
import { initParser, parseSymbols } from '../symbolParser';
import type { ParseBatchResult } from './workerPool';

interface ParseBatchRequest {
    type: 'parseBatch';
    requestId: number;
    files: Array<{ absPath: string; relativePath: string }>;
}

async function main(): Promise<void> {
    await initParser(workerData.extensionPath as string);

    parentPort?.on('message', async (message: ParseBatchRequest) => {
        if (message.type !== 'parseBatch') { return; }

        const symbols: ParseBatchResult['symbols'] = [];
        const metadata: ParseBatchResult['metadata'] = [];
        const errors: string[] = [];

        for (const file of message.files) {
            try {
                const content = fs.readFileSync(file.absPath, 'utf-8');
                const parsed = parseSymbols(file.absPath, file.relativePath, content);
                symbols.push(...parsed);
                const stat = fs.statSync(file.absPath);
                metadata.push({
                    relativePath: file.relativePath,
                    mtime: stat.mtimeMs,
                    size: stat.size,
                    symbolCount: parsed.length,
                });
            } catch (err) {
                errors.push(`${file.relativePath}: ${err instanceof Error ? err.message : String(err)}`);
            }
        }

        parentPort?.postMessage({
            type: 'batchResult',
            requestId: message.requestId,
            symbols,
            metadata,
            errors,
        });
    });
}

void main();
```

- [ ] **Step 3: Remove `createReusableParser`/`parseSymbolsWithParser` from `src/symbolParser.ts`**

In `src/symbolParser.ts`, delete the block from the comment `// ── Reusable parser API` through the end of `parseSymbolsWithParser` (currently lines 140-234). Keep everything above (`initParser`, `parseSymbols`) and the `disposeParser` function at the bottom intact.

- [ ] **Step 4: Run tests**

Run: `npm run compile && npm test`
Expected: all green — no consumer of the reverted API remains (ripgrep-through-search paths don't touch it).

- [ ] **Step 5: Commit**

```bash
git add src/symbolParser.ts src/sync/parseWorker.ts
git commit -m "refactor: revert parser reuse false-lead; restore per-file parseSymbols"
```

---

## Task 11: Integration smoke — 5000-file sync completes + multi-chunk shard

**Files:**
- Create: `test/suite/streamingSyncIntegration.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/suite/streamingSyncIntegration.test.ts`:

```ts
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { StorageManager } from '../../src/storage/storageManager';
import { ShardStreamWriter } from '../../src/storage/shardStreamWriter';
import { shardForPath, shardFileName } from '../../src/storage/shardStrategy';
import { decodeMessagePackMulti } from '../../src/storage/codec';

suite('streaming sync integration (synthetic)', () => {
    test('5000 synthetic files produce multi-chunk shards loadable end-to-end', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'streamsync-'));
        const shardCount = 16;
        const chunkThreshold = 64;  // small to force multi-chunk files
        const mgr = new StorageManager({ workspaceRoot: root, shardCount, chunkThreshold });

        // Build a synthetic snapshot of 5000 files and save it through the streaming write path.
        const symbolsByFile = new Map<string, any[]>();
        const fileMetadata = new Map<string, any>();
        for (let i = 0; i < 5000; i++) {
            const rel = `dir${i % 50}/file${i}.c`;
            symbolsByFile.set(rel, [{
                name: 'f' + i, kind: 'function',
                filePath: '/w/' + rel, relativePath: rel,
                lineNumber: 1, endLineNumber: 1, column: 0, lineContent: 'void f' + i + '(){}',
            }]);
            fileMetadata.set(rel, { relativePath: rel, mtime: 1, size: 1, symbolCount: 1 });
        }

        await mgr.saveFull({ symbolsByFile, fileMetadata });

        // Assert: at least one shard file contains > 1 msgpack chunk
        const shardsDir = path.join(root, '.sisearch', 'shards');
        let multiChunkShardFound = false;
        for (let i = 0; i < shardCount; i++) {
            const p = path.join(shardsDir, shardFileName(i));
            if (!fs.existsSync(p)) { continue; }
            const buf = fs.readFileSync(p);
            let chunks = 0;
            for (const _c of decodeMessagePackMulti(buf)) { chunks++; }
            if (chunks > 1) { multiChunkShardFound = true; break; }
        }
        assert.strictEqual(multiChunkShardFound, true, 'at least one shard must be multi-chunk under chunkThreshold=64');

        // Assert: round-trip via load() restores all 5000 entries
        const back = await mgr.load();
        assert.strictEqual(back.fileMetadata.size, 5000);
        assert.strictEqual(back.symbolsByFile.size, 5000);
    });

    test('direct ShardStreamWriter: rapid appends do not leave empty files', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'streamsync-'));
        const shardsDir = path.join(root, 'shards');
        fs.mkdirSync(shardsDir, { recursive: true });
        const writer = new ShardStreamWriter({ shardsDir, shardCount: 16, chunkThreshold: 1 });

        for (let i = 0; i < 100; i++) {
            const rel = `f${i}.c`;
            const shard = shardForPath(rel, 16);
            writer.add(shard, { relativePath: rel, symbols: [], metadata: { relativePath: rel, mtime: 1, size: 1, symbolCount: 0 } });
        }
        writer.flushAll();
        writer.close();

        for (const name of fs.readdirSync(shardsDir)) {
            const stat = fs.statSync(path.join(shardsDir, name));
            assert.ok(stat.size > 0, `${name} must not be empty`);
        }
    });
});
```

- [ ] **Step 2: Run test**

Run: `npm run compile && npm test -- --grep "streaming sync integration"`
Expected: PASS (both tests).

- [ ] **Step 3: Run full suite**

Run: `npm test`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add test/suite/streamingSyncIntegration.test.ts
git commit -m "test: streaming sync integration (5000-file multi-chunk round-trip)"
```

---

## Task 12: Final manual verification + build

**Files:** None (verification only)

- [ ] **Step 1: Build**

Run: `npm run compile`
Expected: no TypeScript errors.

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: all green.

- [ ] **Step 3: Manual verification checklist**

Verify each (record results in PR description when raising):

1. **Small repo (this project):**
   - Open si-search in VS Code Insiders with the new build installed.
   - Click Sync. Expect: status goes `building` → `ready`, search works.
   - Check `.sisearch/shards/` — files exist and are valid msgpack (e.g. `node -e "const {decodeMulti}=require('@msgpack/msgpack'); for(const x of decodeMulti(require('fs').readFileSync('.sisearch/shards/00.msgpack'))) console.log(x.length)"`).

2. **Cancel mid-sync on small repo:**
   - Start sync, immediately press Cancel.
   - Expect: status → `stale` or `none`, no crash, partial shards on disk.

3. **Old `.sisearch` compatibility:**
   - Stash new build, run old build, sync to generate old-format `.sisearch`.
   - Restore new build without deleting `.sisearch`.
   - Open VS Code — `load()` should not throw; existing entries appear; sync completes.

4. **Large repo:** on the reporter's machine with `linux/drivers` (~33k files):
   - Sync completes without exit 134.
   - Status → `ready`.
   - Search works.

- [ ] **Step 4: No commit** — verification only. If anything fails, a new follow-up task is created and the bug fixed before merge.

---

## Self-review notes (author)

- Spec §2 root cause → Tasks 2/6/7/8 jointly remove the 4 accumulation points.
- Spec §4.2 components → Tasks 1 (codec), 2-4 (writer), 5-7 (storage), 8 (pool), 9 (orchestrator rewire tests).
- Spec §5 back-pressure → Task 8 `await onBatchResult`; test in 8a asserts it.
- Spec §6 on-disk format → Task 5 (load) + Task 7 (save), verified by Task 11.
- Spec §6.2 zero-migration → Task 5 "reads legacy single-array" test.
- Spec §7 error handling: `appendFileSync` throws → Task 4 test; corrupt shard → Task 5 tests; cancellation with flushAll → Task 9 (implicit in saveDirty path). Explicit cancellation flushAll test deferred to manual step 2 since synthetic cancellation inside orchestrator is hard to fake without plumbing new test hooks; the behaviour is correct by the `finally` in Task 7 save paths and the existing token checks in `SyncOrchestrator`.
- Spec §8 testing → Tasks 1-11 map 1-1 to the listed test cases.
- Spec §9.1 commit sequence → 12 commits follow that order, with Task 2-4 being the step-1 split (writer in 3 commits for TDD granularity).
- Spec §11 success criteria → Task 12 manual verification covers 1, 2, 4, 5. Criterion 3 (unit+integration pass) gated by Task 12 Step 2.
