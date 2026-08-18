import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTtlMemo } from "../src/ttl-memo.js";

describe("ttl memo", () => {
  it("serves one load for the TTL, then reloads once it lapses", async () => {
    let clock = 1_000;
    let loads = 0;
    const memo = createTtlMemo<string, number>({
      ttlMs: 60_000,
      now: () => clock,
      load: async () => ++loads,
    });

    assert.equal(await memo("actor-1"), 1);
    clock += 59_999;
    assert.equal(await memo("actor-1"), 1, "a call inside the TTL must not reload");
    clock += 1;
    // expiresAt is 61_000 and the check is `expiresAt <= now`, so the boundary tick reloads.
    assert.equal(await memo("actor-1"), 2);
    assert.equal(loads, 2);
  });

  it("keys entries independently", async () => {
    const loads: string[] = [];
    const memo = createTtlMemo<string, string>({
      ttlMs: 60_000,
      load: async (key) => { loads.push(key); return key; },
    });

    assert.equal(await memo("actor-1"), "actor-1");
    assert.equal(await memo("actor-2"), "actor-2");
    assert.equal(await memo("actor-1"), "actor-1");
    assert.deepEqual(loads, ["actor-1", "actor-2"]);
  });

  it("collapses concurrent callers onto ONE in-flight load", async () => {
    let loads = 0;
    let release!: (value: number) => void;
    const memo = createTtlMemo<string, number>({
      ttlMs: 60_000,
      load: async () => {
        loads += 1;
        return await new Promise<number>((resolve) => { release = resolve; });
      },
    });

    const first = memo("actor-1");
    const second = memo("actor-1");
    const third = memo("actor-1");
    assert.equal(loads, 1, "the second and third callers must subscribe, not start a second load");
    release(7);

    assert.deepEqual(await Promise.all([first, second, third]), [7, 7, 7]);
    assert.equal(loads, 1);
  });

  it("evicts a failed load instead of memoizing the failure", async () => {
    let loads = 0;
    const memo = createTtlMemo<string, string>({
      ttlMs: 60_000,
      load: async () => {
        loads += 1;
        if (loads === 1) throw new Error("upstream is down");
        return "recovered";
      },
    });

    await assert.rejects(async () => { await memo("actor-1"); }, /upstream is down/);
    // A transient outage must not become a TTL-long outage: the very next call retries.
    assert.equal(await memo("actor-1"), "recovered");
    assert.equal(loads, 2);
  });

  it("lets a value's own expiry SHORTEN its entry", async () => {
    let clock = 1_000;
    let loads = 0;
    const memo = createTtlMemo<string, { expiresAtMs: number }>({
      ttlMs: 60_000,
      now: () => clock,
      deriveExpiryMs: (value) => value.expiresAtMs,
      load: async () => { loads += 1; return { expiresAtMs: clock + 5_000 }; },
    });

    await memo("actor-1");
    clock += 4_999;
    await memo("actor-1");
    assert.equal(loads, 1, "still inside the row's own expiry");
    clock += 1;
    await memo("actor-1");
    assert.equal(loads, 2, "the row expired 55s before the cache TTL would have");
  });

  it("never lets a value's own expiry EXTEND an entry past the configured TTL", async () => {
    let clock = 1_000;
    let loads = 0;
    const memo = createTtlMemo<string, number>({
      ttlMs: 10_000,
      now: () => clock,
      // A grant a year out must not pin the answer in memory for a year.
      deriveExpiryMs: () => clock + 365 * 24 * 60 * 60 * 1_000,
      load: async () => ++loads,
    });

    await memo("actor-1");
    clock += 10_000;
    await memo("actor-1");
    assert.equal(loads, 2, "the configured TTL is a ceiling the clamp hook cannot raise");
  });

  it("aborts the shared load only after the LAST subscriber leaves", async () => {
    let loadSignal: AbortSignal | undefined;
    let release!: (value: string) => void;
    const memo = createTtlMemo<string, string>({
      ttlMs: 60_000,
      load: async (_key, signal) => {
        loadSignal = signal;
        return await new Promise<string>((resolve) => { release = resolve; });
      },
    });

    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = memo("actor-1", firstController.signal);
    const second = memo("actor-1", secondController.signal);

    firstController.abort();
    await assert.rejects(async () => { await first; });
    assert.equal(loadSignal?.aborted, false, "one caller leaving must not cancel the other's read");

    secondController.abort();
    await assert.rejects(async () => { await second; });
    assert.equal(loadSignal?.aborted, true, "with nobody left waiting, the upstream read is cancelled");
    release("unused");
  });

  it("refuses an already-aborted caller before touching the cache", async () => {
    let loads = 0;
    const memo = createTtlMemo<string, number>({ ttlMs: 60_000, load: async () => ++loads });
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(async () => { await memo("actor-1", controller.signal); });
    assert.equal(loads, 0);
  });

  it("passes straight through at TTL 0, exactly as if unwrapped", async () => {
    let loads = 0;
    const memo = createTtlMemo<string, number>({ ttlMs: 0, load: async () => ++loads });

    assert.equal(await memo("actor-1"), 1);
    assert.equal(await memo("actor-1"), 2);
    assert.equal(loads, 2);
  });

  it("forwards the caller's own signal to the load when memoization is off", async () => {
    // The TTL-0 opt-out must not silently drop cancellation on the floor.
    let loadSignal: AbortSignal | undefined;
    const memo = createTtlMemo<string, string>({
      ttlMs: 0,
      load: async (_key, signal) => { loadSignal = signal; return "value"; },
    });
    const controller = new AbortController();

    await memo("actor-1", controller.signal);

    assert.equal(loadSignal, controller.signal);
  });
});
