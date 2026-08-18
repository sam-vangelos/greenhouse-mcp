import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { FactBuildResult, FactCompletenessStatus } from "../src/facts.js";
import { buildAnalysisFactMetricLayer } from "../src/tools/analysis-fact-metrics.js";

function facts<T>(factRows: T[], completeness: FactCompletenessStatus = "complete"): FactBuildResult<T> {
  return {
    facts: factRows,
    requiredEndpoints: [],
    requiredProjectionProfile: "recruiter_default",
    completeness,
    omissions: [],
    projectionOmissions: [],
  };
}

describe("analysis fact-metric layer completeness", () => {
  const completeScorecards = facts([
    { scorecard_id: 1, application_id: 101, status: "complete", interviewed_at: "2026-06-01T10:00:00.000Z", submitted_at: "2026-06-02T09:00:00.000Z" },
  ]);

  it("reports complete when facts/metrics are complete and the read finished", () => {
    const layer = buildAnalysisFactMetricLayer({
      facts: { scorecard_fact: completeScorecards },
      metricIds: ["scorecard_submission_rate"],
      readStatus: "complete",
    });
    assert.equal(layer.completeness.status, "complete");
  });

  it("degrades to incomplete_truncated when the upstream read did not complete, even if every metric computed cleanly (regression)", () => {
    const layer = buildAnalysisFactMetricLayer({
      facts: { scorecard_fact: completeScorecards },
      metricIds: ["scorecard_submission_rate"],
      readStatus: "incomplete_timeout",
    });
    assert.equal(layer.completeness.status, "incomplete_truncated");
    assert.ok(layer.completeness.omissions.some((omission) => omission.includes("did not complete")));
  });

  it("ranks a failed fact above a truncated read (failed_missing_fact wins)", () => {
    const layer = buildAnalysisFactMetricLayer({
      facts: {},
      metricIds: ["approval_latency"], // unavailable fact -> failed_missing_fact
      readStatus: "incomplete_rate_limited",
    });
    assert.equal(layer.completeness.status, "failed_missing_fact");
  });

  it("does not invent truncation when readStatus is omitted (back-compat)", () => {
    const layer = buildAnalysisFactMetricLayer({
      facts: { scorecard_fact: completeScorecards },
      metricIds: ["scorecard_submission_rate"],
    });
    assert.equal(layer.completeness.status, "complete");
  });
});
