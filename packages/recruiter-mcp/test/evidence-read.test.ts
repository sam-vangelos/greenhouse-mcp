import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runEvidenceTool } from "../src/tools/evidence.js";
import { createFixtureInventoryProvider, type JobScopeFixture } from "../src/resolvers/job-scope/inventory.js";
import { createScopeSigner } from "../src/resolvers/job-scope/scope-handle.js";
import { fakeScopedReader, scopedDenial, scopedSuccess, testRuntime } from "./test-helpers.js";

// L2 live-pilot finding: the raw search tools used to return a single page (v3 defaults to 100 rows)
// plus a cursor the model had to follow by hand. These tests lock the read-all-backed fix: ONE tool
// call returns the COMPLETE scoped set across cursor pages, with an honest completeness envelope.
//
// REVERT TEST: route runEvidenceTool's list path back through the single-read runScopedTool and the
// >100-row multi-page test below caps at page 1 (120 rows, not 150) with no `read` envelope -> fails.

function applicationPage(startId: number, count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_unused, index) => ({ id: startId + index, job_id: 10, status: "active" }));
}

describe("evidence search tools are read-all-backed (L2)", () => {
  it("returns the COMPLETE set across cursor pages in one call when page 1 exceeds the 100-row default", async () => {
    // 120 rows on page 1 (past the 100-row wall) + a cursor; 30 more on page 2; 150 total.
    const page1 = applicationPage(1, 120);
    const page2 = applicationPage(1000, 30);
    const scopedReader = fakeScopedReader((toolName, params) => {
      assert.equal(toolName, "list_applications");
      if (params?.cursor === "cursor-page-2") {
        return scopedSuccess(toolName, page2, null);
      }
      return scopedSuccess(toolName, page1, "cursor-page-2");
    });
    const { runtime } = testRuntime(scopedReader);

    const result = await runEvidenceTool(runtime, "search_my_applications", { status: "active", per_page: 120 });

    assert.equal(result.ok, true);
    const rows = result.ok ? (result.data as Array<Record<string, unknown>>) : [];
    // The L2 spirit holds UPSTREAM: read-all crawled both cursor pages (150 rows read, no
    // 100-row wall, no hand-followed cursor). The live-pilot fix then honors the caller's
    // EXPLICIT per_page as a result cap — 120 requested, 120 returned — with the truncation
    // DISCLOSED (never silent) and the full scoped-set size named.
    assert.equal(rows.length, 120, "an explicit per_page is honored as a result cap");
    assert.equal(rows[0]!.id, 1);
    const truncation = result.ok ? (result.read as any)?.result_truncated : null;
    assert.equal(truncation?.by, "per_page");
    assert.equal(truncation?.rows_in_scoped_set, 150, "the disclosure names the complete scoped-set size");

    // Two reads: page 1 keeps the search filter at the read-all default page size — the caller's
    // per_page is ONLY a result cap and must never shrink upstream pages (live-pilot fix #2:
    // per_page:50 on a 3k-row scope meant 62 round trips and a client timeout); page 2 is a
    // cursor-only follow-up (per_page and the original filter stripped — the v3 cursor-read contract).
    assert.equal(scopedReader.calls.length, 2);
    assert.deepStrictEqual(scopedReader.calls[0]!.params, { status: "active", per_page: 500 }, "first page keeps the search filters at the fast default page size, NOT the caller's result cap");
    assert.deepStrictEqual(scopedReader.calls[1]!.params, { cursor: "cursor-page-2" }, "the cursor read carries the cursor alone (per_page stripped)");

    // The complete-set DEFAULT is unchanged: no explicit per_page -> every scoped row returned.
    const complete = await runEvidenceTool(runtime, "search_my_applications", { status: "active" });
    assert.equal(complete.ok, true);
    assert.equal((complete.ok ? (complete.data as unknown[]) : []).length, 150, "no per_page -> the full scoped set");
    assert.equal(complete.ok ? (complete.read as any)?.result_truncated : "x", undefined, "no truncation disclosure on a complete return");

    // Honest completeness envelope: complete, both pages counted, nothing truncated, top-level cursor null.
    assert.equal(result.ok && result.read?.complete, true);
    assert.equal(result.ok && result.read?.status, "complete");
    assert.equal(result.ok && result.read?.pages_read, 2);
    assert.equal(result.ok && result.read?.rows_returned, 150);
    assert.equal(result.ok && result.read?.pagination_truncated, false);
    assert.equal(result.ok && result.read?.next_cursor, null);
    assert.equal(result.ok ? result.nextCursor : "x", null, "no single-page cursor escapes to the model on a complete read");
  });

  it("discloses an incomplete read honestly instead of silently truncating (deadline elapses mid-pagination)", async () => {
    const startedAt = Date.parse("2026-06-23T12:00:00.000Z");
    let now = startedAt;
    // Every page returns a fresh cursor and pushes time past the 1s deadline, so read-all stops after
    // the first page and reports incomplete + a resumable cursor rather than claiming completeness.
    const scopedReader = fakeScopedReader((toolName) => {
      now = startedAt + 1_001;
      return scopedSuccess(toolName, applicationPage(1, 120), "cursor-keep-going");
    });
    const { runtime } = testRuntime(scopedReader, {
      now: () => now,
      limits: {
        maxPerPage: 500,
        defaultPerPage: 500,
        maxLookbackDays: 365,
        maxRankings: 25,
        maxEvidenceIds: 200,
        maxToolDurationMs: 1_000,
      },
    });

    const result = await runEvidenceTool(runtime, "search_my_applications", {});

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.read?.complete, false, "a deadline-truncated read must NOT claim completeness");
    assert.equal(result.ok && result.read?.status, "incomplete_timeout");
    assert.equal(result.ok && result.read?.pagination_truncated, true);
    assert.equal(result.ok && result.read?.next_cursor, "cursor-keep-going", "an incomplete read exposes a resumable cursor honestly");
    assert.ok(result.ok && typeof result.read?.message === "string" && result.read.message.length > 0);
  });

  it("a single-page read still carries the read-all completeness envelope", async () => {
    const scopedReader = fakeScopedReader((toolName) => scopedSuccess(toolName, applicationPage(1, 3), null));
    const { runtime } = testRuntime(scopedReader);

    const result = await runEvidenceTool(runtime, "search_my_jobs", {});

    assert.equal(result.ok, true);
    assert.equal(scopedReader.calls.length, 1);
    assert.equal(result.ok && result.read?.complete, true);
    assert.equal(result.ok && result.read?.pages_read, 1);
    assert.equal(result.ok && result.read?.rows_returned, 3);
  });

  it("a SAMPLE read stays single-page (internal probe/leakage path) — does NOT read-all", async () => {
    // Probe/leakage diagnostics want a bounded page, not the complete set. With {sample:true} a
    // multi-page tool returns only page 1 in one read (the pre-read-all behavior), so a readiness
    // probe over an all-scope actor doesn't full-scan every job. Drop the flag and it would read-all.
    const scopedReader = fakeScopedReader((toolName) => scopedSuccess(toolName, applicationPage(1, 25), "cursor-page-2"));
    const { runtime } = testRuntime(scopedReader);

    const result = await runEvidenceTool(runtime, "search_my_applications", { per_page: 25 }, { sample: true });

    assert.equal(result.ok, true);
    assert.equal(scopedReader.calls.length, 1, "a sample read issues exactly one page read, never following the cursor");
    assert.equal(result.ok ? (result.data as unknown[]).length : -1, 25);
    assert.equal(result.ok && result.read, undefined, "a sample read keeps the single-read shape (no read-all envelope)");
  });

  it("get_* single-record reads stay on the single-read path (no read envelope, no extra reads)", async () => {
    const scopedReader = fakeScopedReader((toolName) => scopedSuccess(toolName, { id: 55, job_id: 10 }));
    const { runtime } = testRuntime(scopedReader);

    const result = await runEvidenceTool(runtime, "get_my_application", { id: 55 });

    assert.equal(result.ok, true);
    assert.equal(scopedReader.calls.length, 1);
    assert.equal(result.ok && result.read, undefined, "get_* reads are single-record and carry no read-all envelope");
  });
});

