import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyIdentityBootstrapPlan,
  buildIdentityBootstrapPlan,
  startIdentityBootstrapCli,
  type IdentityBootstrapPlan,
} from "../src/identity-bootstrap.js";

const UNSAFE_GREENHOUSE_USER_ID = Number.MAX_SAFE_INTEGER + 1;

describe("identity directory bootstrap", () => {
  it("builds a token-free resolved identity plan from roster emails and Greenhouse users", () => {
    const plan = buildIdentityBootstrapPlan({
      rosterEmails: [" Recruiter@Company.com ", "other@company.com"],
      allowedDomains: ["company.com"],
      generatedAt: "2026-06-23T00:00:00.000Z",
      greenhouseUsers: {
        data: [
          { id: "123", emails: [{ value: "recruiter@company.com", type: "work" }] },
          { id: 456, primary_email: "other@company.com" },
        ],
      },
    });

    assert.equal(plan.ok, true);
    assert.equal(plan.containsTokens, false);
    assert.equal(plan.canApply, true);
    assert.equal(plan.requestedEmailCount, 2);
    assert.equal(plan.normalizedEmailCount, 2);
    assert.deepEqual(plan.denied, []);
    assert.deepEqual(plan.resolved.map((entry) => [entry.email, entry.greenhouseUserId]), [
      ["recruiter@company.com", 123],
      ["other@company.com", 456],
    ]);
    assert.deepEqual(plan.resolved[0]!.row, {
      greenhouse_user_id: 123,
      primary_email: "recruiter@company.com",
      google_subject: null,
      slack_user_id: null,
      status: "resolved",
      source: "greenhouse_users_roster_bootstrap",
      evidence_detail: {
        source: "greenhouse_users_roster_bootstrap",
        matched_by: "work_email",
        matched_greenhouse_emails: ["recruiter@company.com"],
      },
      last_verified_at: "2026-06-23T00:00:00.000Z",
    });
  });

  it("denies duplicate, unmapped, ambiguous, inactive, and disallowed roster rows before apply", () => {
    const plan = buildIdentityBootstrapPlan({
      rosterEmails: [
        "dupe@company.com",
        "dupe@company.com",
        "missing@company.com",
        "ambig@company.com",
        "inactive@company.com",
        "bad@other.com",
      ],
      allowedDomains: ["company.com"],
      generatedAt: "2026-06-23T00:00:00.000Z",
      greenhouseUsers: [
        { id: 1, email: "dupe@company.com" },
        { id: 2, email: "ambig@company.com" },
        { id: 3, email: "ambig@company.com" },
        { id: 4, email: "inactive@company.com", disabled: true },
      ],
    });

    assert.equal(plan.ok, false);
    assert.equal(plan.canApply, false);
    assert.deepEqual(plan.resolved.map((entry) => entry.email), ["dupe@company.com"]);
    assert.deepEqual(plan.denied.map((entry) => [entry.email, entry.status]), [
      ["dupe@company.com", "ambiguous"],
      ["missing@company.com", "email_missing"],
      ["ambig@company.com", "ambiguous"],
      ["inactive@company.com", "deactivated"],
      ["bad@other.com", "unresolved"],
    ]);
    assert.deepEqual(plan.denied.find((entry) => entry.email === "ambig@company.com")?.greenhouseUserIds, [2, 3]);
  });

  it("denies roster emails matched only to unsafe Greenhouse user ids", () => {
    const plan = buildIdentityBootstrapPlan({
      rosterEmails: ["unsafe-number@company.com", "unsafe-string@company.com"],
      allowedDomains: ["company.com"],
      generatedAt: "2026-06-23T00:00:00.000Z",
      greenhouseUsers: [
        { id: UNSAFE_GREENHOUSE_USER_ID, email: "unsafe-number@company.com" },
        { id: "9007199254740993", primary_email: "unsafe-string@company.com" },
      ],
    });

    assert.equal(plan.ok, false);
    assert.equal(plan.canApply, false);
    assert.deepEqual(plan.resolved, []);
    assert.deepEqual(plan.denied.map((entry) => [entry.email, entry.status]), [
      ["unsafe-number@company.com", "greenhouse_missing"],
      ["unsafe-string@company.com", "greenhouse_missing"],
    ]);
    assert.ok(plan.denied.every((entry) => /safe positive id/.test(entry.reason)));
  });

  it("applies only a clean plan to the Supabase identity directory", async () => {
    const plan = buildIdentityBootstrapPlan({
      rosterEmails: ["recruiter@company.com"],
      allowedDomains: ["company.com"],
      generatedAt: "2026-06-23T00:00:00.000Z",
      greenhouseUsers: [{ id: 123, email_addresses: [{ email: "recruiter@company.com" }] }],
    });
    const requests: Array<{ url: URL; method?: string; headers: Headers; body: unknown }> = [];
    const fetchImpl = async (url: URL | RequestInfo, init?: RequestInit) => {
      requests.push({
        url: new URL(String(url)),
        method: init?.method,
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)),
      });
      return { ok: true, status: 201, json: async () => [] } as Response;
    };

    const report = await applyIdentityBootstrapPlan(plan, {
      supabaseUrl: "https://project.supabase.co/",
      apiKey: "service-key",
      fetchImpl: fetchImpl as typeof fetch,
      appliedAt: "2026-06-23T00:01:00.000Z",
    });

    assert.deepEqual(report, {
      ok: true,
      appliedAt: "2026-06-23T00:01:00.000Z",
      table: "recruiter_identity_directory",
      rowCount: 1,
      containsTokens: false,
    });
    assert.equal(requests[0]?.url.pathname, "/rest/v1/recruiter_identity_directory");
    assert.equal(requests[0]?.url.searchParams.get("on_conflict"), "greenhouse_user_id");
    assert.equal(requests[0]?.method, "POST");
    assert.equal(requests[0]?.headers.get("apikey"), "service-key");
    assert.equal(requests[0]?.headers.get("authorization"), "Bearer service-key");
    assert.equal(requests[0]?.headers.get("prefer"), "resolution=merge-duplicates,return=representation");
    assert.deepEqual(requests[0]?.body, [plan.resolved[0]!.row]);
  });

  it("refuses to apply a plan with denied rows", async () => {
    const plan: IdentityBootstrapPlan = {
      ok: false,
      generatedAt: "2026-06-23T00:00:00.000Z",
      source: "greenhouse_users_roster_bootstrap",
      requestedEmailCount: 1,
      normalizedEmailCount: 1,
      resolved: [],
      denied: [{ email: "missing@company.com", status: "email_missing", reason: "missing" }],
      containsTokens: false,
      canApply: false,
    };

    await assert.rejects(
      async () => applyIdentityBootstrapPlan(plan, { supabaseUrl: "https://project.supabase.co", apiKey: "key" }),
      /contains denied rows/
    );
  });

  it("rejects insecure or unsafe Supabase identity apply config before network calls", async () => {
    const plan = buildIdentityBootstrapPlan({
      rosterEmails: ["recruiter@company.com"],
      allowedDomains: ["company.com"],
      greenhouseUsers: [{ id: 123, email: "recruiter@company.com" }],
    });
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return { ok: true, status: 200 } as Response;
    }) as typeof fetch;

    await assert.rejects(
      () => applyIdentityBootstrapPlan(plan, {
        supabaseUrl: "http://project.supabase.co",
        apiKey: "service-key",
        fetchImpl,
      }),
      /HTTPS origin/
    );
    await assert.rejects(
      () => applyIdentityBootstrapPlan(plan, {
        supabaseUrl: " https://project.supabase.co ",
        apiKey: "service-key",
        fetchImpl,
      }),
      /leading or trailing whitespace/
    );
    await assert.rejects(
      () => applyIdentityBootstrapPlan(plan, {
        supabaseUrl: "https://project.supabase.co",
        apiKey: "service-key",
        table: "identity.rows",
        fetchImpl,
      }),
      /identity directory table/
    );
    await assert.rejects(
      () => applyIdentityBootstrapPlan(plan, {
        supabaseUrl: "https://project.supabase.co",
        apiKey: "service-key",
        table: " recruiter_identity_directory ",
        fetchImpl,
      }),
      /leading or trailing whitespace/
    );
    await assert.rejects(
      () => applyIdentityBootstrapPlan(plan, {
        supabaseUrl: "https://project.supabase.co",
        apiKey: "   ",
        fetchImpl,
      }),
      /API key is required/
    );
    await assert.rejects(
      () => applyIdentityBootstrapPlan(plan, {
        supabaseUrl: "https://project.supabase.co",
        apiKey: " service-key ",
        fetchImpl,
      }),
      /leading or trailing whitespace/
    );
    assert.equal(called, false);
  });

  it("rejects a non-canonical Supabase identity project on the bootstrap apply path (Slice F #3)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-bootstrap-canonical-"));
    const emailsFile = join(dir, "roster.txt");
    const usersFile = join(dir, "greenhouse-users.json");
    await writeFile(emailsFile, "recruiter@company.com\n", "utf8");
    await writeFile(
      usersFile,
      JSON.stringify({ data: [{ id: 123, emails: [{ value: "recruiter@company.com", type: "work" }] }] }),
      "utf8"
    );

    let fetched = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetched = true;
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const originalExitCode = process.exitCode;
    const errors: string[] = [];
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      errors.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stderr.write;
    try {
      await startIdentityBootstrapCli(
        {
          GREENHOUSE_RECRUITER_ALLOWED_EMAIL_DOMAINS: "company.com",
          GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_URL: "https://otherprojectref00000.supabase.co",
          GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_KEY: "service-key",
        } as NodeJS.ProcessEnv,
        ["--emails-file", emailsFile, "--greenhouse-users-file", usersFile, "--apply"]
      );
    } finally {
      globalThis.fetch = originalFetch;
      process.stderr.write = originalStderrWrite;
      process.exitCode = originalExitCode;
    }

    assert.equal(fetched, false, "must not write identity rows to a non-canonical project");
    assert.match(errors.join(""), /canonical Greenhouse MCP Supabase project/);
  });
});
