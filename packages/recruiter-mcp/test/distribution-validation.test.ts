import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import http from "node:http";
import { createSignedSessionToken } from "../src/auth.js";
import {
  parseMcpResponsePayload,
  runRemoteDistributionValidation,
  runRemoteDistributionValidationFromEnv,
  validateRemoteToolAnnotations,
  validateRemoteToolCatalog,
} from "../src/distribution-validation.js";
import { startHttpRecruiterMcp } from "../src/http-server.js";
import { REQUIRED_DISTRIBUTION_CHECKS } from "../src/rollout-gate.js";
import { PILOT_TOOL_NAMES, RECRUITER_TOOL_DEFINITIONS } from "../src/tools/register.js";
import { RECRUITER_MCP_READINESS_CHECK_NAMES } from "../src/readiness.js";

const STRONG_SESSION_SECRET = "session-secret-value-with-at-least-32-chars";
const STRONG_SCOPE_SIGNING_SECRET = "scope-signing-secret-value-at-least-32-chars";
const READYZ_TOKEN = "readiness-token-value-with-at-least-32-chars";
const EXPECTED_COMMIT = "151dbc3fa5a9099875604bc96dd6882a9f7fcf97";
const PASSING_READINESS_CHECKS = RECRUITER_MCP_READINESS_CHECK_NAMES.map((name) => ({
  name,
  status: "pass",
  summary: `${name} passed`,
}));
const EXPECTED_HIDDEN_TOOL_NAMES = [
  "search_my_approvers",
  "search_my_approver_groups",
  "search_my_scorecard_questions",
  "search_my_scorecard_question_options",
  "search_my_scorecard_question_answer_options",
  "search_my_default_interviewers",
  "search_my_job_post_locations",
  "search_my_pay_input_ranges",
  "search_my_prospect_pools",
  "search_my_prospect_pool_stages",
  "search_my_interviewer_tags",
  "search_my_candidate_tags",
  "search_my_job_boards",
  "search_my_custom_field_departments",
  "search_my_custom_field_offices",
  "search_my_job_interviews",
  "search_my_job_notes",
  "search_my_tracking_links",
  "search_my_approval_flows",
  "search_my_interview_kits",
  "search_my_prospect_details",
  "search_my_pay_inputs",
].sort();