// L1 live-pilot finding: a confirmed requisition scope was inert on the application-backed endpoints
// (application_stages/scorecards/rejection_details/notes/attachments). They can only be filtered by
// application_ids, so scope-to-a-req returned stage rows across EVERY permitted job. The fix auto-
// bridges a confirmed scope to the application_ids on its jobs and constrains the read to them.
//
// REVERT TEST: drop the bridge call in runEvidenceListRead (route the scoped application-backed read
// through plain read-all without injecting application_ids) and the first test below sees app 777's
// row from a different permitted job + a missing bridge envelope -> fails.

const FIXTURE = JSON.parse(
  readFileSync(resolve("test/fixtures/job-scope-resolution.fixture.json"), "utf8")
) as JobScopeFixture;
const SIGNER = createScopeSigner("evidence-bridge-secret-evidence-bridge-1");

function scopedRuntime(reader: ReturnType<typeof fakeScopedReader>) {
  // narrow_recruiter is assigned to jobs 9001001..9001010; 9001006 (the scope) and 9001007 (the
  // out-of-scope-but-permitted job) are both accessible, so app 777 below is permitted yet NOT in scope.
  return testRuntime(reader, {
    scopeSigner: SIGNER,
    jobInventory: createFixtureInventoryProvider(FIXTURE, "narrow_recruiter"),
  });
}

// The universe of application_stages the reader would surface for this actor's PERMITTED jobs: apps
// 501/502 are on the in-scope job 9001006; app 777 is on the permitted-but-out-of-scope job 9001007.
const STAGE_UNIVERSE = [
  { id: 9001, application_id: 501, job_interview_stage_id: 7, entered_at: "2026-06-10T00:00:00.000Z", current: true },
  { id: 9002, application_id: 502, job_interview_stage_id: 7, entered_at: "2026-06-11T00:00:00.000Z", current: true },
  { id: 9999, application_id: 777, job_interview_stage_id: 7, entered_at: "2026-06-12T00:00:00.000Z", current: true },
];

function bridgeReader(): ReturnType<typeof fakeScopedReader> {
  return fakeScopedReader((toolName, params) => {
    if (toolName === "list_applications") {
      // The bridge read: /v3/applications filtered by the scope's job_ids -> the req's applications.
      assert.equal(params?.job_ids, "9001006", "the bridge must read applications by the confirmed scope's job_ids");
      return scopedSuccess(toolName, [
        { id: 501, job_id: 9001006, status: "active" },
        { id: 502, job_id: 9001006, status: "active" },
      ]);
    }
    if (toolName === "list_application_stages") {
      const appIdsParam = typeof params?.application_ids === "string" ? params.application_ids : "";
      if (appIdsParam.length > 0) {
        // Bridged read: the endpoint honors application_ids and returns only those apps' stages.
        const requested = new Set(appIdsParam.split(",").map((id) => Number(id)));
        return scopedSuccess(toolName, STAGE_UNIVERSE.filter((row) => requested.has(row.application_id)));
      }
      // Unbridged read (the L1 bug): the scoped reader bounds to PERMITTED jobs, so it returns app
      // 777's row too — across the whole permitted set, not the confirmed req.
      return scopedSuccess(toolName, STAGE_UNIVERSE);
    }
    throw new Error(`unexpected scoped tool ${toolName} (params=${JSON.stringify(params)})`);
  });
}

