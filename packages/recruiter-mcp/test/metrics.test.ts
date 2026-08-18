import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { FactBuildResult, FactCompletenessStatus } from "../src/facts.js";
import {
  METRIC_REGISTRY,
  METRIC_REGISTRY_BY_ID,
  computeMetric,
  type MetricFactName,
} from "../src/metrics.js";

function facts<T>(
  factRows: T[],
  completeness: FactCompletenessStatus = "complete",
  omissions: string[] = []
): FactBuildResult<T> {
  return {
    facts: factRows,
    requiredEndpoints: [],
    requiredProjectionProfile: "recruiter_default",
    completeness,
    omissions,
    projectionOmissions: [],
  };
}

describe("metric registry", () => {
  it("declares reusable metric definitions with facts, fields, profiles, and completeness rules", () => {
    assert.equal(METRIC_REGISTRY.length >= 13, true);
    for (const metric of METRIC_REGISTRY) {
      assert.equal(METRIC_REGISTRY_BY_ID.get(metric.id), metric);
      assert.ok(metric.displayName.length > 0);
      assert.ok(metric.requiredFacts.length > 0, `${metric.id} must declare required facts`);
      assert.ok(metric.requiredFields.length > 0, `${metric.id} must declare required fields`);
      assert.ok(metric.requiredRoleProfile.length > 0);
      assert.ok(metric.exclusions.length > 0);
      assert.ok(metric.completenessRules.length > 0);
      assert.equal(typeof metric.compute, "function");
    }
  });

  it("computes scorecard and interview SLA metrics deterministically", () => {
    // v3 scorecard status enum is ["draft","complete"] (complete == submitted, submitted_at set).
    // These fixtures use the real enum; the old code (status === "submitted") scored them 0/3.
    const scorecardFacts = facts([
      {
        scorecard_id: 1,
        application_id: 101,
        status: "complete",
        interviewed_at: "2026-06-01T10:00:00.000Z",
        submitted_at: "2026-06-02T09:00:00.000Z",
      },
      {
        scorecard_id: 2,
        application_id: 102,
        status: "draft",
        interviewed_at: "2026-06-01T10:00:00.000Z",
      },
      {
        scorecard_id: 3,
        application_id: 103,
        status: "complete",
        interviewed_at: "2026-06-01T10:00:00.000Z",
        submitted_at: "2026-06-04T12:00:00.000Z",
      },
    ]);
    const context = {
      facts: { scorecard_fact: scorecardFacts },
      nowMs: Date.parse("2026-06-05T10:00:00.000Z"),
      overdueDays: 2,
      slaHours: 48,
    };

    assert.deepStrictEqual(computeMetric("scorecard_submission_rate", context), {
      metricId: "scorecard_submission_rate",
      completeness: "complete",
      value: 2 / 3,
      numerator: 2,
      denominator: 3,
      unit: "ratio",
      evidenceRefs: ["scorecard:1", "application:101", "scorecard:2", "application:102", "scorecard:3", "application:103"],
      exclusions: ["scorecards without a stable scorecard id"],
      omissions: [],
    });
    assert.deepStrictEqual(computeMetric("scorecard_overdue_rate", context), {
      metricId: "scorecard_overdue_rate",
      completeness: "complete",
      value: 1 / 3,
      numerator: 1,
      denominator: 3,
      unit: "ratio",
      evidenceRefs: ["scorecard:1", "application:101", "scorecard:2", "application:102", "scorecard:3", "application:103"],
      exclusions: ["scorecards without interviewed_at are excluded from overdue denominator"],
      omissions: [],
    });
    assert.deepStrictEqual(computeMetric("interview_feedback_sla_breach_rate", context), {
      metricId: "interview_feedback_sla_breach_rate",
      completeness: "complete",
      value: 1 / 2,
      numerator: 1,
      denominator: 2,
      unit: "ratio",
      evidenceRefs: ["scorecard:1", "application:101", "scorecard:2", "application:102", "scorecard:3", "application:103"],
      exclusions: ["scorecards missing either interviewed_at or submitted_at are excluded"],
      omissions: [],
    });
  });

  it("computes scheduling, stage, source, and exposure metrics over semantic facts", () => {
    const context = {
      facts: {
        interview_event_fact: facts([
          { interview_id: 1, application_id: 101, availability_received_at: "2026-06-01T10:00:00.000Z", scheduled_at: "2026-06-01T16:00:00.000Z" },
          { interview_id: 2, application_id: 102, availability_received_at: "2026-06-02T10:00:00.000Z", scheduled_at: "2026-06-03T10:00:00.000Z" },
        ]),
        application_stage_transition_fact: facts([
          { application_stage_id: 1, application_id: 101, days_in_stage: 2, exited_at: "2026-06-02T00:00:00.000Z" },
          { application_stage_id: 2, application_id: 102, days_in_stage: 4 },
        ]),
        application_lifecycle_fact: facts([
          { application_id: 101, job_id: 10, source_id: 1, status: "hired", created_at: "2026-06-03T00:00:00.000Z" },
          { application_id: 102, job_id: 10, source_id: 1, status: "rejected", created_at: "2026-06-04T00:00:00.000Z" },
          { application_id: 103, job_id: 10, source_id: 2, status: "active", created_at: "2026-06-10T00:00:00.000Z" },
        ]),
        job_post_exposure_fact: facts([
          { tracking_link_id: 1, job_id: 10, related_post_id: 900 },
          { tracking_link_id: 2, job_id: 10, related_post_id: 900 },
          { tracking_link_id: 3, job_id: 10 },
        ]),
      },
    };

    assert.equal(computeMetric("availability_to_scheduled_interview_hours", context).value, 15);
    // stage_conversion_rate is not-implemented (exit-presence over current stages was a structural 0).
    assert.equal(computeMetric("stage_conversion_rate", context).value, null);
    assert.equal(computeMetric("stage_conversion_rate", context).completeness, "failed_missing_fact");
    assert.equal(computeMetric("stage_dwell_days", context).value, 3);
    assert.deepStrictEqual(computeMetric("weekly_application_volume", context).groups, [
      { week: "2026-06-01", count: 2 },
      { week: "2026-06-08", count: 1 },
    ]);
    assert.deepStrictEqual(computeMetric("source_quality_by_outcome", context).groups, [
      { source_id: 1, applications: 2, positive_outcomes: 1, quality_rate: 0.5 },
      // app103 is "active" (in-flight) — no longer counted as a positive outcome.
      { source_id: 2, applications: 1, positive_outcomes: 0, quality_rate: 0 },
    ]);
    // The group field is tracking_link_count (share-URL rows per post), not applicants — an exposure
    // proxy explicitly labeled so a future planner wiring cannot present it as applicants-per-post.
    assert.deepStrictEqual(computeMetric("job_post_exposure_by_post", context).groups, [
      { post_id: "900", tracking_link_count: 2 },
      { post_id: "unknown", tracking_link_count: 1 },
    ]);
    assert.ok(
      computeMetric("job_post_exposure_by_post", context).omissions.some((o) => /is_proxy/.test(o)),
      "the link-count metric must label itself an exposure proxy, not applicants-per-post"
    );
    assert.deepStrictEqual(computeMetric("job_post_exposure_by_post", context).evidenceRefs, [
      "tracking_link:1",
      "job:10",
      "related_post:900",
      "tracking_link:2",
      "tracking_link:3",
    ]);
  });

  it("propagates incomplete or missing facts instead of producing confident metrics", () => {
    const incomplete = facts(
      [{ scorecard_id: 1, application_id: 101, status: "submitted" }],
      "incomplete_projection",
      ["scorecard_fact:/v3/scorecards.notes:degrades_answer"]
    );

    assert.deepStrictEqual(computeMetric("scorecard_submission_rate", { facts: { scorecard_fact: incomplete } }), {
      metricId: "scorecard_submission_rate",
      completeness: "incomplete_projection",
      value: null,
      evidenceRefs: ["scorecard:1", "application:101"],
      exclusions: ["scorecards without a stable scorecard id"],
      omissions: ["scorecard_fact:/v3/scorecards.notes:degrades_answer"],
    });
    // T3.1: approval_latency now COMPUTES when the fact is present, and still fails closed
    // (never a confident zero) when it is absent.
    const missingApproval = computeMetric("approval_latency", { facts: {} });
    assert.equal(missingApproval.completeness, "failed_missing_fact");
    assert.equal(missingApproval.value, null);
    const pending = computeMetric("approval_latency", {
      facts: {
        approval_flow_fact: facts([
          { approval_flow_id: 71, job_id: 10, approval_status: "pending", created_at: "2026-06-21T00:00:00.000Z" },
          { approval_flow_id: 72, job_id: 11, approval_status: "approved", created_at: "2026-06-01T00:00:00.000Z" },
        ]),
      },
      nowMs: Date.parse("2026-07-01T00:00:00.000Z"),
    });
    assert.equal(pending.completeness, "complete");
    assert.equal(pending.value, 10, "median pending age = 10 days for the one unresolved flow");
    assert.equal(pending.groups?.length, 1, "resolved flows are excluded from pending-age");
    assert.deepStrictEqual(computeMetric("unknown_metric", { facts: {} as Partial<Record<MetricFactName, FactBuildResult<unknown>>> }), {
      metricId: "unknown_metric",
      completeness: "failed_missing_fact",
      value: null,
      evidenceRefs: [],
      exclusions: [],
      omissions: ["Unknown metric definition: unknown_metric"],
    });
  });

  it("counts a scorecard as submitted by submitted_at OR status complete — never by a literal 'submitted' enum (regression: v3 enum)", () => {
    const scorecardFacts = facts([
      { scorecard_id: 1, application_id: 101, status: "complete", interviewed_at: "2026-06-01T10:00:00.000Z" }, // complete, no submitted_at -> submitted
      { scorecard_id: 2, application_id: 102, status: "draft", interviewed_at: "2026-06-01T10:00:00.000Z", submitted_at: "2026-06-02T09:00:00.000Z" }, // submitted_at present -> submitted
      { scorecard_id: 3, application_id: 103, status: "draft", interviewed_at: "2026-06-01T10:00:00.000Z" }, // draft, no submitted_at -> not submitted
    ]);
    const context = { facts: { scorecard_fact: scorecardFacts }, nowMs: Date.parse("2026-06-05T10:00:00.000Z"), overdueDays: 2 };
    const submission = computeMetric("scorecard_submission_rate", context);
    assert.equal(submission.numerator, 2);
    assert.equal(submission.denominator, 3);
    assert.equal(submission.value, 2 / 3);
    const overdue = computeMetric("scorecard_overdue_rate", context);
    // Only scorecard 3 is unsubmitted and aged past the overdue threshold.
    assert.equal(overdue.numerator, 1);
    assert.equal(overdue.denominator, 3);
  });

  it("source_quality_by_outcome credits only realized hires, not converted prospects or in-flight active (regression — #31)", () => {
    const context = {
      facts: {
        application_lifecycle_fact: facts([
          { application_id: 201, job_id: 10, source_id: 1, status: "hired", created_at: "2026-06-03T00:00:00.000Z" },
          { application_id: 202, job_id: 10, source_id: 1, status: "rejected", created_at: "2026-06-03T00:00:00.000Z" },
          { application_id: 203, job_id: 10, source_id: 2, status: "active", created_at: "2026-06-03T00:00:00.000Z" },
          { application_id: 204, job_id: 10, source_id: 3, status: "converted", created_at: "2026-06-03T00:00:00.000Z" },
        ]),
      },
    };
    assert.deepStrictEqual(computeMetric("source_quality_by_outcome", context).groups, [
      { source_id: 1, applications: 2, positive_outcomes: 1, quality_rate: 0.5 }, // hired counts, rejected doesn't
      { source_id: 2, applications: 1, positive_outcomes: 0, quality_rate: 0 },   // active is in-flight, not a win
      { source_id: 3, applications: 1, positive_outcomes: 0, quality_rate: 0 },   // converted is a prospect->candidate conversion, not a win (#31)
    ]);
  });

  it("stage_conversion_rate is reported as not-implemented (failed_missing_fact), never a confident 0 (regression)", () => {
    const context = {
      facts: {
        application_stage_transition_fact: facts([
          { application_stage_id: 1, application_id: 101, days_in_stage: 2, current: true }, // current stage, no exited_at
        ]),
      },
    };
    const conversion = computeMetric("stage_conversion_rate", context);
    assert.equal(conversion.value, null);
    assert.equal(conversion.completeness, "failed_missing_fact");
  });
});