describe("remote distribution validation", () => {
  it("keeps exactly 44 model-facing tools and the approved 22-tool hidden complement", () => {
    const visible = new Set<string>(PILOT_TOOL_NAMES);
    const hidden = RECRUITER_TOOL_DEFINITIONS.map((tool) => tool.name).filter((name) => !visible.has(name)).sort();

    assert.equal(RECRUITER_TOOL_DEFINITIONS.length, 66);
    assert.equal(PILOT_TOOL_NAMES.length, 44);
    assert.equal(new Set(PILOT_TOOL_NAMES).size, 44);
    assert.deepEqual(hidden, EXPECTED_HIDDEN_TOOL_NAMES);
  });

  it("validates the hosted MCP protocol path and recruiter-only tool catalog", async () => {
    const token = createSignedSessionToken({
      subject: "email:recruiter@example.com",
      email: "recruiter@example.com",
      surface: "chatgpt_desktop",
      client: "chatgpt_codex_host",
      tokenId: "distribution-validation-token",
      issuedAt: "2026-06-23T00:00:00.000Z",
    }, STRONG_SESSION_SECRET);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === "exampleprojectref000.supabase.co" && url.pathname === "/rest/v1/recruiter_mcp_session_revocation") {
        return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
      }
      return originalFetch(input, init);
    }) as typeof fetch;
    const server = await startHttpRecruiterMcp({
      GREENHOUSE_RECRUITER_MCP_PORT: "0",
      GREENHOUSE_CLIENT_ID: "client-id-value",
      GREENHOUSE_CLIENT_SECRET: "client-secret-value",
      GREENHOUSE_RECRUITER_STATE_BACKEND: "supabase_postgrest",
      GREENHOUSE_RECRUITER_SESSION_SECRET: STRONG_SESSION_SECRET,
      GREENHOUSE_RECRUITER_SCOPE_SIGNING_SECRET: STRONG_SCOPE_SIGNING_SECRET,
      GREENHOUSE_RECRUITER_READYZ_TOKEN: READYZ_TOKEN,
      GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_URL: "https://exampleprojectref000.supabase.co",
      GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_KEY: "service-role-key-value",
      GREENHOUSE_RECRUITER_REVOCATION_SUPABASE_URL: "https://exampleprojectref000.supabase.co",
      GREENHOUSE_RECRUITER_REVOCATION_SUPABASE_KEY: "revocation-key-value",
      GREENHOUSE_RECRUITER_AUDIT_JSONL_PATH: "/tmp/greenhouse-recruiter-distribution-validation-audit.jsonl",
      GREENHOUSE_RECRUITER_AUDIT_DURABLE_MOUNT_PATH: "/tmp",
      GREENHOUSE_RECRUITER_CORS_ORIGIN: "https://chatgpt.com,https://claude.ai",
      GREENHOUSE_RECRUITER_ALLOWED_TOOLS: PILOT_TOOL_NAMES.join(","),
      GREENHOUSE_RECRUITER_BUILD_SHA: EXPECTED_COMMIT,
    } as NodeJS.ProcessEnv);
    try {
      const base = baseUrl(server);
      const report = await runRemoteDistributionValidation({
        mcpUrl: `${base}/mcp`,
        healthUrl: `${base}/healthz`,
        readinessUrl: `${base}/readyz`,
        readinessToken: READYZ_TOKEN,
        expectedCommit: EXPECTED_COMMIT,
        token,
        now: () => new Date("2026-06-23T00:00:00.000Z"),
      });

      assert.equal(report.ok, true, JSON.stringify(report.checks));
      assert.equal(report.status, "ready");
      assert.equal(report.sessionSurface, "chatgpt_desktop");
      assert.equal(report.sessionClient, "chatgpt_codex_host");
      assert.equal(report.sessionTokenId, "distribution-validation-token");
      assert.equal(report.sessionIssuedAt, "2026-06-23T00:00:00.000Z");
      assert.deepEqual(report.checks.map((check) => check.status), report.checks.map(() => "pass"));
      assert.ok(report.toolNames.includes("analyze_scorecard_accountability"));
      assert.ok(report.toolNames.includes("analyze_interview_feedback_drag"));
      assert.ok(report.toolNames.includes("analyze_stage_latency"));
      assert.ok(report.toolNames.includes("analyze_pipeline_quality"));
      assert.ok(report.toolNames.includes("analyze_source_quality"));
      assert.ok(report.toolNames.includes("answer_my_recruiting_question"));
      assert.equal(report.toolNames.length, 44);
      assert.equal(report.toolNames.some((name) => name === "reject_application" || name.startsWith("patch_")), false);
      // Drift guard: every check the rollout gate requires of distribution evidence must actually be
      // emitted (and pass) by the validator, so a renamed/removed validator check is caught here
      // rather than silently weakening REQUIRED_DISTRIBUTION_CHECKS at deploy.
      for (const required of REQUIRED_DISTRIBUTION_CHECKS) {
        assert.ok(
          report.checks.some((check) => check.name === required && check.status === "pass"),
          `distribution validation must emit gate-required check ${required}`
        );
      }
    } finally {
      globalThis.fetch = originalFetch;
      await closeServer(server);
    }
  });

  it("attributes distribution validation to each supported physical client", async () => {
    const clients = [
      { surface: "claude_desktop", client: "claude_desktop_chat" },
      { surface: "claude_desktop", client: "claude_code" },
      { surface: "chatgpt_desktop", client: "chatgpt_codex_host" },
    ] as const;
    const redirectModes: Array<RequestRedirect | undefined> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      redirectModes.push(init?.redirect);
      const url = new URL(String(input));
      if (url.pathname === "/healthz") return new Response(JSON.stringify({ ok: true }), { status: 200 });
      if (url.pathname === "/readyz") {
        return new Headers(init?.headers).has("authorization")
          ? new Response(JSON.stringify({ ok: true, status: "ready", checks: PASSING_READINESS_CHECKS }), { status: 200 })
          : new Response(JSON.stringify({ ok: false }), { status: 401 });
      }
      if (url.pathname === "/version") return new Response(JSON.stringify({ name: "greenhouse-recruiter-mcp", version: "0.1.0", commit: EXPECTED_COMMIT }), { status: 200 });
      const request = JSON.parse(String(init?.body)) as { id: number; method: string };
      const result = request.method === "initialize"
        ? { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "greenhouse-recruiter-mcp", version: "1" } }
        : {
            tools: PILOT_TOOL_NAMES.map((name) => ({
              name,
              annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
            })),
          };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), { status: 200 });
    };

    for (const identity of clients) {
      const token = createSignedSessionToken({
        subject: "email:recruiter@example.com",
        email: "recruiter@example.com",
        ...identity,
        tokenId: `${identity.client}-token`,
        issuedAt: "2026-06-23T00:00:00.000Z",
      }, STRONG_SESSION_SECRET);
      const report = await runRemoteDistributionValidation({
        mcpUrl: "https://greenhouse-recruiter.example.com/mcp",
        readinessToken: READYZ_TOKEN,
        expectedCommit: EXPECTED_COMMIT,
        token,
        fetchImpl,
        now: () => new Date("2026-06-23T00:00:00.000Z"),
      });

      assert.equal(report.ok, true, JSON.stringify(report.checks));
      assert.equal(report.sessionSurface, identity.surface);
      assert.equal(report.sessionClient, identity.client);
      assert.equal(report.toolNames.length, 44);
    }
    assert.ok(redirectModes.length > 0);
    assert.ok(redirectModes.every((mode) => mode === "error"));
  });

  it("derives the same canonical order as the server when runtime catalog controls are present", async () => {
    const token = createSignedSessionToken({
      subject: "email:recruiter@example.com",
      email: "recruiter@example.com",
      surface: "chatgpt_desktop",
      client: "chatgpt_codex_host",
      tokenId: "distribution-env-order-token",
      issuedAt: "2026-06-23T00:00:00.000Z",
    }, STRONG_SESSION_SECRET);
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/healthz") return new Response(JSON.stringify({ ok: true }), { status: 200 });
      if (url.pathname === "/readyz") {
        return new Headers(init?.headers).has("authorization")
          ? new Response(JSON.stringify({ ok: true, status: "ready", checks: PASSING_READINESS_CHECKS }), { status: 200 })
          : new Response(JSON.stringify({ ok: false }), { status: 401 });
      }
      if (url.pathname === "/version") return new Response(JSON.stringify({ name: "greenhouse-recruiter-mcp", version: "0.1.0", commit: EXPECTED_COMMIT }), { status: 200 });
      const request = JSON.parse(String(init?.body)) as { id: number; method: string };
      const result = request.method === "initialize"
        ? { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "greenhouse-recruiter-mcp", version: "1" } }
        : {
            tools: PILOT_TOOL_NAMES.map((name) => ({
              name,
              annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
            })),
          };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), { status: 200 });
    };

    const report = await runRemoteDistributionValidationFromEnv({
      GREENHOUSE_RECRUITER_REMOTE_MCP_URL: "https://greenhouse-recruiter.example.com/mcp",
      GREENHOUSE_RECRUITER_SESSION_TOKEN: token,
      GREENHOUSE_RECRUITER_ALLOWED_TOOLS: PILOT_TOOL_NAMES.join(","),
      GREENHOUSE_RECRUITER_REMOTE_READY_TOKEN: READYZ_TOKEN,
      GREENHOUSE_RECRUITER_EXPECTED_COMMIT_SHA: EXPECTED_COMMIT,
    } as NodeJS.ProcessEnv, {
      fetchImpl,
      now: () => new Date("2026-06-23T00:00:00.000Z"),
    });

    assert.equal(report.ok, true, JSON.stringify(report.checks));
    assert.deepEqual(report.toolNames, [...PILOT_TOOL_NAMES]);
    assert.equal(report.checks.find((check) => check.name === "exact_tool_catalog")?.status, "pass");
  });

  it("does not accept static identity JSON as final distribution evidence", async () => {
    const token = createSignedSessionToken({
      subject: "email:recruiter@example.com",
      email: "recruiter@example.com",
      surface: "chatgpt_desktop",
      tokenId: "distribution-validation-token",
      issuedAt: "2026-06-23T00:00:00.000Z",
    }, STRONG_SESSION_SECRET);
    const server = await startHttpRecruiterMcp({
      GREENHOUSE_RECRUITER_MCP_PORT: "0",
      GREENHOUSE_CLIENT_ID: "client-id-value",
      GREENHOUSE_CLIENT_SECRET: "client-secret-value",
      GREENHOUSE_RECRUITER_STATE_BACKEND: "supabase_postgrest",
      GREENHOUSE_RECRUITER_SESSION_SECRET: STRONG_SESSION_SECRET,
      GREENHOUSE_RECRUITER_READYZ_TOKEN: READYZ_TOKEN,
      GREENHOUSE_RECRUITER_IDENTITY_JSON: JSON.stringify([
        { email: "recruiter@example.com", status: "resolved", greenhouseUserId: 123 },
      ]),
      GREENHOUSE_RECRUITER_ALLOW_STATIC_IDENTITY_FOR_DEV: "true",
      GREENHOUSE_RECRUITER_REVOCATION_SUPABASE_URL: "https://exampleprojectref000.supabase.co",
      GREENHOUSE_RECRUITER_REVOCATION_SUPABASE_KEY: "revocation-key-value",
      GREENHOUSE_RECRUITER_AUDIT_JSONL_PATH: "/tmp/greenhouse-recruiter-distribution-validation-warning-audit.jsonl",
      GREENHOUSE_RECRUITER_AUDIT_DURABLE_MOUNT_PATH: "/tmp",
      GREENHOUSE_RECRUITER_CORS_ORIGIN: "https://chatgpt.com,https://claude.ai",
      GREENHOUSE_RECRUITER_BUILD_SHA: EXPECTED_COMMIT,
    } as NodeJS.ProcessEnv);
    try {
      const base = baseUrl(server);
      const report = await runRemoteDistributionValidation({
        mcpUrl: `${base}/mcp`,
        healthUrl: `${base}/healthz`,
        readinessUrl: `${base}/readyz`,
        readinessToken: READYZ_TOKEN,
        expectedCommit: EXPECTED_COMMIT,
        token,
        now: () => new Date("2026-06-23T00:00:00.000Z"),
      });

      const readyz = report.checks.find((check) => check.name === "readyz");
      assert.equal(report.ok, false);
      assert.equal(readyz?.status, "fail");
      assert.match(readyz?.summary ?? "", /not ready/);
      assert.equal(readyz?.details?.status, "not_ready");
    } finally {
      await closeServer(server);
    }
  });

  it("fails closed before contacting a remote MCP when no durable session token is configured", async () => {
    const report = await runRemoteDistributionValidationFromEnv({
      GREENHOUSE_RECRUITER_REMOTE_MCP_URL: "https://greenhouse-recruiter.example.com/mcp",
    } as NodeJS.ProcessEnv, {
      now: () => new Date("2026-06-23T00:00:00.000Z"),
      fetchImpl: async () => assert.fail("validation should not fetch without an auth token"),
    });

    assert.equal(report.ok, false);
    assert.equal(report.status, "not_ready");
    assert.deepEqual(report.checks, [{
      name: "auth_token",
      status: "fail",
      summary: "A durable recruiter session token is required for remote MCP validation.",
    }]);
  });

  it("fails closed before contacting a remote MCP when durable session metadata is not exact", async () => {
    const token = createRawSignedSessionPayload({
      subject: "email:recruiter@example.com",
      email: "recruiter@example.com",
      surface: "chatgpt_desktop",
      tokenId: "distribution-validation-token",
      issuedAt: "2026-06-23T00:00:00Z",
    }, STRONG_SESSION_SECRET);
    let fetchCalls = 0;

    const report = await runRemoteDistributionValidation({
      mcpUrl: "https://greenhouse-recruiter.example.com/mcp",
      token,
      fetchImpl: async () => {
        fetchCalls += 1;
        return assert.fail("distribution validation should not fetch with non-exact token metadata") as never;
      },
      now: () => new Date("2026-06-23T00:00:00.000Z"),
    });

    const metadata = report.checks.find((check) => check.name === "session_token_metadata");
    assert.equal(fetchCalls, 0);
    assert.equal(report.ok, false);
    assert.equal(report.sessionIssuedAt, undefined);
    assert.equal(metadata?.status, "fail");
    assert.deepEqual(metadata?.details?.missing, ["issuedAt"]);
  });

  it("sends the separate readiness token when validating protected /readyz", async () => {
    const requested: Array<{ url: string; authorization: string | null }> = [];
    const token = createSignedSessionToken({
      subject: "email:recruiter@example.com",
      email: "recruiter@example.com",
      surface: "chatgpt_desktop",
      tokenId: "distribution-validation-token",
      issuedAt: "2026-06-23T00:00:00.000Z",
    }, STRONG_SESSION_SECRET);

    await runRemoteDistributionValidation({
      mcpUrl: "https://greenhouse-recruiter.example.com/mcp",
      healthUrl: "https://greenhouse-recruiter.example.com/healthz",
      readinessUrl: "https://greenhouse-recruiter.example.com/readyz",
      readinessToken: READYZ_TOKEN,
      expectedCommit: EXPECTED_COMMIT,
      token,
      fetchImpl: async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        const headers = new Headers(init?.headers);
        requested.push({ url, authorization: headers.get("authorization") });
        if (url.endsWith("/healthz")) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        if (url.endsWith("/readyz")) {
          return headers.has("authorization")
            ? new Response(JSON.stringify({ ok: true, status: "ready", checks: PASSING_READINESS_CHECKS }), { status: 200 })
            : new Response(JSON.stringify({ ok: false }), { status: 401 });
        }
        if (url.endsWith("/version")) return new Response(JSON.stringify({ name: "greenhouse-recruiter-mcp", version: "0.1.0", commit: EXPECTED_COMMIT }), { status: 200 });
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }), { status: 200 });
      },
      now: () => new Date("2026-06-23T00:00:00.000Z"),
    });

    const readyz = requested.find((entry) => entry.url.endsWith("/readyz") && entry.authorization === `Bearer ${READYZ_TOKEN}`);
    const unauthorizedReadyz = requested.find((entry) => entry.url.endsWith("/readyz") && entry.authorization === null);
    const mcp = requested.find((entry) => entry.url.endsWith("/mcp"));
    assert.equal(readyz?.authorization, `Bearer ${READYZ_TOKEN}`);
    assert.equal(unauthorizedReadyz?.authorization, null);
    assert.equal(mcp?.authorization, `Bearer ${token}`);
  });

  it("rejects missing, malformed, incomplete, or failing protected readiness checks", async () => {
    const token = createSignedSessionToken({
      subject: "email:recruiter@example.com",
      email: "recruiter@example.com",
      surface: "chatgpt_desktop",
      client: "chatgpt_codex_host",
      tokenId: "distribution-readiness-shape-token",
      issuedAt: "2026-06-23T00:00:00.000Z",
    }, STRONG_SESSION_SECRET);
    const cases: unknown[] = [
      undefined,
      [],
      [{ name: "server_enabled", status: "pass" }],
      PASSING_READINESS_CHECKS.map((check) =>
        check.name === "tool_catalog" ? { ...check, status: "fail" } : check),
    ];

    for (const checks of cases) {
      const report = await runRemoteDistributionValidation({
        mcpUrl: "https://greenhouse-recruiter.example.com/mcp",
        readinessToken: READYZ_TOKEN,
        expectedCommit: EXPECTED_COMMIT,
        token,
        fetchImpl: async (input, init) => {
          const url = new URL(String(input));
          if (url.pathname === "/healthz") return new Response(JSON.stringify({ ok: true }), { status: 200 });
          if (url.pathname === "/readyz") {
            return new Headers(init?.headers).has("authorization")
              ? new Response(JSON.stringify({ ok: true, status: "ready", ...(checks === undefined ? {} : { checks }) }), { status: 200 })
              : new Response(JSON.stringify({ ok: false }), { status: 401 });
          }
          if (url.pathname === "/version") {
            return new Response(JSON.stringify({ name: "greenhouse-recruiter-mcp", version: "0.1.0", commit: EXPECTED_COMMIT }), { status: 200 });
          }
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32603 } }), { status: 200 });
        },
      });

      assert.equal(report.ok, false);
      assert.equal(report.checks.find((check) => check.name === "readyz")?.status, "fail");
    }
  });

  it("does not copy non-OK MCP response bodies into distribution evidence", async () => {
    const token = createSignedSessionToken({
      subject: "email:recruiter@example.com",
      email: "recruiter@example.com",
      surface: "chatgpt_desktop",
      tokenId: "distribution-validation-token",
      issuedAt: "2026-06-23T00:00:00.000Z",
    }, STRONG_SESSION_SECRET);
    const sensitiveBody = JSON.stringify({
      error: "proxy failed",
      authorization: `Bearer ${token}`,
      GREENHOUSE_CLIENT_SECRET: "client-secret-value",
      detail: "internal stack trace",
    });

    const report = await runRemoteDistributionValidation({
      mcpUrl: "https://greenhouse-recruiter.example.com/mcp",
      healthUrl: "https://greenhouse-recruiter.example.com/healthz",
      readinessUrl: "https://greenhouse-recruiter.example.com/readyz",
      readinessToken: READYZ_TOKEN,
      token,
      fetchImpl: async (input) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.endsWith("/healthz")) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        if (url.endsWith("/readyz")) {
          return new Response(JSON.stringify({ ok: true, status: "ready", checks: [] }), { status: 200 });
        }
        return new Response(sensitiveBody, { status: 500 });
      },
      now: () => new Date("2026-06-23T00:00:00.000Z"),
    });

    const serialized = JSON.stringify(report);
    assert.equal(report.ok, false);
    assert.match(report.checks.find((check) => check.name === "mcp_initialize")?.summary ?? "", /HTTP 500/);
    assert.doesNotMatch(serialized, /Bearer|GREENHOUSE_CLIENT_SECRET|client-secret-value|internal stack trace/);
    assert.doesNotMatch(serialized, new RegExp(escapeRegExp(token)));
  });

  it("does not copy JSON-RPC error messages into distribution evidence", async () => {
    const token = createSignedSessionToken({
      subject: "email:recruiter@example.com",
      email: "recruiter@example.com",
      surface: "chatgpt_desktop",
      tokenId: "distribution-validation-token",
      issuedAt: "2026-06-23T00:00:00.000Z",
    }, STRONG_SESSION_SECRET);
    const sensitiveMessage = `failed with Authorization: Bearer ${token} and GREENHOUSE_CLIENT_SECRET=client-secret-value`;

    const report = await runRemoteDistributionValidation({
      mcpUrl: "https://greenhouse-recruiter.example.com/mcp",
      healthUrl: "https://greenhouse-recruiter.example.com/healthz",
      readinessUrl: "https://greenhouse-recruiter.example.com/readyz",
      readinessToken: READYZ_TOKEN,
      token,
      fetchImpl: async (input) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.endsWith("/healthz")) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        if (url.endsWith("/readyz")) {
          return new Response(JSON.stringify({ ok: true, status: "ready", checks: [] }), { status: 200 });
        }
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: sensitiveMessage } }), { status: 200 });
      },
      now: () => new Date("2026-06-23T00:00:00.000Z"),
    });

    const serialized = JSON.stringify(report);
    assert.equal(report.ok, false);
    assert.equal(report.checks.find((check) => check.name === "mcp_initialize")?.summary, "Remote MCP initialize returned a JSON-RPC error.");
    assert.doesNotMatch(serialized, /Bearer|GREENHOUSE_CLIENT_SECRET|client-secret-value/);
    assert.doesNotMatch(serialized, new RegExp(escapeRegExp(token)));
  });

  it("does not copy thrown fetch errors into distribution evidence", async () => {
    const token = createSignedSessionToken({
      subject: "email:recruiter@example.com",
      email: "recruiter@example.com",
      surface: "chatgpt_desktop",
      tokenId: "distribution-validation-token",
      issuedAt: "2026-06-23T00:00:00.000Z",
    }, STRONG_SESSION_SECRET);
    const sensitiveMessage = `proxy failed with Authorization: Bearer ${token} and GREENHOUSE_CLIENT_SECRET=client-secret-value`;

    const report = await runRemoteDistributionValidation({
      mcpUrl: "https://greenhouse-recruiter.example.com/mcp",
      healthUrl: "https://greenhouse-recruiter.example.com/healthz",
      readinessUrl: "https://greenhouse-recruiter.example.com/readyz",
      readinessToken: READYZ_TOKEN,
      token,
      fetchImpl: async () => {
        throw new Error(sensitiveMessage);
      },
      now: () => new Date("2026-06-23T00:00:00.000Z"),
    });

    const serialized = JSON.stringify(report);
    assert.equal(report.ok, false);
    assert.equal(report.checks.find((check) => check.name === "healthz")?.summary, "Remote recruiter MCP health endpoint could not be reached.");
    assert.equal(report.checks.find((check) => check.name === "readyz")?.summary, "Remote recruiter MCP readiness endpoint could not be reached.");
    assert.equal(report.checks.find((check) => check.name === "mcp_initialize")?.summary, "Remote MCP initialize request failed or returned an unreadable response.");
    assert.equal(report.checks.find((check) => check.name === "mcp_tools_list")?.summary, "Remote MCP tools/list request failed or returned an unreadable response.");
    assert.doesNotMatch(serialized, /Bearer|GREENHOUSE_CLIENT_SECRET|client-secret-value|proxy failed/);
    assert.doesNotMatch(serialized, new RegExp(escapeRegExp(token)));
  });

  it("flags missing expected tools, unexpected read tools, and any write/admin tool names", () => {
    const checks = validateRemoteToolCatalog(["search_my_jobs", "list_activity", "reject_application"], [
      "search_my_jobs",
      "analyze_scorecard_accountability",
    ]);

    assert.equal(checks.find((check) => check.name === "expected_tool_catalog")?.status, "fail");
    assert.deepEqual(checks.find((check) => check.name === "expected_tool_catalog")?.details, {
      missing: ["analyze_scorecard_accountability"],
    });
    assert.equal(checks.find((check) => check.name === "no_unexpected_tools")?.status, "fail");
    assert.deepEqual(checks.find((check) => check.name === "no_unexpected_tools")?.details, {
      unexpected: ["list_activity", "reject_application"],
    });
    assert.equal(checks.find((check) => check.name === "exact_tool_catalog")?.status, "fail");
    assert.equal(checks.find((check) => check.name === "no_write_tools")?.status, "fail");
    assert.deepEqual(checks.find((check) => check.name === "no_write_tools")?.details, {
      forbidden: ["reject_application"],
    });
  });

  it("rejects duplicate tool names even when every expected name is present", () => {
    const expected = ["search_my_jobs", "answer_my_recruiting_question"];
    const checks = validateRemoteToolCatalog([...expected, "search_my_jobs"], expected);

    assert.equal(checks.find((check) => check.name === "expected_tool_catalog")?.status, "pass");
    assert.equal(checks.find((check) => check.name === "no_unexpected_tools")?.status, "pass");
    assert.deepEqual(checks.find((check) => check.name === "exact_tool_catalog"), {
      name: "exact_tool_catalog",
      status: "fail",
      summary: "Remote MCP tool catalog is not an exact duplicate-free match for the approved recruiter catalog.",
      details: {
        expectedToolCount: 2,
        actualToolCount: 3,
        missing: [],
        unexpected: [],
        duplicates: ["search_my_jobs"],
        expectedDuplicates: [],
        orderMatch: false,
      },
    });
  });

  it("rejects a reordered remote catalog even when membership and count match", () => {
    const expected = ["search_my_jobs", "answer_my_recruiting_question"];
    const checks = validateRemoteToolCatalog([...expected].reverse(), expected);

    assert.equal(checks.find((check) => check.name === "expected_tool_catalog")?.status, "pass");
    assert.equal(checks.find((check) => check.name === "no_unexpected_tools")?.status, "pass");
    assert.equal(checks.find((check) => check.name === "exact_tool_catalog")?.status, "fail");
    assert.equal(checks.find((check) => check.name === "exact_tool_catalog")?.details?.orderMatch, false);
  });

  it("flags remote tools that are missing read-only safety annotations", () => {
    const pass = validateRemoteToolAnnotations([
      { name: "search_my_jobs", annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true } },
    ]);
    const fail = validateRemoteToolAnnotations([
      { name: "search_my_jobs" },
      { name: "analyze_scorecard_accountability", annotations: { readOnlyHint: true, destructiveHint: true, idempotentHint: false } },
    ]);

    assert.equal(pass.status, "pass");
    assert.equal(fail.status, "fail");
    assert.deepEqual(fail.details, {
      missingReadOnly: ["search_my_jobs"],
      destructive: ["analyze_scorecard_accountability"],
      notIdempotent: ["analyze_scorecard_accountability"],
    });
  });

  it("parses Streamable HTTP SSE JSON-RPC responses", () => {
    assert.deepEqual(parseMcpResponsePayload('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n'), {
      jsonrpc: "2.0",
      id: 1,
      result: { ok: true },
    });
  });
});


async function startRevocationStubServer(rows: unknown[]): Promise<http.Server> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(rows));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

function baseUrl(server: http.Server): string {
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createRawSignedSessionPayload(payload: object, secret: string): string {
  const payloadPart = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(payloadPart).digest("base64url");
  return `${payloadPart}.${signature}`;
}
