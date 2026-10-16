import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createRecruiterMcpServer, SERVER_INSTRUCTIONS } from "../src/server.js";
import { EVIDENCE_TOOL_DEFINITIONS, runEvidenceTool } from "../src/tools/evidence.js";
import { READ_MY_RESUME_TOOL } from "../src/tools/resume.js";
import { getRecruitingCapabilities } from "../src/resolvers/job-scope/capabilities.js";
import { RECRUITER_READ_TOOL_ORDER, recruiterReadToolKind } from "../src/tools/catalog-order.js";
import { EVIDENCE_DOMAIN_CLASSIFICATIONS } from "../src/tools/evidence.js";
import { fakeScopedReader, scopedSuccess, testRuntime } from "./test-helpers.js";
import type { AuthenticatedSession } from "../src/types.js";

/**
 * The R2 fold: the boundary and contract findings. Everything here fails on faa1ecf.
 */

function session(): AuthenticatedSession {
  return { subject: "google-subject-sam", surface: "test", client: "claude_desktop_chat", tokenId: "recruiter-token-abc123" };
}

/** A real McpServer + in-memory client, which is where the schema boundary actually runs. */
async function withClient<T>(
  run: (client: Client, calls: Array<{ toolName: string; params?: Record<string, unknown> }>) => Promise<T>
): Promise<T> {
  const calls: Array<{ toolName: string; params?: Record<string, unknown> }> = [];
  const reader = fakeScopedReader((toolName, params) => {
    calls.push({ toolName, params });
    return scopedSuccess(toolName, []);
  });
  const { runtime } = testRuntime(reader);
  const { server } = createRecruiterMcpServer({
    session: session(),
    env: { GREENHOUSE_RECRUITER_ALLOW_TEST_SURFACE: "true" },
    configureGreenhouse: false,
    scopedReader: reader,
    // The runtime the server builds is its own; the reader above is what both observe.
  });
  void runtime;
  const client = new Client({ name: "r2f-boundary", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return await run(client, calls);
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}

describe("R2 fold 5/23: the boundary accepts every date form its own guidance suggests", () => {
  it("accepts the object form the truncation note tells the model to send", async () => {
    await withClient(async (client, calls) => {
      const result = await client.callTool({
        name: "search_my_applications",
        arguments: { created_at: { gte: "2026-04-01", lte: "2026-06-30" } },
      });
      assert.equal(result.isError ?? false, false, "the object form must not be a -32602 boundary error");
      const call = calls.find((entry) => entry.toolName === "list_applications");
      assert.equal(call?.params?.["created_at[gte]"], "2026-04-01T00:00:00Z");
      assert.equal(call?.params?.["created_at[lte]"], "2026-06-30T23:59:59Z");
    });
  });

  it("accepts the advertised shorthand and a bare ISO value unchanged", async () => {
    await withClient(async (client, calls) => {
      await client.callTool({ name: "search_my_applications", arguments: { created_at: "2026-04-01..2026-06-30" } });
      await client.callTool({ name: "search_my_offers", arguments: { created_at: "2026-04-01T00:00:00Z" } });
      const application = calls.find((entry) => entry.toolName === "list_applications");
      assert.equal(application?.params?.["created_at[gte]"], "2026-04-01T00:00:00Z");
      assert.equal(application?.params?.["created_at[lte]"], "2026-06-30T23:59:59Z");
      const offer = calls.find((entry) => entry.toolName === "list_offers");
      assert.equal(offer?.params?.created_at, "2026-04-01T00:00:00Z");
    });
  });

  it("widens an exclusive bound by one instant and says so rather than rejecting it", async () => {
    const reader = fakeScopedReader((toolName) => scopedSuccess(toolName, []));
    const { runtime } = testRuntime(reader);
    const result = await runEvidenceTool(runtime, "search_my_applications", {
      created_at: "inclusive-bounds:2026-04-01..2026-06-30",
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.ok ? result.read?.bounds_treated_inclusive : null, ["created_at"]);
    const call = reader.calls.find((entry) => entry.toolName === "list_applications");
    assert.equal(call?.params?.["created_at[gte]"], "2026-04-01T00:00:00Z", "the marker never reaches the read");
  });

  it("marks gt/lt at the schema boundary and leaves gte/lte unmarked", async () => {
    await withClient(async (client, calls) => {
      await client.callTool({ name: "search_my_applications", arguments: { created_at: { gt: "2026-04-01" } } });
      const call = calls.find((entry) => entry.toolName === "list_applications");
      assert.equal(call?.params?.["created_at[gte]"], "2026-04-01T00:00:00Z");
      assert.equal(
        JSON.stringify(call?.params ?? {}).includes("inclusive-bounds:"),
        false,
        "the marker is a disclosure carrier, not a filter value"
      );
    });
  });

  it("still advertises one cheap string, not the object union", async () => {
    await withClient(async (client) => {
      const listed = await client.listTools();
      const applications = listed.tools.find((tool) => tool.name === "search_my_applications");
      const createdAt = (applications?.inputSchema?.properties ?? {})["created_at"] as Record<string, unknown>;
      assert.equal(createdAt?.type, "string");
      assert.equal(createdAt?.anyOf, undefined);
      assert.match(String(createdAt?.description), /2026-04-01\.\.2026-06-30/);
    });
  });

  it("shows the a..b form first everywhere the model is told about ranges", () => {
    // The object form was in the truncation notes and nowhere in the schema, which is precisely the
    // contradiction the boundary error came from. It now works, but the cheap form leads.
    assert.match(SERVER_INSTRUCTIONS, /"2026-04-01\.\.2026-06-30"/);
    assert.equal(
      /\{"gte"/.test(SERVER_INSTRUCTIONS),
      false,
      "instructions must not lead with the expensive form"
    );
  });
});

describe("R2 fold 13: what the model is told it holds is what the registrar mounted", () => {
  it("lists every mounted evidence reader as a browsing tool, not two hard-coded ones", () => {
    const visible = new Set(RECRUITER_READ_TOOL_ORDER);
    const capabilities = getRecruitingCapabilities(visible);
    const browsing = capabilities.browsing_tools.map((entry) => entry.tool);
    const evidenceTools = RECRUITER_READ_TOOL_ORDER.filter((name) => recruiterReadToolKind(name) === "evidence");
    assert.deepEqual([...browsing].sort(), [...evidenceTools].sort());
    assert.ok(browsing.length > 2, "the catalog is 80-odd readers; two of them is not the inventory");
    for (const entry of capabilities.browsing_tools) {
      assert.ok(entry.purpose.length > 0, `${entry.tool} needs a purpose`);
    }
  });

  it("drops a denylisted reader from the browsing inventory", () => {
    const visible = new Set(RECRUITER_READ_TOOL_ORDER.filter((name) => name !== "search_my_jobs"));
    const capabilities = getRecruitingCapabilities(visible);
    assert.equal(capabilities.browsing_tools.some((entry) => entry.tool === "search_my_jobs"), false);
  });

  it("classifies every read tool the same way the registrar does", async () => {
    const { RECRUITER_TOOL_DEFINITIONS } = await import("../src/tools/register.js");
    for (const definition of RECRUITER_TOOL_DEFINITIONS) {
      assert.equal(
        recruiterReadToolKind(definition.name),
        definition.kind,
        `${definition.name} is classified differently by the leaf module and the registrar`
      );
    }
  });
});

describe("R2 fold 6: one classifier decides read-only vs write-entitled", () => {
  it("accepts the write-entitled catalog the validator accepts", async () => {
    const { classifyDistributionCatalog } = await import("../src/distribution-validation.js");
    const { ACTION_DEFINITIONS, readActionRuntimeFlags } = await import("../../action-mcp/dist/index.js");
    // The default-on kinds: CLO-401's interview kinds are opt-in and not in a default grant.
    const defaultKinds = readActionRuntimeFlags({}).catalogCapabilities;
    const actionTools = ACTION_DEFINITIONS
      .filter((definition) => defaultKinds.has(definition.kind))
      .flatMap((definition) => [definition.previewTool, definition.applyTool]);
    const entitled = [...RECRUITER_READ_TOOL_ORDER, ...actionTools];

    const classified = classifyDistributionCatalog(entitled);
    assert.equal(classified.variant, "write_entitled");
    assert.deepEqual(classified.expected, entitled);
    assert.equal(
      classified.expected.length,
      RECRUITER_READ_TOOL_ORDER.length + actionTools.length,
      "the full catalog is the read catalog plus every preview/apply pair"
    );

    const readOnly = classifyDistributionCatalog([...RECRUITER_READ_TOOL_ORDER]);
    assert.equal(readOnly.variant, "read_only");

    // A partial action segment is a defect, not a variant: it must not be classified as entitled.
    const partial = classifyDistributionCatalog([...RECRUITER_READ_TOOL_ORDER, actionTools[0]]);
    assert.equal(partial.variant, "read_only");
  });

  // The end-to-end half — a write-entitled report, and a declared denylist, through runRolloutGate
  // over real evidence files — lives in rollout-gate.test.ts, next to the gate's other fixtures.
});

describe("R2 fold 12/21: a denylisted reader is a supported state, not a 503", () => {
  it("fails hosted env hygiene when the retired allowlist variable is still set", async () => {
    const { buildRecruiterMcpReadinessReport } = await import("../src/readiness.js");
    const report = buildRecruiterMcpReadinessReport({
      GREENHOUSE_RECRUITER_ALLOWED_TOOLS: "search_my_jobs",
    } as NodeJS.ProcessEnv);
    const check = report.checks.find((entry) => entry.name === "hosted_env_hygiene");
    assert.equal(check?.status, "fail");
    assert.match(check?.summary ?? "", /GREENHOUSE_RECRUITER_ALLOWED_TOOLS/);
  });

  it("derives the expected catalog from the denylist, in the one place three gates share", async () => {
    const { expectedMountedCatalog } = await import("../src/readiness.js");
    const full = expectedMountedCatalog(new Set());
    assert.deepEqual(full, [...RECRUITER_READ_TOOL_ORDER]);
    const reduced = expectedMountedCatalog(new Set(["search_my_jobs"]));
    assert.equal(reduced.length, full.length - 1);
    assert.equal(reduced.includes("search_my_jobs"), false);
    assert.deepEqual(reduced, full.filter((name) => name !== "search_my_jobs"), "order survives the removal");
  });

  it("boots the container self-check with a denylisted reader instead of throwing", async () => {
    const { runContainerSelfCheck } = await import("../src/container-self-check.js");
    const result = await runContainerSelfCheck({
      GREENHOUSE_RECRUITER_DISABLE_TOOLS: "search_my_job_boards",
    } as NodeJS.ProcessEnv);
    assert.equal(result.ok, true);
    assert.equal(result.catalogToolCount, RECRUITER_READ_TOOL_ORDER.length - 1);
    assert.equal(result.hiddenToolCount, 1, "the removed reader is counted, not hidden");
  });
});

describe("R2 fold 14/17: the copy says what the runtime does", () => {
  it("stops claiming tracking-link tokens are withheld, because they are returned", () => {
    const definition = EVIDENCE_TOOL_DEFINITIONS.find((entry) => entry.name === "search_my_tracking_links");
    assert.ok(definition);
    assert.equal(/token\/url fields are not exposed/.test(definition.description), false);
    assert.match(definition.description, /token/i);
  });

  it("describes read_my_resume's argument as an attachment id, not a resume id", () => {
    assert.match(READ_MY_RESUME_TOOL.description, /attachment/i);
  });

  it("bounds admin_reference rows by what the row actually carries", () => {
    // "Rows must carry a permitted job_id" was told to three endpoints whose rows have no job_id at
    // all, so the stated rule could not be the one being enforced.
    const permissions = EVIDENCE_DOMAIN_CLASSIFICATIONS.search_my_user_job_permissions;
    assert.equal(permissions.domain_class, "admin_reference");
    assert.match(permissions.bounding_rule, /job_id/);
    for (const toolName of ["search_my_future_job_permissions", "search_my_bulk_requests", "search_my_blocked_spam_sources", "get_my_bulk_request"]) {
      const classification = EVIDENCE_DOMAIN_CLASSIFICATIONS[toolName];
      assert.equal(
        /must carry a permitted job_id/.test(classification.bounding_rule),
        false,
        `${toolName} rows carry no job_id, so the bounding rule must not claim one: ${classification.bounding_rule}`
      );
      assert.match(classification.bounding_rule, /carry no job_id/);
    }
  });

  it("names the domain class the runtime actually classified the tool as", () => {
    // The descriptions state a domain class to the model. Two of them stated one the registry does
    // not agree with (bulk_requests and blocked_spam_sources called themselves global_reference while
    // the registry classifies both admin_reference), which is the same copy-vs-runtime class as the
    // tracking-link tokens above.
    for (const definition of EVIDENCE_TOOL_DEFINITIONS) {
      const stated = /Domain class: ([a-z_]+)/.exec(definition.description)?.[1];
      if (!stated) continue;
      assert.equal(
        stated,
        EVIDENCE_DOMAIN_CLASSIFICATIONS[definition.name]?.domain_class,
        `${definition.name} tells the model a domain class the registry does not agree with`
      );
    }
  });

  it("restores the location cross-check sentence the lane replaced", () => {
    assert.match(SERVER_INSTRUCTIONS, /Location resolution cross-checks internal scoped job-post targeting/);
    assert.match(SERVER_INSTRUCTIONS, /search_my_job_post_searchable_locations/);
  });
});