describe("application-backed evidence reads auto-bridge a confirmed scope (L1)", () => {
  it("narrows search_my_application_stages to ONLY the confirmed req's applications (job_ids carrier)", async () => {
    const reader = bridgeReader();
    const { runtime } = scopedRuntime(reader);

    const result = await runEvidenceTool(runtime, "search_my_application_stages", { job_ids: "9001006", current: true });

    assert.equal(result.ok, true);
    const rows = result.ok ? (result.data as Array<Record<string, unknown>>) : [];
    const appIds = rows.map((row) => row.application_id).sort();
    // The whole point of L1: rows are constrained to the req's applications (501/502); app 777 on a
    // different permitted job must NOT appear even though it is within the permitted floor.
    assert.deepStrictEqual(appIds, [501, 502], "a confirmed scope must constrain application_stages to that req's applications only");
    assert.equal(rows.some((row) => row.application_id === 777), false, "an out-of-scope (but permitted) job's stage rows must not leak into a req-scoped read");

    // Bridge + scope disclosure (honest envelope).
    assert.equal(result.ok && result.bridge?.bridged, true);
    assert.equal(result.ok && result.bridge?.via, "application_ids");
    assert.equal(result.ok && result.bridge?.scoped_application_count, 2);
    assert.equal(result.ok && result.scope?.applied, true);
    assert.equal(result.ok && result.scope?.source, "exact_ids");
    assert.equal(result.ok && result.scope?.job_count, 1);

    // The bridge read (applications by job_ids) happened, then the endpoint read by application_ids.
    const appReads = reader.calls.filter((call) => call.toolName === "list_applications");
    const stageReads = reader.calls.filter((call) => call.toolName === "list_application_stages");
    assert.equal(appReads.length, 1, "exactly one bridge read of /v3/applications by job_ids");
    assert.ok(stageReads.length >= 1);
    assert.ok(stageReads.every((call) => typeof call.params?.application_ids === "string" && (call.params.application_ids as string).length > 0), "every application_stages read is constrained by application_ids");
  });

  it("honors a scope_handle the same way (scope_handle carrier)", async () => {
    const reader = bridgeReader();
    const { runtime } = scopedRuntime(reader);
    const handle = SIGNER.signScopeHandle({
      subject: "user-1",
      jobIds: [9001006],
      complete: true,
      label: "Backend Eng",
      source: "cached_index",
      issuedAtMs: Date.parse("2026-06-23T12:00:00.000Z"),
    });

    const result = await runEvidenceTool(runtime, "search_my_application_stages", { scope_handle: handle, current: true });

    assert.equal(result.ok, true);
    const rows = result.ok ? (result.data as Array<Record<string, unknown>>) : [];
    assert.deepStrictEqual(rows.map((row) => row.application_id).sort(), [501, 502]);
    assert.equal(result.ok && result.scope?.source, "scope_handle");
    assert.equal(result.ok && result.bridge?.bridged, true);
  });

  it("a confirmed scope with ZERO applications returns ZERO rows, never falling back to all-permitted", async () => {
    // The empty-bridge correctness guard: a req with no candidates must yield an empty application-
    // backed read, NOT the all-permitted set the L1 bug produced.
    const reader = fakeScopedReader((toolName, params) => {
      if (toolName === "list_applications") {
        return scopedSuccess(toolName, []); // the scope has no applications
      }
      if (toolName === "list_application_stages") {
        // If the bridge regressed to an unfiltered read, this universe would leak in.
        return scopedSuccess(toolName, STAGE_UNIVERSE);
      }
      throw new Error(`unexpected scoped tool ${toolName} (params=${JSON.stringify(params)})`);
    });
    const { runtime } = scopedRuntime(reader);

    const result = await runEvidenceTool(runtime, "search_my_application_stages", { job_ids: "9001006" });

    assert.equal(result.ok, true);
    assert.deepStrictEqual(result.ok ? result.data : "x", [], "an empty scope must return zero rows, not the permitted set");
    assert.equal(result.ok && result.bridge?.scoped_application_count, 0);
    // No application_stages read should have been issued at all (no application_ids to read by).
    assert.equal(reader.calls.some((call) => call.toolName === "list_application_stages"), false, "an empty scope issues no application-backed read");
  });

  it("an UNSCOPED application-backed read discloses it spans all permitted jobs (honest, not silent)", async () => {
    const reader = fakeScopedReader((toolName) => {
      if (toolName === "list_application_stages") return scopedSuccess(toolName, STAGE_UNIVERSE);
      throw new Error(`unexpected scoped tool ${toolName}`);
    });
    const { runtime } = scopedRuntime(reader);

    const result = await runEvidenceTool(runtime, "search_my_application_stages", {});

    assert.equal(result.ok, true);
    // No scope -> no bridge -> spans all permitted jobs, but it says so with a pointer to narrow.
    assert.equal(result.ok && result.bridge, undefined);
    assert.equal(result.ok && result.scope?.applied, false);
    assert.ok(result.ok && typeof result.scope?.note === "string" && result.scope.note.includes("scope_handle"));
    assert.equal(reader.calls.filter((call) => call.toolName === "list_applications").length, 0, "an unscoped read issues no bridge");
  });

  it("never widens past the scope: intersects a caller application_ids (incl. an id OUTSIDE the scope) and drops a candidate_ids filter", async () => {
    // The bridge resolves to apps 501/502. The caller also passes application_ids=501,999 — 999 is
    // OUTSIDE the confirmed scope (an app the caller named that is not in the bridge set) and MUST be
    // dropped by the intersection — and candidate_ids=55 (a parallel, potentially-widening filter on
    // /v3/notes). The read must be constrained to the INTERSECTION (501 only), candidate_ids dropped,
    // 999 never reaching the endpoint — never widened. Including 999 in BOTH the caller list AND the
    // notes universe makes the row outcome (not just the param spy) catch a "use caller ids verbatim"
    // widening: such a mutation would request 999 and surface app-999's note here.
    const reader = fakeScopedReader((toolName, params) => {
      if (toolName === "list_applications") {
        return scopedSuccess(toolName, [
          { id: 501, job_id: 9001006, status: "active" },
          { id: 502, job_id: 9001006, status: "active" },
        ]);
      }
      if (toolName === "list_notes") {
        const appIds = typeof params?.application_ids === "string" ? params.application_ids : "";
        const requested = new Set(appIds.split(",").map((id) => Number(id)));
        const universe = [
          { id: 700, application_id: 501, visibility: "publicly_visible", body: "in scope" },
          { id: 701, application_id: 502, visibility: "publicly_visible", body: "in scope but excluded by caller app filter" },
          { id: 702, application_id: 999, visibility: "publicly_visible", body: "OUT of scope — caller-named but not in the bridge set; must be dropped" },
        ];
        return scopedSuccess(toolName, universe.filter((row) => requested.has(row.application_id)));
      }
      throw new Error(`unexpected scoped tool ${toolName} (params=${JSON.stringify(params)})`);
    });
    const { runtime } = scopedRuntime(reader);

    const result = await runEvidenceTool(runtime, "search_my_notes", {
      job_ids: "9001006",
      application_ids: "501,999",
      candidate_ids: "55",
    });

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.bridge?.scoped_application_count, 1, "caller application_ids=501,999 intersects the bridge set 501/502 down to just 501 (999 is outside the scope, dropped)");
    const noteReads = reader.calls.filter((call) => call.toolName === "list_notes");
    assert.ok(noteReads.length >= 1);
    for (const call of noteReads) {
      assert.equal(call.params?.application_ids, "501", "the read is constrained to the intersected application_ids — 999 (outside the scope) never reaches the endpoint");
      assert.equal("candidate_ids" in (call.params ?? {}), false, "a candidate_ids filter is dropped under a confirmed scope (it could surface out-of-scope rows)");
    }
    const rows = result.ok ? (result.data as Array<Record<string, unknown>>) : [];
    assert.deepStrictEqual(rows.map((row) => row.application_id), [501], "only the in-scope, caller-intersected app 501 appears; 999 is dropped even though it is in the notes universe");
  });

  it("rolls up a later-batch timeout as honest-incomplete, keeping earlier batches' rows (not a TOOL_TIMEOUT that discards them)", async () => {
    // 30 in-scope apps -> two endpoint batches (25 + 5). The deadline (1s) elapses after batch 1
    // returns, so batch 2's read-all denies TOOL_TIMEOUT. The bridged read must keep batch 1's rows
    // and disclose incomplete — NOT throw away completed work and return a hard timeout denial.
    const startedAt = Date.parse("2026-06-23T12:00:00.000Z");
    let now = startedAt;
    const reader = fakeScopedReader((toolName, params) => {
      if (toolName === "list_applications") {
        return scopedSuccess(
          toolName,
          Array.from({ length: 30 }, (_unused, index) => ({ id: 501 + index, job_id: 9001006, status: "active" }))
        );
      }
      if (toolName === "list_application_stages") {
        now = startedAt + 1_001; // the 1s deadline elapses once the first batch has been served
        const appIds = String(params?.application_ids ?? "").split(",").map((id) => Number(id));
        return scopedSuccess(toolName, appIds.map((id) => ({ id: 9000 + id, application_id: id, current: true })));
      }
      throw new Error(`unexpected scoped tool ${toolName} (params=${JSON.stringify(params)})`);
    });
    const { runtime } = testRuntime(reader, {
      scopeSigner: SIGNER,
      jobInventory: createFixtureInventoryProvider(FIXTURE, "narrow_recruiter"),
      now: () => now,
      limits: { maxPerPage: 500, defaultPerPage: 500, maxLookbackDays: 365, maxRankings: 25, maxEvidenceIds: 200, maxToolDurationMs: 1_000 },
    });

    const result = await runEvidenceTool(runtime, "search_my_application_stages", { job_ids: "9001006" });

    assert.equal(result.ok, true, "a later-batch timeout must not become a hard denial that discards earlier batches");
    const rows = result.ok ? (result.data as Array<Record<string, unknown>>) : [];
    assert.equal(rows.length, 25, "the first batch's already-read rows are preserved");
    assert.equal(result.ok && result.read?.complete, false);
    assert.equal(result.ok && result.read?.status, "incomplete_timeout");
    assert.equal(result.ok && result.read?.pagination_truncated, true);
    assert.equal(result.ok && result.bridge?.scoped_application_count, 30, "the scope still resolved to all 30 applications; only the endpoint read truncated");
    // NB: the non-resumable-cursor suppression is locked discriminatingly by the dedicated test below —
    // here both batches return cursorless pages, so asserting next_cursor===null would be tautological
    // (it is null regardless of the suppression). The test below makes a batch yield a live cursor.
  });

  it("a bridged read suppresses a non-resumable batch cursor even when the endpoint read yields one (R4)", async () => {
    // One in-scope app -> one endpoint batch. That batch's read-all truncates AFTER page 1 (the deadline
    // elapses mid-pagination), so read-all returns rows PLUS a live resume cursor. The bridge must NULL
    // that cursor: it is the pagination state of one 25-id application slice, and the bridge re-derives
    // application_ids on every call, so advertising it as "resumable" would be misleading. REVERT the
    // `aggregate.nextCursor = null` suppression in readBridgedByScope and the batch cursor leaks into
    // read.next_cursor -> this test fails. (The plain rollup test above cannot catch that — its batches
    // are cursorless, so next_cursor is null with or without the suppression.)
    const startedAt = Date.parse("2026-06-23T12:00:00.000Z");
    let now = startedAt;
    const reader = fakeScopedReader((toolName) => {
      if (toolName === "list_applications") {
        return scopedSuccess(toolName, [{ id: 501, job_id: 9001006, status: "active" }]);
      }
      if (toolName === "list_application_stages") {
        // Return a page WITH a cursor and push time past the 1s deadline, so read-all reads this page,
        // sees the cursor, then stops incomplete on the next iteration — yielding rows + a live cursor.
        now = startedAt + 1_001;
        return scopedSuccess(toolName, [{ id: 9501, application_id: 501, current: true }], "batch-cursor-should-not-leak");
      }
      throw new Error(`unexpected scoped tool ${toolName}`);
    });
    const { runtime } = testRuntime(reader, {
      scopeSigner: SIGNER,
      jobInventory: createFixtureInventoryProvider(FIXTURE, "narrow_recruiter"),
      now: () => now,
      limits: { maxPerPage: 500, defaultPerPage: 500, maxLookbackDays: 365, maxRankings: 25, maxEvidenceIds: 200, maxToolDurationMs: 1_000 },
    });

    const result = await runEvidenceTool(runtime, "search_my_application_stages", { job_ids: "9001006" });

    assert.equal(result.ok, true);
    // The endpoint read genuinely truncated with a live upstream cursor...
    assert.equal(result.ok && result.read?.complete, false, "the endpoint read truncated mid-pagination");
    assert.equal(result.ok && result.read?.status, "incomplete_timeout");
    assert.equal((result.ok ? (result.data as unknown[]) : []).length, 1, "the page read before truncation is preserved");
    // ...but the bridge NULLS the non-resumable batch cursor rather than advertising a misleading resume.
    // This is the discriminating assertion: it is null ONLY because readBridgedByScope suppresses it.
    assert.equal(result.ok && result.read?.next_cursor, null, "the bridged read must not leak a batch's non-resumable pagination cursor (suppression is load-bearing here)");
  });

  it("denies (fails closed) when the confirmed job scope is not accessible to this actor", async () => {
    const reader = fakeScopedReader((toolName) => scopedSuccess(toolName, []));
    const { runtime } = scopedRuntime(reader);

    // 8888888 is not in narrow_recruiter's accessible inventory.
    const result = await runEvidenceTool(runtime, "search_my_application_stages", { job_ids: "8888888" });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.denial.code, "ACTOR_DENIED");
    assert.equal(reader.calls.some((call) => call.toolName === "list_application_stages"), false, "a denied scope never reads the application-backed endpoint");
  });
});

