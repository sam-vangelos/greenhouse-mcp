import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  HARVEST_V3_ENDPOINT_REGISTRY,
  HARVEST_V3_ENDPOINT_REGISTRY_BY_PATH,
  HARVEST_V3_EVIDENCE_TOOL_ENDPOINTS,
} from "../src/harvest-v3-registry.js";
import { getEvidenceEndpointAdapter, SCOPED_ENDPOINT_ADAPTERS } from "../src/tools/scoped-endpoint-adapters.js";
import { EVIDENCE_TOOL_DEFINITIONS, runEvidenceTool } from "../src/tools/evidence.js";
import { projectEvidenceResult } from "../src/tools/evidence-projection.js";
import { RECRUITER_READ_TOOL_ORDER } from "../src/tools/catalog-order.js";
import { CANDIDATE_SUBSTANCE_TOOLS, DEFAULT_FILTER_REGISTRY } from "../../scoped-core/src/index.js";
import { fakeScopedReader, scopedSuccess, testRuntime } from "./test-helpers.js";

/**
 * R2d — bind what is left, or cite why not.
 *
 * After R2b, twelve GET endpoints in the generated contract still had no reader. "Admin reference"
 * and "role gated" were the labels; neither named a Greenhouse permission. This binds eleven of them
 * and leaves the twelfth deferred with a reason a reader can check.
 */

const BOUND = [
  ["search_my_user_job_permissions", "/v3/user_job_permissions", "list_user_job_permissions"],
  ["search_my_future_job_permissions", "/v3/future_job_permissions", "list_future_job_permissions"],
  ["search_my_scorecard_candidate_attributes", "/v3/scorecard_candidate_attributes", "list_scorecard_candidate_attributes"],
  ["search_my_job_candidate_attributes", "/v3/job_candidate_attributes", "list_job_candidate_attributes"],
  ["search_my_candidate_attribute_types", "/v3/candidate_attribute_types", "list_candidate_attribute_types"],
  ["search_my_focus_candidate_attributes", "/v3/focus_candidate_attributes", "list_focus_candidate_attributes"],
  ["search_my_scorecard_question_candidate_attributes", "/v3/scorecard_question_candidate_attributes", "list_scorecard_question_candidate_attributes"],
  ["search_my_user_emails", "/v3/user_emails", "list_user_emails"],
  ["search_my_bulk_requests", "/v3/bulk_requests", "list_bulk_requests"],
  // R2e fold (Codex attack #8): the single read was deferred as "redundant", but it adds two signed
  // result-file URLs no guard caught. It is bound, with those URLs dropped like any signed URL.
  ["get_my_bulk_request", "/v3/bulk_requests/{bulk_action_uuid}", "get_bulk_request"],
  ["search_my_blocked_spam_sources", "/v3/blocked_spam_sources", "list_blocked_spam_sources"],
  ["search_my_job_board_custom_locations", "/v3/job_board_custom_locations", "list_job_board_custom_locations"],
] as const;

