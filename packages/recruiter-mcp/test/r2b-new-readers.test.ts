import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  HARVEST_V3_ENDPOINT_REGISTRY_BY_PATH,
  HARVEST_V3_EVIDENCE_TOOL_ENDPOINTS,
} from "../src/harvest-v3-registry.js";
import { getEvidenceEndpointAdapter, SCOPED_TOOL_SCOPE_POLICIES } from "../src/tools/scoped-endpoint-adapters.js";
import { EVIDENCE_TOOL_DEFINITIONS, runEvidenceTool } from "../src/tools/evidence.js";
import { projectEvidenceResult } from "../src/tools/evidence-projection.js";
import { RECRUITER_READ_TOOL_ORDER } from "../src/tools/catalog-order.js";
import { DEFAULT_FILTER_REGISTRY } from "../../scoped-core/src/index.js";
import { fakeScopedReader, scopedSuccess, testRuntime } from "./test-helpers.js";

/**
 * R2b — four endpoints bound so a recruiter question closes at both ends.
 *
 * Each one pairs with a tool that already exists and returns an id the recruiter cannot decode, or a
 * question the surface can ask but not answer.
 */

const NEW_TOOLS = [
  ["search_my_job_post_searchable_locations", "/v3/job_post_searchable_locations", "list_job_post_searchable_locations"],
  ["search_my_applied_candidate_tags", "/v3/applied_candidate_tags", "list_applied_candidate_tags"],
  ["search_my_user_roles", "/v3/user_roles", "list_user_roles"],
  ["search_my_email_templates", "/v3/email_templates", "list_email_templates"],
] as const;

