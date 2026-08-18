import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadApplicationIdsForJobScope } from "../src/tools/application-job-lookup.js";
import { createToolDeadline } from "../src/runtime.js";
import { fakeScopedReader, scopedSuccess, testRuntime } from "./test-helpers.js";

// R3: the job -> id derive read sent ALL job_ids in one request, but v3 caps every filter array at
// maxItems:50 (docs/harvest-v3-api: /v3/applications.job_ids, /v3/interviews.job_ids). A confirmed scope
// can span >50 jobs (a broad role / multi-req scope), so an unchunked send would be rejected or silently
// capped at 50 — under-scoping the bridge. The derive now chunks job_ids at <=50 and unions the result.
//
// REVERT TEST: drop the chunking (send `{ job_ids: uniqueJobIds.join(",") }` in one read) and the first
// test below issues one over-cap request (its <=50 assertion fires) and never unions the 51st-60th jobs.
describe("job -> id derive chunks job_ids at v3's maxItems:50 cap (R3)", () => {
  it("reads a >50-job scope in <=50-id chunks and unions every chunk (never caps at 50)", async () => {
    const jobIds = Array.from({ length: 60 }, (_unused, i) => 9000001 + i);
    const reader = fakeScopedReader((toolName, params) => {
      assert.equal(toolName, "list_applications");
      const requested = String(params?.job_ids ?? "")
        .split(",")
        .map((token) => Number(token))
        .filter((value) => Number.isFinite(value) && value > 0);
      assert.ok(requested.length > 0 && requested.length <= 50, `each derive read must carry <=50 job_ids (got ${requested.length})`);
      // One application per requested job, id traceable to its job, so the union proves every job was read.
      return scopedSuccess(toolName, requested.map((jobId) => ({ id: jobId + 1_000_000, job_id: jobId, candidate_id: jobId + 2_000_000 })));
    });
    const { runtime } = testRuntime(reader);

    const result = await loadApplicationIdsForJobScope(runtime, "search_my_application_stages", jobIds);

    assert.equal(result.kind, "ids");
    if (result.kind !== "ids") return;
    assert.equal(reader.calls.length, 2, "a 60-job scope is read in two <=50-id chunks, not one over-cap request");
    assert.equal(result.ids.length, 60, "every chunk's applications are unioned — none dropped by a silent 50-cap");
    assert.ok(result.ids.includes(9000001 + 1_000_000), "the first job's application is present");
    assert.ok(result.ids.includes(9000060 + 1_000_000), "the 60th job's application is present (lost if capped at 50)");
    assert.equal(result.complete, true);
  });

  it("reads independent chunks CONCURRENTLY (T1.3) — a sequential revert deadlocks this barrier", async () => {
    // Two chunks (60 jobs -> 2x<=50). Each read blocks until BOTH reads have STARTED: only a
    // concurrent implementation can satisfy the barrier; the old sequential loop awaits chunk 1
    // before issuing chunk 2 and would hang here (caught by the loud 2s race below).
    const jobIds = Array.from({ length: 60 }, (_unused, i) => 9000001 + i);
    let started = 0;
    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => { releaseBarrier = resolve; });
    const reader = fakeScopedReader(async (toolName, params) => {
      started += 1;
      if (started >= 2) releaseBarrier();
      await barrier;
      const requested = String(params?.job_ids ?? "").split(",").map((token) => Number(token)).filter((value) => value > 0);
      return scopedSuccess(toolName, requested.map((jobId) => ({ id: jobId + 1_000_000, job_id: jobId })));
    });
    const { runtime } = testRuntime(reader);

    const result = await Promise.race([
      loadApplicationIdsForJobScope(runtime, "search_my_application_stages", jobIds),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("chunk reads did not overlap — the bridge regressed to sequential")), 2_000)
      ),
    ]);

    assert.equal(result.kind, "ids");
    if (result.kind !== "ids") return;
    assert.equal(result.ids.length, 60, "concurrent chunks still union deterministically");
    assert.equal(result.complete, true);
  });

  it("dedupes ids unioned across chunks (a candidate/application shared by jobs in different chunks appears once)", async () => {
    const jobIds = Array.from({ length: 60 }, (_unused, i) => 9000001 + i);
    const reader = fakeScopedReader((toolName, params) => {
      const requested = String(params?.job_ids ?? "").split(",").map((token) => Number(token)).filter((value) => value > 0);
      // Every job returns the SAME application id 4242 — a shared row visible from both chunks.
      return scopedSuccess(toolName, requested.map((jobId) => ({ id: 4242, job_id: jobId })));
    });
    const { runtime } = testRuntime(reader);

    const result = await loadApplicationIdsForJobScope(runtime, "search_my_application_stages", jobIds);

    assert.equal(result.kind, "ids");
    if (result.kind !== "ids") return;
    assert.deepStrictEqual(result.ids, [4242], "a shared id unioned across chunks is deduped to a single entry");
  });

  it("rolls up a later-chunk timeout as incomplete, keeping the first chunk's ids (not a hard denial)", async () => {
    const jobIds = Array.from({ length: 60 }, (_unused, i) => 9000001 + i);
    const startedAt = Date.parse("2026-06-30T12:00:00.000Z");
    let now = startedAt;
    const reader = fakeScopedReader((toolName, params) => {
      now = startedAt + 1_001; // the 1s deadline elapses once the first chunk has been served
      const requested = String(params?.job_ids ?? "").split(",").map((token) => Number(token)).filter((value) => value > 0);
      return scopedSuccess(toolName, requested.map((jobId) => ({ id: jobId + 1_000_000, job_id: jobId })));
    });
    const { runtime } = testRuntime(reader, {
      now: () => now,
      limits: { maxPerPage: 500, defaultPerPage: 500, maxLookbackDays: 365, maxRankings: 25, maxEvidenceIds: 200, maxToolDurationMs: 1_000 },
    });
    const deadline = createToolDeadline(runtime, startedAt);

    const result = await loadApplicationIdsForJobScope(runtime, "search_my_application_stages", jobIds, deadline);

    assert.equal(result.kind, "ids");
    if (result.kind !== "ids") return;
    assert.equal(result.ids.length, 50, "the first chunk's already-read ids are preserved, not discarded");
    assert.equal(result.complete, false, "a later-chunk timeout must not claim completeness");
    assert.equal(result.status, "incomplete_timeout");
  });
});
