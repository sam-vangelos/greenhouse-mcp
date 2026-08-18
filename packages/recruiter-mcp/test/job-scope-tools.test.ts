import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createFixtureInventoryProvider, type JobScopeFixture } from "../src/resolvers/job-scope/inventory.js";
import { createScopeSigner } from "../src/resolvers/job-scope/scope-handle.js";
import {
  runConfirmJobScope,
  runGetJobScope,
  runGetRecruitingCapabilities,
  runResolveJobScope,
} from "../src/tools/job-scope/tools.js";
import { PILOT_TOOL_NAMES, RECRUITER_TOOL_DEFINITIONS } from "../src/tools/register.js";
import { runPipelineQuality } from "../src/tools/pipeline-quality.js";
import { PLANNER_RECIPE_IDS } from "../src/tools/question-answer.js";
import type { ResolveJobScopeOutput } from "../src/resolvers/job-scope/resolver.js";
import { fakeScopedReader, scopedSuccess, testRuntime } from "./test-helpers.js";

const fixture = JSON.parse(
  readFileSync(resolve("test/fixtures/job-scope-resolution.fixture.json"), "utf8")
) as JobScopeFixture;
const signer = createScopeSigner("tools-secret-tools-secret-tools-secret-0123");
const NOW = Date.parse("2026-06-23T12:00:00.000Z");

function fixtureRuntime(personaId: string, overrides: Record<string, unknown> = {}) {
  const scopedReader = fakeScopedReader(() => {
    throw new Error("scope tools must not call scopedRead when a fixture inventory is injected");
  });
  return testRuntime(scopedReader, {
    scopeSigner: signer,
    jobInventory: createFixtureInventoryProvider(fixture, personaId),
    ...overrides,
  });
}

function data(result: { ok: boolean; data?: unknown }): any {
  assert.equal(result.ok, true);
  return (result as { data: unknown }).data;
}

describe("resolve_job_scope tool", () => {
  it("auto-confirms a narrow recruiter exact job id and mints a scope handle", async () => {
    const { runtime, auditSink } = fixtureRuntime("narrow_recruiter");
    const result = await runResolveJobScope(runtime, { greenhouse_job_ids: [9001006], purpose: "scorecard_accountability" });
    const out = data(result) as ResolveJobScopeOutput;
    assert.equal(out.resolution_status, "resolved");
    assert.equal(out.scope.scope_status, "confirmed");
    assert.ok(out.scope.scope_handle);
    assert.deepStrictEqual(out.scope.job_ids, [9001006]);
    const audit = auditSink.events.at(-1);
    assert.equal(audit?.tool, "resolve_job_scope");
    assert.equal((audit as any)?.scopeAction, "resolve");
    assert.equal((audit as any)?.scopeResolutionStatus, "resolved");
  });

  it("returns a confirmation token for an ambiguous role family without minting a handle", async () => {
    const { runtime } = fixtureRuntime("narrow_recruiter");
    const result = await runResolveJobScope(runtime, { query: "Frontier Data", purpose: "stage_latency" });
    const out = data(result) as ResolveJobScopeOutput;
    assert.equal(out.resolution_status, "needs_confirmation");
    assert.equal(out.scope.scope_handle, null);
    assert.ok(out.confirmation.confirmation_token);
    assert.deepStrictEqual([...out.scope.job_ids].sort((a, b) => a - b), [9001001, 9001003, 9001004]);
  });
});