// R2 live-pilot finding: five SIBLING tools had the identical "confirmed scope is inert" disease and —
// worse than the application-backed five — returned the all-permitted set with NO scope envelope. Their
// endpoints have no job_ids filter, so a confirmed scope is auto-bridged one hop to the endpoint's own id
// filter, derived through the scoped reader (so every id is permitted-bounded; the bridge only narrows):
//   scorecard_question_answers -> scorecard_ids (job -> applications -> scorecards)
//   interviewers               -> interview_ids (job -> interviews, read by job_ids natively)
//   candidate_educations/employments -> candidate_ids (job -> applications -> candidate_id)
//   candidates                 -> ids             (job -> applications -> candidate_id, the candidates row id)
//
// REVERT TEST: skip the bridge dispatch (route a bridgeable read through plain read-all without injecting
// the derived target id) and every test below sees its out-of-scope-but-permitted row + a missing bridge
// envelope -> fails. Each fixture puts that row (candidate/interview/scorecard 7777/99 on the permitted-
// but-out-of-scope job 9001007) in the endpoint "universe"; under a confirmed scope it must NOT appear.
describe("sibling-tool scope bridges narrow a confirmed scope (R2)", () => {
  it("scorecard questions derive interview_kit_ids from the registry, never the old scorecard_ids guess", async () => {
    const reader = fakeScopedReader((toolName, params) => {
      if (toolName === "list_interview_kits") {
        assert.equal(params?.job_ids, "9001006");
        return scopedSuccess(toolName, [{ id: 41, job_id: 9001006 }]);
      }
      if (toolName === "list_scorecard_questions") {
        assert.equal(params?.interview_kit_ids, "41");
        assert.equal(params?.scorecard_ids, undefined, "scorecard_questions has no scorecard_ids filter");
        return scopedSuccess(toolName, [
          { id: 61, interview_kit_id: 41, question: "System design?" },
        ]);
      }
      throw new Error(`unexpected scoped tool ${toolName}`);
    });
    const { runtime } = scopedRuntime(reader);

    const result = await runEvidenceTool(runtime, "search_my_scorecard_questions", {
      job_ids: "9001006",
    });

    assert.equal(result.ok, true);
    assert.deepStrictEqual(result.ok && result.data, [
      { id: 61, interview_kit_id: 41, question: "System design?" },
    ]);
    assert.equal(reader.calls.some((call) => "scorecard_ids" in (call.params ?? {})), false);
    assert.match(result.ok ? result.bridge?.basis ?? "" : "", /interview_kit_ids/);
  });

  it("candidate_educations: bridges job -> candidate_ids and excludes an out-of-scope candidate", async () => {
    const reader = fakeScopedReader((toolName, params) => {
      if (toolName === "list_applications") {
        assert.equal(params?.job_ids, "9001006", "the candidate-id derive reads applications by the confirmed scope's job_ids");
        return scopedSuccess(toolName, [
          { id: 501, candidate_id: 5001, job_id: 9001006, status: "active" },
          { id: 502, candidate_id: 5002, job_id: 9001006, status: "active" },
        ]);
      }
      if (toolName === "list_candidate_educations") {
        const universe = [
          { id: 1, candidate_id: 5001, degree_custom_field_option_id: 9 },
          { id: 2, candidate_id: 5002, degree_custom_field_option_id: 9 },
          { id: 9, candidate_id: 7777, degree_custom_field_option_id: 9 }, // a candidate on permitted-but-out-of-scope job 9001007
        ];
        const ids = typeof params?.candidate_ids === "string" ? params.candidate_ids : "";
        if (ids.length > 0) {
          const requested = new Set(ids.split(",").map((id) => Number(id)));
          return scopedSuccess(toolName, universe.filter((row) => requested.has(row.candidate_id)));
        }
        return scopedSuccess(toolName, universe); // unbridged (revert): the scoped reader returns all permitted
      }
      throw new Error(`unexpected scoped tool ${toolName} (params=${JSON.stringify(params)})`);
    });
    const { runtime } = scopedRuntime(reader);

    const result = await runEvidenceTool(runtime, "search_my_candidate_educations", { job_ids: "9001006" });

    assert.equal(result.ok, true);
    const rows = result.ok ? (result.data as Array<Record<string, unknown>>) : [];
    assert.deepStrictEqual(rows.map((row) => row.candidate_id).sort(), [5001, 5002], "a confirmed scope constrains to that scope's candidates only");
    assert.equal(rows.some((row) => row.candidate_id === 7777), false, "an out-of-scope (but permitted) candidate's rows must not leak into a req-scoped read");
    assert.equal(result.ok && result.bridge?.via, "candidate_ids");
    assert.equal(result.ok && result.bridge?.bridged, true);
    assert.equal(result.ok && result.scope?.applied, true);
    const eduReads = reader.calls.filter((call) => call.toolName === "list_candidate_educations");
    assert.ok(eduReads.length >= 1);
    assert.ok(eduReads.every((call) => typeof call.params?.candidate_ids === "string" && (call.params.candidate_ids as string).length > 0), "every endpoint read is constrained by candidate_ids");
  });

  it("candidate_employments: a confirmed scope excludes out-of-scope candidates (candidate_ids bridge)", async () => {
    const reader = fakeScopedReader((toolName, params) => {
      if (toolName === "list_applications") return scopedSuccess(toolName, [{ id: 501, candidate_id: 5001, job_id: 9001006 }]);
      if (toolName === "list_candidate_employments") {
        const universe = [
          { id: 1, candidate_id: 5001, company_name: "Acme" },
          { id: 9, candidate_id: 7777, company_name: "OutOfScope" },
        ];
        const ids = typeof params?.candidate_ids === "string" ? params.candidate_ids : "";
        if (ids.length > 0) {
          const requested = new Set(ids.split(",").map((id) => Number(id)));
          return scopedSuccess(toolName, universe.filter((row) => requested.has(row.candidate_id)));
        }
        return scopedSuccess(toolName, universe);
      }
      throw new Error(`unexpected scoped tool ${toolName}`);
    });
    const { runtime } = scopedRuntime(reader);

    const result = await runEvidenceTool(runtime, "search_my_candidate_employments", { job_ids: "9001006" });

    assert.equal(result.ok, true);
    const rows = result.ok ? (result.data as Array<Record<string, unknown>>) : [];
    assert.deepStrictEqual(rows.map((row) => row.candidate_id), [5001]);
    assert.equal(rows.some((row) => row.candidate_id === 7777), false);
    assert.equal(result.ok && result.bridge?.via, "candidate_ids");
  });

  it("candidates: bridges job -> candidate ids onto the `ids` filter, excluding out-of-scope candidates", async () => {
    const reader = fakeScopedReader((toolName, params) => {
      if (toolName === "list_applications") {
        return scopedSuccess(toolName, [
          { id: 501, candidate_id: 5001, job_id: 9001006 },
          { id: 502, candidate_id: 5002, job_id: 9001006 },
        ]);
      }
      if (toolName === "list_candidates") {
        const universe = [{ id: 5001, first_name: "A" }, { id: 5002, first_name: "B" }, { id: 7777, first_name: "Z" }];
        const ids = typeof params?.ids === "string" ? params.ids : "";
        if (ids.length > 0) {
          const requested = new Set(ids.split(",").map((id) => Number(id)));
          return scopedSuccess(toolName, universe.filter((row) => requested.has(row.id)));
        }
        return scopedSuccess(toolName, universe);
      }
      throw new Error(`unexpected scoped tool ${toolName}`);
    });
    const { runtime } = scopedRuntime(reader);

    const result = await runEvidenceTool(runtime, "search_my_candidates", { job_ids: "9001006" });

    assert.equal(result.ok, true);
    const rows = result.ok ? (result.data as Array<Record<string, unknown>>) : [];
    assert.deepStrictEqual(rows.map((row) => row.id).sort(), [5001, 5002]);
    assert.equal(rows.some((row) => row.id === 7777), false, "an out-of-scope candidate must not leak into a req-scoped candidates read");
    assert.equal(result.ok && result.bridge?.via, "ids");
    const candidateReads = reader.calls.filter((call) => call.toolName === "list_candidates");
    assert.ok(candidateReads.every((call) => typeof call.params?.ids === "string" && (call.params.ids as string).length > 0), "the candidates read is constrained by the derived ids filter");
  });

  it("interviewers: bridges job -> interview_ids (interviews read by job_ids natively), excluding an out-of-scope interview", async () => {
    const reader = fakeScopedReader((toolName, params) => {
      if (toolName === "list_interviews") {
        assert.equal(params?.job_ids, "9001006", "the interview-id derive reads interviews by the confirmed scope's job_ids");
        return scopedSuccess(toolName, [{ id: 11, job_id: 9001006 }, { id: 12, job_id: 9001006 }]);
      }
      if (toolName === "list_interviewers") {
        const universe = [
          { id: 1, interview_id: 11, user_id: 50, response_status: "to_be_submitted" },
          { id: 2, interview_id: 12, user_id: 51, response_status: "to_be_submitted" },
          { id: 9, interview_id: 99, user_id: 99, response_status: "to_be_submitted" }, // interview on an out-of-scope job
        ];
        const ids = typeof params?.interview_ids === "string" ? params.interview_ids : "";
        if (ids.length > 0) {
          const requested = new Set(ids.split(",").map((id) => Number(id)));
          return scopedSuccess(toolName, universe.filter((row) => requested.has(row.interview_id)));
        }
        return scopedSuccess(toolName, universe);
      }
      throw new Error(`unexpected scoped tool ${toolName}`);
    });
    const { runtime } = scopedRuntime(reader);

    const result = await runEvidenceTool(runtime, "search_my_interviewers", { job_ids: "9001006" });

    assert.equal(result.ok, true);
    const rows = result.ok ? (result.data as Array<Record<string, unknown>>) : [];
    assert.deepStrictEqual(rows.map((row) => row.interview_id).sort(), [11, 12]);
    assert.equal(rows.some((row) => row.interview_id === 99), false, "an out-of-scope interview's panel rows must not leak into a req-scoped read");
    assert.equal(result.ok && result.bridge?.via, "interview_ids");
    // The derive reads /v3/interviews (by job_ids), NOT /v3/applications — no application hop for this class.
    assert.equal(reader.calls.some((call) => call.toolName === "list_applications"), false);
    assert.equal(reader.calls.filter((call) => call.toolName === "list_interviews").length, 1);
  });

  it("scorecard_question_answers: two-hop bridge job -> applications -> scorecard_ids, excluding an out-of-scope scorecard", async () => {
    const reader = fakeScopedReader((toolName, params) => {
      if (toolName === "list_applications") {
        assert.equal(params?.job_ids, "9001006");
        return scopedSuccess(toolName, [{ id: 501, job_id: 9001006 }, { id: 502, job_id: 9001006 }]);
      }
      if (toolName === "list_scorecards") {
        assert.ok(typeof params?.application_ids === "string" && (params.application_ids as string).length > 0, "hop 2 reads scorecards by the scope's application_ids");
        return scopedSuccess(toolName, [{ id: 31, application_id: 501 }, { id: 32, application_id: 502 }]);
      }
      if (toolName === "list_scorecard_question_answers") {
        const universe = [
          { id: 1, scorecard_id: 31, answer: "x" },
          { id: 2, scorecard_id: 32, answer: "y" },
          { id: 9, scorecard_id: 99, answer: "z" }, // an out-of-scope scorecard's answers
        ];
        const ids = typeof params?.scorecard_ids === "string" ? params.scorecard_ids : "";
        if (ids.length > 0) {
          const requested = new Set(ids.split(",").map((id) => Number(id)));
          return scopedSuccess(toolName, universe.filter((row) => requested.has(row.scorecard_id)));
        }
        return scopedSuccess(toolName, universe);
      }
      throw new Error(`unexpected scoped tool ${toolName}`);
    });
    const { runtime } = scopedRuntime(reader);

    const result = await runEvidenceTool(runtime, "search_my_scorecard_question_answers", { job_ids: "9001006" });

    assert.equal(result.ok, true);
    const rows = result.ok ? (result.data as Array<Record<string, unknown>>) : [];
    assert.deepStrictEqual(rows.map((row) => row.scorecard_id).sort(), [31, 32]);
    assert.equal(rows.some((row) => row.scorecard_id === 99), false, "an out-of-scope scorecard's answers must not leak into a req-scoped read");
    assert.equal(result.ok && result.bridge?.via, "scorecard_ids");
    // Both derivation hops happened: applications (by job_ids) then scorecards (by application_ids).
    assert.equal(reader.calls.filter((call) => call.toolName === "list_applications").length, 1);
    assert.ok(reader.calls.filter((call) => call.toolName === "list_scorecards").length >= 1);
  });

  it("intersects a caller target id OUTSIDE the derived set (never widens past the scope)", async () => {
    // The bridge resolves candidates to {5001, 5002}. The caller ALSO passes candidate_ids=5002,9999 —
    // 9999 is outside the confirmed scope. The read must be constrained to the INTERSECTION {5002}; 9999
    // is dropped, so a caller can only narrow, never widen.
    const reader = fakeScopedReader((toolName, params) => {
      if (toolName === "list_applications") {
        return scopedSuccess(toolName, [
          { id: 501, candidate_id: 5001, job_id: 9001006 },
          { id: 502, candidate_id: 5002, job_id: 9001006 },
        ]);
      }
      if (toolName === "list_candidate_educations") {
        // 9999 sits in the universe but OUTSIDE the confirmed scope's candidate set {5001,5002}. So a
        // "use caller ids verbatim" (widen) mutation would request 9999 and surface it in the rows —
        // the row OUTCOME below independently catches a widen, not only the param-spy assertion.
        const universe = [{ id: 1, candidate_id: 5001 }, { id: 2, candidate_id: 5002 }, { id: 3, candidate_id: 9999 }];
        const ids = typeof params?.candidate_ids === "string" ? params.candidate_ids : "";
        const requested = new Set(ids.split(",").map((id) => Number(id)));
        return scopedSuccess(toolName, universe.filter((row) => requested.has(row.candidate_id)));
      }
      throw new Error(`unexpected scoped tool ${toolName}`);
    });
    const { runtime } = scopedRuntime(reader);

    const result = await runEvidenceTool(runtime, "search_my_candidate_educations", { job_ids: "9001006", candidate_ids: "5002,9999" });

    assert.equal(result.ok, true);
    const rows = result.ok ? (result.data as Array<Record<string, unknown>>) : [];
    assert.deepStrictEqual(rows.map((row) => row.candidate_id), [5002], "caller candidate_ids is intersected with the bridge set; 9999 (outside scope) is dropped");
    for (const call of reader.calls.filter((call) => call.toolName === "list_candidate_educations")) {
      assert.equal(call.params?.candidate_ids, "5002", "the endpoint read is constrained to the intersected candidate_ids only");
    }
  });

  it("an empty scope (no candidates) returns ZERO rows, never the all-permitted set", async () => {
    const reader = fakeScopedReader((toolName) => {
      if (toolName === "list_applications") return scopedSuccess(toolName, []); // the scope resolves to no applications -> no candidates
      if (toolName === "list_candidate_educations") return scopedSuccess(toolName, [{ id: 9, candidate_id: 7777 }]); // would leak if unbridged
      throw new Error(`unexpected scoped tool ${toolName}`);
    });
    const { runtime } = scopedRuntime(reader);

    const result = await runEvidenceTool(runtime, "search_my_candidate_educations", { job_ids: "9001006" });

    assert.equal(result.ok, true);
    assert.deepStrictEqual(result.ok ? result.data : "x", [], "an empty scope returns zero rows, not the permitted set");
    assert.equal(reader.calls.some((call) => call.toolName === "list_candidate_educations"), false, "an empty scope issues no endpoint read");
  });

  it("an UNSCOPED sibling read discloses it spans all permitted jobs (honest, no bridge, no derive)", async () => {
    const reader = fakeScopedReader((toolName) => {
      if (toolName === "list_interviewers") return scopedSuccess(toolName, [{ id: 1, interview_id: 11, response_status: "to_be_submitted" }]);
      throw new Error(`unexpected scoped tool ${toolName}`);
    });
    const { runtime } = scopedRuntime(reader);

    const result = await runEvidenceTool(runtime, "search_my_interviewers", {});

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.bridge, undefined, "no confirmed scope -> no bridge");
    assert.equal(result.ok && result.scope?.applied, false);
    assert.ok(result.ok && typeof result.scope?.note === "string" && result.scope.note.includes("scope_handle"), "an unscoped sibling read discloses how to narrow");
    assert.equal(reader.calls.some((call) => call.toolName === "list_interviews"), false, "an unscoped read issues no derive read");
  });
});

