import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ACTION_DEFINITIONS } from "../../action-mcp/dist/index.js";
import { createActionToolGrant } from "../src/action-tools.js";
import { buildClaudeMcpb } from "../src/claude-mcpb.js";
import { createRecruiterMcpServer, createRecruiterRuntimeForServer, SERVER_INSTRUCTIONS } from "../src/server.js";
import { EVIDENCE_TOOL_DEFINITIONS, evidenceToolParamsSchema, runEvidenceTool } from "../src/tools/evidence.js";
import { RECRUITER_TOOL_DEFINITIONS, registerRecruiterTools } from "../src/tools/register.js";
import { PLANNER_RECIPE_IDS, runRecruitingQuestionAnswer } from "../src/tools/question-answer.js";
import { runGetRecruitingCapabilities } from "../src/tools/job-scope/tools.js";
import { getRecruitingCapabilities } from "../src/resolvers/job-scope/capabilities.js";
import { generateDesktopConfig } from "../src/desktop-config.js";
import { fakeScopedReader, scopedSuccess, testRuntime } from "./test-helpers.js";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActionPlaneMount } from "../src/action-plane.js";
import type { AuthenticatedSession } from "../src/types.js";

/**
 * Lane D / P5 — the model-facing text says what the code does.
 *
 * Every assertion here is against a string the MODEL reads (a registered tool description, a
 * capabilities field, the server instructions, the desktop copy), checked against what the projector
 * and the registrar actually do.
 */

const BASE_ENV: NodeJS.ProcessEnv = {
  GREENHOUSE_RECRUITER_ALLOWED_TOOLS: RECRUITER_TOOL_DEFINITIONS.map((tool) => tool.name).join(","),
  GREENHOUSE_RECRUITER_ALLOW_TEST_SURFACE: "true",
};

function session(): AuthenticatedSession {
  return { subject: "google-subject-sam", surface: "test", client: "claude_desktop_chat", tokenId: "recruiter-token-abc123" };
}

function grantMount(names: string[]): ActionPlaneMount {
  return {
    grantedTools: createActionToolGrant(names),
    buildService: () => ({ preview: async () => ({}), apply: async () => ({}) }) as never,
  };
}

function noReadScopedReader() {
  return { async scopedRead() { throw new Error("no scoped read in a catalog test"); } };
}