describe("resolve_job_scope — owner resolution (my reqs)", () => {
  // A runtime whose inventory comes from the fixture (permitted jobs) but whose scoped reader answers
  // the owner reads (/v3/job_owners, /v3/job_hiring_managers) so owner resolution can run end-to-end.
  function ownerRuntime(
    personaId: string,
    ownerRows: Array<Record<string, unknown>>,
    hmRows: Array<Record<string, unknown>> = []
  ) {
    const scopedReader = fakeScopedReader((toolName: string) => {
      if (toolName === "list_job_owners") return scopedSuccess(toolName, ownerRows);
      if (toolName === "list_job_hiring_managers") return scopedSuccess(toolName, hmRows);
      throw new Error(`owner resolution made an unexpected scoped read: ${toolName}`);
    });
    return testRuntime(scopedReader, {
      scopeSigner: signer,
      jobInventory: createFixtureInventoryProvider(fixture, personaId),
    });
  }

  it("'my reqs' keeps recruiter/sourcer rows, ignores responsible, and excludes coordinators and hiring managers", async () => {
    const { runtime } = ownerRuntime("narrow_recruiter", [
      { id: 1, job_id: 9001003, user_id: 7001001, responsible: false, type: "coordinator" },
      { id: 2, job_id: 9001004, user_id: 7001001, responsible: false, type: "sourcer" },
      { id: 3, job_id: 9001006, user_id: 7001001, responsible: false, type: "recruiter" },
    ], [{ id: 4, job_id: 9001005, user_id: 7001001 }]);
    const reader = runtime.scopedReader as unknown as { calls: Array<{ toolName: string; params?: Record<string, unknown> }> };
    const out = data(await runResolveJobScope(runtime, { filters: { my_jobs_only: true } })) as ResolveJobScopeOutput;
    assert.deepStrictEqual([...out.scope.job_ids].sort((a, b) => a - b), [9001004, 9001006]);
    const ownerCall = reader.calls.find((call) => call.toolName === "list_job_owners");
    assert.ok(ownerCall, "owner resolution reads job_owners");
    assert.equal("type" in (ownerCall!.params ?? {}), false, "the bridge post-filters both accepted role values");
    assert.equal(reader.calls.some((call) => call.toolName === "list_job_hiring_managers"), false);
  });

  it("deduplicates a req assigned to the actor as both recruiter and sourcer", async () => {
    const { runtime } = ownerRuntime("narrow_recruiter", [
      { id: 1, job_id: 9001003, user_id: 7001001, responsible: false, type: "recruiter" },
      { id: 2, job_id: 9001003, user_id: 7001001, responsible: true, type: "sourcer" },
    ]);

    const out = data(await runResolveJobScope(runtime, { filters: { my_jobs_only: true } })) as ResolveJobScopeOutput;

    assert.deepStrictEqual(out.scope.job_ids, [9001003]);
    assert.equal(out.scope.job_count, 1);
  });

  it("discloses an empty owned set and never widens it to all permitted reqs", async () => {
    const { runtime } = ownerRuntime("narrow_recruiter", []);

    const out = data(await runResolveJobScope(runtime, { filters: { my_jobs_only: true } })) as ResolveJobScopeOutput;

    assert.deepStrictEqual(out.scope.job_ids, []);
    assert.equal(out.scope.job_count, 0);
    assert.ok(out.warnings.some((warning) => /narrowed to 0/.test(warning)));
  });

  it("resolves my_jobs_only to the actor's owned reqs, not all permitted (revert lock)", async () => {
    // narrow_recruiter (uid 7001001) is permitted on 7 jobs but OWNS only 9001003 + 9001004.
    const { runtime } = ownerRuntime("narrow_recruiter", [
      { id: 1, job_id: 9001003, user_id: 7001001, responsible: true, type: "recruiter" },
      { id: 2, job_id: 9001004, user_id: 7001001, responsible: false, type: "recruiter" },
    ]);
    const out = data(await runResolveJobScope(runtime, { filters: { my_jobs_only: true } })) as ResolveJobScopeOutput;
    // The proposed scope is the OWNED set, not the 7 permitted jobs. (Revert the owner narrowing in the
    // resolver and this becomes all 7 permitted reqs → fails.)
    assert.deepStrictEqual([...out.scope.job_ids].sort((a, b) => a - b), [9001003, 9001004]);
    assert.notEqual(out.scope.job_ids.length, 7);
  });

  it("never widens past permitted: an owned-but-unpermitted job is dropped", async () => {
    // 9001002 is NOT in narrow_recruiter's permitted set; even if an owner row names it, it must not
    // appear (the resolver intersects the owner set with the permission-filtered inventory).
    const { runtime } = ownerRuntime("narrow_recruiter", [
      { id: 1, job_id: 9001003, user_id: 7001001, responsible: true, type: "recruiter" },
      { id: 2, job_id: 9001002, user_id: 7001001, responsible: true, type: "recruiter" },
    ]);
    const out = data(await runResolveJobScope(runtime, { filters: { my_jobs_only: true } })) as ResolveJobScopeOutput;
    assert.deepStrictEqual([...out.scope.job_ids].sort((a, b) => a - b), [9001003]);
  });

  it("fails closed (does not fall back to all-permitted) when the owner read denies", async () => {
    const scopedReader = fakeScopedReader((toolName: string) => {
      if (toolName === "list_job_owners") throw new Error("greenhouse owner read failed");
      throw new Error(`unexpected scoped tool ${toolName}`);
    });
    const runtime = testRuntime(scopedReader, {
      scopeSigner: signer,
      jobInventory: createFixtureInventoryProvider(fixture, "narrow_recruiter"),
    }).runtime;
    const result = await runResolveJobScope(runtime, { filters: { my_jobs_only: true } });
    assert.equal(result.ok, false, "an owner-read failure must deny, never silently resolve to all permitted jobs");
  });

  it("now resolves recruiter_user_ids (previously refused) to that user's owned reqs", async () => {
    // recruiter_user_ids used to fail closed as an 'unsupported owner filter'; it now narrows via
    // /v3/job_owners, still bounded to the actor's permitted jobs.
    const { runtime } = ownerRuntime("narrow_recruiter", [
      { id: 5, job_id: 9001006, user_id: 7002002, responsible: true, type: "recruiter" },
    ]);
    const out = data(await runResolveJobScope(runtime, { filters: { recruiter_user_ids: [7002002] } })) as ResolveJobScopeOutput;
    assert.equal(out.resolution_status !== "error", true, "recruiter_user_ids is now an applied filter, not a refusal");
    assert.deepStrictEqual([...out.scope.job_ids].sort((a, b) => a - b), [9001006]);
  });

  it("combines my_jobs_only with an attribute filter (owner ∩ status) — my open FDE reqs", async () => {
    // Owner set {9001003 open, 9001007 closed}; status defaults to open-only → only the open one.
    const { runtime } = ownerRuntime("narrow_recruiter", [
      { id: 1, job_id: 9001003, user_id: 7001001, responsible: true, type: "recruiter" },
      { id: 2, job_id: 9001007, user_id: 7001001, responsible: true, type: "recruiter" },
    ]);
    const out = data(await runResolveJobScope(runtime, { filters: { my_jobs_only: true } })) as ResolveJobScopeOutput;
    assert.deepStrictEqual([...out.scope.job_ids].sort((a, b) => a - b), [9001003]);
  });

  // A runtime whose job_owners read succeeds but whose hiring-manager read throws the given upstream
  // error (the exact "Greenhouse API error: <status> ..." shape the raw client produces).
  function ownerRuntimeWithHmError(hmError: Error) {
    const scopedReader = fakeScopedReader((toolName: string) => {
      if (toolName === "list_job_owners") {
        return scopedSuccess(toolName, [{ id: 1, job_id: 9001003, user_id: 7001001, responsible: true, type: "recruiter" }]);
      }
      if (toolName === "list_job_hiring_managers") throw hmError;
      throw new Error(`unexpected scoped tool ${toolName}`);
    });
    return testRuntime(scopedReader, { scopeSigner: signer, jobInventory: createFixtureInventoryProvider(fixture, "narrow_recruiter") }).runtime;
  }

  it("can still apply an explicit hiring-manager filter and disclose a forbidden HM source", async () => {
    const runtime = ownerRuntimeWithHmError(new Error("Greenhouse API error: 403 Forbidden (/v3/job_hiring_managers) [correlation_id=t1]"));
    const out = data(await runResolveJobScope(runtime, { filters: { recruiter_user_ids: [7001001], hiring_manager_user_ids: [7001001] } })) as ResolveJobScopeOutput;
    assert.deepStrictEqual([...out.scope.job_ids].sort((a, b) => a - b), [9001003]);
    assert.ok(out.owner_sources_omitted?.some((o) => o.source === "hiring_managers"), "the forbidden HM source must be disclosed in owner_sources_omitted");
    assert.ok(out.warnings.some((w) => /partial/i.test(w)), "a partial-scope warning must surface to the recruiter");
  });

  it("fails closed when an explicitly requested hiring-manager read is transient", async () => {
    const runtime = ownerRuntimeWithHmError(new Error("Greenhouse API error: 503 Service Unavailable (/v3/job_hiring_managers) [correlation_id=t2]"));
    const result = await runResolveJobScope(runtime, { filters: { recruiter_user_ids: [7001001], hiring_manager_user_ids: [7001001] } });
    // A reachable-but-incomplete source could complete on retry; degrading would silently under-report.
    assert.equal(result.ok, false, "a transient owner-source failure must fail closed, not degrade");
  });

  it("fails closed when EVERY owner source is forbidden (nothing resolved — never all-permitted)", async () => {
    const scopedReader = fakeScopedReader((toolName: string) => {
      if (toolName === "list_job_owners" || toolName === "list_job_hiring_managers") {
        throw new Error(`Greenhouse API error: 403 Forbidden (/v3/${toolName.replace("list_", "")}) [correlation_id=t3]`);
      }
      throw new Error(`unexpected scoped tool ${toolName}`);
    });
    const runtime = testRuntime(scopedReader, { scopeSigner: signer, jobInventory: createFixtureInventoryProvider(fixture, "narrow_recruiter") }).runtime;
    const result = await runResolveJobScope(runtime, { filters: { my_jobs_only: true } });
    assert.equal(result.ok, false, "all owner sources forbidden -> fail closed (no owned set to return)");
  });
});

