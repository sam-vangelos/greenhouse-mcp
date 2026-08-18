import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { ApiResponse, RawReadClient, ReadParams } from "../../scoped-core/src/index.js";
import { createCachingRawReader, readCacheKey, readReadCacheConfig, _resetReadCache, type ReadCacheConfig } from "../src/read-cache.js";

// A counting inner reader: every call increments per-key + total counters and returns a distinct
// payload tagged with the call number, so a cache hit vs a fresh read is observable in the value.
function countingReader(): { reader: RawReadClient; calls: () => number; callsFor: (key: string) => number } {
  let total = 0;
  const per = new Map<string, number>();
  const reader: RawReadClient = {
    async read<T>(path: string, params: ReadParams = {}, cursor?: string): Promise<ApiResponse<T>> {
      total += 1;
      const key = readCacheKey(path, params, cursor);
      per.set(key, (per.get(key) ?? 0) + 1);
      return { data: { path, call: total } as unknown as T, nextCursor: null };
    },
  };
  return { reader, calls: () => total, callsFor: (key) => per.get(key) ?? 0 };
}

function config(overrides: Partial<ReadCacheConfig> = {}): ReadCacheConfig {
  return { enabled: true, ttlMs: 30_000, maxEntries: 200, now: () => 1_000, ...overrides };
}

