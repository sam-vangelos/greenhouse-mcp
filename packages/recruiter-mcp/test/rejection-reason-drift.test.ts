import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runRejectionReasonDrift } from "../src/tools/rejection-reason-drift.js";
import { analysisRuntime, fakeScopedReader, scopedDenial, scopedSuccess } from "./test-helpers.js";

describe("rejection reason drift analysis", () => {
  it("bridges a narrowed scope through application_ids and never sends job_ids to /v3/rejection_details (F5 class lock)", async () => {
    const scopedReader = fakeScopedReader((toolName, params) => {
      if (toolName === "list_applications") {
        // job -> application_ids derive (job_ids filter) AND the app -> job attribution lookup (ids).
        return scopedSuccess(toolName, [{ id: 10, jobs: [{ id: 9001004 }] }]);
      }
      if (toolName === "list_rejection_details") {
        if (params?.job_ids !== undefined) {
          // /v3/rejection_details is application-backed — Harvest 422s on job_ids.
          return scopedDenial(toolName, "TOOL_NOT_AVAILABLE");
        }
        return scopedSuccess(toolName, [
          { id: 1, application_id: 10, rejection_reason_id: 5, created_at: "2026-06-10T00:00:00.000Z" },
        ]);
      }
      if (toolName === "list_rejection_reasons") {
        return scopedSuccess(toolName, [{ id: 5, name: "Withdrew" }]);
      }
      throw new Error(`unexpected tool ${toolName}`);
    });
    const { runtime } = analysisRuntime(scopedReader);

    const result = await runRejectionReasonDrift(runtime, { job_ids: "9001004" });

    assert.equal(result.ok, true, "a narrowed rejection-reason analysis must succeed via the application_ids bridge");
    const detailCalls = scopedReader.calls.filter((c) => c.toolName === "list_rejection_details");
    assert.ok(detailCalls.length > 0, "expected a rejection-detail read");
    for (const call of detailCalls) {
      assert.equal(call.params?.job_ids, undefined, "job_ids must never reach /v3/rejection_details (Harvest 422s on it)");
    }
    assert.ok(detailCalls.some((c) => c.params?.application_ids !== undefined), "rejection details read by application_ids (the L1 bridge)");
  });

  it("resolves a known reason to its name and labels an archived/unknown reason id honestly (F2)", async () => {
    const scopedReader = fakeScopedReader((toolName) => {
      if (toolName === "list_applications") {
        return scopedSuccess(toolName, [{ id: 10, jobs: [{ id: 9001004 }] }, { id: 20, jobs: [{ id: 9001004 }] }]);
      }
      if (toolName === "list_rejection_details") {
        return scopedSuccess(toolName, [
          { id: 1, application_id: 10, rejection_reason_id: 5, created_at: "2026-06-10T00:00:00.000Z" },
          { id: 2, application_id: 20, rejection_reason_id: 4999999004, created_at: "2026-06-11T00:00:00.000Z" },
        ]);
      }
      if (toolName === "list_rejection_reasons") {
        // The archived/global id 4999999004 is NOT in the org's current reasons list.
        return scopedSuccess(toolName, [{ id: 5, name: "Withdrew" }]);
      }
      throw new Error(`unexpected tool ${toolName}`);
    });
    const { runtime } = analysisRuntime(scopedReader);

    const result = await runRejectionReasonDrift(runtime, { job_ids: "9001004" });

    assert.equal(result.ok, true);
    const data = result.ok ? (result.data as any) : null;
    const nameById = new Map<number, string>(data.reason_rankings.map((r: any) => [r.reason_id, r.reason_name]));
    assert.equal(nameById.get(5), "Withdrew");
    assert.equal(
      nameById.get(4999999004),
      "reason 4999999004 (name unavailable)",
      "an archived/global reason id absent from the list must render an honest label, never a bare number"
    );
    assert.equal(data.metrics.rejections_considered, 2);
    assert.equal(data.metrics.distinct_reasons, 2);
    assert.equal(data.completeness.total_records_in_scope, 2);
    assert.equal(data.completeness.records_analyzed, 2);
    assert.equal(data.completeness.records_excluded, 0);
    assert.equal(
      data.completeness.total_records_in_scope,
      data.completeness.records_analyzed + data.completeness.records_excluded
    );
  });
});