describe("confirm_job_scope tool", () => {
  it("confirms a proposed scope and mints a usable, owner-bound scope handle", async () => {
    const { runtime } = fixtureRuntime("narrow_recruiter");
    const resolved = data(await runResolveJobScope(runtime, { query: "Frontier Data" })) as ResolveJobScopeOutput;
    const confirmed = data(await runConfirmJobScope(runtime, {
      resolution_id: resolved.resolution_id,
      confirmation_token: resolved.confirmation.confirmation_token,
      decision: "confirm_all",
    }));
    assert.equal(confirmed.scope_status, "confirmed");
    assert.ok(confirmed.scope_handle);
    assert.equal(confirmed.permission_revalidated, true);
    assert.deepStrictEqual(confirmed.job_ids, [9001001, 9001003, 9001004]);

    const inspected = data(await runGetJobScope(runtime, { scope_handle: confirmed.scope_handle }));
    assert.equal(inspected.valid, true);
    assert.equal(inspected.scope_status, "confirmed");
    assert.deepStrictEqual(inspected.job_ids, [9001001, 9001003, 9001004]);
  });

  it("narrows scope with confirm_selected and never escalates beyond the proposed set", async () => {
    const { runtime } = fixtureRuntime("narrow_recruiter");
    const resolved = data(await runResolveJobScope(runtime, { query: "Frontier Data" })) as ResolveJobScopeOutput;
    const confirmed = data(await runConfirmJobScope(runtime, {
      resolution_id: resolved.resolution_id,
      confirmation_token: resolved.confirmation.confirmation_token,
      decision: "confirm_selected",
      selected_job_ids: [9001003, 9001005], // 9001005 is outside the proposed set
    }));
    assert.equal(confirmed.scope_status, "confirmed");
    assert.deepStrictEqual(confirmed.job_ids, [9001003], "only the in-scope selection is honored");
    assert.ok(confirmed.warnings.some((w: string) => /outside the proposed scope/.test(w)));
  });

  it("never widens to a job the caller can access but did not propose (confirm_selected narrows only)", async () => {
    // 9001006 (Senior Cloud Solutions Engineer) IS accessible to narrow_recruiter but
    // is OUTSIDE the Frontier Data proposal [9001001, 9001003, 9001004]. Permission
    // revalidation cannot drop it, so ONLY the narrows-only guard keeps it out —
    // this asserts the scope MEMBERSHIP outcome, not merely a warning string, so a
    // future regression that drops the guard but keeps revalidation would fail.
    const { runtime } = fixtureRuntime("narrow_recruiter");
    const resolved = data(await runResolveJobScope(runtime, { query: "Frontier Data" })) as ResolveJobScopeOutput;
    assert.ok(!resolved.scope.job_ids.includes(9001006), "precondition: 9001006 is outside the proposed scope");
    const confirmed = data(await runConfirmJobScope(runtime, {
      resolution_id: resolved.resolution_id,
      confirmation_token: resolved.confirmation.confirmation_token,
      decision: "confirm_selected",
      selected_job_ids: [9001003, 9001006], // 9001006 is accessible to the recruiter but outside the proposal
    }));
    assert.equal(confirmed.scope_status, "confirmed");
    assert.deepStrictEqual(confirmed.job_ids, [9001003], "an accessible-but-unproposed job must not be confirmed");
    assert.ok(!confirmed.job_ids.includes(9001006), "scope must not widen to an unproposed accessible job");
    assert.ok(confirmed.warnings.some((w: string) => /outside the proposed scope/.test(w)));
  });

  it("rejects a scope on decision=reject", async () => {
    const { runtime } = fixtureRuntime("narrow_recruiter");
    const resolved = data(await runResolveJobScope(runtime, { query: "Frontier Data" })) as ResolveJobScopeOutput;
    const rejected = data(await runConfirmJobScope(runtime, {
      resolution_id: resolved.resolution_id,
      confirmation_token: resolved.confirmation.confirmation_token,
      decision: "reject",
    }));
    assert.equal(rejected.scope_status, "rejected");
    assert.equal(rejected.scope_handle, null);
  });

  it("requires acknowledgements before confirming a broad admin scope", async () => {
    const { runtime } = fixtureRuntime("site_admin");
    const resolved = data(await runResolveJobScope(runtime, {
      query: "all open jobs",
      filters: { status: ["open"], my_jobs_only: false },
      purpose: "pipeline_quality",
    })) as ResolveJobScopeOutput;
    assert.equal(resolved.resolution_status, "needs_confirmation");
    assert.ok(resolved.confirmation.reason_codes.includes("broad_scope"));
    assert.ok(resolved.confirmation.reason_codes.includes("contains_confidential_jobs"), "broad admin scope includes a confidential job");

    const blocked = data(await runConfirmJobScope(runtime, {
      resolution_id: resolved.resolution_id,
      confirmation_token: resolved.confirmation.confirmation_token,
      decision: "confirm_all",
    }));
    assert.equal(blocked.scope_status, "needs_revision");
    assert.ok(blocked.warnings.some((w: string) => /acknowledg/i.test(w)));

    // The confidential acknowledgement is independently required: supplying only the
    // broad-admin ack must still block.
    const partialAck = data(await runConfirmJobScope(runtime, {
      resolution_id: resolved.resolution_id,
      confirmation_token: resolved.confirmation.confirmation_token,
      decision: "confirm_all",
      acknowledgements: { acknowledge_broad_admin_scope: true },
    }));
    assert.equal(partialAck.scope_status, "needs_revision");
    assert.ok(partialAck.warnings.some((w: string) => /acknowledge_confidential_jobs/.test(w)));

    const confirmed = data(await runConfirmJobScope(runtime, {
      resolution_id: resolved.resolution_id,
      confirmation_token: resolved.confirmation.confirmation_token,
      decision: "confirm_all",
      acknowledgements: { acknowledge_broad_admin_scope: true, acknowledge_confidential_jobs: true },
    }));
    assert.equal(confirmed.scope_status, "confirmed");
    assert.ok(confirmed.scope_handle);
  });

  it("rejects a confirmation token issued to a different session subject", async () => {
    const { runtime } = fixtureRuntime("narrow_recruiter");
    const foreignToken = signer.signConfirmationToken({
      subject: "email:someone-else", resolutionId: "r", jobIds: [9001006], label: "x", complete: true, requiresAck: [], source: "cached_index", issuedAtMs: NOW,
    });
    const result = await runConfirmJobScope(runtime, { confirmation_token: foreignToken, decision: "confirm_all" });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.denial.code, "ACTOR_DENIED");
  });

  it("denies confirmation when a supplied resolution_id does not match the token", async () => {
    const { runtime } = fixtureRuntime("narrow_recruiter");
    const resolved = data(await runResolveJobScope(runtime, { query: "Frontier Data" })) as ResolveJobScopeOutput;
    const result = await runConfirmJobScope(runtime, {
      resolution_id: "not-the-issued-resolution-id",
      confirmation_token: resolved.confirmation.confirmation_token,
      decision: "confirm_all",
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.denial.code, "INVALID_REQUEST");
  });

  it("passes a resolved and confirmed scope handle through analysis with the same signer", async () => {
    const scopedReader = fakeScopedReader((toolName) => {
      if (toolName === "list_applications") {
        return scopedSuccess(toolName, [], null, { rowCounts: { raw: 0, returned: 0 } });
      }
      throw new Error(`unexpected scoped read ${toolName}`);
    });
    const { runtime } = testRuntime(scopedReader, {
      scopeSigner: signer,
      jobInventory: createFixtureInventoryProvider(fixture, "narrow_recruiter"),
    });
    const resolved = data(await runResolveJobScope(runtime, { query: "Frontier Data", purpose: "pipeline_quality" })) as ResolveJobScopeOutput;
    const confirmed = data(await runConfirmJobScope(runtime, {
      resolution_id: resolved.resolution_id,
      confirmation_token: resolved.confirmation.confirmation_token,
      decision: "confirm_all",
    }));

    assert.equal(confirmed.scope_status, "confirmed");
    assert.ok(confirmed.scope_handle);

    const analyzed = await runPipelineQuality(runtime, { scope_handle: confirmed.scope_handle });

    assert.equal(analyzed.ok, true);
    assert.equal(scopedReader.calls[0]?.toolName, "list_applications");
    assert.equal(scopedReader.calls[0]?.params?.job_ids, "9001001,9001003,9001004");
    const out = analyzed.ok ? analyzed.data as any : null;
    assert.equal(out.scope.source, "scope_handle");
  });

  it("confirms when the supplied resolution_id matches the token", async () => {
    const { runtime } = fixtureRuntime("narrow_recruiter");
    const resolved = data(await runResolveJobScope(runtime, { query: "Frontier Data" })) as ResolveJobScopeOutput;
    const confirmed = data(await runConfirmJobScope(runtime, {
      resolution_id: resolved.resolution_id,
      confirmation_token: resolved.confirmation.confirmation_token,
      decision: "confirm_all",
    }));
    assert.equal(confirmed.scope_status, "confirmed");
  });
});

