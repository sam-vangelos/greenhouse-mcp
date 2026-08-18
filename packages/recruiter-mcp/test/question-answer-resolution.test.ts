import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createFixtureInventoryProvider, type JobScopeFixture } from "../src/resolvers/job-scope/inventory.js";
import { createScopeSigner } from "../src/resolvers/job-scope/scope-handle.js";
import { runRecruitingQuestionAnswer } from "../src/tools/question-answer.js";
import { fakeScopedReader, scopedSuccess, testRuntime } from "./test-helpers.js";

const fixture = JSON.parse(
  readFileSync(resolve("test/fixtures/job-scope-resolution.fixture.json"), "utf8")
) as JobScopeFixture;
const signer = createScopeSigner("planner-secret-planner-secret-planner-0123");
const NOW = Date.parse("2026-06-23T12:00:00.000Z");

describe("answer_my_recruiting_question — scope resolution", () => {
  it("resolves a role query first and returns a confirmation-required response without running recipes", async () => {
    const reader = fakeScopedReader((toolName) => {
      throw new Error(`planner must not run recipes before scope is confirmed (called ${toolName})`);
    });
    const { runtime } = testRuntime(reader, {
      scopeSigner: signer,
      jobInventory: createFixtureInventoryProvider(fixture, "narrow_recruiter"),
    });

    const result = await runRecruitingQuestionAnswer(runtime, {
      question: "How are interviews going for my forward deployed engineer reqs?",
      query: "Forward Deployed Engineer",
    });

    assert.equal(result.ok, true);
    const out = result.ok ? (result.data as any) : null;
    assert.equal(out.summary.scope_resolution_required, true);
    assert.equal(out.answer.mode, "resolution_required");
    assert.equal(out.resolution.resolution_status, "needs_confirmation");
    assert.equal(reader.calls.length, 0);
  });

  it("does not silently run org-wide for a site admin broad phrase", async () => {
    const reader = fakeScopedReader((toolName) => {
      throw new Error(`admin broad phrase must not silently run analysis (called ${toolName})`);
    });
    const { runtime } = testRuntime(reader, {
      scopeSigner: signer,
      jobInventory: createFixtureInventoryProvider(fixture, "site_admin"),
    });

    const result = await runRecruitingQuestionAnswer(runtime, {
      question: "Give me pipeline health across all open jobs org-wide.",
    });

    assert.equal(result.ok, true);
    const out = result.ok ? (result.data as any) : null;
    assert.equal(out.summary.scope_resolution_required, true);
    assert.equal(out.resolution.resolution_status, "needs_confirmation");
    assert.ok(out.resolution.confirmation.reason_codes.includes("admin_scope"));
    assert.ok(out.resolution.confirmation.reason_codes.includes("broad_scope"));
    assert.equal(reader.calls.length, 0);
  });

  it("auto-confirms a unique narrow match and runs scoped recipes", async () => {
    const reader = fakeScopedReader((toolName, params) => {
      if (toolName === "list_applications") {
        assert.equal(params?.job_ids, "9001006", "the resolved scope bridges job -> application_ids");
        return scopedSuccess(toolName, [{ id: 10, jobs: [{ id: 9001006 }] }]);
      }
      if (toolName === "list_scorecards") {
        assert.equal(params?.job_ids, undefined, "job_ids must never reach /v3/scorecards");
        return scopedSuccess(toolName, [], null, { rowCounts: { raw: 0, returned: 0 } });
      }
      throw new Error(`unexpected ${toolName}`);
    });
    const { runtime } = testRuntime(reader, {
      scopeSigner: signer,
      jobInventory: createFixtureInventoryProvider(fixture, "narrow_recruiter"),
    });

    const result = await runRecruitingQuestionAnswer(runtime, {
      question: "scorecard accountability for the senior ai solutions engineer role",
      query: "Senior Cloud Solutions Engineer",
      recipes: "scorecard_accountability",
    });

    assert.equal(result.ok, true);
    const out = result.ok ? (result.data as any) : null;
    assert.equal(out.summary.scope_resolution_required, undefined);
    assert.ok(out.summary.scope, "scoped run carries a scope header");
    assert.equal(out.summary.scope.job_count, 1);
    assert.ok(reader.calls.some((c) => c.toolName === "list_scorecards"));
  });

  it("runs recipes scoped to a provided scope_handle", async () => {
    const reader = fakeScopedReader((toolName, params) => {
      if (toolName === "list_applications") {
        assert.equal(params?.job_ids, "9001006", "the confirmed scope bridges job -> application_ids");
        return scopedSuccess(toolName, [{ id: 10, jobs: [{ id: 9001006 }] }]);
      }
      if (toolName === "list_scorecards") {
        assert.equal(params?.job_ids, undefined, "job_ids must never reach /v3/scorecards");
        return scopedSuccess(toolName, [], null, { rowCounts: { raw: 0, returned: 0 } });
      }
      throw new Error(`unexpected ${toolName}`);
    });
    const { runtime } = testRuntime(reader, {
      scopeSigner: signer,
      jobInventory: createFixtureInventoryProvider(fixture, "narrow_recruiter"),
    });
    const handle = signer.signScopeHandle({
      subject: runtime.session.subject, jobIds: [9001006], complete: true, label: "x", source: "cached_index", issuedAtMs: NOW,
    });

    const result = await runRecruitingQuestionAnswer(runtime, {
      question: "unsubmitted scorecards",
      scope_handle: handle,
      recipes: "scorecard_accountability",
    });

    assert.equal(result.ok, true);
    assert.ok(reader.calls.some((c) => c.toolName === "list_scorecards"));
  });

  it("does not silently run org-wide for a site admin even on a role-less generic question", async () => {
    // The dangerous case finding #1 flagged: no broad-phrase tokens, no structured
    // intent — the planner must still gate an operator/all actor via the scope-kind
    // probe, not a phrase heuristic.
    const reader = fakeScopedReader((toolName) => {
      throw new Error(`admin generic question must not run analysis silently (called ${toolName})`);
    });
    const { runtime } = testRuntime(reader, {
      scopeSigner: signer,
      jobInventory: createFixtureInventoryProvider(fixture, "site_admin"),
    });

    const result = await runRecruitingQuestionAnswer(runtime, {
      question: "How is the pipeline health right now?",
    });

    assert.equal(result.ok, true);
    const out = result.ok ? (result.data as any) : null;
    assert.equal(out.summary.scope_resolution_required, true);
    assert.notEqual(out.resolution.resolution_status, "resolved");
    assert.ok(out.resolution.confirmation.reason_codes.includes("admin_scope"));
    assert.equal(reader.calls.length, 0, "no analysis recipes run for an unconfirmed admin scope");
  });

  it("routes an ADMIN's possessive 'my reqs' question through owner resolution, not org-wide (audit D1)", async () => {
    // site_admin (uid 7009000) has all-access, but "my reqs" must mean the reqs they OWN —
    // previously the built owner-resolution was unreachable from NL and this broadened to an
    // org-wide confirmation over the whole inventory.
    const reader = fakeScopedReader((toolName) => {
      if (toolName === "list_job_owners") {
        return scopedSuccess(toolName, [
          { id: 1, job_id: 9001003, user_id: 7009000, responsible: true, type: "recruiter" },
        ]);
      }
      throw new Error(`unexpected ${toolName} — admin 'my reqs' must not run analysis before confirmation`);
    });
    const { runtime } = testRuntime(reader, {
      scopeSigner: signer,
      jobInventory: createFixtureInventoryProvider(fixture, "site_admin"),
    });

    const result = await runRecruitingQuestionAnswer(runtime, {
      question: "Which of my reqs are stalling?",
    });

    assert.equal(result.ok, true);
    const out = result.ok ? (result.data as any) : null;
    // Owner resolution actually ran (the NL plumbing exists)...
    assert.ok(reader.calls.some((c) => c.toolName === "list_job_owners"), "owner resolution must run for admin 'my reqs'");
    assert.equal(reader.calls.some((c) => c.toolName === "list_job_hiring_managers"), false);
    // ...and whatever the resolver proposes is the OWNED req, never the org inventory.
    const proposed: number[] = out.resolution?.scope?.job_ids
      ?? out.resolution?.confirmation?.proposed_scope?.job_ids
      ?? [];
    assert.ok(proposed.length <= 1, `proposed scope must be owner-narrowed, got ${proposed.length} jobs`);
    if (proposed.length === 1) assert.equal(proposed[0], 9001003);
  });

  it("resolves possessive req intent for a narrow recruiter before running recipes", async () => {
    const reader = fakeScopedReader((toolName) => {
      if (toolName === "list_job_owners") {
        return scopedSuccess(toolName, [
          { id: 1, job_id: 9001003, user_id: 7001001, responsible: false, type: "recruiter" },
          { id: 2, job_id: 9001004, user_id: 7001001, responsible: true, type: "coordinator" },
        ]);
      }
      if (toolName === "list_applications") return scopedSuccess(toolName, []);
      if (toolName === "list_scorecards") return scopedSuccess(toolName, []);
      throw new Error(`unexpected ${toolName}`);
    });
    const { runtime } = testRuntime(reader, {
      scopeSigner: signer,
      jobInventory: createFixtureInventoryProvider(fixture, "narrow_recruiter"),
    });

    const result = await runRecruitingQuestionAnswer(runtime, {
      question: "What is broken across my reqs right now?",
      max_recipes: 5,
    });

    assert.equal(result.ok, true);
    const out = result.ok ? (result.data as any) : null;
    assert.equal(out.summary.scope_resolution_required, undefined);
    assert.ok(Array.isArray(out.summary.selected_recipes) && out.summary.selected_recipes.length > 0);
    assert.ok(reader.calls.some((call) => call.toolName === "list_job_owners"));
    assert.equal(reader.calls.some((call) => call.toolName === "list_job_hiring_managers"), false);
    assert.equal(out.summary.scope?.job_count, 1, "coordinator-only assignments do not enter my reqs");
  });

  it("validates an exact job_ids planner request before running recipes", async () => {
    const reader = fakeScopedReader((toolName, params) => {
      if (toolName === "list_applications") {
        assert.equal(params?.job_ids, "9001006", "the confirmed scope bridges job -> application_ids");
        return scopedSuccess(toolName, [{ id: 10, jobs: [{ id: 9001006 }] }]);
      }
      if (toolName === "list_scorecards") {
        assert.equal(params?.job_ids, undefined, "job_ids must never reach /v3/scorecards");
        return scopedSuccess(toolName, [], null, { rowCounts: { raw: 0, returned: 0 } });
      }
      throw new Error(`unexpected ${toolName}`);
    });
    const { runtime } = testRuntime(reader, {
      scopeSigner: signer,
      jobInventory: createFixtureInventoryProvider(fixture, "narrow_recruiter"),
    });

    const result = await runRecruitingQuestionAnswer(runtime, {
      question: "unsubmitted scorecards",
      job_ids: "9001006",
      recipes: "scorecard_accountability",
    });

    assert.equal(result.ok, true);
    assert.ok(reader.calls.some((c) => c.toolName === "list_scorecards"));
  });

  it("denies an inaccessible exact job_ids planner request before any analysis", async () => {
    const reader = fakeScopedReader((toolName) => {
      throw new Error(`inaccessible exact job_ids must not run analysis (called ${toolName})`);
    });
    const { runtime } = testRuntime(reader, {
      scopeSigner: signer,
      jobInventory: createFixtureInventoryProvider(fixture, "narrow_recruiter"),
    });

    const result = await runRecruitingQuestionAnswer(runtime, {
      question: "unsubmitted scorecards",
      job_ids: "9001002",
      recipes: "scorecard_accountability",
    });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.denial.code, "ACTOR_DENIED");
    assert.equal(reader.calls.length, 0);
  });

  it("validates an exact greenhouse_job_ids planner request through the resolver before analysis", async () => {
    const reader = fakeScopedReader((toolName, params) => {
      if (toolName === "list_applications") {
        assert.equal(params?.job_ids, "9001006", "the confirmed scope bridges job -> application_ids");
        return scopedSuccess(toolName, [{ id: 10, jobs: [{ id: 9001006 }] }]);
      }
      if (toolName === "list_scorecards") {
        assert.equal(params?.job_ids, undefined, "job_ids must never reach /v3/scorecards");
        return scopedSuccess(toolName, [], null, { rowCounts: { raw: 0, returned: 0 } });
      }
      throw new Error(`unexpected ${toolName}`);
    });
    const { runtime } = testRuntime(reader, {
      scopeSigner: signer,
      jobInventory: createFixtureInventoryProvider(fixture, "narrow_recruiter"),
    });

    const result = await runRecruitingQuestionAnswer(runtime, {
      question: "unsubmitted scorecards",
      greenhouse_job_ids: [9001006],
      recipes: "scorecard_accountability",
    });

    assert.equal(result.ok, true);
    assert.ok(reader.calls.some((c) => c.toolName === "list_scorecards"));
  });
});