// Live-pilot finding #2 (2026-07-02, the offer-acceptance-rate session): the complete-set design
// left NO working time-window path on big scopes — (1) v3's native bracket ranges
// (resolved_at[gte]=...) were inexpressible at the tool boundary (the registry flattened the object
// params to bare strings, so the model guessed "A..B" and Greenhouse 400'd on the raw passthrough);
// (2) the payload-size guard returned the newest prefix with NO continuation (nextCursor: null);
// (3) an explicit per_page doubled as the UPSTREAM page size, so per_page:50 on a 3k-row scope
// meant 62 round trips and a client timeout. These tests lock the class fix: range translation,
// offset continuation, and per_page as a pure result cap.
describe("evidence search time windows + continuation (live-pilot fix #2)", () => {
  function offerRows(startId: number, count: number): Array<Record<string, unknown>> {
    return Array.from({ length: count }, (_unused, index) => ({ id: startId + index, job_id: 10, status: "Accepted" }));
  }

  it('translates the "A..B" string form to v3 bracket range params (never passes the raw range through)', async () => {
    const reader = fakeScopedReader((toolName) => scopedSuccess(toolName, offerRows(1, 3), null));
    const { runtime } = testRuntime(reader);

    const result = await runEvidenceTool(runtime, "search_my_offers", { resolved_at: "2026-04-01..2026-06-30" });

    assert.equal(result.ok, true);
    const upstream = reader.calls[0]!.params as Record<string, unknown>;
    assert.equal(upstream["resolved_at[gte]"], "2026-04-01", "range start becomes the gte bracket param");
    assert.equal(upstream["resolved_at[lte]"], "2026-06-30", "range end becomes the lte bracket param");
    assert.equal("resolved_at" in upstream, false, "the raw range string never reaches Greenhouse");
  });

  it("translates the object range form ({gte,lte}) to bracket params", async () => {
    const reader = fakeScopedReader((toolName) => scopedSuccess(toolName, offerRows(1, 2), null));
    const { runtime } = testRuntime(reader);

    const result = await runEvidenceTool(runtime, "search_my_offers", {
      resolved_at: { gte: "2026-04-01T00:00:00Z", lte: "2026-06-30T23:59:59Z" },
    });

    assert.equal(result.ok, true);
    const upstream = reader.calls[0]!.params as Record<string, unknown>;
    assert.equal(upstream["resolved_at[gte]"], "2026-04-01T00:00:00Z");
    assert.equal(upstream["resolved_at[lte]"], "2026-06-30T23:59:59Z");
  });

  it("drops bracket params whose base is not an allowed endpoint param, and unknown operators", async () => {
    const reader = fakeScopedReader((toolName) => scopedSuccess(toolName, offerRows(1, 1), null));
    const { runtime } = testRuntime(reader);

    const result = await runEvidenceTool(runtime, "search_my_offers", {
      resolved_at: { gte: "2026-04-01", junk: "x" } as unknown as Record<string, string>,
      not_a_param: { gte: "2026-01-01" } as unknown as Record<string, string>,
    });

    assert.equal(result.ok, true);
    const upstream = reader.calls[0]!.params as Record<string, unknown>;
    assert.equal(upstream["resolved_at[gte]"], "2026-04-01");
    assert.equal("resolved_at[junk]" in upstream, false, "unknown range operators are dropped");
    assert.equal(Object.keys(upstream).some((key) => key.startsWith("not_a_param")), false, "a disallowed base never smuggles through as a bracket param");
  });

  it("an explicit per_page is ONLY a result cap: the upstream sweep keeps the fast default page size", async () => {
    const reader = fakeScopedReader((toolName) => scopedSuccess(toolName, offerRows(1, 40), null));
    const { runtime } = testRuntime(reader);

    const result = await runEvidenceTool(runtime, "search_my_offers", { per_page: 5 });

    assert.equal(result.ok, true);
    assert.equal((result.ok ? (result.data as unknown[]) : []).length, 5);
    const upstream = reader.calls[0]!.params as Record<string, unknown>;
    assert.equal(upstream.per_page, 500, "a small result cap must NOT shrink the upstream page size (per_page:50 on a 3k scope meant 62 round trips and a timeout)");
  });

  it("offset pages the complete scoped set: skip N rows, disclose next_offset, never reach upstream", async () => {
    const reader = fakeScopedReader((toolName) => scopedSuccess(toolName, offerRows(1, 10), null));
    const { runtime } = testRuntime(reader);

    const result = await runEvidenceTool(runtime, "search_my_offers", { per_page: 4, offset: 4 });

    assert.equal(result.ok, true);
    const rows = result.ok ? (result.data as Array<Record<string, unknown>>) : [];
    assert.equal(rows.length, 4);
    assert.equal(rows[0]!.id, 5, "offset skips the first slice of the scoped set");
    const truncation = result.ok ? (result.read as any)?.result_truncated : null;
    assert.equal(truncation?.next_offset, 8, "the disclosure hands the model the next offset");
    assert.equal(truncation?.rows_in_scoped_set, 10);
    const upstream = reader.calls[0]!.params as Record<string, unknown>;
    assert.equal("offset" in upstream, false, "offset is a result-level knob, never an upstream param");

    const tail = await runEvidenceTool(runtime, "search_my_offers", { per_page: 4, offset: 8 });
    assert.equal(tail.ok, true);
    assert.equal((tail.ok ? (tail.data as unknown[]) : []).length, 2, "the final slice returns the remainder");
    const tailTruncation = tail.ok ? (tail.read as any)?.result_truncated : null;
    assert.equal(tailTruncation?.next_offset, undefined, "no next_offset once the scoped set is exhausted");
  });

  it("measures UTF-8 bytes and advances past a single projected row that cannot fit", async () => {
    const reader = fakeScopedReader((toolName) => scopedSuccess(toolName, [
      { id: 1, job_id: 10, status: "é".repeat(300_000) },
      { id: 2, job_id: 10, status: "Accepted" },
    ], null));
    const { runtime } = testRuntime(reader);

    const first = await runEvidenceTool(runtime, "search_my_offers", {});

    assert.equal(first.ok, true);
    assert.deepStrictEqual(first.ok ? first.data : null, []);
    const firstTruncation = first.ok ? (first.read as any)?.result_truncated : null;
    assert.equal(firstTruncation?.oversized_rows_omitted, 1);
    assert.equal(firstTruncation?.next_offset, 1, "continuation must advance instead of looping at offset zero");

    const second = await runEvidenceTool(runtime, "search_my_offers", { offset: 1 });
    assert.equal(second.ok, true);
    assert.deepStrictEqual((second.ok ? (second.data as Array<Record<string, unknown>>) : []).map((row) => row.id), [2]);
  });
});

