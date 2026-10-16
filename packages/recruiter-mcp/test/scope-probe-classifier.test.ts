import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildFixtureInventory, type JobInventory, type JobScopeFixture } from "../src/resolvers/job-scope/inventory.js";
import {
  resolveJobScope,
  type ConfirmationReasonCode,
  type ResolutionStatus,
  type ResolveJobScopeOutput,
} from "../src/resolvers/job-scope/resolver.js";
import { createScopeSigner } from "../src/resolvers/job-scope/scope-handle.js";
import { classifyScopeProbe } from "../src/tools/question-answer.js";

// A7 (CLO-274): classifyScopeProbe is the whole org-wide default policy in one pure, TOTAL
// function — every ResolutionStatus the resolver can emit maps to exactly one of three
// outcomes, so a new status can never silently fall through to "refuse". These are unit tests
// over the classifier itself; the planner integration lives in question-answer-resolution.test.ts.

const fixture = JSON.parse(
  readFileSync(resolve("test/fixtures/job-scope-resolution.fixture.json"), "utf8")
) as JobScopeFixture;
const signer = createScopeSigner("probe-secret-probe-secret-probe-secret-01");
const NOW = Date.parse("2026-06-23T12:00:00.000Z");

function inventory(personaId = "site_admin", complete = true): JobInventory {
  const load = buildFixtureInventory(fixture, personaId, { complete });
  if (!load.ok) throw new Error("fixture inventory failed to build");
  return load.inventory;
}

/** A minimal, valid ResolveJobScopeOutput so each status/reason/band combination can be pinned. */
function probeOutput(overrides: {
  status: ResolutionStatus;
  reasonCodes?: ConfirmationReasonCode[];
  band?: ResolveJobScopeOutput["confidence"]["band"];
  matches?: Array<{ id: number; status?: string; confidential?: boolean }>;
}): ResolveJobScopeOutput {
  const matches = (overrides.matches ?? []).map((entry) => ({
    greenhouse_job_id: entry.id,
    requisition_id: `REQ-${entry.id}`,
    title: `Job ${entry.id}`,
    status: entry.status ?? "open",
    department: null,
    office: null,
    location: null,
    opened_at: null,
    closed_at: null,
    recruiters: [],
    hiring_managers: [],
    confidential: entry.confidential === true,
    match_score: 1,
    match_band: "exact" as const,
    match_reasons: [],
    matched_terms: [],
    unmatched_terms: [],
  }));
  return {
    resolution_id: "r1",
    resolution_status: overrides.status,
    scope: {
      scope_handle: null,
      scope_status: "proposed",
      job_ids: matches.map((match) => match.greenhouse_job_id),
      job_count: matches.length,
      scope_label: "Probe scope",
      scope_hash: "hash",
      expires_at: null,
    },
    matches,
    ambiguous_candidates: [],
    confidence: { overall: 1, band: overrides.band ?? "high", top_margin: null, score_type: "deterministic_lexical_alias_ranker_v1" },
    completeness: {
      inventory_complete: true,
      truncated: false,
      accessible_jobs_seen: 10,
      accessible_jobs_estimated: 10,
      source: "cached_index",
      index_as_of: null,
      pagination_error: null,
      freshness_seconds: 0,
      unnormalizable_jobs_dropped: 0,
    },
    confirmation: {
      required: overrides.status !== "resolved",
      reason_codes: overrides.reasonCodes ?? [],
      confirmation_token: null,
      confirmation_prompt: null,
    },
    warnings: [],
    analysis_allowed: false,
    next_actions: [],
  };
}

