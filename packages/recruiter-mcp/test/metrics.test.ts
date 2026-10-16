import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { FactBuildResult, FactCompletenessStatus } from "../src/facts.js";
import { buildProjectionMetadata, metricsBlockedByOmittedField, projectEvidenceResult } from "../src/tools/evidence-projection.js";
import { SCOPED_ENDPOINT_ADAPTERS_BY_EVIDENCE_TOOL } from "../src/tools/scoped-endpoint-adapters.js";
import { getHarvestEndpointByPath } from "../src/harvest-v3-registry.js";
import type { RecruiterProjectionMetadata } from "../src/types.js";
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

// ---------------------------------------------------------------------------
// H0f: an omitted field blocks a metric only where that metric's field LIVES.
//
// The blocks-answer map was keyed by FIELD alone and consulted on every
// endpoint's projection, so a read of /v3/prospect_pools that dropped `status`
// announced that the scorecard submission rate, the opening fill status, the
// source-quality breakdown and the weekly pipeline movement were all blocked —
// four metrics that never touch that endpoint. Every registered metric now
// declares the endpoint(s) its required fields are read from (the fact builder's
// own `requiredEndpoints`, one per fact), and the map is keyed by (endpoint,
// field). Declaring is MANDATORY: an undeclared metric used to fall back to
// "any endpoint", which is the false-blocker behaviour itself.
// ---------------------------------------------------------------------------
describe("metric required-field endpoints", () => {
  // Each metric's fact builder passes its OWN requiredEndpoints to buildFacts (facts.ts), so this
  // table is not a guess — it is the endpoint the metric's rows demonstrably come from.
  const ENDPOINT_BY_METRIC: Record<string, string[]> = {
    scorecard_submission_rate: ["/v3/scorecards"],
    scorecard_overdue_rate: ["/v3/scorecards"],
    interview_feedback_sla_breach_rate: ["/v3/scorecards"],
    availability_to_scheduled_interview_hours: ["/v3/interviews"],
    scheduled_interview_to_feedback_hours: ["/v3/scorecards"],
    stage_conversion_rate: ["/v3/application_stages"],
    stage_dwell_days: ["/v3/application_stages"],
    weekly_application_volume: ["/v3/applications"],
    weekly_qualified_pipeline_movement: ["/v3/applications"],
    source_quality_by_outcome: ["/v3/applications"],
    job_post_exposure_by_post: ["/v3/tracking_links"],
    approval_latency: ["/v3/approval_flows"],
    prospect_pool_movement: ["/v3/prospect_details"],
    note_activity_volume: ["/v3/notes"],
    opening_fill_status: ["/v3/openings"],
    offer_resolution: ["/v3/offers"],
    hire_count: ["/v3/offers"],
    rubric_answer_coverage: ["/v3/scorecard_question_answers"],
  };

  // /v3/prospect_pools documents no `status` response field, so the contract allowlist drops it —
  // a real projection that really omits `status`, not a hand-built stand-in.
  function statusOmittingProjection() {
    const adapter = SCOPED_ENDPOINT_ADAPTERS_BY_EVIDENCE_TOOL.get("search_my_prospect_pools");
    assert.ok(adapter, "search_my_prospect_pools must be a projected evidence endpoint");
    const projected = projectEvidenceResult(
      {
        ok: true,
        toolName: "search_my_prospect_pools",
        actorId: 1,
        effectiveActorId: 1,
        scoped: true,
        permissionScope: { kind: "jobs", permittedJobCount: 1 },
        data: [{ id: 1, name: "Inbound pool", status: "open" }],
        nextCursor: null,
      } as never,
      adapter
    );
    const projection = (projected as unknown as { projection: RecruiterProjectionMetadata }).projection;
    assert.ok(projection, "the adapter form of projectEvidenceResult attaches projection metadata");
    return projection;
  }

  it("declares the endpoint its required fields live on for EVERY registered metric", () => {
    const declared = Object.fromEntries(
      METRIC_REGISTRY.map((metric) => [metric.id, metric.requiredFieldEndpoints])
    );
    assert.deepStrictEqual(
      declared,
      ENDPOINT_BY_METRIC,
      "an undeclared metric falls back to 'any endpoint', which is the false-blocker behaviour itself"
    );
    for (const metric of METRIC_REGISTRY) {
      assert.ok(
        metric.requiredFieldEndpoints.length > 0,
        `${metric.id} declares no endpoint, so nothing could ever block it`
      );
    }
  });

  // Endpoint path -> the evidence adapter that projects it. A metric whose declared endpoint has no
  // adapter could never be projected at all, so its blocker could never fire either.
  const ADAPTER_BY_ENDPOINT = new Map(
    [...SCOPED_ENDPOINT_ADAPTERS_BY_EVIDENCE_TOOL.values()].map((adapter) => [adapter.endpointPath, adapter])
  );

  // The POSITIVE half of the guarantee, and the half nothing checked: each blocker actually FIRES.
  //
  // `requiredFields` was naming FACT fields for four metrics — `scorecard_id`,
  // `application_stage_id`, `tracking_link_id` — which the builders DERIVE from the row's `id`
  // (facts.ts), and a phantom `status` for opening_fill_status that /v3/openings does not document
  // at all. The projection compares SOURCE-ROW keys, so those blockers could never fire on a real
  // row: a silent miss, the exact opposite failure to the false blockers item 9 removed, and one
  // the endpoint fix alone would have left in place.
  it("fires each metric's blocks_answer omission when its own endpoint really drops the field", () => {
    for (const metric of METRIC_REGISTRY) {
      for (const endpointPath of metric.requiredFieldEndpoints) {
        const adapter = ADAPTER_BY_ENDPOINT.get(endpointPath);
        assert.ok(
          adapter,
          `${metric.id} declares ${endpointPath}, which no evidence adapter projects — its blocker could never fire`
        );
        const documented = (getHarvestEndpointByPath(endpointPath)?.responseFields ?? []).map((field) => field.name);
        assert.ok(documented.length > 0, `${endpointPath} must be in the vendored Harvest contract`);
        for (const field of metric.requiredFields) {
          assert.ok(
            documented.includes(field),
            `${metric.id} requires "${field}" from ${endpointPath}, but the contract documents no such RESPONSE field — a projection can never drop it, so this blocker can never fire`
          );
          // A real row for this endpoint, and the same row with exactly this field dropped: the
          // shape production hands buildProjectionMetadata when a projection really omits a field.
          const source = [Object.fromEntries(documented.map((name) => [name, 1]))];
          const projected = [Object.fromEntries(documented.filter((name) => name !== field).map((name) => [name, 1]))];
          const projection = buildProjectionMetadata(adapter!, source, projected);
          assert.ok(
            projection.requiredFieldOmissions.some((omission) =>
              omission.metricOrFact === metric.id
              && omission.field === field
              && omission.endpointPath === endpointPath
              && omission.impact === "blocks_answer"
            ),
            `dropping ${field} from a ${endpointPath} projection must block ${metric.id}, got ${JSON.stringify(projection.requiredFieldOmissions)}`
          );
        }
      }
    }
  });

  it("attaches each metric's blocker ONLY on its own endpoint", () => {
    for (const metric of METRIC_REGISTRY) {
      for (const field of metric.requiredFields) {
        for (const endpoint of metric.requiredFieldEndpoints) {
          assert.ok(
            metricsBlockedByOmittedField(endpoint, field).includes(metric.id),
            `${metric.id} must be blocked by a projection dropping ${field} from ${endpoint}`
          );
        }
        // Every OTHER registered endpoint must be silent about this metric.
        for (const other of new Set(Object.values(ENDPOINT_BY_METRIC).flat())) {
          if (metric.requiredFieldEndpoints.includes(other)) continue;
          assert.ok(
            !metricsBlockedByOmittedField(other, field).includes(metric.id),
            `${metric.id} must NOT be blocked by a projection of ${other}, which it never reads`
          );
        }
      }
    }
  });

  it("registers hire_count with the field whose absence would fabricate a zero", () => {
    const hireCount = METRIC_REGISTRY_BY_ID.get("hire_count");
    assert.ok(hireCount, "hire_count must be registered");
    assert.deepStrictEqual(hireCount!.requiredFields, ["status"]);
    assert.equal(hireCount!.windowField, "resolved_at", "the clock a hire is windowed on is declared, not inferred");
    assert.deepStrictEqual(hireCount!.requiredFacts, ["hire_fact"]);
  });

  it("emits NO blocks-answer omission on a prospect_pools projection that drops status", () => {
    const projection = statusOmittingProjection();
    assert.deepStrictEqual(
      projection.omittedFields.map((omission) => omission.field),
      ["status"],
      "the fixture omits exactly the field under test"
    );
    assert.deepStrictEqual(
      projection.requiredFieldOmissions.map((omission) => omission.metricOrFact).sort(),
      [],
      "no registered metric reads status from /v3/prospect_pools, so nothing there blocks an answer"
    );
  });

  it("DOES attach the offer metrics where their field lives — /v3/offers", () => {
    assert.deepStrictEqual(
      metricsBlockedByOmittedField("/v3/offers", "status").sort(),
      ["hire_count", "offer_resolution"],
      "a projection that drops status from the OFFER rows really does block the hire count"
    );
    assert.deepStrictEqual(metricsBlockedByOmittedField("/v3/prospect_pools", "status"), []);
    assert.deepStrictEqual(
      metricsBlockedByOmittedField("/v3/applications", "status").sort(),
      ["source_quality_by_outcome", "weekly_qualified_pipeline_movement"],
      "the same field on the applications rows blocks the applications metrics and nothing else"
    );
    assert.deepStrictEqual(
      metricsBlockedByOmittedField("/v3/scorecards", "status"),
      ["scorecard_submission_rate"]
    );
    assert.deepStrictEqual(
      metricsBlockedByOmittedField("/v3/openings", "open"),
      ["opening_fill_status"],
      "the opening fill status turns on `open` and `closed_at`, which is what a projection could drop"
    );
    assert.deepStrictEqual(
      metricsBlockedByOmittedField("/v3/openings", "status"),
      [],
      "/v3/openings documents no `status` response field, so nothing there can be blocked by its absence"
    );
    assert.deepStrictEqual(metricsBlockedByOmittedField("/v3/offers", "candidate_id"), [], "a field no metric requires blocks nothing");
    assert.deepStrictEqual(metricsBlockedByOmittedField("/offers", "status"), [], "endpoint paths are matched verbatim, never by alias");
  });
});
