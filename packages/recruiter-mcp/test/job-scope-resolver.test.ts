import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { base64UrlDecode } from "../src/resolution/artifacts.js";
import { buildFixtureInventory, loadScopedReaderInventory, type JobScopeFixture } from "../src/resolvers/job-scope/inventory.js";
import { resolveJobScope, type ResolveJobScopeInput } from "../src/resolvers/job-scope/resolver.js";
import { createScopeSigner } from "../src/resolvers/job-scope/scope-handle.js";
import { fakeScopedReader, scopedSuccess, testRuntime } from "./test-helpers.js";
import { DEFAULT_LIMITS } from "../src/limits.js";

interface ExpectedResolution {
  case_id: string;
  persona_id: string;
  input: Record<string, unknown> & { simulate_inventory_complete?: boolean };
  expected: {
    resolution_status: string;
    scope_status: string;
    job_ids?: number[];
    excluded_job_ids?: number[];
    forbidden_job_ids?: number[];
    confirmation_required?: boolean;
    reason_codes?: string[];
    must_not_include_titles?: string[];
    analysis_allowed?: boolean;
    matched_job_ids?: number[];
    minimum_match_count?: number;
    confirmation_token?: string | null;
    scope_handle?: string | null;
  };
}

const fixture = JSON.parse(
  readFileSync(resolve("test/fixtures/job-scope-resolution.fixture.json"), "utf8")
) as JobScopeFixture & { expected_resolutions: ExpectedResolution[]; v2_expected_resolutions: ExpectedResolution[] };

const signer = createScopeSigner("test-secret-test-secret-test-secret-0123");
const NOW = Date.parse("2026-06-23T12:00:00.000Z");