describe("get_job_scope tool", () => {
  it("reports an expired handle as invalid for analysis", async () => {
    const { runtime } = fixtureRuntime("narrow_recruiter");
    const expiredHandle = signer.signScopeHandle({
      subject: runtime.session.subject, jobIds: [9001006], complete: true, label: "x", source: "exact_ids", issuedAtMs: NOW - 2 * 3600_000, ttlMs: 3600_000,
    });
    const out = data(await runGetJobScope(runtime, { scope_handle: expiredHandle }));
    assert.equal(out.valid, false);
    assert.equal(out.scope_status, "expired");
  });

  it("rejects a handle from another subject as forbidden", async () => {
    const { runtime } = fixtureRuntime("narrow_recruiter");
    const foreignHandle = signer.signScopeHandle({
      subject: "email:other", jobIds: [9001006], complete: true, label: "x", source: "exact_ids", issuedAtMs: NOW,
    });
    const out = data(await runGetJobScope(runtime, { scope_handle: foreignHandle }));
    assert.equal(out.valid, false);
    assert.equal(out.scope_status, "forbidden");
  });

  it("flags jobs that are no longer accessible after the handle was minted", async () => {
    const { runtime } = fixtureRuntime("narrow_recruiter");
    // 9001002 (EMEA Frontier Data) is NOT in the narrow recruiter inventory.
    const handle = signer.signScopeHandle({
      subject: runtime.session.subject, jobIds: [9001003, 9001002], complete: true, label: "x", source: "cached_index", issuedAtMs: NOW,
    });
    const out = data(await runGetJobScope(runtime, { scope_handle: handle }));
    assert.equal(out.valid, true);
    assert.deepStrictEqual(out.inaccessible_job_ids, [9001002]);
    assert.equal(out.permission_revalidated, true);
  });
});