// Live demo finding (2026-07-02, head-of-TA walkthrough): the LIVE /v3/offers endpoint 422s every
// date filter the vendored contract advertises (applications' bracket ranges work fine — this is
// per-endpoint docs-vs-live divergence, not an encoding bug; reproduced with a live probe). The
// fix is self-healing: try the native filter first, and on a 422 with range params in play,
// re-read WITHOUT them and apply the window LOCALLY to the complete scoped set, disclosed.
describe("date-window fallback when upstream rejects the filter (422)", () => {
  function offersReader() {
    return fakeScopedReader((toolName, params) => {
      const hasBrackets = Object.keys(params ?? {}).some((key) => /\[(gte|lte|gt|lt)\]$/.test(key));
      if (hasBrackets) {
        throw new Error("Greenhouse API error: 422 Unprocessable Entity (/offers) [correlation_id=test]");
      }
      return scopedSuccess(toolName, [
        { id: 1, job_id: 10, status: "Accepted", resolved_at: "2026-05-20T10:00:00.000Z" },
        { id: 2, job_id: 10, status: "Rejected", resolved_at: "2026-06-10T10:00:00.000Z" },
        { id: 3, job_id: 10, status: "Accepted", resolved_at: "2026-07-01T10:00:00.000Z" },
        { id: 4, job_id: 10, status: "Created" }, // unresolved: no resolved_at -> excluded from a resolved_at window
      ], null);
    });
  }

  it("falls back to a local window on 422, returns only in-window rows, and discloses", async () => {
    const reader = offersReader();
    const { runtime } = testRuntime(reader);
    const result = await runEvidenceTool(runtime, "search_my_offers", { resolved_at: "2026-06-01..2026-06-30" });
    assert.equal(result.ok, true, "a rejected upstream filter must degrade to local windowing, not deny");
    const rows = result.ok ? (result.data as Array<Record<string, unknown>>) : [];
    assert.deepStrictEqual(rows.map((row) => row.id), [2], "only the row resolved inside the window survives");
    const windowNote = result.ok ? (result.read as any)?.window_applied_locally : null;
    assert.ok(windowNote, "the local window is disclosed");
    assert.deepStrictEqual(windowNote.fields, ["resolved_at"]);
    assert.equal(windowNote.rows_missing_field, 1, "rows lacking the field are excluded and counted");
    const bracketCalls = reader.calls.filter((call) => Object.keys(call.params ?? {}).some((key) => key.includes("[gte]")));
    assert.equal(bracketCalls.length, 1, "the native filter is still tried FIRST (cheap where live supports it)");
    assert.equal(reader.calls.length, 2, "exactly one fallback re-read");
  });

  it("date-only lte bounds are end-of-day inclusive under local windowing", async () => {
    const reader = offersReader();
    const { runtime } = testRuntime(reader);
    const result = await runEvidenceTool(runtime, "search_my_offers", {
      resolved_at: { gte: "2026-05-01", lte: "2026-06-10" },
    });
    assert.equal(result.ok, true);
    const rows = result.ok ? (result.data as Array<Record<string, unknown>>) : [];
    assert.deepStrictEqual(rows.map((row) => row.id), [1, 2], "a timestamp ON the lte date stays in-window (end-of-day semantics)");
  });

  it("offset and per_page page the WINDOWED set", async () => {
    const reader = offersReader();
    const { runtime } = testRuntime(reader);
    const result = await runEvidenceTool(runtime, "search_my_offers", {
      resolved_at: "2026-05-01..2026-07-02",
      per_page: 1,
      offset: 1,
    });
    assert.equal(result.ok, true);
    const rows = result.ok ? (result.data as Array<Record<string, unknown>>) : [];
    assert.deepStrictEqual(rows.map((row) => row.id), [2], "offset skips within the windowed set");
    const truncation = result.ok ? (result.read as any)?.result_truncated : null;
    assert.equal(truncation?.rows_in_scoped_set, 3, "the scoped-set count reflects the window");
  });
});

