# Streaming Shard Write — Design Spec

**Date:** 2026-04-20
**Status:** Approved (pending user review)
**Problem:** VS Code Extension Host crashes with V8 heap OOM (exit 134, `FATAL ERROR: CALL_AND_RETRY_LAST Allocation failed - JavaScript heap out of memory`) when syncing ~33k files in `linux/drivers`. Two `Mark-Compact (reduce) ... last resort` GC attempts precede the abort in evidence log `~/vscode-crash-evidence/run.log` line ~2335.

## 1. Goal

Eliminate the OOM by removing the three redundant full-symbol-universe copies that currently coexist in the extension-host main thread during sync, while preserving search latency and the existing public API shape.

## 2. Root cause (confirmed from code read)

During sync, four copies of the entire symbol set coexist briefly at sync end:

1. `WorkerPool.parse()` accumulates every symbol into one `aggregated: ParseBatchResult` array (`src/sync/workerPool.ts:69,82-84`).
2. `groupParseResult(parsed)` reshapes the same data into a `Map<file, SymbolEntry[]>` (`src/sync/syncOrchestrator.ts:92`).
3. `inner` in-memory index holds the same data for search.
4. `storage.saveFull/saveDirty` receives a snapshot, then `bucketizeShards` walks the entire map and encodes 16 msgpack shard buffers **sequentially but all held alive** until all 16 are written (`src/storage/storageManager.ts:67-82`).

For ~33k kernel files this is easily hundreds of MB of V8 objects living simultaneously in old-space. Matches the OOM signature.

## 3. Non-goals

- Do not change search latency (keep `inner` index in RAM).
- Do not rewrite `syncDirty()` path (its working set is small and already fine).
- Do not introduce a dedicated writer worker thread (complexity not needed).
- Do not add a legacy-write env toggle (YAGNI).
- Do not attempt to restart failed parser workers (orthogonal).

## 4. Architecture

### 4.1 Before vs. after

```
BEFORE (peak ≈ 4× symbol universe):
  workers → aggregated[] ──┐
                           ├─► grouped:Map ─► inner ─► snapshot:Map ─► 16 msgpack buffers ─► disk
  fileMetadata ────────────┘       (all alive simultaneously at sync end)

AFTER (peak ≈ inner + one batch + 16 bounded flush-buckets):
  worker batch ─► groupParseResult (per-batch, ~32 files) ─► inner.update
                                  │
                                  └─► bucketAccumulator per shard
                                          │ when bucket ≥ chunkThreshold:
                                          ▼
                                     encode msgpack chunk ─► appendFile(shard_N)
                                                               (buffer GC'd immediately)
```

### 4.2 Components

| Component | Change | Responsibility |
|---|---|---|
| `WorkerPool.parse()` | Signature: `Promise<void>` + `onBatchResult` callback param. Remove `aggregated`. | Back-pressure via awaited callback. |
| `ShardStreamWriter` (new, `src/storage/shardStreamWriter.ts`) | New file | Per-shard accumulation buckets + flush policy. `add(shard, entry)`, `flushAll()`, `close()`. |
| `SyncOrchestrator` | Rewire parse → apply → stream-write | Owns the writer lifecycle for one sync run. |
| `StorageManager` | Add `openStreamWriter(dirtyShards?)` factory. Switch `load()` to `decodeMulti`. Keep `saveFull`/`saveDirty` public signatures (callers: `syncDirty`, `saveToDisk`), but reimplement their bodies as a thin wrapper that opens a writer, feeds the snapshot through it, then `flushAll + close`. Single encode path for all writes. | Format I/O + factory. |
| `SymbolIndex` façade | Drop `getSnapshot` clone of `fileMetadata` on sync path; streaming writer no longer needs a snapshot closure. | Unchanged public API. |

## 5. Data flow & back-pressure

Per-batch path (inside `onBatchResult(result: ParseBatchResult)`):

1. Check cancellation; early-return if cancelled.
2. `grouped = groupParseResult(result)` — local, short-lived.
3. For each `[file, symbols]`:
   - `inner.update(file, symbols)`
   - `meta = result.metadata.find(m => m.relativePath === file)` (or apply full metadata array once)
   - `shard = shardForPath(file, shardCount)`
   - `writer.add(shard, { relativePath: file, symbols, metadata: meta })`
4. `writer.add` pushes to `buckets[shard]`; if `buckets[shard].length >= chunkThreshold` (default **512**) it flushes that chunk synchronously via `fs.appendFileSync(shardFile, encodeMessagePack(chunk))` and resets the bucket.
5. `onBatchResult` resolves; `workerLoop` can pull the next batch.

