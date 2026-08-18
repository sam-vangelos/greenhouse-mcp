import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LIMITS } from "../src/limits.js";
import { runScorecardAccountability } from "../src/tools/scorecard-accountability.js";
import { buildEvidencePack } from "../src/tools/evidence-pack.js";
import { analysisRuntime, fakeScopedReader, scopedSuccess } from "./test-helpers.js";
import { mcpTextResult, RECRUITER_RESULT_PAYLOAD_BUDGET_BYTES } from "../src/runtime.js";
import { buildAnalysisCompleteness } from "../src/resolution/analysis-result.js";

function threePeopleReader() {
  return fakeScopedReader((toolName: string) => {
    if (toolName === "list_scorecards") {
      return scopedSuccess(toolName, [
        { id: 1, application_id: 10, interviewer_id: 5, submitter_id: null, status: "to_be_submitted", submitted_at: null, interviewed_at: "2026-06-10T00:00:00.000Z" },
        { id: 2, application_id: 20, interviewer_id: 6, submitter_id: null, status: "to_be_submitted", submitted_at: null, interviewed_at: "2026-06-10T00:00:00.000Z" },
        { id: 3, application_id: 30, interviewer_id: 7, submitter_id: null, status: "to_be_submitted", submitted_at: null, interviewed_at: "2026-06-10T00:00:00.000Z" },
      ]);
    }
    if (toolName === "list_applications") {
      return scopedSuccess(toolName, [{ id: 10, jobs: [{ id: 100 }] }, { id: 20, jobs: [{ id: 100 }] }, { id: 30, jobs: [{ id: 100 }] }]);
    }
    throw new Error(`unexpected tool ${toolName}`);
  });
}

describe("output ceilings", () => {
  it("clamps an explicit max_rankings to the runtime ceiling", async () => {
    const { runtime } = analysisRuntime(threePeopleReader(), { limits: { ...DEFAULT_LIMITS, maxRankings: 2 } });
    const result = await runScorecardAccountability(runtime, { max_rankings: 3 });
    assert.equal(result.ok, true);
    const data = result.ok ? (result.data as any) : null;
    assert.equal(data.rankings.length, 2);
  });

  it("Rank 37: the evidence-id headline honors the configured maxEvidenceIds (was a hard-coded 50)", async () => {
    const { runtime } = analysisRuntime(threePeopleReader(), { limits: { ...DEFAULT_LIMITS, maxEvidenceIds: 2 } });
    const result = await runScorecardAccountability(runtime, {});
    assert.equal(result.ok, true);
    const data = result.ok ? (result.data as any) : null;
    // Three offenders contribute more than two backing ids; the headline must honor the configured
    // cap of 2. The prior hard-coded .slice(0, 50) ignored configuration entirely.
    assert.ok(data.evidence_ids.length >= 1, "rankings produced backing ids");
    assert.equal(data.evidence_ids.length, 2, "headline evidence_ids must honor maxEvidenceIds=2, not the old hard 50");
  });

  it("clamps an explicit evidence_pack_limit and discloses truncation", () => {
    const ids = Array.from({ length: 150 }, (_, i) => `application:${i + 1}`);
    const pack = buildEvidencePack(
      { evidence_pack: true, evidence_pack_limit: 200 },
      [{ name: "rankings", rows: [{ evidence_ids: ids }] }],
      100
    );
    assert.ok(pack);
    assert.equal(pack.total_ids, 150);
    assert.equal(pack.returned_ids, 100);
    assert.equal(pack.limit, 100);
    assert.equal(pack.requested_limit, 200);
    assert.equal(pack.limit_clamped, true);
    assert.equal(pack.truncated, true);
  });

  it("keeps even a 4,000-row result under the universal 700 KB envelope with a continuation disclosure", () => {
    const result = mcpTextResult({
      ok: true,
      toolName: "analyze_pipeline_quality",
      scoped: true,
      data: {
        rankings: Array.from({ length: 4_000 }, (_, index) => ({ rank: index + 1, detail: "x".repeat(300) })),
      },
      nextCursor: null,
    });
    const text = result.content[0]!.text;
    assert.ok(Buffer.byteLength(text, "utf8") <= RECRUITER_RESULT_PAYLOAD_BUDGET_BYTES);
    const payload = JSON.parse(text);
    assert.equal(payload.output.truncated, true);
    assert.equal(payload.data.continuation.strategy, "repeat_same_scope_with_smaller_output");
    assert.equal(payload.data.continuation.resumable, false);
    assert.equal(payload.data.continuation.result_sha256, payload.output.original_sha256);
    assert.match(payload.output.original_sha256, /^[a-f0-9]{64}$/);
  });

  it("omits an oversized denial message instead of carrying it outside the universal ceiling", () => {
    const result = mcpTextResult({
      ok: false,
      toolName: "search_my_jobs",
      denial: { code: "UPSTREAM_ERROR", message: "sensitive-upstream-payload:" + "x".repeat(800_000) },
    });
    const text = result.content[0]!.text;
    assert.ok(Buffer.byteLength(text, "utf8") <= RECRUITER_RESULT_PAYLOAD_BUDGET_BYTES);
    assert.doesNotMatch(text, /sensitive-upstream-payload/);
    const payload = JSON.parse(text);
    assert.equal(payload.denial.code, "UPSTREAM_ERROR");
    assert.equal(payload.output.truncated, true);
    assert.match(payload.output.original_sha256, /^[a-f0-9]{64}$/);
  });

  it("marks an analysis incomplete when its accounting identity does not reconcile", () => {
    const completeness = buildAnalysisCompleteness({
      totalRecordsInScope: 10,
      recordsAnalyzed: 7,
      recordsExcluded: 1,
    });
    assert.equal(completeness.status, "incomplete");
    assert.match(completeness.message ?? "", /Accounting mismatch/);
  });
});
