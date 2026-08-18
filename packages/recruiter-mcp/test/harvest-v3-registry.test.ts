import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerRecruiterTools } from "../src/tools/register.js";
import { EVIDENCE_TOOL_MAP } from "../src/tools/evidence.js";
import {
  HARVEST_V3_ENDPOINT_REGISTRY,
  HARVEST_V3_ENDPOINT_REGISTRY_BY_PATH,
  HARVEST_V3_EVIDENCE_TOOL_ENDPOINTS,
  getHarvestEndpointForEvidenceTool,
  getHiddenModelParametersForEndpoint,
  getModelExposedParametersForEndpoint,
  validateHarvestScopePolicies,
} from "../src/harvest-v3-registry.js";
import { HARVEST_V3_ENDPOINT_DOC_FACTS } from "../src/harvest-v3-registry.generated.js";
import {
  SCOPED_ENDPOINT_ADAPTERS,
  SCOPED_ENDPOINT_ADAPTERS_BY_EVIDENCE_TOOL,
  SCOPED_ENDPOINT_ADAPTERS_BY_PATH,
  SCOPED_TOOL_SCOPE_POLICIES,
} from "../src/tools/scoped-endpoint-adapters.js";
import { fakeScopedReader, scopedSuccess, testRuntime } from "./test-helpers.js";
import {
  createScopedGreenhouseReader,
  type ApiResponse,
  type RawReadClient,
} from "../../scoped-core/src/index.js";

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

