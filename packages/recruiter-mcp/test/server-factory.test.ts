import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createMemoryAuditSink } from "../src/audit.js";
import { createRecruiterMcpServer, createRecruiterRuntimeForServer, readTrustedActAsUserFromEnv } from "../src/server.js";
import { runEvidenceTool } from "../src/tools/evidence.js";
import { PILOT_TOOL_NAMES, RECRUITER_TOOL_DEFINITIONS } from "../src/tools/register.js";
import { fakeScopedReader, scopedSuccess, testSession } from "./test-helpers.js";

describe("recruiter MCP server factory", () => {
  it("builds a server with only recruiter-scoped tools using an injected scoped reader", () => {
    const scopedReader = fakeScopedReader((toolName) => scopedSuccess(toolName, []));
    const bundle = createRecruiterMcpServer({
      session: testSession(),
      scopedReader,
      auditSink: createMemoryAuditSink(),
      configureGreenhouse: false,
      env: {},
    });

    assert.ok(bundle.server);
    // R2a: every registered read tool mounts, in PILOT_TOOL_NAMES order — there is no curated head
    // and withheld tail any more, so this is one equality rather than two slices.
    assert.deepStrictEqual(bundle.registeredTools, [...PILOT_TOOL_NAMES]);
    assert.equal(bundle.registeredTools.length, RECRUITER_TOOL_DEFINITIONS.length);
    assert.equal(new Set(bundle.registeredTools).size, RECRUITER_TOOL_DEFINITIONS.length);
  });

  it("applies surface kill switches during registration", () => {
    const scopedReader = fakeScopedReader((toolName) => scopedSuccess(toolName, []));
    const bundle = createRecruiterMcpServer({
      session: testSession({ surface: "chatgpt_desktop" }),
      scopedReader,
      auditSink: createMemoryAuditSink(),
      configureGreenhouse: false,
      env: {
        GREENHOUSE_RECRUITER_DISABLE_CHATGPT_DESKTOP: "true",
      },
    });

    assert.deepStrictEqual(bundle.registeredTools, []);
  });

  it("passes the owning HTTP request signal into the per-request runtime", () => {
    const controller = new AbortController();
    const runtime = createRecruiterRuntimeForServer({
      session: testSession(),
      scopedReader: fakeScopedReader((toolName) => scopedSuccess(toolName, [])),
      auditSink: createMemoryAuditSink(),
      configureGreenhouse: false,
      env: {},
      signal: controller.signal,
    });

    assert.equal(runtime.signal, controller.signal);
  });

  it("keeps local server creation on console audit when retained audit is not configured", async () => {
    const originalError = console.error;
    const calls: string[] = [];
    console.error = (message?: unknown) => {
      calls.push(String(message));
    };
    try {
      const scopedReader = fakeScopedReader((toolName) => scopedSuccess(toolName, [{ id: 1, job_id: 10 }]));
      const runtime = createRecruiterRuntimeForServer({
        session: testSession(),
        scopedReader,
        configureGreenhouse: false,
        env: {},
      });

      const result = await runEvidenceTool(runtime, "search_my_jobs", {});

      assert.equal(result.ok, true);
      assert.equal(calls.length, 2, "audit v2 emits correlated start and terminal events");
      assert.ok(calls.every((call) => /search_my_jobs/.test(call)));
    } finally {
      console.error = originalError;
    }
  });

  it("parses trusted operator preview target from server-side env only", () => {
    assert.equal(readTrustedActAsUserFromEnv({} as NodeJS.ProcessEnv), undefined);
    assert.equal(readTrustedActAsUserFromEnv({ GREENHOUSE_RECRUITER_TRUSTED_ACT_AS_USER_ID: "321" } as NodeJS.ProcessEnv), 321);
    assert.throws(
      () => readTrustedActAsUserFromEnv({ GREENHOUSE_RECRUITER_TRUSTED_ACT_AS_USER_ID: " 321 " } as NodeJS.ProcessEnv),
      /must not contain leading or trailing whitespace/
    );
    assert.throws(
      () => readTrustedActAsUserFromEnv({ GREENHOUSE_RECRUITER_TRUSTED_ACT_AS_USER_ID: "0" } as NodeJS.ProcessEnv),
      /positive integer/
    );
    assert.throws(
      () => readTrustedActAsUserFromEnv({ GREENHOUSE_RECRUITER_TRUSTED_ACT_AS_USER_ID: "321.5" } as NodeJS.ProcessEnv),
      /positive integer/
    );
  });

  it("rejects invalid programmatic trusted operator preview targets", () => {
    const scopedReader = fakeScopedReader((toolName) => scopedSuccess(toolName, []));
    assert.throws(
      () => createRecruiterRuntimeForServer({
        session: testSession(),
        scopedReader,
        auditSink: createMemoryAuditSink(),
        configureGreenhouse: false,
        env: {},
        trustedActAsUser: 0,
      }),
      /trustedActAsUser must be a safe positive integer Greenhouse user id/
    );
  });

  it("injects trusted operator preview into scopedRead options without trusting tool params", async () => {
    const scopedReader = fakeScopedReader((toolName) => scopedSuccess(toolName, []));
    const runtime = createRecruiterRuntimeForServer({
      session: testSession(),
      scopedReader,
      auditSink: createMemoryAuditSink(),
      configureGreenhouse: false,
      env: { GREENHOUSE_RECRUITER_TRUSTED_ACT_AS_USER_ID: "321" },
    });

    await runEvidenceTool(runtime, "search_my_applications", {
      actAsUser: 999,
      on_behalf_of_user_id: 888,
    });

    assert.equal(scopedReader.calls[0]!.options?.actAsUser, 321);
    assert.ok(scopedReader.calls[0]!.options?.signal instanceof AbortSignal);
    assert.equal(scopedReader.calls[0]!.params?.actAsUser, undefined);
    assert.equal(scopedReader.calls[0]!.params?.on_behalf_of_user_id, undefined);
  });
});
