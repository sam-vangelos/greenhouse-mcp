import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mcpTextResult, runScopedTool } from "../src/runtime.js";
import { runPipelineQuality } from "../src/tools/pipeline-quality.js";
import { runRecruitingQuestionAnswer } from "../src/tools/question-answer.js";
import { analysisRuntime, fakeScopedReader, scopedSuccess, testRuntime, testSession } from "./test-helpers.js";

describe("audit schema v2", () => {
  it("persists a metadata-only start before tool work and a correlated terminal row after it", async () => {
    const order: string[] = [];
    const reader = fakeScopedReader((toolName, _params, options) => {
      order.push("tool");
      reportJobsScope(options, [701, 702]);
      return scopedSuccess(toolName, [{ id: 1 }], null, {
        meta: {
          retry: { attempts: 3, rateLimitRetries: 2, sleptMs: 20, retryAfterSeconds: [0.01, 0.01] },
          cacheHits: 3,
        },
      });
    });
    const { runtime, auditSink } = testRuntime(reader, {
      session: testSession({ surface: "claude_desktop", client: "claude_code", email: "private@example.com" }),
    });
    const originalEmit = auditSink.emit.bind(auditSink);
    auditSink.emit = async (event) => {
      order.push(event.auditStage ?? "legacy");
      await originalEmit(event);
    };

    const result = await runScopedTool(runtime, "search_my_jobs", "list_jobs", {}, "evidence");

    assert.equal(result.ok, true);
    assert.deepEqual(order, ["start", "tool", "terminal"]);
    assert.equal(auditSink.events.length, 1, "call-level compatibility view contains terminal rows only");
    assert.equal(auditSink.allEvents.length, 2);
    const [start, terminal] = auditSink.allEvents;
    assert.equal(start?.schemaVersion, 2);
    assert.equal(start?.outcome, "started");
    assert.equal(terminal?.outcome, "success");
    assert.equal(start?.correlationId, terminal?.correlationId);
    assert.equal(start?.client, "claude_code");
    assert.equal(terminal?.tokenId, "test-session-token-id");
    assert.deepEqual(terminal?.resolvedJobIds, [701, 702]);
    assert.equal(terminal?.resolvedJobCount, 2);
    assert.equal(terminal?.permissionScopeKind, "jobs");
    assert.deepEqual(terminal?.phaseTimingsMs, { total: 0, preflight: 0, authorizationOrScope: 0, tool: 0 });
    assert.equal(terminal?.pagesRead, 1);
    assert.equal(terminal?.retries, 2);
    assert.equal(terminal?.cacheHits, 3);
    const serialized = JSON.stringify(auditSink.allEvents);
    assert.doesNotMatch(serialized, /private@example\.com|"Authorization"|Bearer|session\.token|"prompt"|"resultRows"/i);
    assert.doesNotMatch(JSON.stringify(mcpTextResult(result)), /701|702/, "audit-only permission ids must not enter the model result");
  });

  it("fails closed before upstream work when the required start row cannot be retained", async () => {
    const reader = fakeScopedReader((toolName) => scopedSuccess(toolName, []));
    const { runtime } = testRuntime(reader);
    runtime.auditSink = { emit() { throw new Error("disk unavailable"); } };

    const result = await runScopedTool(runtime, "search_my_jobs", "list_jobs", {}, "evidence");

    assert.equal(result.ok, false);
    assert.equal(result.ok ? "" : result.denial.code, "AUDIT_UNAVAILABLE");
    assert.equal(reader.calls.length, 0);
  });

  it("captures jobs scope for an analyzer through the shared scoped-reader seam without result leakage", async () => {
    const reader = fakeScopedReader((toolName, _params, options) => {
      reportJobsScope(options, [811, 812]);
      if (toolName === "list_applications") {
        return scopedSuccess(toolName, [{
          id: 1,
          candidate_id: 10,
          jobs: [{ id: 9001001 }],
          status: "active",
          created_at: "2026-06-01T00:00:00.000Z",
          current_stage: { id: 7, name: "Review", entered_at: "2026-06-01T00:00:00.000Z" },
          last_activity_at: "2026-06-20T00:00:00.000Z",
        }]);
      }
      throw new Error(`unexpected tool ${toolName}`);
    });
    let tick = Date.parse("2026-06-23T12:00:00.000Z");
    const { runtime, auditSink } = analysisRuntime(reader, { now: () => tick++ });

    const result = await runPipelineQuality(runtime, {});

    assert.equal(result.ok, true);
    const terminal = auditSink.events.at(-1);
    assert.equal(terminal?.tool, "analyze_pipeline_quality");
    assert.deepEqual(terminal?.resolvedJobIds, [811, 812]);
    assert.equal(terminal?.resolvedJobCount, 2);
    assert.equal(terminal?.resolvedJobHash?.length, 64);
    assert.equal(
      (terminal?.phaseTimingsMs?.preflight ?? 0) +
      (terminal?.phaseTimingsMs?.authorizationOrScope ?? 0) +
      (terminal?.phaseTimingsMs?.tool ?? 0),
      terminal?.phaseTimingsMs?.total
    );
    assert.doesNotMatch(JSON.stringify(mcpTextResult(result)), /\b811\b|\b812\b/);
  });

  it("keeps the front-door scope reconstructable across its nested analyzer audit", async () => {
    const reader = fakeScopedReader((toolName, _params, options) => {
      reportJobsScope(options, [9001001, 9001999]);
      if (toolName === "list_applications") {
        return scopedSuccess(toolName, [{
          id: 2,
          candidate_id: 20,
          jobs: [{ id: 9001001 }],
          status: "active",
          created_at: "2026-06-01T00:00:00.000Z",
          current_stage: { id: 8, name: "Review", entered_at: "2026-06-01T00:00:00.000Z" },
          last_activity_at: "2026-06-20T00:00:00.000Z",
        }]);
      }
      throw new Error(`unexpected tool ${toolName}`);
    });
    const { runtime, auditSink } = analysisRuntime(reader);

    const result = await runRecruitingQuestionAnswer(runtime, {
      question: "How is pipeline quality?",
      job_ids: "9001001",
    });

    assert.equal(result.ok, true);
    const frontDoor = [...auditSink.events].reverse().find((event) => event.tool === "answer_my_recruiting_question");
    const analyzer = [...auditSink.events].reverse().find((event) => event.tool === "analyze_pipeline_quality");
    assert.deepEqual(frontDoor?.resolvedJobIds, [9001001]);
    assert.deepEqual(analyzer?.resolvedJobIds, [9001001]);
    assert.equal(frontDoor?.permissionScopeKind, "jobs");
    assert.doesNotMatch(JSON.stringify(mcpTextResult(result)), /\b9001999\b/);
  });

  it("records explicit scope only after intersecting it with live job permissions", async () => {
    const reader = fakeScopedReader((toolName, _params, options) => {
      reportJobsScope(options, [701, 702]);
      return scopedSuccess(toolName, [{ id: 701 }]);
    });
    const { runtime, auditSink } = testRuntime(reader);

    const result = await runScopedTool(
      runtime,
      "search_my_jobs",
      "list_jobs",
      { job_ids: "701,999" },
      "evidence"
    );

    assert.equal(result.ok, true);
    const terminal = auditSink.events.at(-1);
    assert.deepEqual(terminal?.resolvedJobIds, [701]);
    assert.equal(terminal?.resolvedJobCount, 1);
    assert.equal(terminal?.permittedJobCount, 2);
  });

  it("attributes a resolution-required front-door success from its inventory authorization read", async () => {
    const reader = fakeScopedReader((toolName) => {
      if (toolName === "list_jobs") {
        return scopedSuccess(toolName, [
          { id: 901, requisition_id: "FDE-1", name: "Forward Deployed Engineer", status: "open" },
          { id: 902, requisition_id: "FDE-2", name: "Forward Deployed Engineer", status: "open" },
        ], null, { actorId: 321, effectiveActorId: 321 });
      }
      if (["list_offices", "list_departments", "list_job_posts", "list_job_post_locations"].includes(toolName)) {
        return scopedSuccess(toolName, [], null, { actorId: 321, effectiveActorId: 321 });
      }
      throw new Error(`unexpected tool ${toolName}`);
    });
    const { runtime, auditSink } = testRuntime(reader);

    const result = await runRecruitingQuestionAnswer(runtime, {
      question: "How are interviews going for the Forward Deployed Engineer roles?",
      query: "Forward Deployed Engineer",
    });

    assert.equal(result.ok, true);
    assert.equal((result.ok && result.data as any).summary.scope_resolution_required, true);
    const terminal = auditSink.events.find((event) => event.tool === "answer_my_recruiting_question");
    assert.equal(terminal?.actorGreenhouseUserId, 321);
    assert.equal(terminal?.effectiveGreenhouseUserId, 321);
  });
});

function reportJobsScope(options: Record<string, unknown> | undefined, jobIds: number[]): void {
  const observer = options?.onPermissionScopeResolved;
  if (typeof observer === "function") observer({ kind: "jobs", jobIds: new Set(jobIds) });
}