describe("R2b the four new readers are bound end to end", () => {
  for (const [toolName, endpointPath, scopedToolName] of NEW_TOOLS) {
    it(`${toolName} is wired through every layer a read passes`, () => {
      assert.equal(HARVEST_V3_EVIDENCE_TOOL_ENDPOINTS.get(toolName), endpointPath, "registry pair");
      const adapter = getEvidenceEndpointAdapter(toolName);
      assert.ok(adapter, "scoped-endpoint adapter (EVIDENCE_TOOL_SCOPED_TOOL_ENTRIES)");
      assert.equal(adapter.scopedToolName, scopedToolName, "scoped reader binding");
      assert.equal(adapter.exposure, "model_evidence");
      assert.ok(DEFAULT_FILTER_REGISTRY.has(scopedToolName), "scoped-core DEFAULT_FILTER_REGISTRY entry");
      assert.ok(
        EVIDENCE_TOOL_DEFINITIONS.some((definition) => definition.name === toolName),
        "model-facing definition with a description"
      );
      assert.ok(RECRUITER_READ_TOOL_ORDER.includes(toolName as never), "catalog order");
    });
  }

  it("scopes post locations through the post to a permitted job, on a row that carries no job_id", async () => {
    // /v3/job_post_searchable_locations documents job_post_id and NO job_id, so the direct
    // job-scoped filter it used to be classified under would have resolved every row unresolved.
    const entry = HARVEST_V3_ENDPOINT_REGISTRY_BY_PATH.get("/v3/job_post_searchable_locations");
    assert.ok(entry);
    assert.equal(entry.responseFields.some((field) => field.name === "job_id"), false, "the contract really has no job_id");
    assert.equal(entry.scopeClass, "join_backed");
    assert.deepEqual(
      entry.joinDependencies.map((dependency) => [dependency.field, dependency.targetEndpoint]),
      [["job_post_id", "/v3/job_posts"]]
    );
    assert.ok(SCOPED_TOOL_SCOPE_POLICIES.has("list_job_post_searchable_locations"), "an executable join policy");

    const reader = fakeScopedReader((toolName) =>
      scopedSuccess(toolName, [
        { id: 1, job_post_id: 900, city: "Bengaluru", region_long_name: "Karnataka", country_short_name: "IN", latitude: 12.97, longitude: 77.59 },
      ])
    );
    const { runtime } = testRuntime(reader);
    const result = await runEvidenceTool(runtime, "search_my_job_post_searchable_locations", {});
    assert.equal(result.ok, true);
    const rows = (result.ok ? result.data : []) as Array<Record<string, unknown>>;
    // The finer location the server instructions apologise for not having.
    assert.equal(rows[0]?.city, "Bengaluru");
    assert.equal(rows[0]?.latitude, 12.97);
  });

  it("treats applied candidate tags as candidate substance, so the private gate covers them", async () => {
    const { CANDIDATE_SUBSTANCE_TOOLS } = await import("../../scoped-core/src/index.js");
    assert.equal(
      (CANDIDATE_SUBSTANCE_TOOLS as ReadonlySet<string>).has("list_applied_candidate_tags"),
      true,
      "a tag row names a candidate by id; an unattested actor must not learn a private candidate exists through it"
    );
    const reader = fakeScopedReader((toolName) =>
      scopedSuccess(toolName, [{ id: 5, candidate_id: 3, candidate_tag_id: 8, created_at: "2026-01-01T00:00:00.000Z" }])
    );
    const { runtime } = testRuntime(reader);
    const result = await runEvidenceTool(runtime, "search_my_applied_candidate_tags", {});
    assert.equal(result.ok, true);
    const rows = (result.ok ? result.data : []) as Array<Record<string, unknown>>;
    assert.equal(rows[0]?.candidate_tag_id, 8, "the tag id search_my_candidate_tags decodes");
  });

  it("makes user_roles a global reference dictionary rather than an admin diagnostic", () => {
    const entry = HARVEST_V3_ENDPOINT_REGISTRY_BY_PATH.get("/v3/user_roles");
    assert.ok(entry);
    assert.equal(entry.scopeClass, "global_reference");
    assert.equal(entry.sensitivityClass, "default_operational");
    // role_type is the two-value taxonomy; name is the cosmetic label. Both decode role_id.
    assert.deepEqual(
      entry.responseFields.map((field) => field.name).filter((name) => name === "name" || name === "role_type").sort(),
      ["name", "role_type"]
    );
  });

  it("describes user_roles as decoding role_id on the permission endpoints, not on search_my_users", () => {
    const definition = EVIDENCE_TOOL_DEFINITIONS.find((entry) => entry.name === "search_my_user_roles");
    assert.ok(definition);
    assert.match(definition.description, /role_id/);
    // /v3/users has no role_id. Claiming this decodes a field that endpoint returns would be a lie
    // the model would act on.
    const users = HARVEST_V3_ENDPOINT_REGISTRY_BY_PATH.get("/v3/users");
    assert.equal(users?.responseFields.some((field) => field.name === "role_id"), false);
    assert.equal(/search_my_users/.test(definition.description), false);
  });

  it("returns email-template copy but restores recipients to site admins and operators only", () => {
    const row = {
      id: 3,
      name: "Rejection — after onsite",
      subject: "An update on your application",
      body: "Thank you for interviewing with us.",
      email_type: "candidate_rejection",
      from_type: "user_email",
      user_id: 77,
      recipients: "jordan@example.com, riley@example.com",
      default: true,
    };
    const adapter = getEvidenceEndpointAdapter("search_my_email_templates");
    assert.ok(adapter);

    const recruiter = projectEvidenceResult(
      { ok: true, toolName: "search_my_email_templates", scoped: true, nextCursor: null, data: [row], permissionScope: { kind: "jobs" } } as never,
      adapter
    );
    const recruiterRow = ((recruiter.ok ? recruiter.data : []) as Array<Record<string, unknown>>)[0] ?? {};
    assert.equal(recruiterRow.subject, "An update on your application", "the template copy is the point of the read");
    assert.equal(recruiterRow.user_id, 77, "the owning user id is an id, not contact data");
    assert.equal(recruiterRow.recipients, undefined, "colleague addresses are withheld from a line recruiter");
    assert.equal(
      JSON.stringify(recruiter.ok ? recruiter.data : []).includes("@example.com"),
      false,
      "no literal colleague address may reach a job-scoped recruiter"
    );

    const operator = projectEvidenceResult(
      { ok: true, toolName: "search_my_email_templates", scoped: true, nextCursor: null, data: [row], permissionScope: { kind: "operator" } } as never,
      adapter
    );
    const operatorRow = ((operator.ok ? operator.data : []) as Array<Record<string, unknown>>)[0] ?? {};
    assert.equal(operatorRow.recipients, "jordan@example.com, riley@example.com", "an operator administers the directory");
  });

  it("describes email_type without pasting the 51-value enum into the description", () => {
    const definition = EVIDENCE_TOOL_DEFINITIONS.find((entry) => entry.name === "search_my_email_templates");
    assert.ok(definition);
    assert.equal(/candidate_auto_reply/.test(definition.description), false, "enum values live in the schema, not the prose");
    const entry = HARVEST_V3_ENDPOINT_REGISTRY_BY_PATH.get("/v3/email_templates");
    const emailType = entry?.parameters.find((parameter) => parameter.name === "email_type");
    assert.ok((emailType?.enumValues?.length ?? 0) > 40, "the schema still carries every legal value");
  });
});
