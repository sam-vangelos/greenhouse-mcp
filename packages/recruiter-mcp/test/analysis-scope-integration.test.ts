import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createFixtureInventoryProvider, type JobScopeFixture } from "../src/resolvers/job-scope/inventory.js";
import { createScopeSigner, scopeHashOf } from "../src/resolvers/job-scope/scope-handle.js";
import { runScorecardAccountability } from "../src/tools/scorecard-accountability.js";
import { runStageLatency } from "../src/tools/stage-latency.js";
import { fakeScopedReader, scopedSuccess, testRuntime } from "./test-helpers.js";

const fixture = JSON.parse(
  readFileSync(resolve("test/fixtures/job-scope-resolution.fixture.json"), "utf8")
) as JobScopeFixture;
const signer = createScopeSigner("analysis-secret-analysis-secret-analysis-1");
const NOW = Date.parse("2026-06-23T12:00:00.000Z");
const SUBJECT = "user-1";

function scorecardReader() {
  return fakeScopedReader((toolName, params) => {
    if (toolName === "list_applications") {
      // A narrowed scorecard read bridges job -> application_ids (/v3/scorecards has no
      // job_ids filter and 422s on it), so the derive read runs first.
      return scopedSuccess(toolName, [{ id: 10, jobs: [{ id: 9001006 }] }]);
    }
    if (toolName === "list_scorecards") {
      return scopedSuccess(toolName, [], null, { rowCounts: { raw: 0, returned: 0 } });
    }
    throw new Error(`unexpected scoped tool ${toolName} (params=${JSON.stringify(params)})`);
  });
}

function runtimeWith(
  reader: ReturnType<typeof fakeScopedReader>,
  personaId = "narrow_recruiter",
  inventoryOpts: { complete?: boolean } = {}
) {
  return testRuntime(reader, {
    scopeSigner: signer,
    jobInventory: createFixtureInventoryProvider(fixture, personaId, inventoryOpts),
  });
}

function mintHandle(jobIds: number[], opts: { complete?: boolean; subject?: string } = {}): string {
  return signer.signScopeHandle({
    subject: opts.subject ?? SUBJECT,
    jobIds,
    complete: opts.complete ?? true,
    label: "test scope",
    source: "cached_index",
    issuedAtMs: NOW,
  });
}

// A narrow recruiter assigned to a confidential req: the job is in their
// permission-filtered inventory but dropped by the confidential projection.
const CONFIDENTIAL_FIXTURE = {
  personas: [
    { id: "assigned_confidential", greenhouse_user_id: 1, permission_scope_kind: "jobs", accessible_job_ids: [5101, 5102], can_view_confidential: false },
  ],
  jobs: [
    { greenhouse_job_id: 5101, requisition_id: "OPEN-1", title: "Open Role", status: "open", department: null, office: null, location: null, opened_at: null, closed_at: null, confidential: false },
    { greenhouse_job_id: 5102, requisition_id: "CONF-1", title: "Confidential Role", status: "open", department: null, office: null, location: null, opened_at: null, closed_at: null, confidential: true },
  ],
};

function confidentialRuntime(reader: ReturnType<typeof fakeScopedReader>) {
  return testRuntime(reader, {
    scopeSigner: signer,
    jobInventory: createFixtureInventoryProvider(CONFIDENTIAL_FIXTURE as unknown as JobScopeFixture, "assigned_confidential"),
  });
}

