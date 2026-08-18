import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getRecruitingCapabilities } from "../src/resolvers/job-scope/capabilities.js";

// Catalog-wide knowledge lock. The capability catalogue is what the model reads
// to decide what the surface can answer; stale claims about Harvest v3 push the
// model toward wrong joins and "we can't do that" refusals. These assertions
// fail on the pre-application_stages strings and pass only on the corrected
// ones (primary-source-verified in v3-endpoint-inventory.md, §3 of the brief).
describe("recruiting capability knowledge", () => {
  const verificationText = (): string => {
    const capabilities = getRecruitingCapabilities();
    return capabilities.recipes
      .flatMap((recipe) => [...recipe.verification, ...recipe.completeness_requirements])
      .join("\n");
  };

  it("does not claim Harvest v3 lacks stage-transition history", () => {
    const text = verificationText();
    assert.doesNotMatch(text, /exposes no stage-transition history/);
    assert.doesNotMatch(text, /stage transition history is unavailable/);
  });

  it("advertises the application_stages funnel keystone", () => {
    const text = verificationText();
    assert.match(text, /application_stages/);
  });

  it("describes the real id-join, not a stage-name join with a zero-row id-join", () => {
    const text = verificationText();
    assert.doesNotMatch(text, /joins by stage NAME/);
    assert.doesNotMatch(text, /an id-join resolves zero rows/);
    assert.match(text, /application_stages\.job_interview_stage_id/);
    assert.match(text, /job_interview_stages\.id/);
    // The disjoint-id-space warning must be scoped to application.stage_id only.
    assert.match(text, /application\.stage_id/);
  });

  it("states the verified status asymmetry without the unproven 422 mechanism", () => {
    const text = verificationText();
    assert.doesNotMatch(text, /422/);
    assert.match(text, /status=active/);
    assert.match(text, /in_process/);
  });
});
