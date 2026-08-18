import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ActionDeniedError } from "../src/errors.js";
import { createGreenhouseActionMcpServer } from "../src/server.js";
import type { GreenhouseActionService } from "../src/service.js";
import type { ActionKind } from "../src/types.js";
import { testSession } from "./helpers.js";

// Intentionally independent of ACTION_DEFINITIONS: deleting a production
// definition must make this expected catalog fail instead of shrinking both sides.
const EXPECTED: ReadonlyArray<readonly [ActionKind, string, string]> = [
  ["application_assignment_change", "preview_application_assignment_change", "apply_application_assignment_change"],
  ["job_owner_change", "preview_job_owner_change", "apply_job_owner_change"],
  ["application_stage_move", "preview_application_stage_move", "apply_application_stage_move"],
  ["application_rejection", "preview_application_rejection", "apply_application_rejection"],
  ["application_unreject", "preview_application_unreject", "apply_application_unreject"],
  ["candidate_note_create", "preview_candidate_note_create", "apply_candidate_note_create"],
  ["job_note_change", "preview_job_note_change", "apply_job_note_change"],
  ["application_attribution_change", "preview_application_attribution_change", "apply_application_attribution_change"],
  ["candidate_record_update", "preview_candidate_record_update", "apply_candidate_record_update"],
  ["offer_create", "preview_offer_create", "apply_offer_create"],
  ["offer_update", "preview_offer_update", "apply_offer_update"],
];

const PREVIEW_FIELDS: Record<string, string[]> = {
  preview_application_assignment_change: ["application_id", "assignment_role", "proposed_user_id"],
  preview_job_owner_change: ["job_id", "owner_type", "user_id", "verb"],
  preview_application_stage_move: ["application_id", "to_stage_id"],
  preview_application_rejection: ["application_id", "notes", "rejection_reason_id"],
  preview_application_unreject: ["application_id"],
  preview_candidate_note_create: ["application_id", "body", "note_type", "visibility"],
  preview_job_note_change: ["body", "job_id", "note_id", "verb", "visibility"],
  preview_application_attribution_change: ["application_id", "referrer_id", "source_id"],
  preview_candidate_record_update: ["changes", "context_application_id"],
  preview_offer_create: ["application_id", "custom_fields", "starts_on"],
  preview_offer_update: ["application_id", "custom_fields", "offer_id", "starts_on"],
};

const service = {
  async preview(kind: ActionKind) { return { kind, status: "ready" }; },
  async apply(kind: ActionKind) { return { kind, state: "succeeded" }; },
} as unknown as GreenhouseActionService;

