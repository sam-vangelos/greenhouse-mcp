import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CANDIDATE_SUBSTANCE_TOOLS } from "../../scoped-core/src/index.js";
import { SCOPED_TOOL_SCOPE_POLICIES } from "../src/tools/scoped-endpoint-adapters.js";

/**
 * Whether a tool's private candidates are protected depends on WHICH SCOPE ENGINE it happens to use,
 * and nothing in the type system says so.
 *
 * A tool with an entry in the scope-policy registry takes `filterWithScopePolicy` and never runs its
 * row filter — so the inline "View Private Candidates" gate in that filter never runs either. That is
 * how the original gap happened: `list_applications`, `get_application` and `list_application_stages`
 * are all policy-driven, so a gate written only into the row filters covered none of them.
 *
 * The universal backstop (`applyCandidatePrivacyGate`) closes it, but only for the tools named in
 * CANDIDATE_SUBSTANCE_TOOLS. That leaves a drift hazard with no compiler behind it: give a
 * candidate-substance tool a scope policy and it silently loses its gate, with a green suite either
 * way. This file is the tripwire for that drift.
 */

// Every tool that can return a private candidate's substance, and how each is reachable. Maintained
// by hand ON PURPOSE — it is the human judgement the automated checks below are anchored to.
const CANDIDATE_SUBSTANCE_SURFACE: ReadonlyArray<{ tool: string; why: string }> = [
  { tool: "list_applications", why: "the application itself — stage, status, rejection" },
  { tool: "get_application", why: "the same row, fetched by id" },
  { tool: "list_application_stages", why: "the candidate's stage history" },
  { tool: "list_scorecards", why: "interview feedback about the candidate" },
  { tool: "list_rejection_details", why: "why the candidate was rejected" },
  { tool: "list_prospect_details", why: "prospect sourcing detail" },
  { tool: "list_offers", why: "the offer, including compensation" },
  { tool: "list_candidates", why: "the candidate record" },
  { tool: "get_candidate", why: "the same record, fetched by id" },
  { tool: "list_candidate_educations", why: "education history" },
  { tool: "list_candidate_employments", why: "employment history" },
  { tool: "list_notes", why: "notes written about the candidate" },
  { tool: "list_attachments", why: "resumes and other attachments" },
  { tool: "list_scorecard_question_answers", why: "the free text of interview feedback" },
  { tool: "list_interviews", why: "interviews on the candidate's application" },
  { tool: "list_interviewers", why: "who interviewed them" },
];

describe("private-candidate coverage cannot drift between the two scope engines", () => {
  it("keeps every candidate-substance tool either row-filtered or in the backstop set", () => {
    const unprotected = CANDIDATE_SUBSTANCE_SURFACE.filter(({ tool }) =>
      SCOPED_TOOL_SCOPE_POLICIES.has(tool) && !CANDIDATE_SUBSTANCE_TOOLS.has(tool)
    );

    assert.deepEqual(
      unprotected.map(({ tool, why }) => `${tool} (${why})`),
      [],
      "these tools are scope-policy driven, so their row filter — and its private-candidate gate — " +
        "never runs, and they are not in CANDIDATE_SUBSTANCE_TOOLS either, so the universal backstop " +
        "does not cover them. Add them to CANDIDATE_SUBSTANCE_TOOLS, or remove their scope policy."
    );
  });

  it("keeps every backstop entry pointed at a tool that really is candidate substance", () => {
    // The set fails CLOSED — a row it cannot resolve to a candidate is denied — so a tool listed
    // here by mistake does not leak, it silently returns nothing. That is the over-withhold this
    // repo ranks equal to a bug, so the set is held to the same manifest.
    const surface = new Set(CANDIDATE_SUBSTANCE_SURFACE.map(({ tool }) => tool));
    const strays = [...CANDIDATE_SUBSTANCE_TOOLS].filter((tool) => !surface.has(tool));

    assert.deepEqual(
      strays,
      [],
      "CANDIDATE_SUBSTANCE_TOOLS names a tool that is not on the candidate-substance surface. " +
        "Because that set denies any row it cannot resolve to a candidate, this withholds every row " +
        "of that tool rather than leaking one."
    );
  });

  it("documents the policy-driven tools that are deliberately NOT privacy gated", () => {
    // These reach a candidate's application through their join chain but return no candidate
    // substance: approval chains, kit staffing, post/comp config, pool structure, rubric structure,
    // and the answer-option JOIN rows, which /v3 documents as exposing "only the foreign keys" —
    // the answer text and the option labels live on endpoints that are themselves gated.
    //
    // Listed explicitly so a NEW policy-driven tool cannot join them silently: adding one fails this
    // test until someone states which of the two it is.
    const knownUngated = [
      "list_approver_groups",
      "list_approvers",
      "list_default_interviewers",
      "list_job_post_locations",
      "list_pay_input_ranges",
      "list_prospect_pool_stages",
      "list_prospect_pools",
      "list_scorecard_question_answer_options",
      "list_scorecard_question_options",
      "list_scorecard_questions",
    ];

    const policyDriven = [...SCOPED_TOOL_SCOPE_POLICIES.keys()]
      .filter((tool) => !CANDIDATE_SUBSTANCE_TOOLS.has(tool))
      .sort();

    assert.deepEqual(
      policyDriven,
      knownUngated,
      "a scope-policy-driven tool appeared that is neither in the backstop set nor in the reviewed " +
        "list of tools that carry no candidate substance. Decide which it is before shipping it."
    );
  });
});