describe("analysis tools — scope_handle integration", () => {
  it("redeems a scope_handle and scopes the analysis read to its frozen jobs", async () => {
    const reader = scorecardReader();
    const { runtime } = runtimeWith(reader);
    const result = await runScorecardAccountability(runtime, { scope_handle: mintHandle([9001006]) });
    assert.equal(result.ok, true);
    const derive = reader.calls.find((c) => c.toolName === "list_applications");
    assert.equal(derive?.params?.job_ids, "9001006", "the confirmed scope bridges job -> application_ids (/v3/scorecards has no job_ids filter)");
    assert.equal(reader.calls.find((c) => c.toolName === "list_scorecards")?.params?.job_ids, undefined, "job_ids must never reach /v3/scorecards");
    const out = result.ok ? (result.data as any) : null;
    assert.equal(out.scope.source, "scope_handle");
    assert.equal(out.scope.scope_hash, scopeHashOf([9001006]));
  });

  it("lets scope_handle win over job_ids and warns", async () => {
    const reader = scorecardReader();
    const { runtime } = runtimeWith(reader);
    const result = await runScorecardAccountability(runtime, { scope_handle: mintHandle([9001006]), job_ids: "9001009" });
    assert.equal(result.ok, true);
    const derive = reader.calls.find((c) => c.toolName === "list_applications");
    assert.equal(derive?.params?.job_ids, "9001006", "the confirmed scope bridges job -> application_ids (/v3/scorecards has no job_ids filter)");
    assert.equal(reader.calls.find((c) => c.toolName === "list_scorecards")?.params?.job_ids, undefined, "job_ids must never reach /v3/scorecards");
    const out = result.ok ? (result.data as any) : null;
    assert.ok(out.scope.warnings.some((w: string) => /takes precedence/.test(w)));
  });

  it("denies analysis when a scope_handle has no currently accessible jobs", async () => {
    const reader = fakeScopedReader(() => { throw new Error("must not read analysis data when scope has no accessible jobs"); });
    const { runtime } = runtimeWith(reader);
    // 9001002 is not in the narrow recruiter inventory.
    const result = await runScorecardAccountability(runtime, { scope_handle: mintHandle([9001002]) });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.denial.code, "ACTOR_DENIED");
    assert.equal(reader.calls.length, 0);
  });

  it("denies analysis when a scope_handle was frozen from an incomplete inventory", async () => {
    const reader = fakeScopedReader(() => { throw new Error("must not read analysis data for an incomplete-inventory handle"); });
    const { runtime } = runtimeWith(reader);
    const result = await runScorecardAccountability(runtime, { scope_handle: mintHandle([9001006], { complete: false }) });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.denial.code, "INVALID_REQUEST");
  });

  // RED-FIRST (Defect M1): a confirmed scope_handle carries a frozen job id that is
  // ABSENT from the LIVE inventory, but that live inventory is TRUNCATED — so we cannot
  // tell "revoked" from "merely unread past the cap". redeemScopeHandle used to drop the
  // unconfirmable id with only a warning and analyze a silently-narrowed scope. Like
  // validateExactJobIds, it must FAIL CLOSED on an incomplete inventory rather than
  // narrow-and-proceed.
  it("fails closed (does not silently narrow) when a frozen id is unconfirmable under a TRUNCATED live inventory", async () => {
    const reader = fakeScopedReader(() => { throw new Error("must not read analysis data when the live inventory is too incomplete to confirm the frozen scope"); });
    // Live inventory is truncated (complete:false). The frozen scope mixes an accessible
    // id (9001006) with one absent from this truncated read (9001002).
    const { runtime } = runtimeWith(reader, "narrow_recruiter", { complete: false });
    const result = await runScorecardAccountability(runtime, { scope_handle: mintHandle([9001006, 9001002]) });
    assert.equal(result.ok, false, "a truncated inventory cannot confirm the frozen scope; do not narrow-and-proceed");
    assert.equal(result.ok === false && result.denial.code, "INVALID_REQUEST");
    assert.match(result.ok === false ? result.denial.message : "", /incomplete|narrow/i);
    assert.equal(reader.calls.length, 0, "no analysis read on an unconfirmable truncated scope");
  });

  it("rejects a cross-subject scope_handle", async () => {
    const reader = fakeScopedReader(() => { throw new Error("must not read data for a foreign scope handle"); });
    const { runtime } = runtimeWith(reader);
    const result = await runScorecardAccountability(runtime, { scope_handle: mintHandle([9001006], { subject: "someone-else" }) });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.denial.code, "ACTOR_DENIED");
  });

  it("rejects a tampered scope_handle redeemed through an analysis tool before any read", async () => {
    const reader = fakeScopedReader(() => { throw new Error("must not read data for a tampered scope handle"); });
    const { runtime } = runtimeWith(reader);
    const handle = mintHandle([9001006]);
    const [body, sig] = handle.split(".");
    // Flip the last byte of the signed body without re-signing.
    const tampered = `${body.slice(0, -1)}${body.endsWith("A") ? "B" : "A"}.${sig}`;
    const result = await runScorecardAccountability(runtime, { scope_handle: tampered });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.denial.code, "INVALID_REQUEST");
    assert.equal(reader.calls.length, 0);
  });

  it("rejects an expired scope_handle redeemed through an analysis tool before any read", async () => {
    const reader = fakeScopedReader(() => { throw new Error("must not read data for an expired scope handle"); });
    const { runtime } = runtimeWith(reader);
    const expired = signer.signScopeHandle({
      subject: SUBJECT,
      jobIds: [9001006],
      complete: true,
      label: "test scope",
      source: "cached_index",
      issuedAtMs: NOW - 2 * 60 * 60 * 1000,
      ttlMs: 60 * 60 * 1000,
    });
    const result = await runScorecardAccountability(runtime, { scope_handle: expired });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.denial.code, "INVALID_REQUEST");
    assert.equal(reader.calls.length, 0);
  });

  it("scopes analyze_stage_latency to a scope_handle's jobs", async () => {
    const reader = fakeScopedReader((toolName) => {
      if (toolName === "list_applications") return scopedSuccess(toolName, [], null, { rowCounts: { raw: 0, returned: 0 } });
      throw new Error(`unexpected ${toolName}`);
    });
    const { runtime } = runtimeWith(reader);
    const result = await runStageLatency(runtime, { scope_handle: mintHandle([9001003, 9001004]) });
    assert.equal(result.ok, true);
    const call = reader.calls.find((c) => c.toolName === "list_applications");
    assert.equal(call?.params?.job_ids, "9001003,9001004");
  });
});