describe("MCP contract", () => {
  test("exposes exactly the independently enumerated 22-tool catalog", async () => {
    const bundle = createGreenhouseActionMcpServer({
      session: testSession(),
      service,
      capabilities: new Set(EXPECTED.map(([kind]) => kind)),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" });
    try {
      await bundle.server.connect(serverTransport);
      await client.connect(clientTransport);
      const tools = (await client.listTools()).tools;
      assert.deepEqual(tools.map((tool) => tool.name), EXPECTED.flatMap(([, preview, apply]) => [preview, apply]));
      assert.equal(new Set(tools.map((tool) => tool.name)).size, 22);
      for (let index = 0; index < tools.length; index += 2) {
        const preview = tools[index]!;
        const apply = tools[index + 1]!;
        assert.deepEqual(preview.annotations, {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        });
        assert.deepEqual(apply.annotations, {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: true,
        });
        assert.deepEqual(Object.keys(preview.inputSchema.properties ?? {}).sort(), PREVIEW_FIELDS[preview.name]);
        assert.deepEqual(Object.keys(apply.inputSchema.properties ?? {}).sort(),
          apply.name === "apply_application_assignment_change"
            ? ["application_id", "approval", "assignment_role", "current_user_id", "intent", "job_id", "proposed_user_id"]
            : ["approval", "intent"]);
        assert.equal(preview.inputSchema.additionalProperties, false);
        assert.equal(apply.inputSchema.additionalProperties, false);
      }
    } finally {
      await client.close().catch(() => undefined);
      await bundle.server.close().catch(() => undefined);
    }
  });

  test("catalog capability filtering removes both halves of an action pair", async () => {
    const bundle = createGreenhouseActionMcpServer({
      session: testSession(),
      service,
      capabilities: new Set<ActionKind>(["offer_update"]),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" });
    try {
      await bundle.server.connect(serverTransport);
      await client.connect(clientTransport);
      assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), ["preview_offer_update", "apply_offer_update"]);
    } finally {
      await client.close().catch(() => undefined);
      await bundle.server.close().catch(() => undefined);
    }
  });

  test("returns a correlation id and emits a redacted diagnostic for tool failures", async () => {
    const failingService = {
      async preview() { throw new Error("candidate_email=casey.secret@example.com"); },
    } as unknown as GreenhouseActionService;
    const bundle = createGreenhouseActionMcpServer({
      session: testSession(),
      service: failingService,
      capabilities: new Set<ActionKind>(["application_unreject"]),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" });
    const diagnostics: string[] = [];
    const originalConsoleError = console.error;
    console.error = (...values: unknown[]) => { diagnostics.push(values.map(String).join(" ")); };
    try {
      await bundle.server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({
        name: "preview_application_unreject",
        arguments: { application_id: 100 },
      });
      assert.equal(result.isError, true);
      assert.ok(Array.isArray(result.content));
      const content = result.content[0] as { type?: unknown; text?: unknown } | undefined;
      assert.equal(content?.type, "text");
      const text = content?.text;
      if (typeof text !== "string") assert.fail("tool result did not contain text");
      const payload = JSON.parse(text) as {
        error: { code: string; correlation_id: string };
      };
      const diagnostic = JSON.parse(diagnostics[0]!) as {
        event: string; tool: string; code: string; correlation_id: string;
      };
      assert.equal(payload.error.code, "ACTION_SERVICE_UNAVAILABLE");
      assert.equal(diagnostic.event, "tool_failed");
      assert.equal(diagnostic.tool, "preview_application_unreject");
      assert.equal(diagnostic.code, payload.error.code);
      assert.equal(diagnostic.correlation_id, payload.error.correlation_id);
      assert.equal(diagnostics.join("\n").includes("application_id"), false);
      assert.equal(diagnostics.join("\n").includes("casey.secret@example.com"), false);
    } finally {
      console.error = originalConsoleError;
      await client.close().catch(() => undefined);
      await bundle.server.close().catch(() => undefined);
    }
  });

  test("does not log or correlate expected policy denials", async () => {
    const deniedService = {
      async preview() { throw new ActionDeniedError("WRITES_DISABLED", "Greenhouse action writes are disabled."); },
    } as unknown as GreenhouseActionService;
    const bundle = createGreenhouseActionMcpServer({
      session: testSession(),
      service: deniedService,
      capabilities: new Set<ActionKind>(["application_unreject"]),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" });
    const diagnostics: string[] = [];
    const originalConsoleError = console.error;
    console.error = (...values: unknown[]) => { diagnostics.push(values.map(String).join(" ")); };
    try {
      await bundle.server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({
        name: "preview_application_unreject",
        arguments: { application_id: 100 },
      });
      assert.ok(Array.isArray(result.content));
      const content = result.content[0] as { text?: unknown } | undefined;
      if (typeof content?.text !== "string") assert.fail("tool result did not contain text");
      assert.deepEqual(JSON.parse(content.text), {
        error: { code: "WRITES_DISABLED", message: "Greenhouse action writes are disabled." },
      });
      assert.deepEqual(diagnostics, []);
    } finally {
      console.error = originalConsoleError;
      await client.close().catch(() => undefined);
      await bundle.server.close().catch(() => undefined);
    }
  });

  test("preserves safe upstream metadata on operational denials", async () => {
    const deniedService = {
      async preview() {
        throw new ActionDeniedError("UPSTREAM_UNAVAILABLE", "Required Greenhouse state is unavailable.", {
          sourceErrorName: "GreenhouseError",
          upstreamStatus: 403,
          upstreamRequestId: "gh-request-123",
        });
      },
    } as unknown as GreenhouseActionService;
    const bundle = createGreenhouseActionMcpServer({
      session: testSession(),
      service: deniedService,
      capabilities: new Set<ActionKind>(["application_unreject"]),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" });
    const diagnostics: string[] = [];
    const originalConsoleError = console.error;
    console.error = (...values: unknown[]) => { diagnostics.push(values.map(String).join(" ")); };
    try {
      await bundle.server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({
        name: "preview_application_unreject",
        arguments: { application_id: 100 },
      });
      assert.ok(Array.isArray(result.content));
      const content = result.content[0] as { text?: unknown } | undefined;
      if (typeof content?.text !== "string") assert.fail("tool result did not contain text");
      const payload = JSON.parse(content.text) as {
        error: { upstream_status: number; upstream_request_id: string; correlation_id: string };
      };
      const diagnostic = JSON.parse(diagnostics[0]!) as {
        source_error_name: string; upstream_status: number; upstream_request_id: string; correlation_id: string;
      };
      assert.equal(payload.error.upstream_status, 403);
      assert.equal(payload.error.upstream_request_id, "gh-request-123");
      assert.equal(diagnostic.source_error_name, "GreenhouseError");
      assert.equal(diagnostic.upstream_status, 403);
      assert.equal(diagnostic.upstream_request_id, "gh-request-123");
      assert.equal(diagnostic.correlation_id, payload.error.correlation_id);
    } finally {
      console.error = originalConsoleError;
      await client.close().catch(() => undefined);
      await bundle.server.close().catch(() => undefined);
    }
  });
});
