import type { FactBuildResult, FactCompletenessStatus } from "../facts.js";
import {
  METRIC_REGISTRY_BY_ID,
  computeMetric,
  type MetricCompletenessStatus,
  type MetricFactName,
  type MetricResult,
} from "../metrics.js";
import type { ReadAllStatus } from "../read-all.js";
import type { RecruiterProjectionProfileName } from "../types.js";

export interface AnalysisFactMetricLayer {
  required_facts: MetricFactName[];
  required_metrics: string[];
  required_endpoints: string[];
  projection_profiles: RecruiterProjectionProfileName[];
  completeness: {
    status: MetricCompletenessStatus;
    omissions: string[];
    evidence_refs: string[];
  };
  metric_definitions: Array<{
    id: string;
    display_name: string;
    required_facts: MetricFactName[];
    required_fields: string[];
    required_role_profile: RecruiterProjectionProfileName;
    scope_behavior: string;
    exclusions: string[];
    completeness_rules: string[];
  }>;
  metric_results: Record<string, MetricResult>;
}

export function buildAnalysisFactMetricLayer(input: {
  facts: Partial<Record<MetricFactName, FactBuildResult<unknown>>>;
  metricIds: string[];
  nowMs?: number;
  overdueDays?: number;
  slaHours?: number;
  // Status of the upstream paginated read. When the read did not complete (deadline /
  // rate-limit / cursor cap), metric denominators are partial, so the layer must not
  // report "complete" even when every fact/metric individually computed cleanly.
  readStatus?: ReadAllStatus;
}): AnalysisFactMetricLayer {
  const metricResults: Record<string, MetricResult> = {};
  const requiredFacts = new Set<MetricFactName>();
  const requiredEndpoints = new Set<string>();
  const projectionProfiles = new Set<RecruiterProjectionProfileName>();

  for (const metricId of input.metricIds) {
    const metric = METRIC_REGISTRY_BY_ID.get(metricId);
    if (metric) {
      for (const fact of metric.requiredFacts) requiredFacts.add(fact);
      projectionProfiles.add(metric.requiredRoleProfile);
    }
    metricResults[metricId] = computeMetric(metricId, {
      facts: input.facts,
      nowMs: input.nowMs,
      overdueDays: input.overdueDays,
      slaHours: input.slaHours,
    });
  }

  for (const factName of requiredFacts) {
    const result = input.facts[factName];
    if (!result) continue;
    for (const endpoint of result.requiredEndpoints) requiredEndpoints.add(endpoint);
    projectionProfiles.add(result.requiredProjectionProfile);
  }

  const allResults = Object.values(metricResults);
  const readTruncated = input.readStatus !== undefined && input.readStatus !== "complete";
  return {
    required_facts: [...requiredFacts],
    required_metrics: input.metricIds,
    required_endpoints: [...requiredEndpoints].sort(),
    projection_profiles: [...projectionProfiles].sort(),
    completeness: {
      status: combineMetricCompleteness([
        ...allResults.map((result) => result.completeness),
        ...Object.values(input.facts).map((result) => result.completeness),
        ...(readTruncated ? (["incomplete_truncated"] as MetricCompletenessStatus[]) : []),
      ]),
      omissions: uniqueStrings([
        ...allResults.flatMap((result) => result.omissions),
        ...Object.values(input.facts).flatMap((result) => result.omissions),
        ...(readTruncated ? [`Upstream read did not complete (${input.readStatus}); metric denominators may be partial.`] : []),
      ]),
      // Rank 36: matches DEFAULT_LIMITS.maxEvidenceIds — the old 50 capped the metric layer's refs.
      evidence_refs: uniqueStrings(allResults.flatMap((result) => result.evidenceRefs)).slice(0, 200),
    },
    metric_definitions: input.metricIds.flatMap((metricId) => {
      const metric = METRIC_REGISTRY_BY_ID.get(metricId);
      if (!metric) return [];
      return [{
        id: metric.id,
        display_name: metric.displayName,
        required_facts: metric.requiredFacts,
        required_fields: metric.requiredFields,
        required_role_profile: metric.requiredRoleProfile,
        scope_behavior: metric.scopeBehavior,
        exclusions: metric.exclusions,
        completeness_rules: metric.completenessRules,
      }];
    }),
    metric_results: metricResults,
  };
}

function combineMetricCompleteness(statuses: Array<MetricCompletenessStatus | FactCompletenessStatus>): MetricCompletenessStatus {
  if (statuses.includes("failed_missing_fact")) return "failed_missing_fact";
  if (statuses.includes("failed_endpoint")) return "failed_endpoint";
  // Truncated read (partial denominators) ranks above projected-out fields: missing rows
  // distort a rate more than a missing field. Both are non-complete and surface honestly.
  if (statuses.includes("incomplete_truncated")) return "incomplete_truncated";
  if (statuses.includes("incomplete_projection")) return "incomplete_projection";
  return "complete";
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}
