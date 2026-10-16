import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CANDIDATE_ROW_TOOLS, CANDIDATE_SUBSTANCE_TOOLS, DEFAULT_FILTER_REGISTRY } from "../../scoped-core/src/index.js";
import {
  SCOPED_ENDPOINT_ADAPTERS_BY_EVIDENCE_TOOL,
  SCOPED_TOOL_SCOPE_POLICIES,
} from "../src/tools/scoped-endpoint-adapters.js";

/**
 * THE OTHER HALF OF THIS GUARD LIVES IN `scoped-core/test/private-candidate-multihop.test.ts`
 * ("classifies every registered endpoint that can carry candidate substance"), which walks the WHOLE
 * filter registry by endpoint and fails on any registration nobody classified. This file is the
 * recruiter-side half: it works from the tool's SCOPE CLASS, so a reader whose rows reach a candidate
 * has to be classified whichever engine ends up scoping it.
 *
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
  { tool: "list_applied_candidate_tags", why: "which tags a candidate carries — the row names them by id" },
  { tool: "list_scorecard_candidate_attributes", why: "an interviewer's attribute rating and free-text note about one candidate" },
  { tool: "list_notes", why: "notes written about the candidate" },
  { tool: "list_attachments", why: "resumes and other attachments" },
  { tool: "list_scorecard_question_answers", why: "the free text of interview feedback" },
  {
    tool: "list_scorecard_question_answer_options",
    why: "which rubric option an interviewer picked on the candidate's scorecard — FK-only rows, but " +
      "every one of them is one private candidate's interview record",
  },
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

  it("derives the surface from the registry's scope classes, not only from this hand-written list", () => {
    // The list above is human judgement and stays; this is the tripwire under it. Every reader the
    // REGISTRY classifies as candidate-, application- or scorecard-backed carries rows that resolve to
    // a candidate, so each one must be named on the surface above — whether it is row-filtered or
    // policy-driven, which is the half the previous predicate skipped.
    const CANDIDATE_REACHING_CLASSES = new Set(["candidate_backed", "application_backed", "scorecard_backed", "interview_backed"]);
    const surface = new Set(CANDIDATE_SUBSTANCE_SURFACE.map(({ tool }) => tool));
    const unclassified = [...SCOPED_ENDPOINT_ADAPTERS_BY_EVIDENCE_TOOL.values()]
      .filter((adapter) => CANDIDATE_REACHING_CLASSES.has(adapter.scopeClass))
      .map((adapter) => adapter.scopedToolName)
      .filter((scopedToolName) => !surface.has(scopedToolName))
      .sort();

    assert.deepEqual(
      [...new Set(unclassified)],
      [],
      "a reader whose registry scope class reaches a candidate is missing from the candidate-substance " +
        "surface, so nobody has decided whether the private-candidate gate covers it"
    );
  });

  it("names the gate on every ROW-FILTERED reader on the surface, not only the policy-driven ones", () => {
    // The original predicate only looked at policy-driven tools, so the row-filtered half of the
    // surface was unguarded here. Each of them is now held to a NAMED gate: the universal backstop,
    // the candidate-row path (the row IS the candidate, so `private` is decided on the row itself), or
    // the filter's own inline walk. A new row-filtered candidate reader fails this until someone says
    // which of the three covers it.
    const GATED_BY_THEIR_OWN_FILTER_WALK = new Set([
      // The row carries no candidate id at all; the filter walks interview -> application -> job and
      // the privacy gate rides that walk. scoped-core's own sweep classifies both as non-candidate
      // rows for exactly this reason.
      "list_interviews",
      "list_interviewers",
    ]);
    const rowFiltered = CANDIDATE_SUBSTANCE_SURFACE
      .filter(({ tool }) => DEFAULT_FILTER_REGISTRY.get(tool)?.rowFilter !== undefined)
      .map(({ tool }) => tool);
    assert.ok(rowFiltered.length > 0, "the surface must actually contain row-filtered readers");
    const ungated = rowFiltered.filter((tool) =>
      !CANDIDATE_SUBSTANCE_TOOLS.has(tool) && !CANDIDATE_ROW_TOOLS.has(tool) && !GATED_BY_THEIR_OWN_FILTER_WALK.has(tool)
    );
    assert.deepEqual(
      ungated,
      [],
      "these row-filtered candidate-substance readers name no gate at all: add them to " +
        "CANDIDATE_SUBSTANCE_TOOLS, or state which walk covers them"
    );
  });

  it("documents the policy-driven tools that are deliberately NOT privacy gated", () => {
    // These reach a candidate's application through their join chain but return no candidate
    // substance: approval chains, kit staffing, post/comp config, pool structure and rubric
    // structure. `list_scorecard_question_answer_options` used to sit here on the grounds that its
    // rows carry "only the foreign keys"; it does not any more. An answer-option row names the
    // scorecard answer it belongs to, and that answer belongs to exactly one candidate's interview,
    // so an unattested actor reading them learns which rubric option was recorded for a private
    // candidate. It is gated with the rest of the chain now.
    //
    // Listed explicitly so a NEW policy-driven tool cannot join them silently: adding one fails this
    // test until someone states which of the two it is.
    const knownUngated = [
      "list_approver_groups",
      "list_approvers",
      "list_default_interviewers",
      "list_focus_candidate_attributes",
      "list_job_post_locations",
      "list_job_post_searchable_locations",
      "list_pay_input_ranges",
      "list_prospect_pool_stages",
      "list_prospect_pools",
      "list_scorecard_question_candidate_attributes",
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