**Back-pressure:** `workerLoop` awaits `onBatchResult` before advancing `cursor`, so slow I/O naturally throttles parsing. Peak in-flight data = (N workers × 1 batch) + (16 × chunkThreshold entries in buckets) ≈ bounded regardless of corpus size.

**End of sync:** orchestrator calls `writer.flushAll()` to drain non-empty buckets, then `writer.close()`.

## 6. On-disk format

### 6.1 Format

A shard file is now a **concatenation of msgpack chunks**. Each chunk is itself a msgpack-encoded `ShardEntry[]`. No header, no separators, no version byte.

```
shard_0.msgpack:
┌──────────────────────────┐
│ msgpack chunk 1 (array)  │
├──────────────────────────┤
│ msgpack chunk 2 (array)  │
├──────────────────────────┤
│ ...                      │
└──────────────────────────┘
```

### 6.2 Backward compatibility (zero-migration)

Old-format file = "single top-level array" = "new format with exactly one chunk". `decodeMulti(buffer)` iterates top-level values, so old files read correctly with no code branch or format probe. This is the decisive reason for choosing this format.

### 6.3 Read path

```ts
const buf = fs.readFileSync(shardPath);
for (const chunk of decodeMulti(buf)) {
    for (const entry of chunk as ShardEntry[]) {
        symbolsByFile.set(entry.relativePath, entry.symbols);
        fileMetadata.set(entry.relativePath, entry.metadata);
    }
}
```

Decoder errors (truncated final chunk) are caught per-iteration: already-decoded chunks are kept, remaining bytes discarded with a warning. Finer-grained than today's per-shard `try/catch ignore`.

### 6.4 Write atomicity

Each `fs.appendFileSync` is a separate syscall. Crash/kill mid-sync:
- Previously appended chunks remain intact.
- Next `load()` decodes whole chunks only; truncated tail dropped with warning.
- Next sync re-classifies missing files as new and re-processes — self-healing.

Strictly better than today's "one big write at sync end" which can leave a corrupt full shard.

### 6.5 chunkThreshold default

**512 entries per chunk.** Rationale:

- linux/drivers ~33k files / 16 shards ≈ 2062 entries per shard → ~4 chunks per shard
- Assume ~2KB per `ShardEntry` encoded → ~1 MB per chunk
- 16 shards × 1 MB max resident buffer ≈ 16 MB cap — two orders of magnitude below current peak
- Exposed as `StorageManager` constructor option so tests can use small values (e.g. 4) to cover multi-chunk paths

## 7. Error handling

| Failure | Behaviour |
|---|---|
| `appendFileSync` throws (disk full, EACCES) | `writer.add` throws → propagated out of `onBatchResult` → `parse` rejects → orchestrator rejects → façade sets status `stale`, rethrows. Already-flushed chunks survive on disk. |
| Parser worker crashes | Existing `workerLoop` awaits `parseBatch`; crash rejects that await, `Promise.all` rejects, propagates as above. No new path. |
| Shard file corrupted on load | `decodeMulti` iterator catches; keeps successfully decoded entries, logs warning, continues to next shard. |
| Cancellation token fires mid-sync | `onBatchResult` early-returns; `workerLoop` head also checks token. Orchestrator calls `writer.flushAll()` (inside try/catch) before propagating — **partial progress preserved**. Status → stale or none per existing façade logic. |
| Empty `files` array | `parse` resolves immediately; `onBatchResult` never invoked; writer never opened. |

## 8. Testing strategy

### 8.1 Unit tests (new / modified)

**`ShardStreamWriter` (new suite):**
- `add` below threshold → no fs write
- `add` reaching threshold → one `appendFileSync` with correct msgpack bytes
- Multiple shards accumulate independently
- `flushAll` drains all non-empty buckets exactly once
- `flushAll` does NOT write empty buckets
- `appendFileSync` throwing propagates out of `add`

**`StorageManager.load` format compatibility:**
- Reads old single-array file correctly
- Reads new multi-chunk file correctly (hand-assembled fixture)
- Reads truncated multi-chunk file: keeps whole chunks, drops tail, no throw
- Reads fully corrupt file: empty result, no throw

**`WorkerPool.parse` new signature:**
- `onBatchResult` invoked `ceil(files/batchSize)` times
- Pending `onBatchResult` promise blocks cursor advance (back-pressure)
- Thrown error in `onBatchResult` rejects `parse`
- Empty `files` → callback never invoked, resolves

