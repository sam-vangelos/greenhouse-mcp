import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EVIDENCE_TOOL_SCOPED_TOOL_NAMES } from "../src/tools/scoped-endpoint-adapters.js";
import { getHarvestEndpointForEvidenceTool } from "../src/harvest-v3-registry.js";
import { runScorecardAccountability } from "../src/tools/scorecard-accountability.js";
import { runInterviewFeedbackDrag } from "../src/tools/interview-feedback-drag.js";
import { runStageLatency } from "../src/tools/stage-latency.js";
import { runPipelineQuality } from "../src/tools/pipeline-quality.js";
import { runSourceQuality } from "../src/tools/source-quality.js";
import { runRejectionReasonDrift } from "../src/tools/rejection-reason-drift.js";
import { analysisRuntime, fakeScopedReader, scopedSuccess } from "./test-helpers.js";
import type { RecruiterToolRuntime } from "../src/runtime.js";
import type { RecruiterToolResult } from "../src/types.js";

// ---------------------------------------------------------------------------
// Harvest v3 param contract
// ---------------------------------------------------------------------------
//
// Ground truth is the vendored v3 API surface (docs/harvest-v3-api, mirrored in
// HARVEST_V3_ENDPOINT_REGISTRY), NOT our beliefs about it. This test drives each
// analysis recipe through the NARROWED-scope path — the path that shipped the F5
// outage (analyze_scorecard_accountability forwarding job_ids to /v3/scorecards,
// which Harvest 422-rejects) — captures every scoped read the code actually
// issues, and asserts every param it sends is a parameter the target endpoint
// accepts. A recipe that sends an unsupported param fails here at build time
// instead of returning UPSTREAM_ERROR in production.

const SCOPED_TO_EVIDENCE = new Map<string, string>();
for (const [evidenceTool, scopedTool] of EVIDENCE_TOOL_SCOPED_TOOL_NAMES) {
  SCOPED_TO_EVIDENCE.set(scopedTool, evidenceTool);
}

// Params the scoped read layer/runtime attaches that are not Harvest query params
// (control-plane only, never forwarded to the v3 endpoint). Kept explicit so a real
// unsupported filter can never hide behind a blanket allowance.
const NON_ENDPOINT_CONTROL_PARAMS = new Set<string>([]);

function endpointParamsForScopedTool(scopedToolName: string): { path: string; params: Set<string> } | null {
  const evidenceTool = SCOPED_TO_EVIDENCE.get(scopedToolName);
  if (!evidenceTool) return null;
  const endpoint = getHarvestEndpointForEvidenceTool(evidenceTool);
  if (!endpoint) return null;
  // A param is legal if the endpoint declares it at all (query filters or {id} path
  // params) — the F5 class is a param the endpoint does not declare AT ALL.
  return { path: endpoint.path, params: new Set(endpoint.parameters.map((p) => p.name)) };
}

// A reader that returns generic-but-shaped rows so every recipe's read graph
// proceeds to completion (derive -> bridged read -> attribution), while recording
// every (scopedTool, params) pair the code issues.
function recordingReader() {
  const row = {
    id: 1,
    application_id: 10,
    job_id: 9001004,
    jobs: [{ id: 9001004 }],
    candidate_id: 1000,
    source_id: 5,
    referrer_id: 6,
    user_id: 7,
    interviewer_id: 7,
    submitter_id: 7,
    status: "active",
    stage_name: "Recruiter Screen",
    job_interview_stage_id: 3,
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-05T00:00:00.000Z",
    submitted_at: null,
    interviewed_at: "2026-06-02T00:00:00.000Z",
    rejected_at: null,
    last_activity_at: "2026-06-05T00:00:00.000Z",
  };
  return fakeScopedReader((toolName) => scopedSuccess(toolName, [row, { ...row, id: 2, application_id: 20 }]));
}

const RECIPE_CASES: Array<{ name: string; run: (r: RecruiterToolRuntime, p: Record<string, unknown>) => Promise<RecruiterToolResult> }> = [
  { name: "analyze_scorecard_accountability", run: runScorecardAccountability },
  { name: "analyze_interview_feedback_drag", run: runInterviewFeedbackDrag },
  { name: "analyze_stage_latency", run: runStageLatency },
  { name: "analyze_pipeline_quality", run: runPipelineQuality },
  { name: "analyze_source_quality", run: runSourceQuality },
  { name: "analyze_rejection_reason_drift", run: runRejectionReasonDrift },
];

describe("Harvest v3 param contract — no scoped read sends an unsupported param", () => {
  for (const recipe of RECIPE_CASES) {
    it(`${recipe.name} sends only endpoint-declared params on the narrowed-scope path`, async () => {
      const reader = recordingReader();
      const { runtime } = analysisRuntime(reader);

      // 9001004 is a permitted job for the narrow_recruiter fixture; the narrowed
      // scope is exactly what forced the F5 recipes down the /v3/scorecards read.
      await recipe.run(runtime, { job_ids: "9001004" });

      assert.ok(reader.calls.length > 0, `${recipe.name} issued no scoped reads to check`);
      for (const call of reader.calls) {
        const endpoint = endpointParamsForScopedTool(call.toolName);
        assert.ok(endpoint, `no v3 endpoint mapping for scoped tool "${call.toolName}" — extend the registry map`);
        for (const param of Object.keys(call.params ?? {})) {
          if (NON_ENDPOINT_CONTROL_PARAMS.has(param)) continue;
          assert.ok(
            endpoint!.params.has(param),
            `${recipe.name}: read to ${endpoint!.path} sent "${param}", which the vendored v3 spec does not declare for that endpoint (declared: ${[...endpoint!.params].sort().join(", ")})`
          );
        }
      }
    });
  }
});
