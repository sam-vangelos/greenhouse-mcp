import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildApplicationLifecycleFacts,
  buildApplicationStageTransitionFacts,
  buildInterviewEventFacts,
  buildJobOrgDimensions,
  buildJobPostExposureFacts,
  buildNoteActivityFacts,
  buildOfferFacts,
  buildOpeningHeadcountFacts,
  buildScorecardFacts,
  buildSourceReferrerAttributionFacts,
  buildUserOrgDimensions,
} from "../src/facts.js";
import type { RecruiterProjectionMetadata } from "../src/types.js";

function projection(endpointPath: string, requiredFieldOmissions: RecruiterProjectionMetadata["requiredFieldOmissions"] = []): RecruiterProjectionMetadata {
  return {
    endpointPath,
    profile: "recruiter_default",
    omittedFields: requiredFieldOmissions.map((omission) => ({
      endpointPath: omission.endpointPath,
      field: omission.field,
      reason: "role_gated",
    })),
    requiredFieldOmissions,
    incompleteProjection: requiredFieldOmissions.length > 0,
  };
}

describe("semantic fact builders", () => {
  it("builds core recruiting facts from projected endpoint rows", () => {
    assert.deepStrictEqual(buildApplicationLifecycleFacts([{
      id: 101,
      job_id: 10,
      candidate_id: 55,
      status: "active",
      source_id: 3,
      referrer_id: 4,
      credited_to_id: 77,
      coordinator_id: 88,
      recruiter_id: 99,
      job_post_id: 1001,
      prospect: true,
      needs_decision: false,
      created_at: "2026-06-01T00:00:00.000Z",
    }]).facts, [{
      application_id: 101,
      job_id: 10,
      candidate_id: 55,
      status: "active",
      source_id: 3,
      referrer_id: 4,
      credited_to_id: 77,
      coordinator_id: 88,
      recruiter_id: 99,
      job_post_id: 1001,
      prospect: true,
      needs_decision: false,
      created_at: "2026-06-01T00:00:00.000Z",
    }]);

    assert.deepStrictEqual(buildApplicationStageTransitionFacts([{
      id: 201,
      application_id: 101,
      job_interview_stage_id: 9,
      entered_at: "2026-06-02T00:00:00.000Z",
      days_in_stage: 4,
      current: true,
    }]).facts, [{
      application_stage_id: 201,
      application_id: 101,
      job_interview_stage_id: 9,
      entered_at: "2026-06-02T00:00:00.000Z",
      days_in_stage: 4,
      current: true,
    }]);

    assert.deepStrictEqual(buildInterviewEventFacts([{
      id: 301,
      application_id: 101,
      job_id: 10,
      job_interview_id: 12,
      organizer_id: 77,
      status: "scheduled",
      scheduled_at: "2026-06-03T00:00:00.000Z",
      availability_received_at: "2026-06-02T00:00:00.000Z",
    }]).facts, [{
      interview_id: 301,
      application_id: 101,
      job_id: 10,
      job_interview_id: 12,
      organizer_id: 77,
      status: "scheduled",
      scheduled_at: "2026-06-03T00:00:00.000Z",
      availability_received_at: "2026-06-02T00:00:00.000Z",
    }]);

    assert.deepStrictEqual(buildScorecardFacts([{ id: 401, application_id: 101, interviewer_id: 77, interview_kit_id: 12, status: "submitted" }]).facts, [{
      scorecard_id: 401,
      application_id: 101,
      interviewer_id: 77,
      interview_kit_id: 12,
      status: "submitted",
    }]);

    assert.deepStrictEqual(buildNoteActivityFacts([{ id: 501, application_id: 101, candidate_id: 55, type: "availability_request", private: false }]).facts, [{
      note_id: 501,
      application_id: 101,
      candidate_id: 55,
      type: "availability_request",
      private: false,
    }]);

    assert.deepStrictEqual(buildSourceReferrerAttributionFacts([{ id: 101, job_id: 10, source_id: 3, referrer_id: 4, credited_to_id: 77 }]).facts, [{
      application_id: 101,
      job_id: 10,
      source_id: 3,
      referrer_id: 4,
      credited_to_id: 77,
    }]);

    assert.deepStrictEqual(buildJobPostExposureFacts([{ id: 601, job_id: 10, job_post_id: 1001, related_post_id: 1002, related_post_type: "job_post" }]).facts, [{
      tracking_link_id: 601,
      job_id: 10,
      job_post_id: 1001,
      related_post_id: 1002,
      related_post_type: "job_post",
    }]);

    assert.deepStrictEqual(buildOpeningHeadcountFacts([{ id: 701, job_id: 10, open: true, target_start_on: "2026-07-01", sort_order: 2 }]).facts, [{
      opening_id: 701,
      job_id: 10,
      open: true,
      target_start_on: "2026-07-01",
      sort_order: 2,
    }]);

    assert.deepStrictEqual(buildOfferFacts([{ id: 801, job_id: 10, application_id: 101, starts_on: "2026-08-01", version: 3 }]).facts, [{
      offer_id: 801,
      job_id: 10,
      application_id: 101,
      starts_on: "2026-08-01",
      version: 3,
    }]);

    assert.deepStrictEqual(buildJobOrgDimensions([{ id: 10, name: "Frontend Engineer", office_ids: [4], confidential: false }]).facts, [{
      job_id: 10,
      name: "Frontend Engineer",
      confidential: false,
      office_ids: [4],
    }]);

    assert.deepStrictEqual(buildUserOrgDimensions([{ id: 77, name: "Recruiter One", job_title: "Senior Recruiter", deactivated: false, department_ids: [3] }]).facts, [{
      user_id: 77,
      name: "Recruiter One",
      job_title: "Senior Recruiter",
      deactivated: false,
      department_ids: [3],
    }]);
  });

  it("propagates required projection omissions into fact completeness", () => {
    const result = buildNoteActivityFacts(
      [{ id: 501, application_id: 101, type: "availability_request" }],
      projection("/v3/notes", [{
        metricOrFact: "note_activity_fact",
        endpointPath: "/v3/notes",
        field: "body",
        impact: "degrades_answer",
      }])
    );

    assert.equal(result.completeness, "incomplete_projection");
    assert.equal(result.requiredProjectionProfile, "recruiter_default");
    assert.deepStrictEqual(result.requiredEndpoints, ["/v3/notes"]);
    assert.equal(result.projectionOmissions.length, 1);
    assert.match(result.omissions[0] ?? "", /note_activity_fact:\/v3\/notes\.body:degrades_answer/);
  });

  it("fails closed when required identifiers are missing from projected rows", () => {
    const result = buildApplicationLifecycleFacts([{ id: 101, status: "active" }]);

    assert.deepStrictEqual(result.facts, []);
    assert.equal(result.completeness, "failed_endpoint");
    assert.match(result.omissions[0] ?? "", /required identifiers/);
  });
});