**`SyncOrchestrator` (revised):**
- Injected fake pool + fake writer:
  - `inner.update` called `total` times
  - `writer.add` called `total` times
  - `writer.flushAll` called once at sync end
  - Cancellation mid-sync still calls `writer.flushAll`

### 8.2 Integration tests

**Large-file-count smoke (~5000 files):**
- Generate 5000 small `.c` files, run full sync
- Assert: sync succeeds, search hits, ≤ 16 shard files exist, at least one shard file contains >1 msgpack chunk (validates streaming)

**Cancel + resume:**
- Cancel sync mid-flight; assert status = `stale`, shards exist with partial chunks, re-running sync converges to full coverage

### 8.3 Deliberately NOT tested

- Exact memory byte measurements — V8 GC behaviour too variable; assert behaviour instead
- Real ripgrep or real tree-sitter WASM in unit tests — fakes only
- Format version negotiation — there is no version; zero-migration is the design

### 8.4 TDD discipline

Each task: write failing test → run (confirm red) → minimal implementation → run (confirm green) → commit. Integration tests added after all unit-level changes green.

## 9. Rollout

### 9.1 Commit sequence (single branch)

1. Add `ShardStreamWriter` + unit tests (pure new code, not wired)
2. Switch `StorageManager.load()` to `decodeMulti` + compat tests
3. Add `StorageManager.openStreamWriter` factory (old APIs untouched)
4. Change `WorkerPool.parse` signature + unit tests
5. Rewire `SyncOrchestrator.synchronize` to streaming
6. Wire `SymbolIndex.synchronize` adjustments
7. Remove dead `aggregated`/grouping helpers no longer on hot path
8. Revert commit 476cc01's `createReusableParser` false-lead; keep `BATCH_SIZE=32` as a configurable option (default reversible later, not blocking this work)
9. Add integration tests; manual verification on linux/drivers

Each commit must build + pass tests so `git bisect` works.

### 9.2 Rollback

- If post-refactor OOM persists: revert to merge-base. Old version's `load()` already ignores shards it can't parse, so new on-disk format is harmless (user sees empty index, re-syncs with old binary).
- No env toggle added.

### 9.3 Manual verification

1. Small repo (si-search itself): sync succeeds, search works, shards are valid msgpack
2. Medium subset (~2k files, e.g. `linux/drivers/gpu`): no OOM, search results match pre-refactor count
3. Full `linux/drivers` (~33k files): sync completes, no exit 134, search count matches earlier successful baseline
4. Cancel mid-sync: status → stale, shards present with partial chunks, re-sync converges
5. Old `.sisearch` directory from pre-refactor build: loads without error in new build

### 9.4 Risk table

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| `decodeMulti` cross-version behaviour | Low | Medium | Unit tests; pinned `@msgpack/msgpack` version |
| `chunkThreshold` misjudged | Low | Low | Default 512 + option override |
| Append mid-fail leaves half chunk | Low | Low | `decodeMulti` skips bad tail; next sync self-heals |
| `flushAll` throws during cancel | Very low | Low | try/catch; still set `stale` |
| Old tests assert `aggregated` shape | Medium | Low | Fixed as part of step 4 |

## 10. Out of scope / deferred

- Parallel writes to multiple shard files (all currently synchronous per batch — good enough)
- Compaction / vacuum of append-only shard files (not needed; saveFull replaces the file)
- Moving parser workers to a separate process pool (already separate threads; process isolation not required)
- Search-path LRU over on-disk shards (only relevant if `inner` is removed — not this refactor)

## 11. Success criteria

1. Full `linux/drivers` sync completes without exit 134 on the reporter's machine
2. Peak extension-host memory during sync remains within the baseline VS Code provides (no need for `--max-old-space-size` override)
3. All unit + integration tests pass
4. Existing `.sisearch` directories continue to load
5. Search latency unchanged (±10%) versus pre-refactor

## 12. References

- Crash evidence: `~/vscode-crash-evidence/run.log` line ~2335 (`FATAL ERROR: CALL_AND_RETRY_LAST`)
- Current hot-path files:
  - `src/sync/workerPool.ts:69,82-84` — `aggregated` accumulator
  - `src/sync/syncOrchestrator.ts:84-100` — parse → grouped → apply
  - `src/symbolIndex.ts:133-136` — `getSnapshot` clone
  - `src/storage/storageManager.ts:67-82` — `bucketizeShards` + `writeShard`
- Prior commit on wrong hypothesis (parser churn): 476cc01 — to be reverted as step 8 above