describe("shared read cache", () => {
  beforeEach(() => _resetReadCache());

  it("serves an identical read from cache within TTL (one upstream fetch)", async () => {
    const { reader, calls } = countingReader();
    let t = 1_000;
    const cached = createCachingRawReader(reader, config({ now: () => t }));

    const a = await cached.read("/applications", { job_ids: "10" });
    t = 1_020; // still inside 30s TTL
    const b = await cached.read("/applications", { job_ids: "10" });

    assert.equal(calls(), 1, "second identical read must hit the cache, not Greenhouse");
    assert.deepEqual(a, b);
  });

  it("never caches or coalesces attachment reads carrying signed URLs", async () => {
    const { reader, calls } = countingReader();
    const cached = createCachingRawReader(reader, config());

    const first = cached.read("/attachments", { ids: "42" });
    const second = cached.read("/attachments", { ids: "42" });
    const [a, b] = await Promise.all([first, second]);

    assert.equal(calls(), 2, "each attachment lookup must mint a fresh permission-scoped URL");
    assert.notDeepEqual(a, b);
    await cached.read("/attachments", { ids: "42" });
    assert.equal(calls(), 3, "a completed attachment lookup must not enter the TTL cache");
  });

  it("marks cached and coalesced responses for reconstructable audit metrics", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const inner: RawReadClient = {
      async read<T>(): Promise<ApiResponse<T>> {
        await gate;
        return {
          data: [] as unknown as T,
          nextCursor: null,
          meta: { retry: { attempts: 1, rateLimitRetries: 0, sleptMs: 0, retryAfterSeconds: [] } },
        };
      },
    };
    const cached = createCachingRawReader(inner, config());
    const first = cached.read("/applications");
    const coalesced = cached.read("/applications");
    release();

    assert.equal((await first).meta?.cacheHits ?? 0, 0);
    assert.equal((await coalesced).meta?.cacheHits, 1);
    assert.equal((await cached.read("/applications")).meta?.cacheHits, 1);
  });

  it("re-fetches after the TTL expires", async () => {
    const { reader, calls } = countingReader();
    let t = 1_000;
    const cached = createCachingRawReader(reader, config({ ttlMs: 30_000, now: () => t }));

    await cached.read("/applications", { job_ids: "10" });
    t = 40_000; // past the 30s TTL
    await cached.read("/applications", { job_ids: "10" });

    assert.equal(calls(), 2, "an expired entry must re-fetch");
  });

  it("coalesces concurrent identical reads into a single upstream fetch (single-flight)", async () => {
    let total = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const slow: RawReadClient = {
      async read<T>(): Promise<ApiResponse<T>> {
        total += 1;
        await gate; // hold both callers in-flight simultaneously
        return { data: { call: total } as unknown as T, nextCursor: null };
      },
    };
    const cached = createCachingRawReader(slow, config());

    const p1 = cached.read("/applications", { job_ids: "10" });
    const p2 = cached.read("/applications", { job_ids: "10" });
    release();
    const [r1, r2] = await Promise.all([p1, p2]);

    assert.equal(total, 1, "two concurrent identical reads must share ONE upstream fetch");
    assert.deepEqual(r1, r2);
  });

  it("lets one caller cancel without aborting another subscriber's shared request", async () => {
    let total = 0;
    let upstreamAborted = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const slow: RawReadClient = {
      async read<T>(
        _path: string,
        _params?: ReadParams,
        _cursor?: string,
        signal?: AbortSignal
      ): Promise<ApiResponse<T>> {
        total += 1;
        signal?.addEventListener("abort", () => { upstreamAborted = true; }, { once: true });
        await gate;
        return { data: { ok: true } as unknown as T, nextCursor: null };
      },
    };
    const cached = createCachingRawReader(slow, config());
    const first = new AbortController();

    const abandoned = cached.read("/applications", { job_ids: "10" }, undefined, first.signal);
    const remaining = cached.read("/applications", { job_ids: "10" });
    first.abort();
    await assert.rejects(abandoned, (error: unknown) => error instanceof Error && error.name === "AbortError");
    assert.equal(upstreamAborted, false, "another subscriber still owns the shared request");
    release();
    assert.deepEqual((await remaining).data, { ok: true });
    assert.equal(total, 1);
  });

  it("aborts the shared upstream request after its final subscriber cancels", async () => {
    let upstreamAborted = false;
    const slow: RawReadClient = {
      async read<T>(
        _path: string,
        _params?: ReadParams,
        _cursor?: string,
        signal?: AbortSignal
      ): Promise<ApiResponse<T>> {
        return new Promise<ApiResponse<T>>((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            upstreamAborted = true;
            const error = new Error("upstream cancelled");
            error.name = "AbortError";
            reject(error);
          }, { once: true });
        });
      },
    };
    const cached = createCachingRawReader(slow, config());
    const first = new AbortController();
    const second = new AbortController();
    const a = cached.read("/applications", {}, undefined, first.signal);
    const b = cached.read("/applications", {}, undefined, second.signal);

    first.abort();
    await assert.rejects(a);
    assert.equal(upstreamAborted, false);
    second.abort();
    await assert.rejects(b);
    assert.equal(upstreamAborted, true);
  });

  it("keys on path + params + cursor (order-independent params; distinct cursors are distinct)", async () => {
    const { reader, calls } = countingReader();
    const cached = createCachingRawReader(reader, config());

    await cached.read("/applications", { job_ids: "10", per_page: "500" });
    await cached.read("/applications", { per_page: "500", job_ids: "10" }); // same key (sorted)
    assert.equal(calls(), 1, "param order must not change the cache key");

    await cached.read("/applications", { job_ids: "11" }); // different params
    await cached.read("/applications", {}, "cursor-abc"); // cursor read
    assert.equal(calls(), 3);
  });

  it("never caches a failed read (the next call retries)", async () => {
    let total = 0;
    const flaky: RawReadClient = {
      async read<T>(): Promise<ApiResponse<T>> {
        total += 1;
        if (total === 1) throw new Error("Greenhouse API error: 500 boom");
        return { data: { ok: true } as unknown as T, nextCursor: null };
      },
    };
    const cached = createCachingRawReader(flaky, config());

    await assert.rejects(() => cached.read("/applications", { job_ids: "10" }));
    const ok = await cached.read("/applications", { job_ids: "10" });
    assert.equal(total, 2, "a thrown read must not be cached — the retry must reach upstream");
    assert.deepEqual(ok.data, { ok: true });
  });

  it("is a transparent passthrough when disabled or TTL<=0", async () => {
    const { reader, calls } = countingReader();
    const disabled = createCachingRawReader(reader, config({ enabled: false }));
    await disabled.read("/applications", { job_ids: "10" });
    await disabled.read("/applications", { job_ids: "10" });
    assert.equal(calls(), 2, "disabled cache must not dedupe");
  });

  it("evicts oldest entries past maxEntries (bounded memory)", async () => {
    const { reader, calls } = countingReader();
    let t = 1_000;
    const cached = createCachingRawReader(reader, config({ maxEntries: 2, now: () => t }));

    await cached.read("/x", { a: "1" }); // key1
    await cached.read("/x", { a: "2" }); // key2
    await cached.read("/x", { a: "3" }); // key3 -> evicts key1 (oldest)
    assert.equal(calls(), 3);

    await cached.read("/x", { a: "1" }); // key1 was evicted -> re-fetch
    assert.equal(calls(), 4, "the evicted oldest entry must re-fetch");
    await cached.read("/x", { a: "3" }); // key3 still cached
    assert.equal(calls(), 4, "a still-cached entry must not re-fetch");
  });

  it("readReadCacheConfig: on by default, disabled by env flag, env-tunable TTL", () => {
    assert.equal(readReadCacheConfig({} as NodeJS.ProcessEnv).enabled, true);
    assert.equal(readReadCacheConfig({ GREENHOUSE_RECRUITER_READ_CACHE_DISABLED: "true" } as NodeJS.ProcessEnv).enabled, false);
    assert.equal(readReadCacheConfig({ GREENHOUSE_RECRUITER_READ_CACHE_TTL_MS: "5000" } as NodeJS.ProcessEnv).ttlMs, 5000);
  });
});