async function listedToolNames(options: { env: NodeJS.ProcessEnv; actionPlane?: ActionPlaneMount }): Promise<string[]> {
  const { server } = createRecruiterMcpServer({
    session: session(),
    env: options.env,
    configureGreenhouse: false,
    scopedReader: noReadScopedReader() as never,
    ...(options.actionPlane ? { actionPlane: options.actionPlane } : {}),
  });
  const client = new Client({ name: "lane-d-catalog-check", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return (await client.listTools()).tools.map((tool) => tool.name);
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}

function capabilitiesRuntime(actionPlane?: ActionPlaneMount) {
  // The same runtime assembly the live server uses, including the allowlist and the granted-tool
  // wiring — which is exactly what the capabilities tool reads.
  return createRecruiterRuntimeForServer({
    session: session(),
    env: BASE_ENV,
    configureGreenhouse: false,
    scopedReader: noReadScopedReader() as never,
    ...(actionPlane ? { actionPlane } : {}),
  });
}

describe("lane D P5 — capabilities tells the truth about the write plane", () => {
  it("D5 keeps the read-only sentence for a no-argument call and for a session with no grant", async () => {
    const noArgument = getRecruitingCapabilities();
    assert.equal(noArgument.read_only, true, "a no-argument call must never fail open into claiming writes");
    assert.ok(
      noArgument.excluded.some((line) => /No write\/admin tools/.test(line)),
      "the read-only session's excluded list keeps the write sentence"
    );

    const withVisibleTools = getRecruitingCapabilities(new Set(["search_my_jobs"]));
    assert.equal(withVisibleTools.read_only, true);
    assert.ok(withVisibleTools.excluded.some((line) => /No write\/admin tools/.test(line)));
  });

  it("D5 names the granted write actions instead of denying they exist", async () => {
    const granted = getRecruitingCapabilities(
      new Set(["search_my_jobs"]),
      new Set(["apply_candidate_note_create"])
    );
    assert.equal(granted.read_only, false, "a session that can write is not a read-only surface");
    assert.equal(
      granted.excluded.some((line) => /No write\/admin tools/.test(line)),
      false,
      "the write sentence is false for an entitled session and must be replaced, not kept"
    );
    const writeLine = granted.excluded.find((line) => /Write actions are available to this session/.test(line));
    assert.ok(writeLine, "an entitled session must be told which write actions it holds");
    assert.match(writeLine!, /apply_candidate_note_create/);
    assert.ok(granted.model_visible_tools?.includes("apply_candidate_note_create"));
    assert.ok(granted.model_visible_tools?.includes("search_my_jobs"));
  });

  it("D5 reaches the same answer through the registered tool on an entitled runtime", async () => {
    const entitled = grantMount(["preview_candidate_note_create", "apply_candidate_note_create"]);
    const result = await runGetRecruitingCapabilities(capabilitiesRuntime(entitled), {});
    assert.equal(result.ok, true);
    const caps = result.ok ? (result.data as any) : null;
    assert.equal(caps.read_only, false);
    const writeLine = caps.excluded.find((line: string) => /Write actions are available to this session/.test(line));
    assert.ok(writeLine, "the entitled session's capabilities must name its write plane");
    assert.match(writeLine, /1 preview\/apply pair/);
    assert.match(writeLine, /preview_candidate_note_create/);
    assert.match(writeLine, /apply_candidate_note_create/);

    const readOnly = await runGetRecruitingCapabilities(capabilitiesRuntime(), {});
    const readOnlyCaps = readOnly.ok ? (readOnly.data as any) : null;
    assert.equal(readOnlyCaps.read_only, true);
    assert.ok(readOnlyCaps.excluded.some((line: string) => /No write\/admin tools/.test(line)));
  });

  it("D5 refuses a granted name the action catalog does not define", async () => {
    // A grant is only SHAPE-checked (preview_/apply_ + snake_case), so a name no ACTION_DEFINITION
    // declares used to pass straight through and be advertised as an available write tool.
    const phantom = grantMount(["preview_not_in_action_catalog", "apply_not_in_action_catalog"]);
    const result = await runGetRecruitingCapabilities(capabilitiesRuntime(phantom), {});
    assert.equal(result.ok, true);
    const caps = result.ok ? (result.data as any) : null;
    assert.equal(caps.read_only, true, "a grant outside the action catalog mounts nothing and writes nothing");
    assert.ok(caps.excluded.some((line: string) => /No write\/admin tools/.test(line)));
    assert.equal(
      caps.excluded.some((line: string) => /not_in_action_catalog/.test(line)),
      false,
      "a phantom grant must never be named as an available write action"
    );
    assert.equal(caps.model_visible_tools?.includes("apply_not_in_action_catalog"), false);
  });

  it("D5 counts complete preview/apply pairs only, and says so for a half grant", async () => {
    const definition = ACTION_DEFINITIONS[0]!;
    const applyOnly = grantMount([definition.applyTool]);
    const result = await runGetRecruitingCapabilities(capabilitiesRuntime(applyOnly), {});
    assert.equal(result.ok, true);
    const caps = result.ok ? (result.data as any) : null;
    const writeLine = caps.excluded.find((line: string) => /Write actions are available to this session/.test(line));
    assert.ok(writeLine, "the granted apply tool is real and must be disclosed");
    assert.match(writeLine, /0 preview\/apply pairs \(1 tool\)/);
    assert.match(writeLine, /cannot be completed on this session/);
    assert.equal(caps.model_visible_tools?.includes(definition.previewTool), false);
    assert.equal(caps.model_visible_tools?.includes(definition.applyTool), true);
  });

  it("D5 drops a granted action the operator denylist disables, exactly as the registrar does", async () => {
    const definition = ACTION_DEFINITIONS[0]!;
    const mount = grantMount([definition.previewTool, definition.applyTool]);
    const runtime = createRecruiterRuntimeForServer({
      session: session(),
      env: { ...BASE_ENV, GREENHOUSE_RECRUITER_DISABLE_TOOLS: definition.applyTool },
      configureGreenhouse: false,
      scopedReader: noReadScopedReader() as never,
      actionPlane: mount,
    });
    const result = await runGetRecruitingCapabilities(runtime, {});
    assert.equal(result.ok, true);
    const caps = result.ok ? (result.data as any) : null;
    const writeLine = caps.excluded.find((line: string) => /Write actions are available to this session/.test(line));
    assert.ok(writeLine, "the preview half is still mounted and still disclosed");
    assert.equal(
      writeLine.includes(definition.applyTool),
      false,
      "a disabled tool is not in the catalog and must not be announced"
    );
    assert.match(writeLine, /0 preview\/apply pairs \(1 tool\)/);

    // And what is announced equals what the server actually lists.
    const listed = await listedToolNames({
      env: { ...BASE_ENV, GREENHOUSE_RECRUITER_DISABLE_TOOLS: definition.applyTool },
      actionPlane: mount,
    });
    assert.equal(listed.includes(definition.previewTool), true);
    assert.equal(listed.includes(definition.applyTool), false);
  });

  it("D5 announces exactly the action names the registrar mounts", async () => {
    const definition = ACTION_DEFINITIONS[0]!;
    const mount = grantMount([definition.previewTool, definition.applyTool]);
    const result = await runGetRecruitingCapabilities(capabilitiesRuntime(mount), {});
    const caps = result.ok ? (result.data as any) : null;
    const announced = (caps.model_visible_tools as string[]).filter((name) => /^(preview|apply)_/.test(name)).sort();
    const listed = (await listedToolNames({ env: BASE_ENV, actionPlane: mount }))
      .filter((name) => /^(preview|apply)_/.test(name))
      .sort();
    assert.deepStrictEqual(announced, listed);
    assert.deepStrictEqual(announced, [definition.applyTool, definition.previewTool].sort());
  });

  it("D5 no longer claims offer compensation, candidate contact, private scorecards or id-only candidate reads are unavailable", () => {
    const serialized = JSON.stringify(getRecruitingCapabilities());
    assert.doesNotMatch(serialized, /Offer\/compensation signals remain unavailable on the recruiter surface/);
    assert.doesNotMatch(serialized, /No offer compensation, candidate contact, private notes, or admin\/write endpoints are exposed/);
    assert.doesNotMatch(serialized, /Private scorecards and private notes remain unavailable/);
    assert.doesNotMatch(serialized, /Candidate reads are projected to ids and scoped application references only/);
    assert.doesNotMatch(serialized, /Candidate contact, raw profiles, private notes, and write disposition tools remain unavailable/);
    // The stalled/strong recipe REQUIRES search_my_candidates, which returns contact fields.
    const stalled = getRecruitingCapabilities().recipes.find((r) => r.id === "stalled_and_strong_projected_limited");
    assert.ok(stalled);
    assert.ok(stalled.required_tools.includes("search_my_candidates"));
    assert.equal(
      stalled.safety_notes.some((note) => /does not read candidate contact/.test(note)),
      false,
      "a recipe whose required_tools include search_my_candidates cannot claim it reads no candidate contact"
    );
  });
});

describe("lane D P5 — evidence descriptions match the projector", () => {
  function description(name: string): string {
    return EVIDENCE_TOOL_DEFINITIONS.find((tool) => tool.name === name)?.description ?? "";
  }

  it("D6 says colleague emails reach site admins and operators, and the projector agrees", async () => {
    for (const name of ["search_my_users", "get_my_user"]) {
      assert.doesNotMatch(description(name), /excludes email\/contact fields/, `${name} description is false for an operator`);
      assert.match(description(name), /email addresses are returned to site admins and operators only/i, name);
    }
    const userRow = { id: 900, name: "Ops Admin", primary_email: "admin@example.com" };
    const operatorReader = fakeScopedReader((toolName) =>
      scopedSuccess(toolName, [userRow], null, { permissionScope: { kind: "operator", permittedJobCount: null } })
    );
    const result = await runEvidenceTool(testRuntime(operatorReader).runtime, "search_my_users", {});
    assert.equal(result.ok, true);
    assert.equal((result.ok ? (result.data as any[])[0] : {}).primary_email, "admin@example.com");
  });

  it("D6 says the referrer user_id passes, and the projector agrees", async () => {
    assert.doesNotMatch(description("search_my_referrers"), /the linking user_id is excluded/);
    assert.match(description("search_my_referrers"), /user_id/);
    const reader = fakeScopedReader((toolName) => scopedSuccess(toolName, [{ id: 4, name: "Ada", user_id: 77 }]));
    const result = await runEvidenceTool(testRuntime(reader).runtime, "search_my_referrers", {});
    assert.equal(result.ok, true);
    assert.equal((result.ok ? (result.data as any[])[0] : {}).user_id, 77);
  });

  it("D6 says offer compensation custom fields pass unless flagged private, and the projector agrees", async () => {
    assert.doesNotMatch(description("search_my_offers"), /compensation and custom fields are not exposed on the default profile/);
    assert.match(description("search_my_offers"), /custom fields/i);
    assert.match(description("search_my_offers"), /private/i);
    const reader = fakeScopedReader((toolName) => {
      if (toolName === "list_custom_fields") return scopedSuccess(toolName, []);
      return scopedSuccess(toolName, [{ id: 3, job_id: 100, status: "sent", custom_fields: { base_salary: "200000" } }]);
    });
    const result = await runEvidenceTool(testRuntime(reader).runtime, "search_my_offers", {});
    assert.equal(result.ok, true);
    assert.deepStrictEqual((result.ok ? (result.data as any[])[0] : {}).custom_fields, { base_salary: "200000" });
  });
});

describe("lane D P5 — the recipes parameter is generated from what the planner can run", () => {
  function registeredSchemas() {
    const reader = fakeScopedReader((toolName) => scopedSuccess(toolName, []));
    const { runtime } = testRuntime(reader);
    const schemas = new Map<string, Record<string, any>>();
    registerRecruiterTools(
      { tool(name: string, _d: string, paramsSchema: Record<string, any>) { schemas.set(name, paramsSchema); } } as any,
      runtime
    );
    return schemas;
  }

  it("D7 advertises every executable recipe id", () => {
    const description = registeredSchemas().get("answer_my_recruiting_question")?.recipes?.description ?? "";
    assert.ok(PLANNER_RECIPE_IDS.length > 0);
    for (const id of PLANNER_RECIPE_IDS) {
      assert.ok(description.includes(id), `recipes description omits the executable recipe "${id}"`);
    }
  });

  it("D7 round-trips every advertised id through the planner's alias parser", async () => {
    for (const id of PLANNER_RECIPE_IDS) {
      const reader = fakeScopedReader((toolName) => scopedSuccess(toolName, []));
      const { runtime } = testRuntime(reader);
      const result = await runRecruitingQuestionAnswer(runtime, {
        question: "How is the pipeline doing?",
        recipes: id,
      });
      assert.equal(result.ok, true, `${id} failed to run`);
      const data = result.ok ? (result.data as any) : null;
      assert.deepStrictEqual(
        data.summary.selected_recipes,
        [id],
        `the advertised id "${id}" must select that recipe, not be silently dropped`
      );
    }
  });
});

describe("lane D P5 — cursor stays, and says what it is for", () => {
  it("D8 keeps cursor on EVERY search schema with a resume-a-truncated-read description", () => {
    let checked = 0;
    for (const definition of EVIDENCE_TOOL_DEFINITIONS) {
      if (!definition.name.startsWith("search_")) continue;
      const schema = evidenceToolParamsSchema(definition.name);
      // Not `continue` — cursor is the ONLY resume path for a truncated read, so a search tool
      // missing it is the defect this locks, and skipping it would have hidden exactly that.
      assert.ok("cursor" in schema, `${definition.name} must expose cursor: it is the only resume path`);
      checked += 1;
      const described = (schema.cursor as any)?.description ?? "";
      assert.match(described, /read\.next_cursor/, `${definition.name} cursor description must name read.next_cursor`);
      assert.doesNotMatch(described, /Cursor returned from a prior paginated response\./, definition.name);
    }
    assert.ok(checked > 0, "expected at least one search schema to carry cursor");
  });

  it("D8 stops telling the model there is no cursor to follow", () => {
    assert.doesNotMatch(SERVER_INSTRUCTIONS, /there is no cursor to follow(?!\s+on a complete read)/);
    assert.match(SERVER_INSTRUCTIONS, /read\.next_cursor/);
  });
});

describe("lane D P5 — every registered tool carries a title", () => {
  async function listedTools(actionPlane?: ActionPlaneMount) {
    const { server } = createRecruiterMcpServer({
      session: session(),
      env: BASE_ENV,
      configureGreenhouse: false,
      scopedReader: noReadScopedReader() as never,
      ...(actionPlane ? { actionPlane } : {}),
    });
    const client = new Client({ name: "lane-d-title-check", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      return (await client.listTools()).tools;
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  }

  it("D9 lists a non-empty annotations.title for every tool, through a real client", async () => {
    const tools = await listedTools();
    assert.ok(tools.length > 0);
    const titles = new Set<string>();
    const annotationObjects = new Set<unknown>();
    for (const tool of tools) {
      const title = (tool.annotations as { title?: unknown } | undefined)?.title;
      assert.equal(typeof title, "string", `${tool.name} has no annotations.title`);
      assert.ok(String(title).length > 0, `${tool.name} has an empty annotations.title`);
      // A per-tool title is only a title if it is per-tool: one shared string would satisfy
      // "non-empty" for all of them.
      assert.equal(titles.has(String(title)), false, `${tool.name} reuses the title "${String(title)}"`);
      titles.add(String(title));
      // And each registration must carry its OWN annotations object — spreading a fresh one is what
      // keeps the shared frozen constant from being mutated into carrying somebody else's title.
      assert.equal(annotationObjects.has(tool.annotations), false, `${tool.name} shares an annotations object`);
      annotationObjects.add(tool.annotations);
      // The literal safety triple the container self-check and distribution validation read.
      assert.equal(tool.annotations?.readOnlyHint, true, tool.name);
      assert.equal(tool.annotations?.destructiveHint, false, tool.name);
      assert.equal(tool.annotations?.idempotentHint, true, tool.name);
      // openWorldHint is TRUE here, deliberately: these tools reach a live external system whose
      // contents change between calls. Asserting the literal keeps a silent flip visible.
      assert.equal(tool.annotations?.openWorldHint, true, tool.name);
    }
    const jobs = tools.find((tool) => tool.name === "search_my_jobs");
    assert.equal((jobs?.annotations as { title?: string } | undefined)?.title, "Search my jobs");
  });

  it("D9 gives each action tool the title its own definition declares", async () => {
    const definition = ACTION_DEFINITIONS[0]!;
    const tools = await listedTools(grantMount([definition.previewTool, definition.applyTool]));
    const preview = tools.find((tool) => tool.name === definition.previewTool);
    const apply = tools.find((tool) => tool.name === definition.applyTool);
    assert.ok(preview && apply, "the entitled catalog must carry the granted pair");
    assert.equal((preview!.annotations as { title?: string }).title, definition.previewTitle);
    assert.equal((apply!.annotations as { title?: string }).title, definition.applyTitle);
    assert.equal(apply!.annotations?.destructiveHint, true, "apply stays honestly destructive");
  });
});

describe("lane D P5 — desktop copy stops promising read-only", () => {
  it("D10 says write actions appear only for entitled sessions in the packaged extension too", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "lane-d-mcpb-"));
    const sessionPath = join(tmp, "session.json");
    const outputDir = join(tmp, "out");
    const claims = {
      subject: "email:recruiter@example.com",
      email: "recruiter@example.com",
      surface: "claude_desktop",
      client: "claude_desktop_chat",
      tokenId: "lane-d-mcpb-token",
      issuedAt: "2026-06-23T00:00:00.000Z",
    };
    const token = `${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${"signature".repeat(5)}`;
    await writeFile(sessionPath, `${JSON.stringify({ ...claims, token })}\n`, { mode: 0o600 });

    const report = await buildClaudeMcpb({
      issuedSessionFile: sessionPath,
      mcpUrl: "https://greenhouse-recruiter.example.com/mcp",
      outputDir,
    });
    const artifactPath = join(outputDir, report.artifactPath);
    // The extension manifest lives INSIDE the .mcpb; outputDir/manifest.json is the build report.
    const packedManifest = spawnSync("unzip", ["-p", artifactPath, "manifest.json"], { encoding: "utf8" });
    assert.equal(packedManifest.status, 0);
    const manifest = JSON.parse(packedManifest.stdout);
    assert.match(manifest.description, /write actions appear only for entitled sessions/i);
    assert.equal(
      (manifest.keywords as string[]).includes("read-only"),
      false,
      "the packaged extension advertised itself as read-only while the write plane shipped in it"
    );
    const readme = spawnSync("unzip", ["-p", artifactPath, "README.md"], { encoding: "utf8" });
    assert.equal(readme.status, 0);
    assert.doesNotMatch(readme.stdout, /Private read-only Claude Desktop bridge/);
    assert.match(readme.stdout, /write actions appear only for entitled sessions/i);
  });

  it("D10 says write actions appear only for entitled sessions", () => {
    const report = generateDesktopConfig({
      surface: "chatgpt_desktop",
      mcpUrl: "https://greenhouse-recruiter.example.com/mcp",
      token: "durable-user-token",
    });
    const serialized = JSON.stringify(report.config);
    assert.doesNotMatch(serialized, /Recruiter-scoped Greenhouse read and analysis tools\./);
    assert.match(serialized, /write actions appear only for entitled sessions/i);
  });
});

describe("lane D P5 — both v3 date-filter encodings survive URL serialization", () => {
  it("D11 carries `created_at=gte|…` and `interviewed_at[gte]=…` to the wire unchanged", () => {
    // Harvest v3 documents BOTH forms (`created_at=gte|2024-01-01T00:00:00Z`), and the client
    // serializes params with the same `URLSearchParams.set(key, String(value))` loop for either one
    // (control-plane/src/client-readonly.ts, buildUrlForAdapter). This locks that neither the pipe
    // nor the brackets are rewritten on the way out — the reason the OLD created_at floor was a real,
    // honoured, row-dropping filter rather than an inert string.
    const params: Record<string, string> = {
      created_at: "gte|2026-05-24T12:00:00.000Z",
      "interviewed_at[gte]": "2026-05-24T12:00:00.000Z",
      "interviewed_at[lte]": "2026-06-23T12:00:00.000Z",
    };
    const url = new URL("https://harvest.greenhouse.io/v3/scorecards");
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));

    assert.match(url.toString(), /created_at=gte%7C2026-05-24T12%3A00%3A00.000Z/);
    assert.match(url.toString(), /interviewed_at%5Bgte%5D=2026-05-24T12%3A00%3A00.000Z/);
    const roundTripped = new URL(url.toString()).searchParams;
    assert.equal(roundTripped.get("created_at"), "gte|2026-05-24T12:00:00.000Z");
    assert.equal(roundTripped.get("interviewed_at[gte]"), "2026-05-24T12:00:00.000Z");
    assert.equal(roundTripped.get("interviewed_at[lte]"), "2026-06-23T12:00:00.000Z");
  });
});