describe("get_recruiting_capabilities tool", () => {
  it("describes only the active pilot catalog and executable recipes when allowlisted", async () => {
    const { runtime } = fixtureRuntime("narrow_recruiter", {
      toolConfig: {
        serverDisabled: false,
        allowedTools: new Set(PILOT_TOOL_NAMES),
        disabledTools: new Set<string>(),
        evidenceToolsEnabled: true,
        analyticalToolsEnabled: true,
        claudeDesktopEnabled: true,
        chatgptDesktopEnabled: true,
        operatorUnscopedEnabled: true,
      },
    });
    const caps = data(await runGetRecruitingCapabilities(runtime, {}));
    assert.deepEqual(new Set(caps.model_visible_tools), new Set(PILOT_TOOL_NAMES));
    assert.deepEqual(new Set(caps.recipes.map((recipe: any) => recipe.id)), new Set(PLANNER_RECIPE_IDS));
    for (const recipe of caps.recipes) {
      assert.ok(recipe.required_tools.every((tool: string) => PILOT_TOOL_NAMES.includes(tool as never)));
    }
  });

  it("lists read-only scope-aware recipes and excludes write/admin tools", async () => {
    const { runtime } = fixtureRuntime("narrow_recruiter");
    const caps = data(await runGetRecruitingCapabilities(runtime, {}));
    assert.equal(caps.read_only, true);
    assert.ok(caps.recipes.every((r: any) => r.read_only === true));
    assert.ok(caps.scope_resolution.tools.includes("resolve_job_scope"));
    const serialized = JSON.stringify(caps);
    assert.doesNotMatch(serialized, /reject_application|move_application_to_stage|create_offer|update_application_assignment/);
  });

  it("returns v2 recipe metadata that references only registered read-only scoped tools", async () => {
    const { runtime } = fixtureRuntime("narrow_recruiter");
    const caps = data(await runGetRecruitingCapabilities(runtime, {}));
    const registered = new Set(RECRUITER_TOOL_DEFINITIONS.map((tool) => tool.name));
    const allowedScopes = new Set(["single_job", "job_set", "recruiter_permitted_jobs", "confirmed_operator_scope"]);

    assert.ok(Array.isArray(caps.recipes));
    assert.ok(caps.recipes.length >= 5);
    for (const recipe of caps.recipes) {
      assert.equal(typeof recipe.id, "string");
      assert.equal(typeof recipe.name, "string");
      assert.equal(typeof recipe.example_question, "string");
      assert.equal(typeof recipe.summary, "string");
      assert.equal(recipe.read_only, true);
      assert.ok(Array.isArray(recipe.required_tools), `${recipe.id} required_tools`);
      assert.ok(recipe.required_tools.length > 0, `${recipe.id} must name at least one scoped tool`);
      assert.ok(allowedScopes.has(recipe.required_scope), `${recipe.id} required_scope`);
      assert.ok(Array.isArray(recipe.verification) && recipe.verification.length > 0, `${recipe.id} verification`);
      assert.ok(Array.isArray(recipe.completeness_requirements) && recipe.completeness_requirements.length > 0, `${recipe.id} completeness`);
      assert.ok(Array.isArray(recipe.safety_notes) && recipe.safety_notes.length > 0, `${recipe.id} safety`);
      for (const tool of recipe.required_tools) {
        assert.ok(registered.has(tool), `${recipe.id} references unregistered tool ${tool}`);
      }
    }

    // Executability honesty: a recipe is marked available IFF the planner can run
    // it. Recipes that are not planner-executable are model-composed from scoped
    // reads and must not claim answer_my_recruiting_question as their tool or a
    // required tool (which would advertise a single-call analysis that silently
    // routes to a different recipe).
    const availableIds = caps.recipes
      .filter((recipe: any) => recipe.availability === "available")
      .map((recipe: any) => recipe.id)
      .sort();
    assert.deepStrictEqual(
      availableIds,
      [...PLANNER_RECIPE_IDS].sort(),
      "availability:'available' must match exactly the planner-runnable recipes",
    );
    for (const recipe of caps.recipes) {
      assert.ok(recipe.required_tools.length > 0, `${recipe.id}: required_tools must list the tools the recipe needs`);
      assert.ok(!recipe.required_tools.includes("answer_my_recruiting_question"), `${recipe.id}: required_tools must not include the planner itself`);
      if (recipe.availability === "available") {
        // #19: an available recipe is run by exactly one executor — it must name that tool.
        assert.equal(typeof recipe.tool, "string", `${recipe.id} is planner-executable; it must name its single executor tool`);
      } else {
        // #19: a model-composed recipe has NO single executor. A `tool` pointer here misdirects the
        // model to one analysis that produces a different result, so it must be omitted — the model
        // composes required_tools instead.
        assert.equal(recipe.tool, undefined, `${recipe.id} is model-composed; it must not advertise a single executor tool`);
      }
    }
  });

  it("recipe catalog encodes the verified v3 API traps, not generic boilerplate (S4 knowledge lock)", async () => {
    const { runtime } = fixtureRuntime("narrow_recruiter");
    const caps = data(await runGetRecruitingCapabilities(runtime, {}));
    const byId = new Map(caps.recipes.map((recipe: any) => [recipe.id, recipe]));
    const text = (id: string) => {
      const r = byId.get(id) as any;
      return [...(r.safety_notes || []), ...(r.completeness_requirements || []), ...(r.verification || [])].join(" ");
    };
    assert.match(text("scorecard_accountability"), /organizer_id/, "scorecard recipe must warn organizer_id is unpopulated (attribute by job-owner, not per-interviewer)");
    assert.match(text("pipeline_quality"), /status=active/, "pipeline recipe must encode the status=active query leg");
    assert.match(text("pipeline_quality"), /in_process/, "pipeline recipe must encode the in_process response leg (the 422 query/response asymmetry)");
    assert.match(text("stage_latency"), /current_stage_at|transition history|last_activity/, "stage recipe must encode the v3 stage-timing limitation");
  });
});