describe("analysis tools — exact job_ids and rejection", () => {
  it("validates an exact accessible job id against the live inventory before analysis", async () => {
    const reader = scorecardReader();
    const { runtime } = runtimeWith(reader, "narrow_recruiter");
    const result = await runScorecardAccountability(runtime, { job_ids: "9001006" });
    assert.equal(result.ok, true);
    const derive = reader.calls.find((c) => c.toolName === "list_applications");
    assert.equal(derive?.params?.job_ids, "9001006", "the confirmed scope bridges job -> application_ids (/v3/scorecards has no job_ids filter)");
    assert.equal(reader.calls.find((c) => c.toolName === "list_scorecards")?.params?.job_ids, undefined, "job_ids must never reach /v3/scorecards");
    const out = result.ok ? (result.data as any) : null;
    assert.equal(out.scope.source, "exact_ids");
    assert.equal(out.scope.job_count, 1);
  });

  it("denies an exact inaccessible job id before any analysis read", async () => {
    const reader = fakeScopedReader(() => { throw new Error("must not read analysis data for an inaccessible job id"); });
    // 9001002 (EMEA Frontier Data) is not in the narrow recruiter's permitted jobs.
    const { runtime } = runtimeWith(reader, "narrow_recruiter");
    const result = await runScorecardAccountability(runtime, { job_ids: "9001002" });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.denial.code, "ACTOR_DENIED");
    assert.ok(!reader.calls.some((c) => c.toolName === "list_scorecards"));
  });

  it("returns a distinct confidential-exclusion denial for an assigned confidential job id", async () => {
    const reader = fakeScopedReader(() => { throw new Error("must not read data for a confidential-excluded job id"); });
    const { runtime } = confidentialRuntime(reader);
    // 5102 is assigned to this recruiter but dropped by the confidential filter.
    const result = await runScorecardAccountability(runtime, { job_ids: "5102" });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.denial.code, "ACTOR_DENIED");
    assert.match(result.ok === false ? result.denial.message : "", /confidential/i);
    assert.equal(reader.calls.length, 0);
  });

  it("uses the generic not-accessible denial for a genuinely unassigned job id, not the confidential message", async () => {
    const reader = fakeScopedReader(() => { throw new Error("must not read data for an unassigned job id"); });
    const { runtime } = confidentialRuntime(reader);
    // 9999 is not in the inventory at all (not confidential-excluded, just unassigned).
    const result = await runScorecardAccountability(runtime, { job_ids: "9999" });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.denial.code, "ACTOR_DENIED");
    assert.doesNotMatch(result.ok === false ? result.denial.message : "", /confidential/i);
    assert.equal(reader.calls.length, 0);
  });

  it("denies mixed accessible + inaccessible job ids rather than silently narrowing", async () => {
    const reader = fakeScopedReader(() => { throw new Error("must not read analysis data when any requested id is inaccessible"); });
    const { runtime } = runtimeWith(reader, "narrow_recruiter");
    const result = await runScorecardAccountability(runtime, { job_ids: "9001006,9001002" });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.denial.code, "ACTOR_DENIED");
    assert.ok(!reader.calls.some((c) => c.toolName === "list_scorecards"));
  });

  it("denies when no requested job id survives validation", async () => {
    const reader = fakeScopedReader(() => { throw new Error("must not read analysis data when no requested id is accessible"); });
    const { runtime } = runtimeWith(reader, "narrow_recruiter");
    const result = await runScorecardAccountability(runtime, { job_ids: "9001002,9001005" });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.denial.code, "ACTOR_DENIED");
  });

  it("fails closed for exact job ids when the inventory is incomplete and an id is unconfirmed", async () => {
    const reader = fakeScopedReader(() => { throw new Error("must not read analysis data under an incomplete inventory with an unconfirmed id"); });
    const { runtime } = runtimeWith(reader, "narrow_recruiter", { complete: false });
    const result = await runScorecardAccountability(runtime, { job_ids: "9001006,9999999" });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.denial.code, "INVALID_REQUEST");
    assert.ok(!reader.calls.some((c) => c.toolName === "list_scorecards"));
  });

  it("rejects free-text job_query on an analysis tool", async () => {
    const reader = fakeScopedReader(() => { throw new Error("must not read data when free-text scope is rejected"); });
    const { runtime } = testRuntime(reader, { scopeSigner: signer });
    const result = await runScorecardAccountability(runtime, { job_query: "Forward Deployed Engineer" } as Record<string, unknown>);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.denial.code, "INVALID_REQUEST");
    assert.equal(reader.calls.length, 0);
  });

  it("rejects requisition_ids on an analysis tool (must resolve first)", async () => {
    const reader = fakeScopedReader(() => { throw new Error("must not read data when requisition scope is rejected"); });
    const { runtime } = testRuntime(reader, { scopeSigner: signer });
    const result = await runScorecardAccountability(runtime, { requisition_ids: ["SAIS-US-401"] } as Record<string, unknown>);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.denial.code, "INVALID_REQUEST");
  });

  it("rejects unknown analysis params before any scoped read", async () => {
    const reader = fakeScopedReader(() => { throw new Error("must not read data when an unsupported analysis param is rejected"); });
    const { runtime } = testRuntime(reader, { scopeSigner: signer });
    const result = await runScorecardAccountability(runtime, { future_job_text: "Senior Cloud Solutions Engineer" } as Record<string, unknown>);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.denial.code, "INVALID_REQUEST");
    assert.match(result.ok === false ? result.denial.message : "", /future_job_text/);
    assert.equal(reader.calls.length, 0);
  });
});