async function resolveCase(personaId: string, input: ResolveJobScopeInput, complete = true) {
  const load = buildFixtureInventory(fixture, personaId, { complete });
  assert.equal(load.ok, true);
  if (!load.ok) throw new Error("inventory load failed");
  return resolveJobScope(input, {
    inventory: load.inventory,
    subject: `email:${personaId}`,
    signer,
    nowMs: NOW,
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("job scope resolver — golden fixture", () => {
  for (const testCase of [...fixture.expected_resolutions, ...fixture.v2_expected_resolutions]) {
    it(testCase.case_id, async () => {
      const { simulate_inventory_complete, ...rest } = testCase.input;
      const complete = simulate_inventory_complete !== false;
      const output = await resolveCase(testCase.persona_id, rest as ResolveJobScopeInput, complete);
      const exp = testCase.expected;

      assert.equal(output.resolution_status, exp.resolution_status, "resolution_status");
      assert.equal(output.scope.scope_status, exp.scope_status, "scope_status");

      if (Array.isArray(exp.job_ids)) {
        assert.deepStrictEqual(
          [...output.scope.job_ids].sort((a, b) => a - b),
          [...exp.job_ids].sort((a, b) => a - b),
          "job_ids"
        );
      }
      if (typeof exp.confirmation_required === "boolean") {
        assert.equal(output.confirmation.required, exp.confirmation_required, "confirmation_required");
      }
      if (Array.isArray(exp.reason_codes)) {
        for (const code of exp.reason_codes) {
          assert.ok(
            output.confirmation.reason_codes.includes(code as never),
            `expected reason "${code}" in [${output.confirmation.reason_codes.join(", ")}]`
          );
        }
      }
      if (Array.isArray(exp.matched_job_ids)) {
        for (const id of exp.matched_job_ids) {
          assert.ok(
            output.matches.some((m) => m.greenhouse_job_id === id),
            `expected preview match ${id} in [${output.matches.map((m) => m.greenhouse_job_id).join(", ")}]`
          );
        }
      }
      if (typeof exp.minimum_match_count === "number") {
        assert.ok(output.matches.length >= exp.minimum_match_count, `expected at least ${exp.minimum_match_count} matches`);
      }
      if ("confirmation_token" in exp) {
        assert.equal(output.confirmation.confirmation_token, exp.confirmation_token, "confirmation_token");
      }
      if ("scope_handle" in exp) {
        assert.equal(output.scope.scope_handle, exp.scope_handle, "scope_handle");
      }
      if (typeof exp.analysis_allowed === "boolean") {
        assert.equal(output.analysis_allowed, exp.analysis_allowed, "analysis_allowed");
      }
      if (Array.isArray(exp.excluded_job_ids)) {
        for (const id of exp.excluded_job_ids) {
          assert.ok(!output.scope.job_ids.includes(id), `excluded job ${id} must not be in scope`);
        }
      }
      if (Array.isArray(exp.forbidden_job_ids)) {
        for (const id of exp.forbidden_job_ids) {
          assert.ok(!output.scope.job_ids.includes(id), `forbidden job ${id} must not be in scope`);
          assert.ok(
            !output.matches.some((m) => m.greenhouse_job_id === id),
            `forbidden job ${id} must not appear in matches`
          );
          assert.ok(
            !output.ambiguous_candidates.some((m) => m.greenhouse_job_id === id),
            `forbidden job ${id} must not appear in ambiguous candidates`
          );
        }
      }
      if (Array.isArray(exp.must_not_include_titles)) {
        const serialized = JSON.stringify(output);
        for (const title of exp.must_not_include_titles) {
          assert.doesNotMatch(serialized, new RegExp(escapeRegExp(title)), `must not leak "${title}"`);
        }
      }

      // Scope handle is minted only for an auto-confirmed (resolved) scope.
      if (exp.scope_status === "confirmed") {
        assert.equal(typeof output.scope.scope_handle, "string");
        assert.ok((output.scope.scope_handle ?? "").length > 0, "confirmed scope must mint a handle");
        assert.ok(output.scope.expires_at, "confirmed scope must carry expiry");
      } else {
        assert.equal(output.scope.scope_handle, null, "non-confirmed scope must not mint a handle");
      }

      // Incomplete inventory must block analysis (no handle, no confirmation token to proceed past).
      if (exp.analysis_allowed === false) {
        assert.equal(output.scope.scope_handle, null);
        assert.equal(output.resolution_status, "incomplete");
        assert.deepStrictEqual(output.scope.job_ids, [], "preview must not create an analysis scope");
      }
    });
  }
});

describe("job scope resolver — additional matrix cases", () => {
  it("resolves an exact requisition id to a single open job for a narrow recruiter", async () => {
    const output = await resolveCase("narrow_recruiter", { requisition_ids: ["SAIS-US-401"] });
    assert.equal(output.resolution_status, "resolved");
    assert.equal(output.scope.scope_status, "confirmed");
    assert.deepStrictEqual(output.scope.job_ids, [9001006]);
    assert.equal(output.confirmation.required, false);
    assert.ok(output.scope.scope_handle);
  });

  it("auto-confirms an exact job id for a site admin (exact-id path, not broad)", async () => {
    const output = await resolveCase("site_admin", { greenhouse_job_ids: [9001006] });
    assert.equal(output.resolution_status, "resolved");
    assert.equal(output.scope.scope_status, "confirmed");
    assert.deepStrictEqual(output.scope.job_ids, [9001006]);
    assert.ok(output.scope.scope_handle);
  });

  it("requires confirmation when a site admin uses a free-text single match (not exact id)", async () => {
    const output = await resolveCase("site_admin", { query: "Senior Cloud Solutions Engineer" });
    assert.equal(output.resolution_status, "needs_confirmation");
    assert.equal(output.scope.scope_handle, null);
    assert.ok(output.confirmation.reason_codes.includes("admin_scope"));
  });

  it("excludes confidential jobs from a narrow recruiter inventory entirely", async () => {
    const load = buildFixtureInventory(fixture, "narrow_recruiter");
    assert.equal(load.ok, true);
    if (!load.ok) throw new Error("load failed");
    assert.ok(!load.inventory.records.some((r) => r.confidential), "no confidential jobs for narrow recruiter");
    assert.ok(!load.inventory.records.some((r) => r.greenhouse_job_id === 9001008));
  });

  it("does not auto-confirm when allow_auto_confirm is false", async () => {
    const output = await resolveCase("narrow_recruiter", {
      greenhouse_job_ids: [9001006],
      allow_auto_confirm: false,
    });
    assert.equal(output.resolution_status, "needs_confirmation");
    assert.equal(output.scope.scope_handle, null);
    assert.ok(output.confirmation.confirmation_token);
  });

  it("emits a deterministic scope hash over the resolved job ids", async () => {
    const a = await resolveCase("narrow_recruiter", { greenhouse_job_ids: [9001006] });
    const b = await resolveCase("narrow_recruiter", { greenhouse_job_ids: [9001006] });
    assert.equal(a.scope.scope_hash, b.scope.scope_hash);
    assert.equal(a.confidence.score_type, "deterministic_lexical_alias_ranker_v1");
  });
});

describe("job scope resolver — scope cap (timidity Rank 24)", () => {
  // 25 jobs, above DEFAULT_MAX_CANDIDATES (20), so the old unconditional slice(0, 20) truncated
  // an entitled set. permission_scope_kind "all" makes the persona a site admin (isAdmin).
  const manyJobs = Array.from({ length: 25 }, (_, i) => ({
    greenhouse_job_id: 7000 + i,
    requisition_id: `REQ-${i}`,
    title: `Engineering Role ${i}`,
    status: "open",
    department: "Engineering",
    office: "US",
    location: "US",
    opened_at: null,
    closed_at: null,
  }));
  const adminInventory = {
    personas: [{ id: "admin", greenhouse_user_id: 1, permission_scope_kind: "all", accessible_job_ids: "all", can_view_confidential: true }],
    jobs: manyJobs,
  };
  const allIds = manyJobs.map((j) => j.greenhouse_job_id);

  function loadAdmin() {
    const load = buildFixtureInventory(adminInventory as any, "admin");
    assert.equal(load.ok, true);
    if (!load.ok) throw new Error("load failed");
    return load.inventory;
  }

  it("freezes ALL explicitly named job ids, never truncating to the preview cap", () => {
    const output = resolveJobScope(
      { greenhouse_job_ids: allIds },
      { inventory: loadAdmin(), subject: "admin", signer, nowMs: NOW }
    );
    // The caller named 25 exact ids; every one must be in the proposed scope (was silently 20).
    assert.equal(output.scope.job_count, 25);
    assert.equal(output.matches.length, 25);
    assert.deepStrictEqual([...output.scope.job_ids].sort((a, b) => a - b), [...allIds].sort((a, b) => a - b));
    // A multi-job scope still passes through the confirmation gate — uncapping does not auto-run it.
    assert.equal(output.confirmation.required, true);
  });

  it("freezes the full org-wide set for a deliberate broad request (site admin, all reqs)", () => {
    const output = resolveJobScope(
      { query: "everything across the entire org" },
      { inventory: loadAdmin(), subject: "admin", signer, nowMs: NOW }
    );
    // The "all 240 reqs" case: a broad admin request must carry the full set, not a 100/20 preview.
    assert.equal(output.scope.job_count, 25);
    assert.equal(output.matches.length, 25);
    assert.equal(output.confirmation.required, true);
    assert.ok(output.confirmation.reason_codes.includes("broad_scope"));
  });

  it("still preview-caps a genuinely ambiguous fuzzy search (disambiguation UX preserved)", () => {
    // A fuzzy keyword that scores many candidates (not exact, not broad) keeps a bounded preview so a
    // disambiguation prompt is not flooded; the operator narrows or names ids to scope all of them.
    const output = resolveJobScope(
      { query: "Engineering Role" },
      { inventory: loadAdmin(), subject: "admin", signer, nowMs: NOW, maxCandidates: 5 }
    );
    assert.equal(output.matches.length, 5, "fuzzy search preview is capped to maxCandidates");
    assert.ok(
      output.warnings.some((w) => /Showing the top 5 of 25 fuzzy matches/.test(w)),
      "fuzzy cap is disclosed, pointing at exact-id scoping for the full set"
    );
  });
});

describe("job scope resolver — review hardening", () => {
  it("mints a redeemable (complete) handle for an exact id under a truncated inventory", async () => {
    const output = await resolveCase("narrow_recruiter", { greenhouse_job_ids: [9001006] }, false);
    assert.equal(output.resolution_status, "resolved");
    assert.equal(output.scope.scope_status, "confirmed");
    assert.ok(output.scope.scope_handle);
    const verified = signer.verifyScopeHandle(output.scope.scope_handle!, { subject: "email:narrow_recruiter", nowMs: NOW + 1000 });
    assert.equal(verified.ok, true);
    if (verified.ok) assert.equal(verified.payload.complete, true, "named exact-id scope is complete and redeemable");
    // Provenance still reports the true inventory completeness.
    assert.equal(output.completeness.inventory_complete, false);
  });

  it("fails closed (incomplete) for an exact requisition id under a truncated inventory", async () => {
    // A requisition_id can map to multiple jobs; under truncation a same-req
    // duplicate may be off-page, so the req path cannot prove uniqueness and must
    // fail closed rather than mint an analyzable complete:true scope.
    const output = await resolveCase("narrow_recruiter", { requisition_ids: ["SAIS-US-401"] }, false);
    assert.equal(output.resolution_status, "incomplete");
    assert.equal(output.scope.scope_status, "rejected");
    assert.equal(output.scope.scope_handle, null);
    assert.equal(output.completeness.inventory_complete, false);
  });

  it("does not auto-confirm a requisition id when its duplicate is withheld off-page (truncated inventory)", async () => {
    // Only one DUP-1 job is visible; its same-req twin (9001010) is on an
    // un-fetched page (complete:false). Under the old shortcut this auto-confirmed
    // a single match and minted a complete:true handle, silently defeating
    // duplicate-req ambiguity and freezing an incomplete scope as complete.
    const inline = {
      personas: [{ id: "r", greenhouse_user_id: 1, permission_scope_kind: "jobs", accessible_job_ids: [9001009], can_view_confidential: false }],
      jobs: [
        { greenhouse_job_id: 9001009, requisition_id: "DUP-1", title: "Frontier Data Engineer", status: "open", department: null, office: null, location: null, opened_at: null, closed_at: null },
      ],
    };
    const load = buildFixtureInventory(inline as any, "r", { complete: false });
    assert.equal(load.ok, true);
    if (!load.ok) throw new Error("load failed");
    const output = resolveJobScope({ requisition_ids: ["DUP-1"] }, { inventory: load.inventory, subject: "r", signer, nowMs: NOW });

    assert.equal(output.resolution_status, "incomplete", "req under truncated inventory must fail closed");
    assert.equal(output.scope.scope_status, "rejected");
    assert.equal(output.scope.scope_handle, null, "no analyzable handle is minted");
    assert.equal(output.completeness.inventory_complete, false, "completeness must not claim a complete inventory");
    // Defense in depth: even the (absent) handle must never claim completeness.
    assert.ok(!output.confirmation.confirmation_token || output.resolution_status === "incomplete");
  });

  it("returns non-analyzable preview matches for a free-text query under a truncated inventory", async () => {
    const output = await resolveCase("narrow_recruiter", { query: "Senior Cloud Solutions Engineer" }, false);
    assert.equal(output.resolution_status, "incomplete");
    assert.equal(output.scope.scope_handle, null);
    assert.equal(output.confirmation.confirmation_token, null);
    assert.deepStrictEqual(output.scope.job_ids, []);
    assert.equal(output.analysis_allowed, false);
    assert.ok(output.matches.some((match) => match.greenhouse_job_id === 9001006));
    assert.ok(output.next_actions.includes("confirm_exact_id"));
    assert.ok(output.next_actions.includes("select_candidate"));
  });

  it("treats no visible free-text match under truncated inventory as incomplete", async () => {
    const output = await resolveCase("narrow_recruiter", { query: "Role That Is Not In The Visible Page" }, false);

    assert.equal(output.resolution_status, "incomplete");
    assert.equal(output.scope.scope_status, "rejected");
    assert.deepStrictEqual(output.scope.job_ids, []);
    assert.equal(output.scope.scope_handle, null);
    assert.equal(output.confirmation.confirmation_token, null);
    assert.equal(output.analysis_allowed, false);
    assert.ok(output.confirmation.reason_codes.includes("partial_inventory"));
  });

  it("matches decorated title queries without requiring every decorative token", async () => {
    const output = await resolveCase("site_admin", {
      query: "Senior Cloud Solutions Engineer STEM US",
      filters: { status: ["open"], my_jobs_only: false },
    } as ResolveJobScopeInput, false);
    assert.equal(output.resolution_status, "incomplete");
    const match = output.matches.find((entry) => entry.greenhouse_job_id === 9001006);
    assert.ok(match, "decorated query should surface the intended job as a preview candidate");
    assert.equal(match.match_band, "high");
    assert.ok(match.match_reasons.includes("title_token_overlap"));
    assert.ok(match.unmatched_terms.includes("stem"));
    assert.deepStrictEqual(output.scope.job_ids, []);
    assert.equal(output.scope.scope_handle, null);
    assert.equal(output.confirmation.confirmation_token, null);
  });

  it("searches safe indexed owner metadata without candidate data (an exact req id short-circuits to the exact path)", async () => {
    // Owner metadata stays fuzzy-searchable; an EXACT req id in the query now resolves
    // via the exact identifier path (see the free-text-query suite), so this exercises
    // the owner-metadata text search on its own.
    const output = await resolveCase("narrow_recruiter", { query: "Synthetic HM" });
    const match = output.matches.find((entry) => entry.greenhouse_job_id === 9001006);
    assert.ok(match, "safe owner metadata should be searchable");
    assert.ok(match?.match_reasons.some((reason) => reason === "text_tokens" || reason === "text_token_overlap"));
    assert.doesNotMatch(JSON.stringify(output), /candidate_email|resume|attachment|phone/i);
  });

  it("does not match a query token embedded inside a longer word", async () => {
    const inline = {
      personas: [{ id: "p", greenhouse_user_id: 1, permission_scope_kind: "jobs", accessible_job_ids: [1, 2], can_view_confidential: false }],
      jobs: [
        { greenhouse_job_id: 1, requisition_id: "T-1", title: "Training Program Lead", status: "open", department: "People", office: "US", location: "US", opened_at: null, closed_at: null },
        { greenhouse_job_id: 2, requisition_id: "AI-1", title: "AI Solutions Engineer", status: "open", department: "Engineering", office: "US", location: "US", opened_at: null, closed_at: null },
      ],
    };
    const load = buildFixtureInventory(inline as any, "p");
    assert.equal(load.ok, true);
    if (!load.ok) throw new Error("load failed");
    const output = resolveJobScope({ query: "ai" }, { inventory: load.inventory, subject: "p", signer, nowMs: NOW });
    assert.ok(!output.scope.job_ids.includes(1), '"ai" must not match "Training Program Lead"');
    assert.ok(output.matches.every((m) => m.greenhouse_job_id !== 1));
    assert.deepStrictEqual(output.scope.job_ids, [2]);
  });

  it("removes a confidential job via the confidential filter even when permission grants it (load-bearing)", () => {
    const inline = {
      personas: [{ id: "limited", greenhouse_user_id: 5, permission_scope_kind: "jobs", accessible_job_ids: [1, 2], can_view_confidential: false }],
      jobs: [
        { greenhouse_job_id: 1, requisition_id: "OK-1", title: "Open Role", status: "open", department: null, office: null, location: null, opened_at: null, closed_at: null, confidential: false },
        { greenhouse_job_id: 2, requisition_id: "SECRET-1", title: "Secret Role", status: "open", department: null, office: null, location: null, opened_at: null, closed_at: null, confidential: true },
      ],
    };
    const load = buildFixtureInventory(inline as any, "limited");
    assert.equal(load.ok, true);
    if (!load.ok) throw new Error("load failed");
    // Job 2 is in accessible_job_ids (passes the permission filter); ONLY the
    // confidential filter can drop it for a can_view_confidential=false persona.
    assert.deepStrictEqual(load.inventory.records.map((r) => r.greenhouse_job_id), [1]);
    assert.ok(!load.inventory.records.some((r) => r.confidential));
  });

  it("treats a single in-scope meaning of a collision alias as needs_confirmation, not ambiguous", async () => {
    // narrow_recruiter can see the Frontier Data jobs but NOT Finance Director (9001005),
    // so "FD" has only one in-scope meaning — genuine ambiguity requires two.
    const output = await resolveCase("narrow_recruiter", { aliases: ["FD"], query: "FD roles" });
    assert.equal(output.resolution_status, "needs_confirmation");
    assert.deepStrictEqual(output.ambiguous_candidates, []);
    assert.ok(output.confirmation.reason_codes.includes("alias_expansion"));
    assert.ok(!output.scope.job_ids.includes(9001005), "Finance Director is not in the narrow recruiter scope");
  });

  // Owner filters are SUPPORTED through the resolve_job_scope tool (which pre-resolves them into
  // ctx.ownerScopedJobIds). The PURE resolver invoked here gets no pre-resolved set, so it must FAIL
  // CLOSED rather than silently broaden — the defensive floor for any caller that skips the pre-read.
  it("the pure resolver fails closed on an owner filter with no pre-resolved owner set (no broadening)", async () => {
    const output = await resolveCase("narrow_recruiter", {
      query: "Frontier Data",
      filters: { recruiter_user_ids: [7001001] },
    } as ResolveJobScopeInput);
    assert.equal(output.resolution_status, "error");
    assert.equal(output.scope.scope_status, "rejected");
    assert.equal(output.scope.scope_handle, null);
    assert.deepStrictEqual(output.scope.job_ids, []);
    assert.ok(output.warnings.some((w) => /recruiter_user_ids/.test(w)));
  });

  it("the pure resolver fails closed on a hiring_manager_user_ids filter with no pre-resolved owner set", async () => {
    const output = await resolveCase("site_admin", {
      query: "Forward Deployed Engineer",
      filters: { hiring_manager_user_ids: [7009000] },
    } as ResolveJobScopeInput);
    assert.equal(output.resolution_status, "error");
    assert.equal(output.scope.scope_handle, null);
    assert.deepStrictEqual(output.scope.job_ids, []);
  });

  it("treats empty or unknown status as non-open and requires confirmation", () => {
    const inline = {
      personas: [{ id: "p", greenhouse_user_id: 1, permission_scope_kind: "jobs", accessible_job_ids: [1], can_view_confidential: false }],
      jobs: [
        { greenhouse_job_id: 1, requisition_id: "UNK-1", title: "Unknown Status Role", status: "", department: null, office: null, location: null, opened_at: null, closed_at: null },
      ],
    };
    const load = buildFixtureInventory(inline as any, "p");
    assert.equal(load.ok, true);
    if (!load.ok) throw new Error("load failed");

    const output = resolveJobScope({ greenhouse_job_ids: [1] }, { inventory: load.inventory, subject: "p", signer, nowMs: NOW });
    assert.equal(output.resolution_status, "needs_confirmation");
    assert.equal(output.scope.scope_handle, null);
    assert.ok(output.confirmation.reason_codes.includes("contains_closed_jobs"));
    assert.ok(output.confirmation.confirmation_token);
  });

  it("marks inventory incomplete and surfaces count when live job rows cannot normalize", async () => {
    const reader = fakeScopedReader((toolName) => {
      if (toolName !== "list_jobs") throw new Error(`unexpected ${toolName}`);
      return scopedSuccess(toolName, [
        { name: "Missing Id Role", status: "open" },
        { id: 1, name: "Visible Role", status: "open", requisition_id: "VIS-1" },
      ], null, { rowCounts: { raw: 2, returned: 2 } });
    });
    const { runtime } = testRuntime(reader);
    const load = await loadScopedReaderInventory(runtime);
    assert.equal(load.ok, true);
    if (!load.ok) throw new Error("load failed");

    assert.equal(load.inventory.complete, false);
    assert.equal(load.inventory.unnormalizableRows, 1);
    assert.equal(load.inventory.rawRowsSeen, 2);

    const output = resolveJobScope({ query: "Visible Role" }, { inventory: load.inventory, subject: "p", signer, nowMs: NOW });
    assert.equal(output.resolution_status, "incomplete");
    assert.equal(output.completeness.inventory_complete, false);
    assert.equal(output.completeness.unnormalizable_jobs_dropped, 1);
    assert.ok(output.warnings.some((warning) => /could not be normalized/.test(warning)));
  });

  it("loads all cursor pages for live inventory without using maxPages as a completeness cap", async () => {
    const reader = fakeScopedReader((toolName, params) => {
      if (toolName !== "list_jobs") throw new Error(`unexpected ${toolName}`);
      if (params?.cursor === "jobs-page-2") {
        return scopedSuccess(toolName, [
          { id: 2, name: "Second Page Role", status: "open", requisition_id: "REQ-2" },
        ], null, { rowCounts: { raw: 1, returned: 1 } });
      }
      assert.deepStrictEqual(params, { per_page: 500 });
      return scopedSuccess(toolName, [
        { id: 1, name: "First Page Role", status: "open", requisition_id: "REQ-1" },
      ], "jobs-page-2", { rowCounts: { raw: 1, returned: 1 } });
    });
    const { runtime } = testRuntime(reader, { limits: { ...DEFAULT_LIMITS } });
    const load = await loadScopedReaderInventory(runtime);
    assert.equal(load.ok, true);
    if (!load.ok) throw new Error("load failed");

    assert.equal(load.inventory.complete, true);
    assert.equal(load.inventory.truncated, false);
    assert.equal(load.inventory.rawRowsSeen, 2);
    assert.deepStrictEqual(load.inventory.records.map((record) => record.greenhouse_job_id), [1, 2]);
    const jobCalls = reader.calls.filter((call) => call.toolName === "list_jobs");
    assert.deepStrictEqual(jobCalls.map((call) => call.params), [{ per_page: 500 }, { cursor: "jobs-page-2" }]);
  });

  it("returns partial live inventory as incomplete when the read-all deadline expires after data", async () => {
    let nowMs = NOW;
    const reader = fakeScopedReader((toolName) => {
      if (toolName !== "list_jobs") throw new Error(`unexpected ${toolName}`);
      nowMs = NOW + 10;
      return scopedSuccess(toolName, [
        { id: 1, name: "First Page Role", status: "open", requisition_id: "REQ-1" },
      ], "jobs-page-2", { rowCounts: { raw: 1, returned: 1 } });
    });
    const { runtime } = testRuntime(reader, {
      limits: { ...DEFAULT_LIMITS, maxToolDurationMs: 5, maxAnalysisDurationMs: 5 },
      now: () => nowMs,
    });
    const load = await loadScopedReaderInventory(runtime, {
      startedAt: NOW,
      timeoutMs: 5,
      now: () => nowMs,
    });
    assert.equal(load.ok, true);
    if (!load.ok) throw new Error("load failed");

    assert.equal(load.inventory.complete, false);
    assert.equal(load.inventory.truncated, true);
    assert.equal(load.inventory.rawRowsSeen, 1);
    assert.match(load.inventory.paginationError ?? "", /analysis deadline elapsed/);
    assert.equal(reader.calls.length, 1);
  });

  it("surfaces an inventory-load timeout as TOOL_TIMEOUT, not UPSTREAM_ERROR (friction F1)", async () => {
    const reader = fakeScopedReader(() => new Promise(() => {}));
    const { runtime } = testRuntime(reader, { limits: { ...DEFAULT_LIMITS, maxToolDurationMs: 1, maxAnalysisDurationMs: 1 } });
    const load = await loadScopedReaderInventory(runtime);
    assert.equal(load.ok, false);
    assert.equal(load.ok === false && load.code, "TOOL_TIMEOUT", "inventory-load timeout must surface as TOOL_TIMEOUT, not be relabeled UPSTREAM_ERROR");
  });

  it("does not place raw user query text into signed confirmation labels", () => {
    const secretQuery = "customer-private-launch-codename";
    const load = buildFixtureInventory(fixture, "narrow_recruiter");
    assert.equal(load.ok, true);
    if (!load.ok) throw new Error("load failed");

    const output = resolveJobScope(
      { greenhouse_job_ids: [9001006], query: secretQuery, allow_auto_confirm: false },
      { inventory: load.inventory, subject: "email:narrow_recruiter", signer, nowMs: NOW }
    );
    assert.equal(output.resolution_status, "needs_confirmation");
    assert.doesNotMatch(output.scope.scope_label, new RegExp(secretQuery));
    assert.ok(output.confirmation.confirmation_token);

    const payload = JSON.parse(base64UrlDecode(output.confirmation.confirmation_token!.split(".")[0]!).toString("utf8"));
    assert.equal(payload.label, output.scope.scope_label);
    assert.doesNotMatch(JSON.stringify(payload), new RegExp(secretQuery));
  });

  it("does not echo raw no-match query text in the public scope label", () => {
    const secretQuery = "unannounced-customer-acquisition-role";
    const load = buildFixtureInventory(fixture, "narrow_recruiter");
    assert.equal(load.ok, true);
    if (!load.ok) throw new Error("load failed");

    const output = resolveJobScope({ query: secretQuery }, { inventory: load.inventory, subject: "email:narrow_recruiter", signer, nowMs: NOW });
    assert.equal(output.resolution_status, "no_match");
    assert.doesNotMatch(output.scope.scope_label, new RegExp(secretQuery));
  });
});

// F1: a recruiter's most precise input is the bare req number, typed into the
// free-text `query`. It must resolve exactly like the structured requisition_ids
// field, not fuzzy-rank down to medium/needs_confirmation. Consistency fix — the
// promotion routes through the same exact path, so no banding/gating logic changes.
describe("job scope resolver — exact identifier typed as free-text query (F1)", () => {
  it("promotes a bare requisition id in `query` to the exact structured path (query:'X' === requisition_ids:['X'])", async () => {
    const viaQuery = await resolveCase("narrow_recruiter", { query: "SAIS-US-401" });
    const viaStructured = await resolveCase("narrow_recruiter", { requisition_ids: ["SAIS-US-401"] });

    assert.equal(viaQuery.resolution_status, "resolved", "an exact req in `query` must resolve, not needs_confirmation");
    assert.equal(viaQuery.scope.scope_status, "confirmed");
    assert.deepStrictEqual(
      [...viaQuery.scope.job_ids].sort((a, b) => a - b),
      [...viaStructured.scope.job_ids].sort((a, b) => a - b),
      "the query path must scope the same job(s) as the structured field"
    );
    const top = viaQuery.matches[0];
    assert.ok(top, "expected a match");
    assert.equal(top!.match_band, "exact", "must be banded exact, not fuzzy");
    assert.equal(top!.match_score, 1);
    assert.ok(top!.match_reasons.includes("exact_requisition_id"));
  });

  it("promotes a bare greenhouse job id in `query` to the exact id path", async () => {
    const load = buildFixtureInventory(fixture, "narrow_recruiter");
    assert.equal(load.ok, true);
    if (!load.ok) throw new Error("load failed");
    const jobId = load.inventory.records[0]!.greenhouse_job_id;

    const output = await resolveCase("narrow_recruiter", { query: String(jobId) });
    assert.equal(output.scope.scope_status, "confirmed");
    assert.deepStrictEqual(output.scope.job_ids, [jobId]);
    assert.equal(output.matches[0]!.match_band, "exact");
    assert.ok(output.matches[0]!.match_reasons.includes("exact_job_id"));
  });

  it("triangulates an exact req id embedded in a natural question (no structured field, no bare id)", async () => {
    // The recruiter should never have to lift the req number out of their sentence.
    const output = await resolveCase("narrow_recruiter", { query: "unsubmitted scorecards for SAIS-US-401" });
    assert.equal(output.resolution_status, "resolved", "an embedded exact req id must resolve, not dead-end at no_match");
    assert.equal(output.scope.scope_status, "confirmed");
    const top = output.matches[0];
    assert.ok(top, "expected a match");
    assert.equal(top!.match_band, "exact");
    assert.ok(top!.match_reasons.includes("exact_requisition_id"));
  });

  it("does NOT collapse a cross-req comparison to one exact scope (two distinct req ids stay fuzzy)", async () => {
    const output = await resolveCase("narrow_recruiter", { query: "compare SAIS-US-401 and SAIS-US-400" });
    const soleExact = output.matches.length === 1 && output.matches[0]!.match_band === "exact";
    assert.ok(!soleExact, "two named reqs must not auto-promote to a single exact-confirmed scope");
  });

  it("does NOT promote a bare token that matches no accessible id (no false exact match)", async () => {
    const output = await resolveCase("narrow_recruiter", { query: "NOPE-000-NOTAREQ" });
    const promoted = output.matches.some(
      (m) => m.match_reasons.includes("exact_requisition_id") || m.match_reasons.includes("exact_job_id")
    );
    assert.ok(!promoted, "a non-matching token must not be promoted to an exact identifier");
  });

  it("triangulates a noisy natural-language question onto the role, ignoring analysis-intent noise", async () => {
    // "losing"/"candidates"/"roles" describe the analysis, not the job — they must not
    // drag the FDE title match below threshold into a no_match dead end.
    const output = await resolveCase("narrow_recruiter", {
      query: "why are we losing candidates on the forward deployed engineer roles",
    });
    assert.notEqual(output.resolution_status, "no_match", "a noisy role question must not dead-end");
    const top = output.matches[0];
    assert.ok(top, "expected a match");
    assert.match(String(top!.title), /Forward Deployed Engineer/);
    assert.equal(top!.match_band, "high", "the role signal resolves at high confidence despite the surrounding noise");
  });

  it("still dead-ends on an unknown role rather than over-broadening (noise-strip must not widen scope)", async () => {
    const output = await resolveCase("narrow_recruiter", { query: "blockchain wizard" });
    assert.equal(output.resolution_status, "no_match", "an unknown role must not be silently broadened to all jobs");
  });
});

// F1b#3: a role-less analysis question ("which of my reqs are stalling") names no job —
// every word is analysis-intent — so it has no scope signal. It should resolve to the
// caller's permitted set (broad, confirm), never dead-end at no_match; and for an admin it
// must be flagged (admin_scope) and confirmed, never silently run org-wide.
describe("job scope resolver — role-less analysis questions (F1b#3)", () => {
  it("resolves a role-less analysis question to the permitted set (broad + confirm), not no_match — narrow recruiter", async () => {
    const output = await resolveCase("narrow_recruiter", { query: "which of my reqs are stalling" });
    assert.notEqual(output.resolution_status, "no_match", "a role-less analysis question must offer scope, not dead-end");
    assert.equal(output.resolution_status, "needs_confirmation");
    assert.ok(
      output.confirmation.reason_codes.includes("broad_scope"),
      `expected broad_scope in [${output.confirmation.reason_codes.join(", ")}]`
    );
    assert.ok(output.matches.length > 0, "offers the permitted jobs to confirm");
    assert.notEqual(output.scope.scope_status, "confirmed", "a broad set must never auto-confirm");
  });

  it("does NOT auto-run org-wide for a role-less question from a site admin (admin_scope + confirm)", async () => {
    const output = await resolveCase("site_admin", { query: "which reqs are stalling right now" });
    assert.equal(output.resolution_status, "needs_confirmation");
    assert.ok(output.confirmation.reason_codes.includes("broad_scope"));
    assert.ok(
      output.confirmation.reason_codes.includes("admin_scope"),
      "an admin broad set must be flagged, never silently org-wide"
    );
    assert.notEqual(output.scope.scope_status, "confirmed");
  });

  it("still dead-ends on an unknown role, never broadening (the analysis-intent guard)", async () => {
    const output = await resolveCase("narrow_recruiter", { query: "blockchain wizard stalling" });
    assert.equal(output.resolution_status, "no_match", "a non-analysis unknown token must keep the query at no_match");
  });
});

// Live-pilot finding #4 (2026-07-02): "FDE roles in NY" missed a role POSTED to New York whose
// office tag said USA — this tenant's geo tags are coarse, and tag-only location matching silently
// under-matches. The resolver must DISCLOSE the signal it used so the client model cross-checks
// job-post targeting instead of trusting the tag as ground truth.
describe("location-filter hygiene disclosure", () => {
  it("a locations filter discloses union matching when enrichment is complete, TAGS-only when degraded", async () => {
    const output = await resolveCase("site_admin", {
      query: "Forward Deployed Engineer",
      filters: { locations: ["New York"] },
    } as ResolveJobScopeInput);
    assert.ok(
      output.warnings.some((w) => /job-post targeting/.test(w) && !/TAGS only/.test(w)),
      "complete enrichment discloses the union, never the degraded warning"
    );

    const load = buildFixtureInventory(fixture, "site_admin");
    assert.equal(load.ok, true);
    if (!load.ok) throw new Error("load failed");
    load.inventory.enrichmentIncomplete = ["job_posts"];
    const degraded = await resolveJobScope(
      { query: "Forward Deployed Engineer", filters: { locations: ["New York"] } } as ResolveJobScopeInput,
      { inventory: load.inventory, subject: "email:site_admin", signer, nowMs: NOW }
    );
    assert.ok(
      degraded.warnings.some((w) => /TAGS only/.test(w) && /job_post/.test(w)),
      "a degraded join must disclose tag-only matching and name the cross-check"
    );
  });

  it("no locations filter -> no location-hygiene warning noise", async () => {
    const output = await resolveCase("site_admin", {
      query: "Forward Deployed Engineer",
    } as ResolveJobScopeInput);
    assert.equal(output.warnings.some((w) => /TAGS only/.test(w)), false);
  });
});
