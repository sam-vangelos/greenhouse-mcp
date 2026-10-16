import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { registerRecruiterTools } from "../src/tools/register.js";
import { runEvidenceTool } from "../src/tools/evidence.js";
import { fakeScopedReader, narrowRecruiterInventory, scopedSuccess, testRuntime } from "./test-helpers.js";
import { v3ApplicationStage } from "./fixtures-production-shapes.js";

function registeredSchemas(): Map<string, Record<string, unknown>> {
  const scopedReader = fakeScopedReader((toolName) => scopedSuccess(toolName, []));
  const { runtime } = testRuntime(scopedReader);
  const schemas = new Map<string, Record<string, unknown>>();
  const server = {
    tool(name: string, _description: string, paramsSchema: Record<string, unknown>) {
      schemas.set(name, paramsSchema);
    },
  };
  registerRecruiterTools(server as any, runtime);
  return schemas;
}

describe("search_my_application_stages endpoint-specific contract", () => {
  it("advertises the v3 /application_stages filter set: current in, status/active/open out", () => {
    const schemas = registeredSchemas();
    const stageSchema = schemas.get("search_my_application_stages");
    assert.ok(stageSchema, "search_my_application_stages must be registered");

    // v3 /application_stages supports current + the id/date filters only.
    assert.ok("current" in stageSchema, "schema must advertise the supported `current` filter");
    assert.ok("application_ids" in stageSchema);
    assert.ok("job_interview_stage_ids" in stageSchema);
    assert.ok("created_at" in stageSchema);
    assert.ok("updated_at" in stageSchema);
    assert.ok("cursor" in stageSchema);
    assert.ok("per_page" in stageSchema);

    // Filters the endpoint does NOT support must not be advertised on this tool.
    assert.equal("status" in stageSchema, false, "endpoint has no status filter");
    assert.equal("active" in stageSchema, false, "endpoint has no active filter");
    assert.equal("open" in stageSchema, false, "endpoint has no open filter");
    assert.equal("stage_name" in stageSchema, false, "endpoint has no stage_name filter");
    assert.equal("scheduling_type" in stageSchema, false, "endpoint has no scheduling_type filter");
  });

  it("keeps the shared application search schema unchanged (status stays advertised)", () => {
    const schemas = registeredSchemas();
    const applicationSchema = schemas.get("search_my_applications");
    assert.ok(applicationSchema);
    assert.ok("status" in applicationSchema, "search_my_applications keeps the shared status filter");
    assert.ok("stage_name" in applicationSchema);
    assert.equal("current" in applicationSchema, false, "the application_stages-only `current` filter must not leak onto the shared schema");
  });

  it("strips unsupported status before the /application_stages read but keeps current + application_ids", async () => {
    const scopedReader = fakeScopedReader((toolName) => scopedSuccess(toolName, []));
    const { runtime } = testRuntime(scopedReader);

    const result = await runEvidenceTool(runtime, "search_my_application_stages", {
      status: "active",
      current: true,
      application_ids: "100",
    });

    assert.equal(result.ok, true);
    assert.deepStrictEqual(scopedReader.calls.map(({ toolName, params }) => ({ toolName, params })), [
      {
        toolName: "list_application_stages",
        params: { current: true, application_ids: "100", per_page: 500 },
      },
    ]);
    assert.ok(scopedReader.calls[0]?.options?.signal instanceof AbortSignal);
  });

  it("regression guard: search_my_applications still forwards status to the scoped read", async () => {
    const scopedReader = fakeScopedReader((toolName) => scopedSuccess(toolName, [{ id: 1, job_id: 9001001 }]));
    const { runtime } = testRuntime(scopedReader, { jobInventory: narrowRecruiterInventory() });

    const result = await runEvidenceTool(runtime, "search_my_applications", {
      status: "active",
      job_ids: "9001001",
    });

    assert.equal(result.ok, true);
    assert.deepStrictEqual(scopedReader.calls.map(({ toolName, params }) => ({ toolName, params })), [
      {
        toolName: "list_applications",
        params: { status: "active", job_ids: "9001001", per_page: 500 },
      },
    ]);
    assert.ok(scopedReader.calls[0]?.options?.signal instanceof AbortSignal);
  });

  it("projection lock: the application_stages projector excludes stage_name and stage_rank", async () => {
    const scopedReader = fakeScopedReader((toolName) => {
      if (toolName === "list_application_stages") {
        return scopedSuccess(toolName, [
          // Seed PII the backend could leak alongside the stage row — a candidate name and
          // email must never ride through the application_stages projection onto the surface.
          v3ApplicationStage({ stage_name: "Phone Screen", stage_rank: 2, candidate_name: "Jane Leak", candidate_email: "leak@example.com" }),
        ]);
      }
      throw new Error(`unexpected tool ${toolName}`);
    });
    const { runtime } = testRuntime(scopedReader);

    const result = await runEvidenceTool(runtime, "search_my_application_stages", {});

    assert.equal(result.ok, true);
    const rows = result.ok ? (result.data as Record<string, unknown>[]) : [];
    assert.equal(rows.length, 1);
    assert.deepStrictEqual(rows[0], {
      id: 4001,
      application_id: 100,
      job_interview_stage_id: 7,
      entered_at: "2026-06-10T00:00:00.000Z",
      exited_at: "2026-06-14T00:00:00.000Z",
      days_in_stage: 4,
      current: false,
      created_at: "2026-06-10T00:00:00.000Z",
      updated_at: "2026-06-14T00:00:00.000Z",
    });
    assert.equal("stage_name" in rows[0], false, "stage_name is not a v3 /application_stages field");
    assert.equal("stage_rank" in rows[0], false, "stage_rank is not a v3 /application_stages field");
    assert.equal("candidate_name" in rows[0], false, "candidate_name must not project onto the application_stages surface");
    assert.equal("candidate_email" in rows[0], false, "candidate_email must not project onto the application_stages surface");
  });
});
