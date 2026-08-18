import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getRecruitingCapabilities } from "../src/resolvers/job-scope/capabilities.js";
import { runRecruitingQuestionAnswer } from "../src/tools/question-answer.js";
import { analysisRuntime, fakeScopedReader, scopedSuccess } from "./test-helpers.js";

// F4: get_recruiting_capabilities used to mark 6 recipes "projected_limited", but at
// runtime 4 actually route to an adjacent executor and 2 dead-end at missing_domain.
// The label now distinguishes available | limited (runs, reduced fidelity) | planned
// (returns missing_domain, not wired). This locks the CATALOG to runtime REALITY the
// way the param-contract test locks endpoint params: drive each recipe's own
// example_question through the planner (with a forced scope so scope resolution never
// masks the routing) and assert the advertised availability matches whether it runs.

const NON_RUN_MODES = new Set(["missing_domain", "unrecognized_question", "resolution_required"]);

function genericReader() {
  const row = {
    id: 1, application_id: 10, job_id: 9001004, jobs: [{ id: 9001004 }], candidate_id: 1000,
    source_id: 5, referrer_id: 6, user_id: 7, interviewer_id: 7, submitter_id: 7,
    status: "active", stage_name: "Recruiter Screen", job_interview_stage_id: 3,
    created_at: "2026-06-01T00:00:00.000Z", updated_at: "2026-06-05T00:00:00.000Z",
    submitted_at: null, interviewed_at: "2026-06-02T00:00:00.000Z", rejected_at: null,
    last_activity_at: "2026-06-05T00:00:00.000Z",
  };
  return fakeScopedReader((toolName) => scopedSuccess(toolName, [row, { ...row, id: 2, application_id: 20 }]));
}

describe("recipe catalog availability matches runtime routing (F4 contract)", () => {
  for (const recipe of getRecruitingCapabilities().recipes) {
    it(`${recipe.id} advertised '${recipe.availability}' matches whether the planner runs it`, async () => {
      const { runtime } = analysisRuntime(genericReader());
      const result = await runRecruitingQuestionAnswer(runtime, {
        question: recipe.example_question,
        job_ids: "9001004",
      });
      assert.equal(result.ok, true);
      const mode = result.ok ? ((result.data as Record<string, unknown>).answer as Record<string, unknown> | undefined)?.mode : undefined;
      const ran = !NON_RUN_MODES.has(String(mode));
      if (recipe.availability === "planned") {
        assert.equal(ran, false, `planned recipe ${recipe.id} advertises "planned" but the planner ran it (mode=${mode})`);
      } else {
        assert.equal(ran, true, `recipe ${recipe.id} advertises "${recipe.availability}" but the planner did not run it (mode=${mode})`);
      }
    });
  }
});