describe("Harvest v3 endpoint registry", () => {
  it("represents every vendored Harvest v3 GET/read endpoint", () => {
    assert.equal(HARVEST_V3_ENDPOINT_DOC_FACTS.length, 72);
    assert.equal(HARVEST_V3_ENDPOINT_REGISTRY.length, 72);
    assert.equal(new Set(HARVEST_V3_ENDPOINT_REGISTRY.map((entry) => entry.path)).size, 72);

    for (const fact of HARVEST_V3_ENDPOINT_DOC_FACTS) {
      const entry = HARVEST_V3_ENDPOINT_REGISTRY_BY_PATH.get(fact.path);
      assert.ok(entry, `missing registry entry for ${fact.path}`);
      assert.equal(entry.method, "GET");
      assert.equal(entry.sourceDocPath, fact.sourceDocPath);
      assert.deepStrictEqual(entry.parameters.map((param) => param.name), fact.parameters.map((param) => param.name));
      assert.deepStrictEqual(entry.responseFields.map((field) => field.name), fact.responseFields.map((field) => field.name));
    }
  });

  it("classifies /v3/user_job_permissions as internal permission infrastructure", () => {
    const entry = HARVEST_V3_ENDPOINT_REGISTRY_BY_PATH.get("/v3/user_job_permissions");
    assert.ok(entry);
    assert.equal(entry.scopeClass, "admin_reference");
    assert.equal(entry.sensitivityClass, "admin_diagnostic");
    assert.equal(entry.defaultProjectionProfile, "internal_permission");
    assert.equal(entry.toolName, undefined);
    assert.ok(entry.parameters.some((param) => param.name === "user_ids"));
    assert.ok(entry.responseFields.some((field) => field.name === "job_id"));
  });

  it("maps every current evidence tool to a registry entry without creating raw endpoint tools", () => {
    for (const toolName of EVIDENCE_TOOL_MAP.keys()) {
      const endpointPath = HARVEST_V3_EVIDENCE_TOOL_ENDPOINTS.get(toolName);
      assert.ok(endpointPath, `missing endpoint mapping for ${toolName}`);
      assert.ok(HARVEST_V3_ENDPOINT_REGISTRY_BY_PATH.has(endpointPath), `missing registry entry for ${toolName} -> ${endpointPath}`);
      const adapter = SCOPED_ENDPOINT_ADAPTERS_BY_EVIDENCE_TOOL.get(toolName);
      assert.ok(adapter, `missing scoped endpoint adapter for ${toolName}`);
      assert.equal(adapter.endpointPath, endpointPath);
      assert.equal(adapter.exposure, "model_evidence");
    }

    assert.equal(HARVEST_V3_ENDPOINT_REGISTRY.length > EVIDENCE_TOOL_MAP.size, true, "registry breadth must not imply raw model-tool exposure");
    assert.equal([...EVIDENCE_TOOL_MAP.keys()].some((toolName) => toolName.startsWith("list_")), false);
  });

  it("builds a scoped endpoint adapter or explicit non-exposure reason for every registry endpoint", () => {
    assert.equal(SCOPED_ENDPOINT_ADAPTERS.length, HARVEST_V3_ENDPOINT_REGISTRY.length);
    assert.equal(SCOPED_ENDPOINT_ADAPTERS_BY_PATH.size, HARVEST_V3_ENDPOINT_REGISTRY.length);

    for (const endpoint of HARVEST_V3_ENDPOINT_REGISTRY) {
      const adapter = SCOPED_ENDPOINT_ADAPTERS_BY_PATH.get(endpoint.path);
      assert.ok(adapter, `missing scoped endpoint adapter for ${endpoint.path}`);
      assert.equal(adapter.scopeClass, endpoint.scopeClass);
      assert.equal(adapter.sensitivityClass, endpoint.sensitivityClass);
      assert.equal(adapter.defaultProjectionProfile, endpoint.defaultProjectionProfile);
      // #9: allowedProjectionProfiles is advisory and must not advertise a profile the recruiter
      // projection cannot produce. The default profile is always allowed; the dead role_gated_detail
      // "restore" tier (consumed by nothing) was removed so it cannot be mistaken for a live path.
      assert.ok(
        adapter.allowedProjectionProfiles.includes(adapter.defaultProjectionProfile),
        `${endpoint.path}: default projection profile must be among the allowed profiles`
      );
      assert.ok(
        !(adapter.allowedProjectionProfiles as string[]).includes("role_gated_detail"),
        `${endpoint.path}: must not advertise the removed role_gated_detail restore profile`
      );
      assert.deepStrictEqual(adapter.joinDependencies, endpoint.joinDependencies);
      assert.equal(typeof adapter.boundingRule, "string");
      assert.ok(adapter.boundingRule.length > 20);
      if (adapter.exposure !== "model_evidence") {
        assert.equal(typeof adapter.nonExposureReason, "string", `${endpoint.path} needs a non-exposure reason`);
        assert.ok(adapter.nonExposureReason!.length > 30, `${endpoint.path} has a weak non-exposure reason`);
      }
    }

    const internal = SCOPED_ENDPOINT_ADAPTERS_BY_PATH.get("/v3/user_job_permissions");
    assert.ok(internal);
    assert.equal(internal.exposure, "internal_permission");
    assert.deepStrictEqual(internal.evidenceTools, []);
    assert.equal([...SCOPED_ENDPOINT_ADAPTERS_BY_EVIDENCE_TOOL.keys()].length, EVIDENCE_TOOL_MAP.size);
  });

  it("locks the executable permission chains for every formerly-global job-backed reference", () => {
    const expected: Record<string, string[]> = {
      "/v3/approvers": ["approver_group_id:approver_group_ids->/v3/approver_groups", "approval_flow_id:approval_flow_ids->/v3/approval_flows"],
      "/v3/approver_groups": ["approval_flow_id:approval_flow_ids->/v3/approval_flows"],
      "/v3/scorecard_questions": ["interview_kit_id:interview_kit_ids->/v3/interview_kits"],
      "/v3/scorecard_question_options": ["scorecard_question_id:scorecard_question_ids->/v3/scorecard_questions", "interview_kit_id:interview_kit_ids->/v3/interview_kits"],
      "/v3/scorecard_question_answer_options": ["scorecard_question_answer_id:scorecard_question_answer_ids->/v3/scorecard_question_answers", "scorecard_id:scorecard_ids->/v3/scorecards", "application_id:application_ids->/v3/applications"],
      "/v3/default_interviewers": ["interview_kit_id:interview_kit_ids->/v3/interview_kits"],
      "/v3/job_post_locations": ["job_post_id:job_post_ids->/v3/job_posts"],
      "/v3/pay_input_ranges": ["job_post_id:job_post_ids->/v3/job_posts"],
      "/v3/prospect_pool_stages": ["prospect_pool_id:prospect_pool_ids->/v3/prospect_pools"],
    };

    for (const [path, chain] of Object.entries(expected)) {
      const endpoint = HARVEST_V3_ENDPOINT_REGISTRY_BY_PATH.get(path);
      assert.ok(endpoint);
      assert.equal(endpoint.scopeClass, "join_backed");
      assert.equal(endpoint.scopePolicy?.kind, "join_backed");
      assert.deepStrictEqual(
        endpoint.joinDependencies.map((join) => `${join.field}:${join.sourceFilter}->${join.targetEndpoint}`),
        chain,
        path
      );
      for (const dependency of endpoint.joinDependencies) {
        assert.equal(dependency.targetField, "id", `${path}: parent lookups must join on documented ids`);
        assert.equal(dependency.targetFilter, "ids", `${path}: parent lookups must use the documented ids filter`);
        assert.equal(dependency.purpose, "scope", `${path}: the dependency must be executable scope metadata`);
      }
      assert.equal(endpoint.scopePolicy?.terminal.field, path === "/v3/prospect_pool_stages" ? "job_ids" : "job_id");
      const adapter = SCOPED_ENDPOINT_ADAPTERS_BY_PATH.get(path);
      assert.ok(adapter?.scopePolicy);
      for (const binding of adapter.evidenceTools) {
        assert.equal(SCOPED_TOOL_SCOPE_POLICIES.get(binding.scopedToolName), adapter.scopePolicy);
      }
    }

    const pools = HARVEST_V3_ENDPOINT_REGISTRY_BY_PATH.get("/v3/prospect_pools");
    assert.equal(pools?.scopePolicy?.kind, "direct");
    assert.equal(pools?.scopePolicy?.terminal.field, "job_ids");
  });

  it("declares the strict production application job compatibility shape on every application terminal", () => {
    const compatibility = { kind: "single_nested_id", field: "jobs", idField: "id" };
    const applications = HARVEST_V3_ENDPOINT_REGISTRY_BY_PATH.get("/v3/applications");
    assert.equal(applications?.scopePolicy?.kind, "direct");
    assert.deepStrictEqual(applications?.scopePolicy?.terminal.compatibility, compatibility);
    assert.ok(applications?.knownAliases.some((alias) =>
      alias.canonical === "job_id" && alias.alias === "jobs[].id"
    ));

    const answerOptions = HARVEST_V3_ENDPOINT_REGISTRY_BY_PATH.get("/v3/scorecard_question_answer_options");
    assert.equal(answerOptions?.scopePolicy?.kind, "join_backed");
    assert.equal(answerOptions?.scopePolicy?.dependencies.at(-1)?.targetEndpoint, "/v3/applications");
    assert.deepStrictEqual(answerOptions?.scopePolicy?.terminal.compatibility, compatibility);
  });

  it("executes application-stage authorization through the batched registry policy", () => {
    const stages = HARVEST_V3_ENDPOINT_REGISTRY_BY_PATH.get("/v3/application_stages");
    assert.equal(stages?.scopeClass, "application_backed");
    assert.equal(stages?.scopePolicy?.kind, "join_backed");
    assert.deepStrictEqual(stages?.scopePolicy?.dependencies, [{
      field: "application_id",
      sourceFilter: "application_ids",
      targetEndpoint: "/v3/applications",
      targetField: "id",
      targetFilter: "ids",
      purpose: "scope",
    }]);
    assert.deepStrictEqual(stages?.scopePolicy?.terminal, {
      field: "job_id",
      filter: "job_ids",
      compatibility: { kind: "single_nested_id", field: "jobs", idField: "id" },
    });
    assert.equal(stages?.scopePolicy?.kind === "join_backed" && stages.scopePolicy.rowVisibility, "public_only");
    assert.equal(SCOPED_TOOL_SCOPE_POLICIES.get("list_application_stages"), stages?.scopePolicy);
  });

  it("batches application-stage permission parents and preserves the cross-job boundary", async () => {
    let activeParentReads = 0;
    let maxActiveParentReads = 0;
    const parentBatches: number[][] = [];
    const rawReader: RawReadClient = {
      async read<T>(
        path: string,
        params?: Record<string, string | number | boolean | undefined>
      ): Promise<ApiResponse<T>> {
        if (path === "/application_stages") {
          return {
            data: Array.from({ length: 102 }, (_, index) => ({
              id: 10_000 + index,
              application_id: index === 101 ? 1 : index + 1,
              current: true,
              ...(index === 101 ? { visibility: "private" } : {}),
            })) as T,
            nextCursor: null,
          };
        }
        // Applications carry candidate_id in the v3 default field set; the privacy gate resolves
        // each kept stage row's candidate through it. None of these candidates is private, so the
        // job boundary below is what decides every row.
        if (path === "/candidates") {
          return {
            data: String(params?.ids)
              .split(",")
              .map(Number)
              .filter((id) => Number.isInteger(id) && id > 0)
              .map((id) => ({ id, private: false })) as T,
            nextCursor: null,
          };
        }
        assert.equal(path, "/applications");
        const ids = String(params?.ids).split(",").map(Number);
        parentBatches.push(ids);
        activeParentReads += 1;
        maxActiveParentReads = Math.max(maxActiveParentReads, activeParentReads);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeParentReads -= 1;
        return {
          data: ids.map((id) => ({ id, job_id: id <= 50 ? 1 : 2, candidate_id: 5_000 + id })) as T,
          nextCursor: null,
        };
      },
    };
    const scopedReader = createScopedGreenhouseReader<number>({
      rawReader,
      actorResolver: { async resolveActor(identity) { return identity; } },
      permissionProvider: { async getPermittedJobIds() { return new Set([1]); } },
      scopePolicyRegistry: SCOPED_TOOL_SCOPE_POLICIES,
    });

    const result = await scopedReader.scopedRead(100, "list_application_stages", {});

    assert.equal(result.ok, true);
    assert.equal(result.ok && Array.isArray(result.data) && result.data.length, 50);
    assert.equal(result.ok && Array.isArray(result.data) && result.data.some((row: any) => row.id === 10_101), false);
    assert.deepStrictEqual(parentBatches.map((batch) => batch.length), [50, 50, 1]);
    assert.equal(parentBatches.every((batch) => batch.length <= 50), true);
    assert.equal(maxActiveParentReads, 3);
    assert.equal(result.ok && result.rowCounts.permissionExcluded, 52);
    assert.equal(result.ok && result.rowCounts.status, "complete");
  });

  it("fails registry validation if application stages loses its executable policy", () => {
    const entries = HARVEST_V3_ENDPOINT_REGISTRY.map((entry) =>
      entry.path === "/v3/application_stages" ? { ...entry, scopePolicy: null } : { ...entry }
    );
    assert.throws(
      () => validateHarvestScopePolicies(entries),
      /application_stages: join_backed endpoint is missing an executable join policy/
    );
  });

  it("rejects undeclared terminal compatibility metadata", () => {
    const entries = HARVEST_V3_ENDPOINT_REGISTRY.map((entry) => ({
      ...entry,
      knownAliases: entry.path === "/v3/applications"
        ? entry.knownAliases.filter((alias) => alias.alias !== "jobs[].id")
        : entry.knownAliases,
    }));

    assert.throws(
      () => validateHarvestScopePolicies(entries),
      /terminal compatibility is not declared as a known alias: jobs\[\]\.id/
    );
  });

  it("rejects policy fields and filters that are absent from the generated contract", () => {
    const entries = HARVEST_V3_ENDPOINT_REGISTRY.map((entry) => ({ ...entry }));
    const index = entries.findIndex((entry) => entry.path === "/v3/approvers");
    const original = entries[index]!;
    assert.equal(original.scopePolicy?.kind, "join_backed");
    entries[index] = {
      ...original,
      scopePolicy: {
        ...original.scopePolicy,
        dependencies: [
          { ...original.scopePolicy.dependencies[0]!, sourceFilter: "scorecard_ids" },
          ...original.scopePolicy.dependencies.slice(1),
        ],
      },
    };
    assert.throws(
      () => validateHarvestScopePolicies(entries),
      /join source filter is not documented: scorecard_ids/
    );
  });

  it("rejects cyclic policies and policies that do not terminate at job ids", () => {
    const cyclic = HARVEST_V3_ENDPOINT_REGISTRY.map((entry) => ({ ...entry }));
    const cyclicIndex = cyclic.findIndex((entry) => entry.path === "/v3/approvers");
    const cyclicEntry = cyclic[cyclicIndex]!;
    assert.equal(cyclicEntry.scopePolicy?.kind, "join_backed");
    cyclic[cyclicIndex] = {
      ...cyclicEntry,
      scopePolicy: {
        ...cyclicEntry.scopePolicy,
        dependencies: [
          cyclicEntry.scopePolicy.dependencies[0]!,
          {
            ...cyclicEntry.scopePolicy.dependencies[1]!,
            targetEndpoint: "/v3/approvers",
          },
        ],
      },
    };
    assert.throws(
      () => validateHarvestScopePolicies(cyclic),
      /scope join graph contains a cycle at \/v3\/approvers/
    );

    const nonJobTerminal = HARVEST_V3_ENDPOINT_REGISTRY.map((entry) => ({ ...entry }));
    const terminalIndex = nonJobTerminal.findIndex((entry) => entry.path === "/v3/approver_groups");
    const terminalEntry = nonJobTerminal[terminalIndex]!;
    assert.equal(terminalEntry.scopePolicy?.kind, "join_backed");
    nonJobTerminal[terminalIndex] = {
      ...terminalEntry,
      scopePolicy: {
        ...terminalEntry.scopePolicy,
        terminal: { field: "id", filter: "ids" },
      },
    };
    assert.throws(
      () => validateHarvestScopePolicies(nonJobTerminal),
      /scope policy does not terminate at job ids/
    );
  });

  it("derives current evidence schemas from endpoint-specific registry parameters", () => {
    const schemas = registeredSchemas();
    // Bridgeable classes = endpoints with NO job_ids filter, which therefore advertise the scope
    // carriers (scope_handle/job_ids) the auto-bridge consumes: application_backed (L1) +
    // scorecard/interview/candidate-backed (R2). Hardcoded here (NOT derived from the production
    // getScopeBridgeSpec) so the lock is an independent check, not a mirror of the resolver.
    const BRIDGEABLE_SCOPE_CLASSES = ["application_backed", "scorecard_backed", "interview_backed", "candidate_backed", "join_backed"];

    for (const toolName of EVIDENCE_TOOL_MAP.keys()) {
      const schema = schemas.get(toolName);
      assert.ok(schema, `missing registered schema for ${toolName}`);
      if (toolName.startsWith("get_")) {
        assert.deepStrictEqual(Object.keys(schema), ["id"]);
        continue;
      }
      const endpoint = getHarvestEndpointForEvidenceTool(toolName);
      assert.ok(endpoint, `missing endpoint for ${toolName}`);
      // Bridgeable tools (no job_ids filter on the endpoint) additionally advertise the two scope
      // carriers (scope_handle/job_ids) that the L1+R2 auto-bridge consumes — they are deliberately
      // NOT endpoint filters, which is precisely why the bridge exists.
      const isBridgeable = BRIDGEABLE_SCOPE_CLASSES.includes(SCOPED_ENDPOINT_ADAPTERS_BY_EVIDENCE_TOOL.get(toolName)?.scopeClass ?? "")
        || endpoint.path === "/v3/prospect_pools"
        || endpoint.path === "/v3/applications";
      const scopeCarriers = isBridgeable
        ? [
            ...(endpoint.parameters.some((param) => param.name === "job_ids") ? [] : ["job_ids"]),
            "scope_handle",
          ]
        : [];
      // `offset` is the runtime's own result-continuation knob (live-pilot fix #2), applied to the
      // complete scoped set AFTER the read — advertised on every search tool, never sent upstream.
      const runtimeParams = ["offset"];
      const expected = [...getModelExposedParametersForEndpoint(endpoint.path).map((param) => param.name), ...scopeCarriers, ...runtimeParams].sort();
      assert.deepStrictEqual(Object.keys(schema).sort(), expected, `${toolName} schema must match registry-exposed params${isBridgeable ? " plus the scope carriers" : ""} plus offset`);
      for (const paramName of Object.keys(schema)) {
        if (scopeCarriers.includes(paramName) || runtimeParams.includes(paramName)) continue; // narrow via the bridge / applied post-read, not endpoint filters
        assert.ok(endpoint.parameters.some((param) => param.name === paramName), `${toolName} advertises unsupported param ${paramName}`);
      }
    }

    // Positive lock: every BRIDGEABLE search tool carries BOTH scope carriers so a confirmed requisition
    // scope can reach the bridge (drop either and the read regresses to all-permitted). L1 = application_
    // backed; R2 = scorecard/interview/candidate-backed.
    for (const [toolName, adapter] of SCOPED_ENDPOINT_ADAPTERS_BY_EVIDENCE_TOOL) {
      if ((
        !BRIDGEABLE_SCOPE_CLASSES.includes(adapter.scopeClass)
        && adapter.endpointPath !== "/v3/prospect_pools"
        && adapter.endpointPath !== "/v3/applications"
      ) || toolName.startsWith("get_")) continue;
      const schema = schemas.get(toolName)!;
      assert.ok("scope_handle" in schema, `${toolName} must advertise scope_handle for the bridge`);
      assert.ok("job_ids" in schema, `${toolName} must advertise job_ids for the bridge`);
    }
  });

  it("exposes the custom_field_option_id filter on openings/rejection_details/users but keeps it hidden on offers (Rank 23)", () => {
    const exposes = (path: string) =>
      getModelExposedParametersForEndpoint(path).some((param) => param.name === "custom_field_option_id");
    // Un-hidden: a recruiter may filter these reads by a custom-field value (their own Greenhouse
    // entitlement already permits it).
    for (const path of ["/v3/openings", "/v3/rejection_details", "/v3/users"]) {
      assert.ok(exposes(path), `${path} should expose the custom_field_option_id filter`);
    }
    // Retained-hidden with a cited external reason: offer custom fields are compensation-sensitive.
    assert.equal(exposes("/v3/offers"), false);
    assert.ok(
      getHiddenModelParametersForEndpoint("/v3/offers").some((param) => param.name === "custom_field_option_id"),
      "offers must keep custom_field_option_id hidden (comp-sensitive)"
    );
  });

  it("captures path-level OpenAPI parameters merged from the path item, e.g. {bulk_action_uuid} (regression)", () => {
    const entry = HARVEST_V3_ENDPOINT_REGISTRY_BY_PATH.get("/v3/bulk_requests/{bulk_action_uuid}");
    assert.ok(entry, "bulk_requests endpoint must be registered");
    const param = entry.parameters.find((candidate) => candidate.name === "bulk_action_uuid");
    assert.ok(param, "the required path-level bulk_action_uuid param must be captured, not silently dropped");
    assert.equal(param.in, "path");
    assert.equal(param.required, true);
  });

  it("locks every endpoint's scope/sensitivity classification against an independent golden snapshot", () => {
    // The adapter<->registry parity checks above are tautological (the adapter copies the registry).
    // This golden is a frozen, separately-committed snapshot, so a sensitivity/scope reclassification
    // on any of the 72 endpoints must deliberately update the golden instead of passing silently.
    const golden = JSON.parse(
      readFileSync(new URL("./fixtures/harvest-v3-classification.golden.json", import.meta.url), "utf8")
    );
    const actual: Record<string, unknown> = {};
    for (const entry of [...HARVEST_V3_ENDPOINT_REGISTRY].sort((a, b) => a.path.localeCompare(b.path))) {
      actual[entry.path] = {
        scopeClass: entry.scopeClass,
        sensitivityClass: entry.sensitivityClass,
        defaultProjectionProfile: entry.defaultProjectionProfile,
      };
    }
    assert.equal(Object.keys(golden).length, 72);
    assert.deepStrictEqual(actual, golden);
  });

  it("keeps hidden supported filters explicit instead of silently dropping them", () => {
    const searchEndpointPaths = new Set(
      [...HARVEST_V3_EVIDENCE_TOOL_ENDPOINTS.entries()]
        .filter(([toolName]) => toolName.startsWith("search_"))
        .map(([, endpointPath]) => endpointPath)
    );

    for (const endpointPath of searchEndpointPaths) {
      const entry = HARVEST_V3_ENDPOINT_REGISTRY_BY_PATH.get(endpointPath);
      assert.ok(entry);
      const exposed = new Set(getModelExposedParametersForEndpoint(endpointPath).map((param) => param.name));
      const hidden = new Map(getHiddenModelParametersForEndpoint(endpointPath).map((param) => [param.name, param.reason]));
      for (const param of entry.parameters) {
        if (!exposed.has(param.name)) {
          assert.ok(hidden.get(param.name), `${endpointPath} hides ${param.name} without a reason`);
        }
      }
    }
  });
});