describe("R2d the remaining endpoints are bound, or the deferral is cited", () => {
  for (const [toolName, endpointPath, scopedToolName] of BOUND) {
    it(`${toolName} is wired through every layer a read passes`, () => {
      assert.equal(HARVEST_V3_EVIDENCE_TOOL_ENDPOINTS.get(toolName), endpointPath);
      const adapter = getEvidenceEndpointAdapter(toolName);
      assert.ok(adapter, "scoped-endpoint adapter");
      assert.equal(adapter.scopedToolName, scopedToolName);
      assert.ok(DEFAULT_FILTER_REGISTRY.has(scopedToolName), "scoped-core registry entry");
      assert.ok(EVIDENCE_TOOL_DEFINITIONS.some((definition) => definition.name === toolName), "model-facing definition");
      assert.ok(RECRUITER_READ_TOOL_ORDER.includes(toolName as never), "catalog order");
    });
  }

  it("leaves exactly the endpoints a stated constraint covers unbound, and no others", () => {
    const unbound = SCOPED_ENDPOINT_ADAPTERS
      .filter((adapter) => adapter.exposure !== "model_evidence")
      .map((adapter) => adapter.endpointPath)
      .sort();
    assert.deepEqual(unbound, [
      // EEOC and demographics: the vendor returns these row-level in the API and aggregate-only in
      // the product. Binding them would hand a recruiter individual demographic responses through a
      // door the ATS itself closes.
      "/v3/demographic_answer_options",
      "/v3/demographic_answers",
      "/v3/demographic_question_sets",
      "/v3/demographic_questions",
      "/v3/eeoc",
      // Redundant: /v3/rejection_reasons already returns every row this fetches by id.
      "/v3/rejection_reasons/{id}",
    ].sort());
  });

  it("bounds requisition permissions to the reader's own reqs rather than the whole org", async () => {
    // "Who else can see this req" is a question about YOUR req. The row carries job_id and the
    // endpoint takes job_ids, so it is bounded exactly like any other job-scoped read — no org-wide
    // view of who has access to reqs the reader cannot see.
    const entry = HARVEST_V3_ENDPOINT_REGISTRY_BY_PATH.get("/v3/user_job_permissions");
    assert.ok(entry);
    assert.equal(entry.responseFields.some((field) => field.name === "job_id"), true);

    const reader = fakeScopedReader((toolName) =>
      scopedSuccess(toolName, [{ id: 1, job_id: 10, user_id: 77, role_id: 4, automated: false }])
    );
    const { runtime } = testRuntime(reader);
    const result = await runEvidenceTool(runtime, "search_my_user_job_permissions", {});
    assert.equal(result.ok, true);
    const rows = (result.ok ? result.data : []) as Array<Record<string, unknown>>;
    assert.equal(rows[0]?.role_id, 4, "the role_id search_my_user_roles decodes");
    assert.equal(rows[0]?.user_id, 77);
  });

  it("returns staff-permission and staff-email rows to site admins and operators only", () => {
    for (const [toolName, row] of [
      ["search_my_future_job_permissions", { id: 1, user_id: 77, role_id: 4, department_id: 3, office_id: 4 }],
      ["search_my_user_emails", { id: 2, user_id: 77, email: "colleague@example.com", verified: true }],
    ] as const) {
      const adapter = getEvidenceEndpointAdapter(toolName);
      assert.ok(adapter, toolName);

      const recruiter = projectEvidenceResult(
        { ok: true, toolName, scoped: true, nextCursor: null, data: [row], permissionScope: { kind: "jobs" } } as never,
        adapter
      );
      assert.deepEqual(recruiter.ok ? recruiter.data : null, [], `${toolName} must return nothing to a job-scoped recruiter`);

      const operator = projectEvidenceResult(
        { ok: true, toolName, scoped: true, nextCursor: null, data: [row], permissionScope: { kind: "operator" } } as never,
        adapter
      );
      const operatorRows = (operator.ok ? operator.data : []) as Array<Record<string, unknown>>;
      assert.equal(operatorRows.length, 1, `${toolName} must reach an operator`);
      assert.equal(operatorRows[0]?.user_id, 77);
    }
  });

  it("treats the interviewer note on a scorecard attribute as candidate substance", () => {
    assert.equal(
      (CANDIDATE_SUBSTANCE_TOOLS as ReadonlySet<string>).has("list_scorecard_candidate_attributes"),
      true,
      "the row carries an interviewer's free-text note about one candidate"
    );
    const entry = HARVEST_V3_ENDPOINT_REGISTRY_BY_PATH.get("/v3/scorecard_candidate_attributes");
    assert.equal(entry?.responseFields.some((field) => field.name === "note"), true);
  });

  it("reclassifies the two attribute endpoints that were bound to a field they do not have", () => {
    // focus_candidate_attributes was job_scoped with no job_id on the row; the chain runs through the
    // interview kit. scorecard_question_candidate_attributes was scorecard_backed with no
    // scorecard_id; the chain runs through the rubric question.
    const focus = HARVEST_V3_ENDPOINT_REGISTRY_BY_PATH.get("/v3/focus_candidate_attributes");
    assert.equal(focus?.responseFields.some((field) => field.name === "job_id"), false);
    assert.equal(focus?.scopeClass, "join_backed");
    assert.deepEqual(focus?.joinDependencies.map((dependency) => dependency.targetEndpoint), ["/v3/interview_kits"]);

    const answers = HARVEST_V3_ENDPOINT_REGISTRY_BY_PATH.get("/v3/scorecard_question_candidate_attributes");
    assert.equal(answers?.responseFields.some((field) => field.name === "scorecard_id"), false);
    assert.equal(answers?.scopeClass, "join_backed");
    assert.deepEqual(
      answers?.joinDependencies.map((dependency) => dependency.targetEndpoint),
      ["/v3/scorecard_questions", "/v3/interview_kits"]
    );
  });

  it("moves job-board custom locations off a job scope the row cannot support", () => {
    const entry = HARVEST_V3_ENDPOINT_REGISTRY_BY_PATH.get("/v3/job_board_custom_locations");
    assert.equal(entry?.responseFields.some((field) => field.name === "job_id"), false);
    assert.equal(entry?.scopeClass, "global_reference");
  });

  it("mounts every registered endpoint that a reader can reach", () => {
    // The catalog and the contract agree: an endpoint with a reader has a definition, an endpoint
    // without one appears in the cited-deferral list above.
    const bound = HARVEST_V3_ENDPOINT_REGISTRY.filter((entry) => entry.toolName !== undefined);
    for (const entry of bound) {
      assert.ok(
        EVIDENCE_TOOL_DEFINITIONS.some((definition) => HARVEST_V3_EVIDENCE_TOOL_ENDPOINTS.get(definition.name) === entry.path),
        `${entry.path} has a tool name but no definition`
      );
    }
  });
});
