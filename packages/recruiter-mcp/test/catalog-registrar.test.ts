import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createRecruiterMcpServer } from "../src/server.js";
import { PILOT_TOOL_NAMES, RECRUITER_TOOL_DEFINITIONS } from "../src/tools/register.js";
import { createRecruiterToolConfig } from "../src/limits.js";
import {
  HARVEST_V3_EVIDENCE_TOOL_ENDPOINTS,
  getHiddenModelParametersForEndpoint,
  getModelExposedParametersForEndpoint,
} from "../src/harvest-v3-registry.js";
import { projectEvidenceResult } from "../src/tools/evidence-projection.js";
import { getEvidenceEndpointAdapter } from "../src/tools/scoped-endpoint-adapters.js";
import { READ_MY_RESUME_TOOL, runReadMyResume } from "../src/tools/resume.js";
import { fakeScopedReader, scopedSuccess, testRuntime } from "./test-helpers.js";
import type { AuthenticatedSession } from "../src/types.js";

/**
 * R2a — the registrar IS the catalog.
 *
 * The 22 readers this repo built, tested and then hid were hidden by ONE mechanism: a hand-maintained
 * `GREENHOUSE_RECRUITER_ALLOWED_TOOLS` env allowlist that stated a count and no reason. These tests
 * lock the replacement property: every read tool the registrar defines is mounted, and the only way
 * to remove one is the denylist, which forces whoever removes it to name it.
 */

function session(): AuthenticatedSession {
  return { subject: "google-subject-sam", surface: "test", client: "claude_desktop_chat", tokenId: "recruiter-token-abc123" };
}

function noReadScopedReader() {
  return { async scopedRead() { throw new Error("no scoped read in a catalog test"); } };
}