describe("join-backed scope bridge accounting", () => {
  it("folds derivation and endpoint accounting without losing incomplete scope resolution", async () => {
    const meta = (rateLimitRetries: number, cacheHits: number) => ({
      retry: {
        attempts: rateLimitRetries + 1,
        rateLimitRetries,
        sleptMs: rateLimitRetries * 10,
        retryAfterSeconds: [],
      },
      cacheHits,
    });
    const reader = fakeScopedReader((toolName, params) => {
      if (toolName === "list_approval_flows") {
        assert.equal(params?.job_ids, "9001006");
        return scopedSuccess(toolName, [
          { id: 81, job_id: 9001006 },
          { id: 82, job_id: 9001006 },
        ], null, {
          rowCounts: {
            raw: 4,
            returned: 2,
            permissionExcluded: 1,
            unresolved: 1,
            status: "incomplete_scope_resolution",
          },
          meta: meta(2, 1),
        });
      }
      if (toolName === "list_approver_groups") {
        assert.equal(params?.approval_flow_ids, "81,82");
        return scopedSuccess(toolName, [
          { id: 91, approval_flow_id: 81 },
          { id: 92, approval_flow_id: 82 },
        ], null, {
          rowCounts: { raw: 3, returned: 2, permissionExcluded: 1, unresolved: 0, status: "complete" },
          meta: meta(1, 2),
        });
      }
      if (toolName === "list_approvers") {
        assert.equal(params?.approver_group_ids, "91,92");
        return scopedSuccess(toolName, [
          { id: 101, approver_group_id: 91 },
          { id: 102, approver_group_id: 92 },
        ], null, {
          rowCounts: {
            raw: 4,
            returned: 2,
            permissionExcluded: 1,
            unresolved: 1,
            status: "incomplete_scope_resolution",
          },
          meta: meta(3, 3),
        });
      }
      throw new Error(`unexpected scoped tool ${toolName}`);
    });
    const { runtime } = scopedRuntime(reader);

    const result = await runEvidenceTool(runtime, "search_my_approvers", { job_ids: "9001006" });

    assert.equal(result.ok, true);
    assert.equal(result.ok ? (result.data as unknown[]).length : -1, 2, "only endpoint rows are returned as evidence");
    assert.deepStrictEqual(result.ok && result.read && {
      status: result.read.status,
      complete: result.read.complete,
      raw: result.read.raw_rows_read,
      returned: result.read.rows_returned,
      permissionExcluded: result.read.permission_excluded,
      unresolved: result.read.unresolved_scope_rows,
      pages: result.read.pages_read,
      retries: result.read.rate_limit_retries,
      cacheHits: result.read.cache_hits,
    }, {
      status: "incomplete_scope_resolution",
      complete: false,
      raw: 11,
      returned: 6,
      permissionExcluded: 3,
      unresolved: 2,
      pages: 3,
      retries: 6,
      cacheHits: 6,
    });
    assert.ok(result.ok && (result.read?.warnings.length ?? 0) >= 2, "derive and endpoint warnings are retained");
    assert.equal(result.ok && result.rowCounts?.returned, 2, "response row count remains the evidence payload size");
    assert.equal(result.ok && result.rowCounts?.status, "incomplete_scope_resolution");
    assert.equal(result.ok && result.bridge?.derive_read_status, "incomplete_scope_resolution");
  });

  it("keeps earlier derived ids as an honest partial when a later 50-id batch cannot resolve scope", async () => {
    const jobIds = Array.from({ length: 51 }, (_unused, index) => index + 1);
    const baseInventory = createFixtureInventoryProvider(FIXTURE, "site_admin");
    const broadInventory = {
      async loadInventory(...args: Parameters<typeof baseInventory.loadInventory>) {
        const loaded = await baseInventory.loadInventory(...args);
        if (!loaded.ok) return loaded;
        const template = loaded.inventory.records[0]!;
        return {
          ok: true as const,
          inventory: {
            ...loaded.inventory,
            records: jobIds.map((id) => ({ ...template, greenhouse_job_id: id })),
            accessibleSeen: jobIds.length,
            rawRowsSeen: jobIds.length,
          },
        };
      },
    };
    const handle = SIGNER.signScopeHandle({
      subject: "user-1",
      jobIds,
      complete: true,
      label: "broad scope",
      source: "exact_ids",
      issuedAtMs: Date.parse("2026-06-23T12:00:00.000Z"),
    });
    const reader = fakeScopedReader((toolName, params) => {
      if (toolName === "list_approval_flows") {
        if (params?.job_ids === "51") return scopedDenial(toolName, "PERMISSION_JOIN_FAILED");
        return scopedSuccess(toolName, [{ id: 81, job_id: 1 }]);
      }
      if (toolName === "list_approver_groups") {
        assert.equal(params?.approval_flow_ids, "81");
        return scopedSuccess(toolName, [{ id: 91, approval_flow_id: 81 }]);
      }
      throw new Error(`unexpected scoped tool ${toolName}`);
    });
    const { runtime } = testRuntime(reader, { scopeSigner: SIGNER, jobInventory: broadInventory });

    const result = await runEvidenceTool(runtime, "search_my_approver_groups", { scope_handle: handle });

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.read?.status, "incomplete_scope_resolution");
    assert.equal(result.ok && result.read?.complete, false);
    assert.deepStrictEqual(result.ok ? (result.data as unknown[]) : [], [{ id: 91, approval_flow_id: 81 }]);
    assert.ok(result.ok && result.read?.warnings.some((warning) => warning.includes("later batch")));
  });

  it("fails closed when the first scope-id derivation batch is denied", async () => {
    const reader = fakeScopedReader((toolName) => scopedDenial(toolName, "PERMISSION_JOIN_FAILED"));
    const { runtime } = scopedRuntime(reader);

    const result = await runEvidenceTool(runtime, "search_my_approver_groups", { job_ids: "9001006" });

    assert.equal(result.ok, false);
    assert.equal(result.ok ? "ok" : result.denial.code, "PERMISSION_JOIN_FAILED");
    assert.equal(reader.calls.some((call) => call.toolName === "list_approver_groups"), false);
  });
});