describe("classifyScopeProbe — the org-wide default policy (A7, CLO-274)", () => {
  it("is total over every ResolutionStatus the resolver can emit", () => {
    const statuses: ResolutionStatus[] = [
      "resolved", "needs_confirmation", "ambiguous", "incomplete", "no_match", "forbidden", "error",
    ];
    for (const status of statuses) {
      const decision = classifyScopeProbe(probeOutput({ status, matches: [{ id: 9001006 }] }), inventory());
      assert.ok(
        ["use_scope", "org_wide", "confirm"].includes(decision.kind),
        `${status} produced no decision`
      );
    }
  });

  it("resolved -> use_scope", () => {
    const decision = classifyScopeProbe(probeOutput({ status: "resolved", matches: [{ id: 9001006 }] }), inventory());
    assert.equal(decision.kind, "use_scope");
  });

  // Item 13: no_match is only reachable when the question DID carry terms (an empty/role-less
  // question is synthesized to the permitted set instead), so the disclosure says the terms
  // missed — not that nothing was named.
  it("no_match -> org_wide saying the question's terms matched no requisition", () => {
    const decision = classifyScopeProbe(probeOutput({ status: "no_match" }), inventory());
    assert.equal(decision.kind, "org_wide");
    assert.ok(
      decision.kind === "org_wide" && decision.warnings.some((w) => /matched no requisition|no requisition matched/i.test(w)),
      "the answer must say the named terms matched nothing"
    );
  });

  it("incomplete -> org_wide, disclosing that the index was truncated (the read does not depend on it)", () => {
    const decision = classifyScopeProbe(
      probeOutput({ status: "incomplete", reasonCodes: ["partial_inventory"] }),
      inventory("site_admin", false)
    );
    assert.equal(decision.kind, "org_wide");
    assert.ok(decision.kind === "org_wide" && decision.warnings.some((w) => /index/i.test(w) && /complete|truncat/i.test(w)));
  });

  it("forbidden and error keep today's confirmation handling", () => {
    assert.equal(classifyScopeProbe(probeOutput({ status: "forbidden" }), inventory()).kind, "confirm");
    assert.equal(classifyScopeProbe(probeOutput({ status: "error" }), inventory()).kind, "confirm");
  });

  it("ambiguous (a genuine alias collision) -> confirm", () => {
    const decision = classifyScopeProbe(
      probeOutput({ status: "ambiguous", reasonCodes: ["alias_expansion", "multiple_matches"], matches: [{ id: 1 }, { id: 2 }] }),
      inventory()
    );
    assert.equal(decision.kind, "confirm");
  });

  it("duplicate_req_id -> confirm", () => {
    const decision = classifyScopeProbe(
      probeOutput({ status: "ambiguous", reasonCodes: ["duplicate_req_id"], matches: [{ id: 9001009 }, { id: 9001010 }] }),
      inventory()
    );
    assert.equal(decision.kind, "confirm");
  });

  it("several NAMED jobs at a real match band -> confirm", () => {
    for (const band of ["high", "medium"] as const) {
      const decision = classifyScopeProbe(
        probeOutput({ status: "needs_confirmation", reasonCodes: ["multiple_matches"], band, matches: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }] }),
        inventory()
      );
      assert.equal(decision.kind, "confirm", `band ${band} with several named matches must confirm`);
    }
  });

  it("a named selection carrying only closed/confidential flags USES the scope and warns", () => {
    const closed = classifyScopeProbe(
      probeOutput({ status: "needs_confirmation", reasonCodes: ["contains_closed_jobs"], matches: [{ id: 9001007, status: "closed" }] }),
      inventory()
    );
    assert.equal(closed.kind, "use_scope");
    assert.ok(closed.kind === "use_scope" && closed.warnings.some((w) => /1 closed req/i.test(w)));

    const confidential = classifyScopeProbe(
      probeOutput({ status: "needs_confirmation", reasonCodes: ["contains_confidential_jobs"], matches: [{ id: 9001008, confidential: true }] }),
      inventory()
    );
    assert.equal(confidential.kind, "use_scope");
    assert.ok(confidential.kind === "use_scope" && confidential.warnings.some((w) => /1 confidential req/i.test(w)));
  });

  // Item 7 (principal's ruling): a named req found under a stale index is MORE useful than an
  // org-wide answer, so the outcome is use_scope with the staleness disclosed. "not confirm" was
  // too weak an assertion — it passed equally for org_wide, which is a different answer.
  it("a stale index on a NAMED match uses that scope and warns (never blocks, never widens)", () => {
    const decision = classifyScopeProbe(
      probeOutput({ status: "needs_confirmation", reasonCodes: ["stale_index"], matches: [{ id: 9001006 }] }),
      inventory()
    );
    assert.equal(decision.kind, "use_scope");
    assert.ok(decision.kind === "use_scope" && decision.warnings.some((w) => /stale/i.test(w)));
  });

  // Item 18: the two clauses of the named-selection discriminator, isolated. Each of these
  // fails if the OTHER clause is deleted, so neither can rot unnoticed.
  it("item 18 (band clause): ONE match at band low is not a named selection -> org_wide", () => {
    const decision = classifyScopeProbe(
      probeOutput({ status: "needs_confirmation", reasonCodes: ["low_confidence"], band: "low", matches: [{ id: 9001006 }] }),
      inventory()
    );
    assert.equal(decision.kind, "org_wide");
  });

  it("item 18 (band clause): ONE match at band none is not a named selection -> org_wide", () => {
    const decision = classifyScopeProbe(
      probeOutput({ status: "needs_confirmation", reasonCodes: ["low_confidence"], band: "none", matches: [{ id: 9001006 }] }),
      inventory()
    );
    assert.equal(decision.kind, "org_wide");
  });

  // Item 12: `broad_scope` rides the PHRASE alone (resolver.ts sets it for "all"/"every"/"entire"),
  // so keying the discriminator off its absence threw away a real, unique, high-band match.
  it("item 12 (broad clause): a broad token alongside a unique HIGH-band match still uses that scope", () => {
    const decision = classifyScopeProbe(
      probeOutput({
        status: "needs_confirmation",
        reasonCodes: ["broad_scope"],
        band: "high",
        matches: [{ id: 9001006 }],
      }),
      inventory()
    );
    assert.equal(decision.kind, "use_scope");
    assert.ok(
      decision.kind === "use_scope" && decision.warnings.some((w) => /analysis (wording|phrasing)/i.test(w)),
      `the broad wording must be disclosed as read-as-analysis, got ${JSON.stringify(decision.kind === "use_scope" ? decision.warnings : [])}`
    );
  });

  it("item 12: the SYNTHESIZED all-permitted set (broad_scope at band none) is still org_wide", () => {
    const inv = inventory();
    const decision = classifyScopeProbe(
      probeOutput({
        status: "needs_confirmation",
        reasonCodes: ["broad_scope", "multiple_matches", "low_confidence"],
        band: "none",
        matches: inv.records.map((record) => ({ id: record.greenhouse_job_id })),
      }),
      inv
    );
    assert.equal(decision.kind, "org_wide");
  });

  // Item 13: the resolver's own warnings were dropped on the no_match branch, and every org_wide
  // path claimed "no req was named" even when the question named one that missed.
  it("item 13: the resolver's own warnings reach the answer, and a MISSED name says so", () => {
    const output = probeOutput({ status: "no_match" });
    output.warnings = ["Some query terms did not match any scoped job: brazil."];
    const decision = classifyScopeProbe(output, inventory());
    assert.equal(decision.kind, "org_wide");
    assert.ok(
      decision.kind === "org_wide" && decision.warnings.includes("Some query terms did not match any scoped job: brazil."),
      `the resolver's warnings must not be dropped, got ${JSON.stringify(decision.kind === "org_wide" ? decision.warnings : [])}`
    );
    assert.ok(
      decision.kind === "org_wide" && decision.warnings.some((w) => /matched no requisition|no requisition matched/i.test(w)),
      "a question whose terms missed must not claim no req was named"
    );
    assert.equal(
      decision.kind === "org_wide" && decision.warnings.some((w) => /No specific requisition was named/i.test(w)),
      false,
      "the 'named nothing' wording belongs only to a question that named nothing"
    );
  });

  it("the REAL org-wide probe (multiple_matches + broad_scope + low_confidence + contains_confidential_jobs) -> org_wide", () => {
    const inv = inventory();
    const output = resolveJobScope(
      { query: "Give me pipeline health across all open jobs org-wide.", purpose: "general_question" },
      { inventory: inv, subject: "email:site_admin", signer, nowMs: NOW }
    );
    assert.equal(output.resolution_status, "needs_confirmation");
    for (const code of ["multiple_matches", "broad_scope", "low_confidence", "contains_confidential_jobs"] as const) {
      assert.ok(output.confirmation.reason_codes.includes(code), `probe should carry ${code}, got [${output.confirmation.reason_codes.join(", ")}]`);
    }
    assert.equal(output.confidence.band, "none");
    const decision = classifyScopeProbe(output, inv);
    assert.equal(decision.kind, "org_wide");
  });

  it("a real role-less admin question also lands org_wide, not confirm", () => {
    const inv = inventory();
    const output = resolveJobScope(
      { query: "How is the pipeline health right now?", purpose: "general_question" },
      { inventory: inv, subject: "email:site_admin", signer, nowMs: NOW }
    );
    assert.equal(classifyScopeProbe(output, inv).kind, "org_wide");
  });

  it("a real MULTI-job title probe still confirms (naming several reqs is genuine ambiguity)", () => {
    const inv = inventory();
    const output = resolveJobScope(
      { query: "How is Field Data doing?", purpose: "general_question" },
      { inventory: inv, subject: "email:site_admin", signer, nowMs: NOW }
    );
    assert.equal(output.resolution_status, "needs_confirmation");
    assert.ok(output.matches.length >= 4, `expected several matches, got ${output.matches.length}`);
    assert.equal(output.confidence.band, "high");
    assert.equal(classifyScopeProbe(output, inv).kind, "confirm");
  });
});