async function listedToolNames(env: NodeJS.ProcessEnv): Promise<string[]> {
  const { server } = createRecruiterMcpServer({
    session: session(),
    env,
    configureGreenhouse: false,
    scopedReader: noReadScopedReader() as never,
  });
  const client = new Client({ name: "r2a-catalog-check", version: "1" });
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

describe("R2a the registrar is the catalog", () => {
  it("hides no registered read tool: PILOT_TOOL_NAMES is the full read catalog", () => {
    assert.equal(
      PILOT_TOOL_NAMES.length,
      RECRUITER_TOOL_DEFINITIONS.length,
      "PILOT_TOOL_NAMES is the ORDER of the full read catalog, not a curated subset"
    );
    const defined = new Set(RECRUITER_TOOL_DEFINITIONS.map((tool) => tool.name));
    const ordered = new Set<string>(PILOT_TOOL_NAMES);
    assert.deepEqual(
      [...defined].filter((name) => !ordered.has(name)).sort(),
      [],
      "every registered read tool must appear in the order list"
    );
    assert.deepEqual(
      [...ordered].filter((name) => !defined.has(name)).sort(),
      [],
      "the order list must not name a tool no definition backs"
    );
  });

  it("mounts every registered read definition through a real MCP server with no allowlist env", async () => {
    const listed = await listedToolNames({ GREENHOUSE_RECRUITER_ALLOW_TEST_SURFACE: "true" });
    assert.deepEqual(
      [...listed].sort(),
      RECRUITER_TOOL_DEFINITIONS.map((tool) => tool.name).sort(),
      "tools/list must carry exactly the registered read definitions"
    );
    assert.deepEqual(listed, [...PILOT_TOOL_NAMES], "the mounted order is PILOT_TOOL_NAMES");
  });

  it("no longer honours a tool allowlist: the env var is not a mechanism", async () => {
    // The allowlist was the mechanism that hid the 22 readers. It is deleted, so setting it changes
    // nothing — a reader is removed only by the denylist, which forces a named reason.
    const listed = await listedToolNames({
      GREENHOUSE_RECRUITER_ALLOW_TEST_SURFACE: "true",
      GREENHOUSE_RECRUITER_ALLOWED_TOOLS: "search_my_jobs",
    });
    assert.equal(listed.length, RECRUITER_TOOL_DEFINITIONS.length);
    const config = createRecruiterToolConfig({ GREENHOUSE_RECRUITER_ALLOWED_TOOLS: "search_my_jobs" });
    assert.equal(
      "allowedTools" in config,
      false,
      "RecruiterToolConfig must not carry an allowlist field for a caller to fail open on"
    );
  });

  it("an unknown name in the allowlist env no longer throws, because there is no allowlist", () => {
    assert.doesNotThrow(() =>
      createRecruiterToolConfig({ GREENHOUSE_RECRUITER_ALLOWED_TOOLS: "search_my_jobs,unknown_tool" })
    );
  });

  it("the denylist still removes a reader, and it is the only thing that does", async () => {
    const listed = await listedToolNames({
      GREENHOUSE_RECRUITER_ALLOW_TEST_SURFACE: "true",
      GREENHOUSE_RECRUITER_DISABLE_TOOLS: "search_my_job_boards",
    });
    assert.equal(listed.includes("search_my_job_boards"), false);
    assert.equal(listed.length, RECRUITER_TOOL_DEFINITIONS.length - 1);
  });
});

describe("R2a the parameters and fields a stated reason no longer covers", () => {
  it("exposes users.primary_email and users.show_service_accounts as filters", () => {
    const exposed = new Set(getModelExposedParametersForEndpoint("/v3/users").map((param) => param.name));
    // Filtering by an address you already hold discloses nothing — the PROJECTION is what enforces
    // the teammate-email rule, and it is unchanged (site admins/operators only).
    assert.equal(exposed.has("primary_email"), true);
    // A recruiter counting interviewer load needs service accounts OUT of the denominator, which
    // means being able to ask for them.
    assert.equal(exposed.has("show_service_accounts"), true);
  });

  it("exposes the tracking_links.token filter and returns the slug", () => {
    const exposed = new Set(getModelExposedParametersForEndpoint("/v3/tracking_links").map((param) => param.name));
    assert.equal(exposed.has("token"), true);
    const projected = projectEvidenceResult(
      {
        ok: true,
        toolName: "search_my_tracking_links",
        scoped: true,
        nextCursor: null,
        data: [{ id: 7, job_id: 10, token: "abc123xyz", source_id: 3 }],
      } as never,
      getEvidenceEndpointAdapter("search_my_tracking_links")
    );
    const rows = (projected.ok ? projected.data : []) as Array<Record<string, unknown>>;
    assert.equal(rows[0]?.token, "abc123xyz", "the public attribution slug is the whole point of the row");
  });

  it("returns the interview join link the recruiter coordinates", () => {
    const projected = projectEvidenceResult(
      {
        ok: true,
        toolName: "search_my_interviews",
        scoped: true,
        nextCursor: null,
        data: [{ id: 1, job_id: 10, application_id: 5, video_conferencing_url: "https://meet.example.com/abc" }],
      } as never,
      getEvidenceEndpointAdapter("search_my_interviews")
    );
    const rows = (projected.ok ? projected.data : []) as Array<Record<string, unknown>>;
    assert.equal(rows[0]?.video_conferencing_url, "https://meet.example.com/abc");
  });

  it("keeps the three params an external constraint still covers hidden, each with that reason", () => {
    const candidateHidden = new Map(
      getHiddenModelParametersForEndpoint("/v3/candidates").map((param) => [param.name, param.reason])
    );
    const offerHidden = new Map(
      getHiddenModelParametersForEndpoint("/v3/offers").map((param) => [param.name, param.reason])
    );
    assert.match(candidateHidden.get("private") ?? "", /private-candidate permission/i);
    assert.match(candidateHidden.get("custom_field_option_id") ?? "", /private custom-field permission/i);
    assert.match(offerHidden.get("custom_field_option_id") ?? "", /private custom-field permission/i);
  });

  it("hides no filter without a reason that names an external constraint", () => {
    for (const [toolName, endpointPath] of HARVEST_V3_EVIDENCE_TOOL_ENDPOINTS) {
      if (!toolName.startsWith("search_")) continue;
      for (const hidden of getHiddenModelParametersForEndpoint(endpointPath)) {
        assert.match(
          hidden.reason,
          /permission|422|projection profiles/i,
          `${endpointPath}.${hidden.name} is hidden for a reason that cites no external constraint: ${hidden.reason}`
        );
      }
    }
  });
});

describe("R2a read_my_resume reads any attachment the actor may see", () => {
  function attachmentRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 42,
      application_id: 7,
      candidate_id: 3,
      filename: "offer-letter.txt",
      type: "offer_letter",
      url: "https://files.example.com/offer-letter.txt?sig=abc",
      updated_at: "2026-01-01T00:00:00.000Z",
      ...overrides,
    };
  }

  // Two representative types, not four: each call spawns the isolated parser subprocess, and the
  // property (the type field is not consulted) is proven by any non-"resume" value.
  it("reads a cover letter and an offer letter, not only type=resume", async (context) => {
    for (const type of ["cover_letter", "offer_letter"]) {
      await context.test(type, async () => {
        const reader = fakeScopedReader((toolName) => scopedSuccess(toolName, [attachmentRow({ type })]));
        const { runtime } = testRuntime(reader);
        const result = await runReadMyResume(runtime, { attachment_id: 42 }, {
          fetchImpl: (async () =>
            new Response("Dear candidate, we are pleased to extend an offer.", {
              status: 200,
              headers: { "content-type": "text/plain" },
            })) as unknown as typeof fetch,
        });
        assert.equal(result.ok, true, `${type} must be readable`);
        const data = result.ok ? (result.data as Record<string, unknown>) : {};
        assert.match(String(data.text), /pleased to extend an offer/);
      });
    }
  });

  it("still refuses an attachment the scoped reader did not return", async () => {
    const reader = fakeScopedReader((toolName) => scopedSuccess(toolName, [attachmentRow({ id: 99 })]));
    const { runtime } = testRuntime(reader);
    let fetches = 0;
    const result = await runReadMyResume(runtime, { attachment_id: 42 }, {
      fetchImpl: (async () => { fetches += 1; return new Response("no"); }) as unknown as typeof fetch,
    });
    assert.equal(result.ok, false);
    assert.equal(fetches, 0, "an unpermitted attachment is never downloaded");
  });

  it("keeps signed URLs out of the listing surface", () => {
    const projected = projectEvidenceResult(
      {
        ok: true,
        toolName: "search_my_attachments",
        scoped: true,
        nextCursor: null,
        data: [attachmentRow()],
      } as never,
      getEvidenceEndpointAdapter("search_my_attachments")
    );
    const rows = (projected.ok ? projected.data : []) as Array<Record<string, unknown>>;
    assert.equal(rows[0]?.url, undefined, "the expiring signed capability stays server-side");
    assert.equal(rows[0]?.type, "offer_letter");
  });

  it("describes itself as reading an attachment, and names the non-resume kinds", () => {
    assert.match(READ_MY_RESUME_TOOL.description, /attachment/i);
    assert.match(READ_MY_RESUME_TOOL.description, /cover letter/i);
    assert.match(READ_MY_RESUME_TOOL.description, /offer letter/i);
    assert.equal(
      /among resume versions/i.test(READ_MY_RESUME_TOOL.description),
      false,
      "the description must not still promise resumes only"
    );
  });
});
