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

  // INVERTED by CLO-274. This used to assert that a site admin's broad-phrase question was
  // REFUSED until confirmed. Refusing it bought nothing — the scoped core is the permission
  // floor either way — and cost the operator the answer they asked for. The property that
  // still matters, and is asserted here, is that the org-wide scope is said OUT LOUD.
  it("CLO-274: a site admin's broad-phrase question runs org-wide with the scope disclosed, not refused", async () => {
    const reader = fakeScopedReader((toolName) => {
      if (toolName === "list_applications") {
        return scopedSuccess(toolName, [
          { id: 100, candidate_id: 1000, job_id: 9001001, stage_id: 7, stage_name: "Phone Screen", status: "active", current_stage_at: "2026-06-01T00:00:00.000Z", last_activity_at: "2026-06-01T00:00:00.000Z" },
        ]);
      }
      throw new Error(`unexpected ${toolName}`);
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
    assert.equal(out.summary.scope_resolution_required, undefined, "the question is answered, not bounced");
    assert.equal(out.summary.scope.source, "permission_scope");
    // The question said "open jobs", so the population is the OPEN readable set (9 of 10 —
    // 9001007 is closed) and the label says so rather than claiming the whole org.
    assert.equal(out.summary.scope.job_count, 9);
    assert.match(out.summary.scope.scope_label, /all 9 open jobs you can see/);
    assert.ok(reader.calls.some((c) => c.toolName === "list_applications"), "the analysis actually ran");
    assert.equal(
      reader.calls.find((c) => c.toolName === "list_applications")?.params?.job_ids,
      "9001001,9001002,9001003,9001004,9001005,9001006,9001008,9001009,9001010"
    );
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
      query: "Senior AI Solutions Engineer",
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

  // INVERTED by CLO-274. Formerly: a role-less generic admin question was gated by the
  // scope-kind probe and refused. It is now ANSWERED across the actor's whole readable set,
  // with the scope named on the answer and a warning that no req was named.
  it("CLO-274: a role-less generic admin question is answered org-wide with a 'no req named' warning", async () => {
    const reader = fakeScopedReader((toolName) => {
      if (toolName === "list_applications") {
        return scopedSuccess(toolName, [
          { id: 100, candidate_id: 1000, job_id: 9001001, stage_id: 7, stage_name: "Phone Screen", status: "active", current_stage_at: "2026-06-01T00:00:00.000Z", last_activity_at: "2026-06-01T00:00:00.000Z" },
        ]);
      }
      throw new Error(`unexpected ${toolName}`);
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
    assert.equal(out.summary.scope_resolution_required, undefined);
    assert.equal(out.summary.scope.source, "permission_scope");
    assert.equal(out.summary.scope.job_count, 10, "every job the site admin can see");
    assert.ok(
      out.summary.scope.warnings.some((w: string) => /No specific requisition was named/i.test(w)),
      `expected a 'no req named' warning, got ${JSON.stringify(out.summary.scope.warnings)}`
    );
    assert.ok(reader.calls.some((c) => c.toolName === "list_applications"));
  });

  // INVERTED by CLO-274. The owner-resolution routing still holds — "my reqs" means
  // the reqs the admin OWNS, never the org inventory — but the answer no longer stops at a
  // confirmation. A deterministic owner scope is exactly named by the actor, so it runs.
  it("CLO-274: an ADMIN's possessive 'my reqs' question resolves through owner resolution and RUNS, no confirmation", async () => {
    const reader = fakeScopedReader((toolName, params) => {
      if (toolName === "list_job_owners") {
        return scopedSuccess(toolName, [
          { id: 1, job_id: 9001003, user_id: 7009000, responsible: true, type: "recruiter" },
        ]);
      }
      if (toolName === "list_applications") {
        assert.equal(params?.job_ids, "9001003", "the owned req is the scope, not the org inventory");
        return scopedSuccess(toolName, [
          { id: 100, candidate_id: 1000, job_id: 9001003, stage_id: 7, stage_name: "Phone Screen", status: "active", current_stage_at: "2026-06-01T00:00:00.000Z", last_activity_at: "2026-06-01T00:00:00.000Z" },
        ]);
      }
      if (toolName === "list_application_stages") {
        return scopedSuccess(toolName, [
          { id: 4001, application_id: 100, job_interview_stage_id: 7, entered_at: "2026-06-01T00:00:00.000Z", exited_at: null, days_in_stage: 22, current: true },
        ]);
      }
      throw new Error(`unexpected ${toolName}`);
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
    assert.ok(reader.calls.some((c) => c.toolName === "list_job_owners"), "owner resolution must run for admin 'my reqs'");
    assert.equal(reader.calls.some((c) => c.toolName === "list_job_hiring_managers"), false);
    assert.equal(out.summary.scope_resolution_required, undefined, "an owned scope the actor named runs without a round-trip");
    assert.equal(out.summary.scope.source, "scope_handle");
    assert.equal(out.summary.scope.job_count, 1);
    assert.ok(out.summary.scope.warnings.some((w: string) => /Owner filter applied/.test(w)));
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

  // An EXPLICITLY EMPTY job_ids is a scope the caller named — zero reqs — not an absent one.
  // hasExactJobIds read "" and [] as false, so the planner skipped resolveAnalysisContext (which
  // rejects an empty set) and ran anyway. On the RECIPE path each recipe re-resolved the scope and
  // caught it; on the PLANNED-DOMAIN path (offers, openings) nothing did, and the answer came back
  // over everything the actor's permissions reach — the one direction a scope must never move on
  // its own. Probed at 7b2a1a5: `{question: "offer acceptance rate", job_ids: ""}` returned ok with
  // one unfiltered list_offers read.
  for (const [label, jobIds] of [["an empty string", ""], ["an empty array", []]] as const) {
    it(`rejects ${label} of job_ids on the planned-domain path instead of widening it to everything the actor can see`, async () => {
      const reader = fakeScopedReader((toolName) => {
        throw new Error(`an explicitly empty job_ids must read nothing (called ${toolName})`);
      });
      const { runtime } = testRuntime(reader, {
        scopeSigner: signer,
        jobInventory: createFixtureInventoryProvider(fixture, "narrow_recruiter"),
      });

      const result = await runRecruitingQuestionAnswer(runtime, {
        question: "What is our offer acceptance rate this month?",
        job_ids: jobIds,
      });

      assert.equal(result.ok, false, "zero named reqs is a scope error, never a permission-wide answer");
      assert.equal(result.ok === false && result.denial.code, "INVALID_REQUEST");
      assert.deepStrictEqual(reader.calls.map((call) => call.toolName), [], "and it costs no upstream read");
    });
  }

  it("still answers a planned-domain question with NO job_ids key over the permission-wide scope", async () => {
    // The other half of the rule: `undefined` is not an empty scope, it is "whatever my Greenhouse
    // permissions reach", and it stays ONE read.
    const reader = fakeScopedReader((toolName) => scopedSuccess(toolName, [
      { id: 1, job_id: 9001006, application_id: 101, status: "Accepted", resolved_at: "2026-06-05T10:00:00.000Z" },
    ]));
    const { runtime } = testRuntime(reader, {
      scopeSigner: signer,
      jobInventory: createFixtureInventoryProvider(fixture, "narrow_recruiter"),
    });

    const result = await runRecruitingQuestionAnswer(runtime, {
      question: "What is our offer acceptance rate this month?",
    });

    assert.equal(result.ok, true);
    const offerReads = reader.calls.filter((call) => call.toolName === "list_offers");
    assert.equal(offerReads.length, 1, "a permission-wide planned-domain read is one read");
    assert.equal(offerReads[0]!.params?.job_ids, undefined, "and it invents no job_ids");
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

// ---------------------------------------------------------------------------
// CLO-274: an actor whose Greenhouse permissions already span the org gets an ANSWER,
// with the scope it ran over stated on every answer. Naming a req still narrows.
// ---------------------------------------------------------------------------

// Inventory scopeKind distinguishes "operator" from "all"; eligibility for the org-wide
// default is scopeKind !== "jobs", so BOTH kinds are exercised.
const ALL_ACCESS_FIXTURE = {
  ...fixture,
  personas: [
    ...fixture.personas,
    {
      id: "all_access_admin",
      greenhouse_user_id: 7009001,
      permission_scope_kind: "all",
      risk_profile: "admin",
      accessible_job_ids: "all" as const,
      can_view_confidential: true,
    },
  ],
} as JobScopeFixture;

const ORG_WIDE_PERSONAS = ["site_admin", "all_access_admin"] as const;

// H0b: offer rows carry resolved_at because the planner windows on resolved_at rather than sent_on
// (the clock every published hire report uses), and the offer path bridges the accepted set's
// application_ids to /v3/applications for the reconciliation line's second count.
function offerReader() {
  return fakeScopedReader((toolName, params) => {
    if (toolName === "list_offers") {
      return scopedSuccess(toolName, [
        { id: 1, job_id: 9001001, application_id: 101, status: "Accepted", sent_on: "2026-06-01", resolved_at: "2026-06-01" },
        { id: 2, job_id: 9001001, application_id: 102, status: "Rejected", sent_on: "2026-06-02", resolved_at: "2026-06-02" },
        // 9001007 is CLOSED: an "open reqs" question must not count it.
        { id: 3, job_id: 9001007, application_id: 103, status: "Accepted", sent_on: "2026-06-03", resolved_at: "2026-06-03" },
      ]);
    }
    if (toolName === "list_applications") return bridgedHiredApplications(params);
    throw new Error(`unexpected ${toolName}`);
  });
}

function bridgedHiredApplications(params?: Record<string, unknown>) {
  const ids = String(params?.ids ?? "").split(",").filter(Boolean).map(Number);
  return scopedSuccess("list_applications", ids.map((id: number) => ({ id, job_id: 9001001, status: "hired" })));
}

describe("answer_my_recruiting_question — org-wide default (CLO-274)", () => {
  for (const personaId of ORG_WIDE_PERSONAS) {
    it(`A1: ${personaId} gets an open-req answer with the scope said out loud`, async () => {
      const reader = offerReader();
      const { runtime } = testRuntime(reader, {
        scopeSigner: signer,
        jobInventory: createFixtureInventoryProvider(ALL_ACCESS_FIXTURE, personaId),
      });

      const result = await runRecruitingQuestionAnswer(runtime, {
        question: "What is our offer acceptance rate this quarter across all open reqs?",
      });

      assert.equal(result.ok, true);
      const out = result.ok ? (result.data as any) : null;
      assert.equal(out.summary.scope_resolution_required, undefined, "an all-access actor gets an answer");
      assert.equal(out.summary.scope.source, "permission_scope");
      assert.equal(out.summary.scope.job_count, 9, "the 9 OPEN jobs, not all 10");
      assert.match(out.summary.scope.scope_label, /all 9 open jobs you can see/);
      assert.ok(
        out.summary.scope.warnings.some((w: string) => /No specific requisition was named/i.test(w)),
        `expected the 'no req named' warning, got ${JSON.stringify(out.summary.scope.warnings)}`
      );
      // The offer on the CLOSED req is excluded; without the open-req population it would be 2/3.
      assert.equal(out.answer.mode, "planned_metric");
      assert.equal(out.answer.metric.value, 0.5);
      assert.equal(out.answer.metric.denominator, 2);
    });
  }

  it("A1b: the same actor with no broad token (the probe returns no_match) still gets an org-wide answer", async () => {
    const reader = offerReader();
    const { runtime } = testRuntime(reader, {
      scopeSigner: signer,
      jobInventory: createFixtureInventoryProvider(fixture, "site_admin"),
    });

    const result = await runRecruitingQuestionAnswer(runtime, {
      question: "What is our offer acceptance rate this quarter?",
    });

    assert.equal(result.ok, true);
    const out = result.ok ? (result.data as any) : null;
    assert.equal(out.summary.scope_resolution_required, undefined);
    assert.equal(out.summary.scope.source, "permission_scope");
    assert.equal(out.summary.scope.job_count, 10, "no open-req token, so the whole readable set");
    assert.match(out.summary.scope.scope_label, /all 10 jobs you can see in Greenhouse \(org-wide\)/);
    assert.equal(out.answer.mode, "planned_metric");
  });

  it("A1c: a TRUNCATED job index is disclosed, not blocking", async () => {
    const reader = offerReader();
    const { runtime } = testRuntime(reader, {
      scopeSigner: signer,
      jobInventory: createFixtureInventoryProvider(fixture, "site_admin", { complete: false }),
    });

    const result = await runRecruitingQuestionAnswer(runtime, {
      question: "What is our offer acceptance rate this quarter across all open reqs?",
    });

    assert.equal(result.ok, true);
    const out = result.ok ? (result.data as any) : null;
    assert.equal(out.summary.scope_resolution_required, undefined, "a truncated index must not block the answer");
    assert.equal(out.summary.scope.source, "permission_scope");
    assert.match(out.summary.scope.scope_label, /org-wide; at least 10 enumerated, index truncated/);
    assert.ok(
      out.summary.scope.warnings.some((w: string) => /truncat/i.test(w)),
      `expected a truncation warning, got ${JSON.stringify(out.summary.scope.warnings)}`
    );
    // The open-req population could not be enumerated, so that gap is disclosed too.
    assert.ok(out.summary.scope.warnings.some((w: string) => /closed reqs included|open reqs/i.test(w)));
  });

  it("A2: possessive req intent for an admin resolves and runs, no confirmation", async () => {
    const reader = fakeScopedReader((toolName, params) => {
      if (toolName === "list_job_owners") {
        return scopedSuccess(toolName, [{ id: 1, job_id: 9001003, user_id: 7009000, responsible: true, type: "recruiter" }]);
      }
      if (toolName === "list_applications") {
        assert.equal(params?.job_ids, "9001003");
        return scopedSuccess(toolName, [
          { id: 100, candidate_id: 1000, job_id: 9001003, stage_id: 7, stage_name: "Phone Screen", status: "active", current_stage_at: "2026-06-01T00:00:00.000Z", last_activity_at: "2026-06-01T00:00:00.000Z" },
        ]);
      }
      if (toolName === "list_application_stages") {
        return scopedSuccess(toolName, [
          { id: 4001, application_id: 100, job_interview_stage_id: 7, entered_at: "2026-06-01T00:00:00.000Z", exited_at: null, days_in_stage: 22, current: true },
        ]);
      }
      throw new Error(`unexpected ${toolName}`);
    });
    const { runtime } = testRuntime(reader, {
      scopeSigner: signer,
      jobInventory: createFixtureInventoryProvider(fixture, "site_admin"),
    });

    const result = await runRecruitingQuestionAnswer(runtime, {
      question: "Where are candidates stuck in my reqs right now?",
    });

    assert.equal(result.ok, true);
    const out = result.ok ? (result.data as any) : null;
    assert.equal(out.summary.scope_resolution_required, undefined);
    assert.equal(out.summary.scope.source, "scope_handle");
    assert.equal(out.summary.scope.job_count, 1);
    assert.ok(out.summary.scope.warnings.some((w: string) => /Owner filter applied/.test(w)));
    assert.ok(reader.calls.some((c) => c.toolName === "list_application_stages"), "the analysis ran");
  });

  it("A3: a title matching four jobs at a real band still asks which one", async () => {
    const reader = fakeScopedReader((toolName) => {
      throw new Error(`a genuinely ambiguous title must not pick a scope for the operator (called ${toolName})`);
    });
    const { runtime } = testRuntime(reader, {
      scopeSigner: signer,
      jobInventory: createFixtureInventoryProvider(fixture, "site_admin"),
    });

    const result = await runRecruitingQuestionAnswer(runtime, {
      question: "How is Field Data doing?",
    });

    assert.equal(result.ok, true);
    const out = result.ok ? (result.data as any) : null;
    assert.equal(out.summary.scope_resolution_required, true);
    assert.equal(out.answer.mode, "resolution_required");
    assert.ok(out.resolution.matches.length >= 4, `expected four candidate reqs, got ${out.resolution.matches.length}`);
    const codes: string[] = out.resolution.confirmation.reason_codes;
    assert.ok(codes.includes("multiple_matches"), `expected multiple_matches in [${codes.join(", ")}]`);
    assert.ok(codes.some((code) => code !== "admin_scope"), "admin_scope must not be the only reason to ask");
    assert.equal(reader.calls.length, 0);
  });

  it("A3b: a named selection containing a CLOSED req runs, with the closed reqs disclosed", async () => {
    const reader = fakeScopedReader((toolName, params) => {
      if (toolName === "list_applications") {
        assert.equal(params?.job_ids, "9001007", "the named closed req is the scope");
        return scopedSuccess(toolName, [
          { id: 100, candidate_id: 1000, job_id: 9001007, stage_id: 7, stage_name: "Phone Screen", status: "active", current_stage_at: "2026-06-01T00:00:00.000Z", last_activity_at: "2026-06-01T00:00:00.000Z" },
        ]);
      }
      if (toolName === "list_application_stages") {
        return scopedSuccess(toolName, [
          { id: 4001, application_id: 100, job_interview_stage_id: 7, entered_at: "2026-06-01T00:00:00.000Z", exited_at: null, days_in_stage: 22, current: true },
        ]);
      }
      throw new Error(`unexpected ${toolName}`);
    });
    const { runtime } = testRuntime(reader, {
      scopeSigner: signer,
      jobInventory: createFixtureInventoryProvider(fixture, "site_admin"),
    });

    const result = await runRecruitingQuestionAnswer(runtime, {
      question: "Why is req SAIS-US-400 slow?",
    });

    assert.equal(result.ok, true);
    const out = result.ok ? (result.data as any) : null;
    assert.equal(out.summary.scope_resolution_required, undefined, "a closed req the operator NAMED is not a reason to refuse");
    assert.equal(out.summary.scope.job_count, 1);
    assert.ok(
      out.summary.scope.warnings.some((w: string) => /1 closed req/i.test(w)),
      `expected a closed-req disclosure, got ${JSON.stringify(out.summary.scope.warnings)}`
    );
  });

  // A4 (LOCK). promoteExactIdentifierQuery already lifts a bare req id out of free text, so an
  // org-wide-eligible actor who names a req in a sentence gets THAT req — before and after CLO-274.
  // (A narrow recruiter's plain question never reaches the resolver at all, so the promotion is
  // unreachable for them; see the report — that gap is a separate defect, not this lane's change.)
  it("A4 (LOCK): an exact req id inside a natural question resolves to that job", async () => {
    const reader = fakeScopedReader((toolName, params) => {
      if (toolName === "list_applications") {
        assert.equal(params?.job_ids, "9001006");
        return scopedSuccess(toolName, [
          { id: 100, candidate_id: 1000, job_id: 9001006, stage_id: 7, stage_name: "Phone Screen", status: "active", current_stage_at: "2026-06-01T00:00:00.000Z", last_activity_at: "2026-06-01T00:00:00.000Z" },
        ]);
      }
      if (toolName === "list_application_stages") {
        return scopedSuccess(toolName, [
          { id: 4001, application_id: 100, job_interview_stage_id: 7, entered_at: "2026-06-01T00:00:00.000Z", exited_at: null, days_in_stage: 22, current: true },
        ]);
      }
      throw new Error(`unexpected ${toolName}`);
    });
    const { runtime } = testRuntime(reader, {
      scopeSigner: signer,
      jobInventory: createFixtureInventoryProvider(fixture, "site_admin"),
    });

    const result = await runRecruitingQuestionAnswer(runtime, {
      question: "Why is req SAIS-US-401 slow?",
    });

    assert.equal(result.ok, true);
    const out = result.ok ? (result.data as any) : null;
    assert.equal(out.summary.scope_resolution_required, undefined);
    assert.equal(out.summary.scope.job_count, 1);
  });

  // ---------------------------------------------------------------------------
  // Item 0: the live defect A5's lock was hiding. A NARROW recruiter who names a req in free
  // text never reached the resolver at all (the permitted-set shortcut ran first), so
  // "why is req X slow" was answered across their whole book. The probe now runs for them
  // too; only a high-band named match narrows, and everything else keeps today's default.
  // ---------------------------------------------------------------------------
  it("A0: a narrow recruiter who names a req id in free text gets THAT req, not their whole book", async () => {
    const reader = fakeScopedReader((toolName, params) => {
      if (toolName === "list_applications") {
        assert.equal(params?.job_ids, "9001006", "the req the recruiter named is the scope");
        return scopedSuccess(toolName, [
          { id: 100, candidate_id: 1000, job_id: 9001006, stage_id: 7, stage_name: "Phone Screen", status: "active", current_stage_at: "2026-06-01T00:00:00.000Z", last_activity_at: "2026-06-01T00:00:00.000Z" },
        ]);
      }
      if (toolName === "list_application_stages") {
        return scopedSuccess(toolName, [
          { id: 4001, application_id: 100, job_interview_stage_id: 7, entered_at: "2026-06-01T00:00:00.000Z", exited_at: null, days_in_stage: 22, current: true },
        ]);
      }
      throw new Error(`unexpected ${toolName}`);
    });
    const { runtime } = testRuntime(reader, {
      scopeSigner: signer,
      jobInventory: createFixtureInventoryProvider(fixture, "narrow_recruiter"),
    });

    const result = await runRecruitingQuestionAnswer(runtime, { question: "Why is req SAIS-US-401 slow?" });

    assert.equal(result.ok, true);
    const out = result.ok ? (result.data as any) : null;
    assert.equal(out.summary.scope_resolution_required, undefined, "a req the recruiter named is not a reason to bounce");
    assert.equal(out.summary.scope.source, "scope_handle");
    assert.equal(out.summary.scope.job_count, 1);
    assert.ok(reader.calls.some((c) => c.toolName === "list_application_stages"), "the analysis actually ran");
  });

  it("A0b: a narrow recruiter's question that names a role AMBIGUOUSLY keeps the permitted-set default", async () => {
    // Field Data matches several of this recruiter's reqs at a real band. For an org-wide actor
    // that is a confirmation; for a narrow recruiter it must stay today's behavior — answer over
    // the permitted book — never a NEW confirmation round-trip they did not get before.
    const reader = fakeScopedReader((toolName, params) => {
      if (toolName === "list_applications") {
        assert.equal(params?.job_ids, undefined, "the permitted-set default passes no job_ids");
        return scopedSuccess(toolName, []);
      }
      if (toolName === "list_application_stages") return scopedSuccess(toolName, []);
      throw new Error(`unexpected ${toolName}`);
    });
    const { runtime } = testRuntime(reader, {
      scopeSigner: signer,
      jobInventory: createFixtureInventoryProvider(fixture, "narrow_recruiter"),
    });

    const result = await runRecruitingQuestionAnswer(runtime, {
      question: "Where are candidates stuck on Field Data?",
    });

    assert.equal(result.ok, true);
    const out = result.ok ? (result.data as any) : null;
    assert.equal(out.summary.scope_resolution_required, undefined);
    assert.equal(out.summary.scope.source, "permission_scope");
    assert.equal(out.summary.scope.job_count, 7);
  });

  // ---------------------------------------------------------------------------
  // Items 1 + 11: explicit narrowing that MISSES must never broaden. The classifier's
  // no_match/incomplete -> org_wide rule is for an UNNAMED natural-language probe only.
  // ---------------------------------------------------------------------------
  it("item 1: an org-wide actor's explicit query that matched nothing stays unresolved, never org-wide", async () => {
    const reader = fakeScopedReader((toolName) => {
      throw new Error(`an explicit query that missed must not widen to an org-wide read (called ${toolName})`);
    });
    const { runtime } = testRuntime(reader, {
      scopeSigner: signer,
      jobInventory: createFixtureInventoryProvider(fixture, "site_admin"),
    });

    const result = await runRecruitingQuestionAnswer(runtime, {
      question: "How is the pipeline health right now?",
      query: "Blockchain Wizard",
    });

    assert.equal(result.ok, true);
    const out = result.ok ? (result.data as any) : null;
    assert.equal(out.summary.scope_resolution_required, true);
    assert.equal(out.answer.mode, "resolution_required");
    assert.equal(out.summary.scope, undefined, "an unresolved explicit narrowing carries no permission_scope header");
  });

  it("item 1: an org-wide actor's requisition_ids that matched nothing stays unresolved", async () => {
    const reader = fakeScopedReader((toolName) => {
      throw new Error(`an explicit requisition_ids miss must not widen (called ${toolName})`);
    });
    const { runtime } = testRuntime(reader, {
      scopeSigner: signer,
      jobInventory: createFixtureInventoryProvider(fixture, "site_admin"),
    });

    const result = await runRecruitingQuestionAnswer(runtime, {
      question: "How is the pipeline health right now?",
      requisition_ids: ["NOT-A-REAL-REQ"],
    });

    assert.equal(result.ok, true);
    const out = result.ok ? (result.data as any) : null;
    assert.equal(out.summary.scope_resolution_required, true);
    assert.equal(reader.calls.length, 0);
  });

  it("item 11: 'my reqs' with an EMPTY owned set answers zero-scope, never the whole tenant", async () => {
    const reader = fakeScopedReader((toolName) => {
      if (toolName === "list_job_owners") return scopedSuccess(toolName, []);
      throw new Error(`an empty owned set must not fall back to an org-wide read (called ${toolName})`);
    });
    const { runtime } = testRuntime(reader, {
      scopeSigner: signer,
      jobInventory: createFixtureInventoryProvider(fixture, "site_admin"),
    });

    const result = await runRecruitingQuestionAnswer(runtime, { question: "Which of my reqs are stalling?" });

    assert.equal(result.ok, true);
    const out = result.ok ? (result.data as any) : null;
    assert.equal(out.summary.scope?.source, undefined, "no permission_scope header — the actor asked about THEIR reqs");
    assert.equal(out.answer.mode, "empty_scope");
    assert.match(String(out.answer.message), /recruiter or sourcer/i);
    assert.deepStrictEqual(out.analyses, []);
    assert.equal(reader.calls.some((c) => c.toolName === "list_applications"), false);
  });

  // Item 3: an "all open reqs" question over a complete index with ZERO open jobs used to fall
  // through to the unscoped permission-wide path and analyze the CLOSED ones.
  it("item 3: 'all open reqs' with no open jobs returns an empty result, not an analysis of closed reqs", async () => {
    const allClosed = {
      ...fixture,
      jobs: fixture.jobs.map((job) => ({ ...job, status: "closed" })),
    } as JobScopeFixture;
    const reader = fakeScopedReader((toolName) => {
      throw new Error(`no open req means no analysis of closed ones (called ${toolName})`);
    });
    const { runtime } = testRuntime(reader, {
      scopeSigner: signer,
      jobInventory: createFixtureInventoryProvider(allClosed, "site_admin"),
    });

    const result = await runRecruitingQuestionAnswer(runtime, {
      question: "What is our offer acceptance rate this quarter across all open reqs?",
    });

    assert.equal(result.ok, true);
    const out = result.ok ? (result.data as any) : null;
    assert.equal(out.answer.mode, "empty_scope");
    assert.match(String(out.answer.message), /no open req/i);
    assert.equal(reader.calls.some((c) => c.toolName === "list_offers"), false);
  });

  // Item 9 (principal: ACCEPTED AS IS — owner intent is the better reading of this phrase).
  it("item 9: 'across all my open reqs' resolves to the OWNED scope with no confirmation", async () => {
    const reader = fakeScopedReader((toolName, params) => {
      if (toolName === "list_job_owners") {
        return scopedSuccess(toolName, [{ id: 1, job_id: 9001003, user_id: 7009000, responsible: true, type: "recruiter" }]);
      }
      if (toolName === "list_offers") {
        // The planned-domain path reads the permitted set and narrows in memory by job_id, so the
        // proof that the OWNED scope was applied is the metric, not the read params.
        assert.equal(params?.job_ids, undefined);
        return scopedSuccess(toolName, [
          { id: 1, job_id: 9001003, application_id: 101, status: "Accepted", sent_on: "2026-06-01", resolved_at: "2026-06-01" },
          { id: 2, job_id: 9001001, application_id: 102, status: "Rejected", sent_on: "2026-06-02", resolved_at: "2026-06-02" },
        ]);
      }
      if (toolName === "list_applications") return bridgedHiredApplications(params);
      throw new Error(`unexpected ${toolName}`);
    });
    const { runtime } = testRuntime(reader, {
      scopeSigner: signer,
      jobInventory: createFixtureInventoryProvider(fixture, "site_admin"),
    });

    const result = await runRecruitingQuestionAnswer(runtime, {
      question: "What is our offer acceptance rate across all my open reqs?",
    });

    assert.equal(result.ok, true);
    const out = result.ok ? (result.data as any) : null;
    assert.equal(out.summary.scope_resolution_required, undefined);
    assert.equal(out.summary.scope.source, "scope_handle", "owner intent wins over the permitted-set reading");
    assert.equal(out.summary.scope.job_count, 1);
    assert.ok(out.summary.scope.warnings.some((w: string) => /Owner filter applied/.test(w)));
    assert.equal(out.summary.rows_considered, 1, "only the owned req's offer is in scope");
  });

  // Item 12: `broad_scope` rides the PHRASE alone, so "the entire <req>" threw away a real match.
  it("item 12: a broad word next to a NAMED req keeps the req's scope and says why", async () => {
    const reader = fakeScopedReader((toolName, params) => {
      if (toolName === "list_applications") {
        assert.equal(params?.job_ids, "9001006", "the named req survives the broad wording");
        return scopedSuccess(toolName, [
          { id: 100, candidate_id: 1000, job_id: 9001006, stage_id: 7, stage_name: "Phone Screen", status: "active", current_stage_at: "2026-06-01T00:00:00.000Z", last_activity_at: "2026-06-01T00:00:00.000Z" },
        ]);
      }
      if (toolName === "list_application_stages") {
        return scopedSuccess(toolName, [
          { id: 4001, application_id: 100, job_interview_stage_id: 7, entered_at: "2026-06-01T00:00:00.000Z", exited_at: null, days_in_stage: 22, current: true },
        ]);
      }
      throw new Error(`unexpected ${toolName}`);
    });
    const { runtime } = testRuntime(reader, {
      scopeSigner: signer,
      jobInventory: createFixtureInventoryProvider(fixture, "site_admin"),
    });

    const result = await runRecruitingQuestionAnswer(runtime, {
      question: "Where is the entire Senior AI Solutions Engineer - US pipeline stuck?",
    });

    assert.equal(result.ok, true);
    const out = result.ok ? (result.data as any) : null;
    assert.equal(out.summary.scope_resolution_required, undefined);
    assert.equal(out.summary.scope.job_count, 1);
    assert.ok(
      out.summary.scope.warnings.some((w: string) => /analysis (wording|phrasing)/i.test(w)),
      `the broad wording must be disclosed as read-as-analysis, got ${JSON.stringify(out.summary.scope.warnings)}`
    );
  });

  it("A5: a narrow recruiter's reads are unchanged; only the disclosed header is new", async () => {
    const broadPhrase = offerReader();
    const { runtime: broadRuntime } = testRuntime(broadPhrase, {
      scopeSigner: signer,
      jobInventory: createFixtureInventoryProvider(fixture, "narrow_recruiter"),
    });
    const broadResult = await runRecruitingQuestionAnswer(broadRuntime, {
      question: "What is our offer acceptance rate this quarter across all open reqs?",
    });

    const plain = offerReader();
    const { runtime: plainRuntime } = testRuntime(plain, {
      scopeSigner: signer,
      jobInventory: createFixtureInventoryProvider(fixture, "narrow_recruiter"),
    });
    const plainResult = await runRecruitingQuestionAnswer(plainRuntime, {
      question: "What is our offer acceptance rate this quarter?",
    });

    assert.equal(broadResult.ok, true);
    assert.equal(plainResult.ok, true);
    const broadOut = broadResult.ok ? (broadResult.data as any) : null;
    const plainOut = plainResult.ok ? (plainResult.data as any) : null;

    // Item 19: pinned ABSOLUTELY, not relative to a sibling run. Two runs that both silently
    // narrowed would still be deepStrictEqual to each other; only naming the expected read
    // catches a regression that changes BOTH.
    // H0b: the offer path now makes a SECOND read — the accepted set's application_ids bridged to
    // /v3/applications for the reconciliation line's "how many of these does Greenhouse call hired"
    // count. Still exactly two reads, still unscoped by job_ids, still pinned absolutely so a
    // regression that silently narrows BOTH runs is caught.
    const expectedReads = [
      { toolName: "list_offers", job_ids: undefined },
      { toolName: "list_applications", job_ids: undefined },
    ];
    assert.deepStrictEqual(
      broadPhrase.calls.map((c) => ({ toolName: c.toolName, job_ids: c.params?.job_ids })),
      expectedReads,
      "a narrow recruiter's broad-phrase question reads exactly one unscoped list_offers"
    );
    assert.deepStrictEqual(
      plain.calls.map((c) => ({ toolName: c.toolName, job_ids: c.params?.job_ids })),
      expectedReads,
      "and so does the same question without the broad phrase"
    );
    for (const out of [broadOut, plainOut]) {
      assert.equal(out.summary.scope_resolution_required, undefined);
      assert.equal(out.summary.scope.source, "permission_scope");
      assert.equal(out.summary.scope.job_count, 7);
      assert.match(out.summary.scope.scope_label, /all 7 reqs you can see in Greenhouse/);
      assert.equal(out.summary.scope.scope_hash, undefined, "an unbounded permitted-set read mints no scope hash");
    }
  });
});

// ---------------------------------------------------------------------------
// Fold-3 item 5: EVERY explicit scope carrier, not just job_ids.
//
// `job_ids: []` was fixed and the sibling carriers were not: the planner
// recognized `scope_handle` and `greenhouse_job_ids` only when NON-EMPTY, so
// `{scope_handle: "   "}` and `{greenhouse_job_ids: []}` fell through to
// default-scope resolution and answered permission-wide — a scope the caller
// named being replaced by a wider one it did not.
// ---------------------------------------------------------------------------
describe("answer_my_recruiting_question — a present-but-empty scope carrier is rejected, never widened", () => {
  for (const [label, params] of [
    ["a blank scope_handle", { scope_handle: "" }],
    ["a whitespace scope_handle", { scope_handle: "   " }],
    ["a non-string scope_handle", { scope_handle: 0 }],
    ["an empty greenhouse_job_ids", { greenhouse_job_ids: [] }],
    ["a greenhouse_job_ids of only unusable ids", { greenhouse_job_ids: [0] }],
    ["an empty requisition_ids", { requisition_ids: [] }],
    ["a requisition_ids of only blanks", { requisition_ids: ["  "] }],
    ["a whitespace job_ids", { job_ids: "   " }],
    ["a zero job_ids", { job_ids: "0" }],
  ] as const) {
    it(`rejects ${label} on the planned-domain path instead of answering permission-wide`, async () => {
      const reader = fakeScopedReader((toolName) => {
        throw new Error(`an explicitly empty scope carrier must read nothing (called ${toolName})`);
      });
      const { runtime } = testRuntime(reader, {
        scopeSigner: signer,
        jobInventory: createFixtureInventoryProvider(fixture, "narrow_recruiter"),
      });

      const result = await runRecruitingQuestionAnswer(runtime, {
        question: "What is our offer acceptance rate this month?",
        ...params,
      });

      assert.equal(result.ok, false, "a named-but-empty scope is an error, never a permission-wide answer");
      assert.equal(result.ok === false && result.denial.code, "INVALID_REQUEST");
      assert.deepStrictEqual(reader.calls.map((call) => call.toolName), [], "and it costs no upstream read");
    });
  }

  it("still answers permission-wide when NO scope carrier is present at all", async () => {
    // The other half of the rule, and the one that stops the fix from becoming a fail-closed:
    // absent is not empty, and an unscoped question is still answered over everything the actor's
    // Greenhouse permissions reach.
    const reader = fakeScopedReader((toolName) => scopedSuccess(toolName, [
      { id: 1, job_id: 9001006, application_id: 101, status: "Accepted", resolved_at: "2026-06-05T10:00:00.000Z" },
    ]));
    const { runtime } = testRuntime(reader, {
      scopeSigner: signer,
      jobInventory: createFixtureInventoryProvider(fixture, "narrow_recruiter"),
    });

    const result = await runRecruitingQuestionAnswer(runtime, {
      question: "What is our offer acceptance rate this month?",
      scope_handle: undefined,
      greenhouse_job_ids: undefined,
    });

    assert.equal(result.ok, true);
    assert.equal(reader.calls.filter((call) => call.toolName === "list_offers").length, 1);
  });
});

// ---------------------------------------------------------------------------
// Fold-3 item 6: the recipes' window validator, on the planned-domain path too.
//
// The planned-domain path read window bounds through key PRESENCE and parsed
// them with a bare Date.parse, so `window_start: ""` suppressed the sentence's
// own window and answered ALL TIME; `"0"` parsed as the year 2000 under an ISO
// contract; and a start after an end returned a confident, complete ZERO. The
// recipes reject all three, so which answer you got depended on routing.
// ---------------------------------------------------------------------------
describe("answer_my_recruiting_question — explicit window bounds are validated on the planned-domain path", () => {
  for (const [label, params] of [
    ["a blank window_start", { window_start: "" }],
    ["a blank window_end", { window_end: "" }],
    ["a non-ISO window_start", { window_start: "0", window_end: "2026-06-30" }],
    ["a non-string window_start", { window_start: 0 }],
    ["a null window_end", { window_end: null }],
    ["a start after its end", { window_start: "2026-06-30", window_end: "2026-04-01" }],
  ] as const) {
    it(`rejects ${label} rather than answering over a window nobody asked for`, async () => {
      const reader = fakeScopedReader((toolName) => {
        throw new Error(`an invalid window must read nothing (called ${toolName})`);
      });
      const { runtime } = testRuntime(reader, {
        scopeSigner: signer,
        jobInventory: createFixtureInventoryProvider(fixture, "narrow_recruiter"),
      });

      const result = await runRecruitingQuestionAnswer(runtime, {
        question: "What is our offer acceptance rate this month?",
        ...params,
      });

      assert.equal(result.ok, false, "an unusable bound is a request error, not an all-time answer");
      assert.equal(result.ok === false && result.denial.code, "INVALID_REQUEST");
      assert.equal(
        reader.calls.filter((call) => call.toolName === "list_offers").length,
        0,
        "and no offer read is paid for"
      );
    });
  }

  it("accepts a valid explicit window and answers over exactly it", async () => {
    const reader = fakeScopedReader((toolName) => {
      if (toolName === "list_offers") {
        return scopedSuccess(toolName, [
          { id: 1, job_id: 9001006, application_id: 101, status: "Accepted", resolved_at: "2026-05-05T10:00:00.000Z" },
          { id: 2, job_id: 9001006, application_id: 102, status: "Accepted", resolved_at: "2026-01-05T10:00:00.000Z" },
        ]);
      }
      return scopedSuccess(toolName, []);
    });
    const { runtime } = testRuntime(reader, {
      scopeSigner: signer,
      jobInventory: createFixtureInventoryProvider(fixture, "narrow_recruiter"),
    });

    const result = await runRecruitingQuestionAnswer(runtime, {
      question: "What is our offer acceptance rate?",
      window_start: "2026-04-01",
      window_end: "2026-06-30",
    });

    assert.equal(result.ok, true);
    const data = result.ok ? (result.data as any) : null;
    assert.equal(data.summary.rows_considered, 1, "only the offer resolved inside the explicit window");
  });

  it("accepts a ONE-SIDED explicit window rather than demanding both bounds", async () => {
    const reader = fakeScopedReader((toolName) => {
      if (toolName === "list_offers") {
        return scopedSuccess(toolName, [
          { id: 1, job_id: 9001006, application_id: 101, status: "Accepted", resolved_at: "2026-05-05T10:00:00.000Z" },
          { id: 2, job_id: 9001006, application_id: 102, status: "Accepted", resolved_at: "2026-01-05T10:00:00.000Z" },
        ]);
      }
      return scopedSuccess(toolName, []);
    });
    const { runtime } = testRuntime(reader, {
      scopeSigner: signer,
      jobInventory: createFixtureInventoryProvider(fixture, "narrow_recruiter"),
    });

    const result = await runRecruitingQuestionAnswer(runtime, {
      question: "What is our offer acceptance rate?",
      window_start: "2026-04-01",
    });

    assert.equal(result.ok, true, "a one-sided window is honoured as one-sided, never rejected");
    const data = result.ok ? (result.data as any) : null;
    assert.equal(data.summary.rows_considered, 1);
  });
});
