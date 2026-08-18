import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildRecruiterMcpReadinessReport, RECRUITER_MCP_READINESS_CHECK_NAMES } from "../src/readiness.js";
import { PILOT_TOOL_NAMES } from "../src/tools/register.js";

const STRONG_SESSION_SECRET = "session-secret-value-with-at-least-32-chars";
const STRONG_SCOPE_SIGNING_SECRET = "scope-signing-secret-value-at-least-32-chars";
const READYZ_TOKEN = "readiness-token-value-with-at-least-32-chars";

describe("recruiter MCP readiness", () => {
  it("reports ready for durable hosted distribution config without exposing secret values", () => {
    const report = buildRecruiterMcpReadinessReport(completeEnv(), () => Date.parse("2026-06-23T12:00:00.000Z"));

    assert.equal(report.ok, true);
    assert.equal(report.status, "ready");
    assert.deepEqual(report.configuredSurfaces, ["chatgpt_desktop", "claude_desktop"]);
    const serialized = JSON.stringify(report);
    assert.doesNotMatch(serialized, /client-secret-value/);
    assert.doesNotMatch(serialized, /session-secret-value/);
    assert.doesNotMatch(serialized, /scope-signing-secret-value/);
    assert.doesNotMatch(serialized, /readiness-token-value/);
    assert.doesNotMatch(serialized, /service-role-key-value/);
    assert.doesNotMatch(serialized, /revocation-key-value/);
  });

  it("fails readiness when the retained audit sink is not configured", () => {
    const report = buildRecruiterMcpReadinessReport({
      ...completeEnv(),
      GREENHOUSE_RECRUITER_AUDIT_JSONL_PATH: undefined,
    } as NodeJS.ProcessEnv);

    const check = report.checks.find((entry) => entry.name === "audit_sink");
    assert.equal(report.ok, false);
    assert.equal(check?.status, "fail");
    assert.match(check?.summary ?? "", /AUDIT_JSONL_PATH/);
  });

  it("fails readiness when the retained audit path is not absolute JSONL storage", () => {
    const relativeReport = buildRecruiterMcpReadinessReport({
      ...completeEnv(),
      GREENHOUSE_RECRUITER_AUDIT_JSONL_PATH: "audit.jsonl",
    } as NodeJS.ProcessEnv);
    const nonJsonlReport = buildRecruiterMcpReadinessReport({
      ...completeEnv(),
      GREENHOUSE_RECRUITER_AUDIT_JSONL_PATH: "/secure/audit.log",
    } as NodeJS.ProcessEnv);

    const relativeCheck = relativeReport.checks.find((entry) => entry.name === "audit_sink");
    const nonJsonlCheck = nonJsonlReport.checks.find((entry) => entry.name === "audit_sink");
    assert.equal(relativeReport.ok, false);
    assert.equal(relativeCheck?.status, "fail");
    assert.match(relativeCheck?.summary ?? "", /absolute path/);
    assert.equal(nonJsonlReport.ok, false);
    assert.equal(nonJsonlCheck?.status, "fail");
    assert.match(nonJsonlCheck?.summary ?? "", /\.jsonl/);
  });

  it("fails hosted readiness when only the static JSON identity pilot adapter is configured", () => {
    const report = buildRecruiterMcpReadinessReport({
      ...completeEnv(),
      GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_URL: undefined,
      GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_KEY: undefined,
      GREENHOUSE_RECRUITER_IDENTITY_JSON: JSON.stringify([{ email: "recruiter@example.com", status: "resolved", greenhouseUserId: 123 }]),
    } as NodeJS.ProcessEnv);

    const check = report.checks.find((entry) => entry.name === "identity_directory");
    assert.equal(report.ok, false);
    assert.equal(check?.status, "fail");
    assert.match(check?.summary ?? "", /pilot adapter/);
  });

  it("fails hosted readiness when static JSON identity is explicitly marked dev-only", () => {
    const report = buildRecruiterMcpReadinessReport({
      ...completeEnv(),
      GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_URL: undefined,
      GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_KEY: undefined,
      GREENHOUSE_RECRUITER_IDENTITY_JSON: JSON.stringify([{ email: "recruiter@example.com", status: "resolved", greenhouseUserId: 123 }]),
      GREENHOUSE_RECRUITER_ALLOW_STATIC_IDENTITY_FOR_DEV: "true",
    } as NodeJS.ProcessEnv);

    const check = report.checks.find((entry) => entry.name === "identity_directory");
    assert.equal(report.ok, false);
    assert.equal(check?.status, "fail");
    assert.match(check?.summary ?? "", /dev\/test-only/);
  });

  it("fails readiness when the session signing secret is too short", () => {
    const report = buildRecruiterMcpReadinessReport({
      ...completeEnv(),
      GREENHOUSE_RECRUITER_SESSION_SECRET: "short-secret",
    } as NodeJS.ProcessEnv);

    const check = report.checks.find((entry) => entry.name === "session_secret");
    assert.equal(report.ok, false);
    assert.equal(check?.status, "fail");
    assert.match(check?.summary ?? "", /at least 32 characters/);
  });

  it("fails readiness when the session signing secret has surrounding whitespace", () => {
    const report = buildRecruiterMcpReadinessReport({
      ...completeEnv(),
      GREENHOUSE_RECRUITER_SESSION_SECRET: ` ${STRONG_SESSION_SECRET} `,
    } as NodeJS.ProcessEnv);

    const check = report.checks.find((entry) => entry.name === "session_secret");
    assert.equal(report.ok, false);
    assert.equal(check?.status, "fail");
    assert.match(check?.summary ?? "", /whitespace/);
    assert.doesNotMatch(JSON.stringify(report), new RegExp(STRONG_SESSION_SECRET));
  });

  it("fails readiness when the scope artifact signing secret is missing, short, or padded", () => {
    const missing = buildRecruiterMcpReadinessReport({
      ...completeEnv(),
      GREENHOUSE_RECRUITER_SCOPE_SIGNING_SECRET: undefined,
    } as NodeJS.ProcessEnv);
    const short = buildRecruiterMcpReadinessReport({
      ...completeEnv(),
      GREENHOUSE_RECRUITER_SCOPE_SIGNING_SECRET: "short-secret",
    } as NodeJS.ProcessEnv);
    const padded = buildRecruiterMcpReadinessReport({
      ...completeEnv(),
      GREENHOUSE_RECRUITER_SCOPE_SIGNING_SECRET: ` ${STRONG_SCOPE_SIGNING_SECRET} `,
    } as NodeJS.ProcessEnv);

    assert.equal(missing.ok, false);
    assert.equal(missing.checks.find((entry) => entry.name === "scope_signing_secret")?.status, "fail");
    assert.match(missing.checks.find((entry) => entry.name === "scope_signing_secret")?.summary ?? "", /SCOPE_SIGNING_SECRET/);
    assert.equal(short.ok, false);
    assert.match(short.checks.find((entry) => entry.name === "scope_signing_secret")?.summary ?? "", /at least 32/);
    assert.equal(padded.ok, false);
    assert.match(padded.checks.find((entry) => entry.name === "scope_signing_secret")?.summary ?? "", /whitespace/);
    assert.doesNotMatch(JSON.stringify(padded), new RegExp(STRONG_SCOPE_SIGNING_SECRET));
  });

  it("fails readiness when required production config is missing", () => {
    const report = buildRecruiterMcpReadinessReport({} as NodeJS.ProcessEnv);

    assert.equal(report.ok, false);
    assert.equal(report.status, "not_ready");
    assert.deepEqual(
      report.checks.filter((check) => check.status === "fail").map((check) => check.name),
      ["greenhouse_client_id", "greenhouse_client_secret", "session_secret", "scope_signing_secret", "detailed_readiness_auth", "state_backend", "token_revocation_source", "identity_directory", "audit_sink", "tool_catalog", "cors_origin_allowlist"]
    );
  });

  it("treats whitespace-only required production config as missing", () => {
    const report = buildRecruiterMcpReadinessReport({
      ...completeEnv(),
      GREENHOUSE_CLIENT_SECRET: "   ",
      GREENHOUSE_RECRUITER_REVOCATION_SUPABASE_KEY: "   ",
    } as NodeJS.ProcessEnv);

    const clientSecretCheck = report.checks.find((check) => check.name === "greenhouse_client_secret");
    const revocationCheck = report.checks.find((check) => check.name === "token_revocation_source");
    assert.equal(report.ok, false);
    assert.equal(clientSecretCheck?.status, "fail");
    assert.equal(revocationCheck?.status, "fail");
    assert.match(revocationCheck?.summary ?? "", /must be set together/);
  });

  it("fails readiness when Greenhouse client credentials have surrounding whitespace", () => {
    const report = buildRecruiterMcpReadinessReport({
      ...completeEnv(),
      GREENHOUSE_CLIENT_ID: " client-id-value",
      GREENHOUSE_CLIENT_SECRET: "client-secret-value\n",
    } as NodeJS.ProcessEnv);

    const clientIdCheck = report.checks.find((check) => check.name === "greenhouse_client_id");
    const clientSecretCheck = report.checks.find((check) => check.name === "greenhouse_client_secret");
    const serialized = JSON.stringify(report);
    assert.equal(report.ok, false);
    assert.equal(clientIdCheck?.status, "fail");
    assert.equal(clientSecretCheck?.status, "fail");
    assert.match(clientIdCheck?.summary ?? "", /whitespace/);
    assert.match(clientSecretCheck?.summary ?? "", /whitespace/);
    assert.doesNotMatch(serialized, /client-secret-value/);
  });

  it("fails readiness when detailed readiness output is not protected", () => {
    const report = buildRecruiterMcpReadinessReport({
      ...completeEnv(),
      GREENHOUSE_RECRUITER_READYZ_TOKEN: undefined,
    } as NodeJS.ProcessEnv);

    const check = report.checks.find((entry) => entry.name === "detailed_readiness_auth");
    assert.equal(report.ok, false);
    assert.equal(check?.status, "fail");
    assert.match(check?.summary ?? "", /READYZ_TOKEN/);
  });

  it("fails readiness when the detailed readiness token is weak", () => {
    const report = buildRecruiterMcpReadinessReport({
      ...completeEnv(),
      GREENHOUSE_RECRUITER_READYZ_TOKEN: "short-token",
    } as NodeJS.ProcessEnv);

    const check = report.checks.find((entry) => entry.name === "detailed_readiness_auth");
    assert.equal(report.ok, false);
    assert.equal(check?.status, "fail");
    assert.match(check?.summary ?? "", /at least 32 characters/);
  });

  it("fails readiness when the detailed readiness token has surrounding whitespace", () => {
    const report = buildRecruiterMcpReadinessReport({
      ...completeEnv(),
      GREENHOUSE_RECRUITER_READYZ_TOKEN: ` ${READYZ_TOKEN} `,
    } as NodeJS.ProcessEnv);

    const check = report.checks.find((entry) => entry.name === "detailed_readiness_auth");
    assert.equal(report.ok, false);
    assert.equal(check?.status, "fail");
    assert.match(check?.summary ?? "", /whitespace/);
    assert.doesNotMatch(JSON.stringify(report), new RegExp(READYZ_TOKEN));
  });

  it("fails readiness when public detailed readiness is explicitly enabled for dev", () => {
    const report = buildRecruiterMcpReadinessReport({
      ...completeEnv(),
      GREENHOUSE_RECRUITER_ALLOW_PUBLIC_READYZ_FOR_DEV: "true",
    } as NodeJS.ProcessEnv);

    const check = report.checks.find((entry) => entry.name === "detailed_readiness_auth");
    assert.equal(report.ok, false);
    assert.equal(check?.status, "fail");
    assert.match(check?.summary ?? "", /must not be enabled/);
  });

  it("fails readiness when boolean env flags are malformed", () => {
    const report = buildRecruiterMcpReadinessReport({
      ...completeEnv(),
      GREENHOUSE_RECRUITER_DISABLE_ANALYTICS: " true ",
    } as NodeJS.ProcessEnv);

    const check = report.checks.find((entry) => entry.name === "boolean_env_flags");
    assert.equal(report.ok, false);
    assert.equal(check?.status, "fail");
    assert.match(check?.summary ?? "", /GREENHOUSE_RECRUITER_DISABLE_ANALYTICS/);
    assert.match(check?.summary ?? "", /exactly "true" or "false"/);
  });


  it("fails readiness when Supabase token revocation env is only partially configured", () => {
    const report = buildRecruiterMcpReadinessReport({
      ...completeEnv(),
      GREENHOUSE_RECRUITER_REVOCATION_SUPABASE_URL: "https://exampleprojectref000.supabase.co",
      GREENHOUSE_RECRUITER_REVOCATION_SUPABASE_KEY: undefined,
    } as NodeJS.ProcessEnv);

    const revocationCheck = report.checks.find((check) => check.name === "token_revocation_source");
    assert.equal(report.ok, false);
    assert.equal(revocationCheck?.status, "fail");
    assert.match(revocationCheck?.summary ?? "", /must be set together/);
  });

  it("fails readiness when Supabase token revocation config is not an HTTPS origin", () => {
    const report = buildRecruiterMcpReadinessReport({
      ...completeEnv(),
      GREENHOUSE_RECRUITER_REVOCATION_SUPABASE_URL: "http://example.supabase.co/rest/v1",
    } as NodeJS.ProcessEnv);

    const revocationCheck = report.checks.find((check) => check.name === "token_revocation_source");
    assert.equal(report.ok, false);
    assert.equal(revocationCheck?.status, "fail");
    assert.match(revocationCheck?.summary ?? "", /HTTPS origin/);
  });

  it("fails readiness when Supabase token revocation URL has surrounding whitespace", () => {
    const report = buildRecruiterMcpReadinessReport({
      ...completeEnv(),
      GREENHOUSE_RECRUITER_REVOCATION_SUPABASE_URL: " https://example.supabase.co ",
    } as NodeJS.ProcessEnv);

    const revocationCheck = report.checks.find((check) => check.name === "token_revocation_source");
    assert.equal(report.ok, false);
    assert.equal(revocationCheck?.status, "fail");
    assert.match(revocationCheck?.summary ?? "", /whitespace/);
  });

  it("fails readiness when Supabase token revocation API key has surrounding whitespace", () => {
    const report = buildRecruiterMcpReadinessReport({
      ...completeEnv(),
      GREENHOUSE_RECRUITER_REVOCATION_SUPABASE_KEY: " revocation-key-value ",
    } as NodeJS.ProcessEnv);

    const revocationCheck = report.checks.find((check) => check.name === "token_revocation_source");
    assert.equal(report.ok, false);
    assert.equal(revocationCheck?.status, "fail");
    assert.match(revocationCheck?.summary ?? "", /whitespace/);
    assert.doesNotMatch(JSON.stringify(report), /revocation-key-value/);
  });

  it("fails readiness when Supabase token revocation identifiers are unsafe", () => {
    const report = buildRecruiterMcpReadinessReport({
      ...completeEnv(),
      GREENHOUSE_RECRUITER_REVOCATION_TOKEN_ID_COLUMN: "token_id,status",
    } as NodeJS.ProcessEnv);

    const revocationCheck = report.checks.find((check) => check.name === "token_revocation_source");
    assert.equal(report.ok, false);
    assert.equal(revocationCheck?.status, "fail");
    assert.match(revocationCheck?.summary ?? "", /token id column/);
  });

  it("fails readiness when Supabase token revocation identifiers have surrounding whitespace", () => {
    const report = buildRecruiterMcpReadinessReport({
      ...completeEnv(),
      GREENHOUSE_RECRUITER_REVOCATION_TOKEN_ID_COLUMN: " token_id ",
    } as NodeJS.ProcessEnv);

    const revocationCheck = report.checks.find((check) => check.name === "token_revocation_source");
    assert.equal(report.ok, false);
    assert.equal(revocationCheck?.status, "fail");
    assert.match(revocationCheck?.summary ?? "", /whitespace/);
  });

  it("fails readiness when Supabase identity env is only partially configured", () => {
    const report = buildRecruiterMcpReadinessReport({
      ...completeEnv(),
      GREENHOUSE_RECRUITER_IDENTITY_JSON: undefined,
      GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_URL: "https://exampleprojectref000.supabase.co",
      GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_KEY: undefined,
    } as NodeJS.ProcessEnv);

    const identityCheck = report.checks.find((check) => check.name === "identity_directory");
    assert.equal(report.ok, false);
    assert.equal(identityCheck?.status, "fail");
    assert.match(identityCheck?.summary ?? "", /must be set together/);
  });

  it("fails readiness when Supabase identity config is not an HTTPS origin", () => {
    const report = buildRecruiterMcpReadinessReport({
      ...completeEnv(),
      GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_URL: "https://example.supabase.co/rest/v1",
    } as NodeJS.ProcessEnv);

    const identityCheck = report.checks.find((check) => check.name === "identity_directory");
    assert.equal(report.ok, false);
    assert.equal(identityCheck?.status, "fail");
    assert.match(identityCheck?.summary ?? "", /HTTPS origin/);
  });

  it("fails readiness when Supabase identity URL has surrounding whitespace", () => {
    const report = buildRecruiterMcpReadinessReport({
      ...completeEnv(),
      GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_URL: " https://example.supabase.co ",
    } as NodeJS.ProcessEnv);

    const identityCheck = report.checks.find((check) => check.name === "identity_directory");
    assert.equal(report.ok, false);
    assert.equal(identityCheck?.status, "fail");
    assert.match(identityCheck?.summary ?? "", /whitespace/);
  });

  it("fails readiness when Supabase identity API key has surrounding whitespace", () => {
    const report = buildRecruiterMcpReadinessReport({
      ...completeEnv(),
      GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_KEY: " service-role-key-value ",
    } as NodeJS.ProcessEnv);

    const identityCheck = report.checks.find((check) => check.name === "identity_directory");
    assert.equal(report.ok, false);
    assert.equal(identityCheck?.status, "fail");
    assert.match(identityCheck?.summary ?? "", /whitespace/);
    assert.doesNotMatch(JSON.stringify(report), /service-role-key-value/);
  });

  it("fails readiness when Supabase identity identifiers are unsafe", () => {
    const report = buildRecruiterMcpReadinessReport({
      ...completeEnv(),
      GREENHOUSE_RECRUITER_IDENTITY_EMAIL_COLUMN: "primary_email,google_subject",
    } as NodeJS.ProcessEnv);

    const identityCheck = report.checks.find((check) => check.name === "identity_directory");
    assert.equal(report.ok, false);
    assert.equal(identityCheck?.status, "fail");
    assert.match(identityCheck?.summary ?? "", /email column/);
  });

  it("fails readiness when Supabase identity identifiers have surrounding whitespace", () => {
    const report = buildRecruiterMcpReadinessReport({
      ...completeEnv(),
      GREENHOUSE_RECRUITER_IDENTITY_EMAIL_COLUMN: " primary_email ",
    } as NodeJS.ProcessEnv);

    const identityCheck = report.checks.find((check) => check.name === "identity_directory");
    assert.equal(report.ok, false);
    assert.equal(identityCheck?.status, "fail");
    assert.match(identityCheck?.summary ?? "", /whitespace/);
  });

  it("validates the directory-id column override alongside the other four", () => {
    // The fifth identity column override shipped without readiness knowing it existed, so a typo in
    // it reached the live lookup instead of failing preflight. Its ABSENCE from the table is
    // tolerated (identity.ts degrades to read-only); a malformed override is still misconfiguration.
    const malformed = buildRecruiterMcpReadinessReport({
      ...completeEnv(),
      GREENHOUSE_RECRUITER_IDENTITY_DIRECTORY_ID_COLUMN: "id;drop",
    } as NodeJS.ProcessEnv);
    const malformedCheck = malformed.checks.find((check) => check.name === "identity_directory");
    assert.equal(malformed.ok, false);
    assert.equal(malformedCheck?.status, "fail");
    assert.match(malformedCheck?.summary ?? "", /directory id column/);

    const wellFormed = buildRecruiterMcpReadinessReport({
      ...completeEnv(),
      GREENHOUSE_RECRUITER_IDENTITY_DIRECTORY_ID_COLUMN: "row_id",
    } as NodeJS.ProcessEnv);
    assert.equal(wellFormed.checks.find((check) => check.name === "identity_directory")?.status, "pass");
  });

  it("fails readiness when the Supabase identity URL points at a non-canonical project (Slice F #3)", () => {
    const report = buildRecruiterMcpReadinessReport({
      ...completeEnv(),
      GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_URL: "https://otherprojectref00000.supabase.co",
    } as NodeJS.ProcessEnv);

    const identityCheck = report.checks.find((check) => check.name === "identity_directory");
    assert.equal(report.ok, false);
    assert.equal(identityCheck?.status, "fail");
    assert.match(identityCheck?.summary ?? "", /canonical Greenhouse MCP Supabase project/);
  });

  it("fails readiness when the Supabase revocation URL points at a non-canonical project (Slice F #3)", () => {
    const report = buildRecruiterMcpReadinessReport({
      ...completeEnv(),
      GREENHOUSE_RECRUITER_REVOCATION_SUPABASE_URL: "https://otherprojectref00000.supabase.co",
    } as NodeJS.ProcessEnv);

    const revocationCheck = report.checks.find((check) => check.name === "token_revocation_source");
    assert.equal(report.ok, false);
    assert.equal(revocationCheck?.status, "fail");
    assert.match(revocationCheck?.summary ?? "", /canonical Greenhouse MCP Supabase project/);
  });

  it("fails readiness when hosted rate limiting is disabled", () => {
    const report = buildRecruiterMcpReadinessReport({
      ...completeEnv(),
      GREENHOUSE_RECRUITER_RATE_LIMIT_DISABLED: "true",
    } as NodeJS.ProcessEnv);

    const check = report.checks.find((entry) => entry.name === "rate_limiter");
    assert.equal(report.ok, false);
    assert.equal(check?.status, "fail");
    assert.match(check?.summary ?? "", /must not be true/);
  });

  it("fails readiness when hosted rate-limit configuration is invalid", () => {
    const report = buildRecruiterMcpReadinessReport({
      ...completeEnv(),
      GREENHOUSE_RECRUITER_MAX_ANALYSIS_CALLS_PER_WINDOW: "0",
    } as NodeJS.ProcessEnv);

    const check = report.checks.find((entry) => entry.name === "rate_limiter");
    assert.equal(report.ok, false);
    assert.equal(check?.status, "fail");
    assert.match(check?.summary ?? "", /MAX_ANALYSIS_CALLS_PER_WINDOW/);
  });

  it("fails readiness when hosted runtime limit configuration is invalid", () => {
    const report = buildRecruiterMcpReadinessReport({
      ...completeEnv(),
      GREENHOUSE_RECRUITER_MAX_TOOL_DURATION_MS: "not-a-number",
    } as NodeJS.ProcessEnv);

    const check = report.checks.find((entry) => entry.name === "runtime_limits");
    assert.equal(report.ok, false);
    assert.equal(check?.status, "fail");
    assert.match(check?.summary ?? "", /MAX_TOOL_DURATION_MS/);
  });

  it("fails readiness for an empty, duplicated, or unknown tool allowlist", () => {
    for (const value of ["", "search_my_jobs,search_my_jobs", "search_my_jobs,unknown_tool"]) {
      const report = buildRecruiterMcpReadinessReport({
        ...completeEnv(),
        GREENHOUSE_RECRUITER_ALLOWED_TOOLS: value,
      } as NodeJS.ProcessEnv);
      assert.equal(report.ok, false);
      assert.equal(report.checks.find((entry) => entry.name === "tool_catalog")?.status, "fail");
    }
  });

  it("fails readiness unless every hosted desktop surface has the exact 44-tool allowlist", () => {
    const cases = [
      undefined,
      "search_my_jobs",
      PILOT_TOOL_NAMES.slice(0, -1).join(","),
      [...PILOT_TOOL_NAMES, "search_my_interview_questions"].join(","),
    ];
    for (const value of cases) {
      const report = buildRecruiterMcpReadinessReport({
        ...completeEnv(),
        GREENHOUSE_RECRUITER_ALLOWED_TOOLS: value,
      } as NodeJS.ProcessEnv);
      assert.equal(report.ok, false);
      assert.equal(report.checks.find((entry) => entry.name === "tool_catalog")?.status, "fail");
    }
  });

  it("fails readiness when the hosted CORS origin allowlist is missing", () => {
    const report = buildRecruiterMcpReadinessReport({
      ...completeEnv(),
      GREENHOUSE_RECRUITER_CORS_ORIGIN: undefined,
    } as NodeJS.ProcessEnv);

    const check = report.checks.find((entry) => entry.name === "cors_origin_allowlist");
    assert.equal(report.ok, false);
    assert.equal(check?.status, "fail");
    assert.match(check?.summary ?? "", /CORS_ORIGIN/);
  });

  it("fails readiness when the hosted CORS origin allowlist uses a wildcard", () => {
    const report = buildRecruiterMcpReadinessReport({
      ...completeEnv(),
      GREENHOUSE_RECRUITER_CORS_ORIGIN: "*",
    } as NodeJS.ProcessEnv);

    const check = report.checks.find((entry) => entry.name === "cors_origin_allowlist");
    assert.equal(report.ok, false);
    assert.equal(check?.status, "fail");
    assert.match(check?.summary ?? "", /wildcard/);
  });

  it("fails readiness when the hosted CORS origin allowlist contains non-HTTPS origins", () => {
    const report = buildRecruiterMcpReadinessReport({
      ...completeEnv(),
      GREENHOUSE_RECRUITER_CORS_ORIGIN: "https://chatgpt.com,http://localhost:3333",
    } as NodeJS.ProcessEnv);

    const check = report.checks.find((entry) => entry.name === "cors_origin_allowlist");
    assert.equal(report.ok, false);
    assert.equal(check?.status, "fail");
    assert.match(check?.summary ?? "", /non-HTTPS/);
  });

  it("fails readiness when the hosted CORS origin allowlist is not exact", () => {
    const whitespaceReport = buildRecruiterMcpReadinessReport({
      ...completeEnv(),
      GREENHOUSE_RECRUITER_CORS_ORIGIN: "https://chatgpt.com, https://claude.ai",
    } as NodeJS.ProcessEnv);
    const duplicateReport = buildRecruiterMcpReadinessReport({
      ...completeEnv(),
      GREENHOUSE_RECRUITER_CORS_ORIGIN: "https://chatgpt.com,https://chatgpt.com",
    } as NodeJS.ProcessEnv);

    const whitespaceCheck = whitespaceReport.checks.find((entry) => entry.name === "cors_origin_allowlist");
    const duplicateCheck = duplicateReport.checks.find((entry) => entry.name === "cors_origin_allowlist");
    assert.equal(whitespaceReport.ok, false);
    assert.equal(whitespaceCheck?.status, "fail");
    assert.match(whitespaceCheck?.summary ?? "", /without whitespace/);
    assert.equal(duplicateReport.ok, false);
    assert.equal(duplicateCheck?.status, "fail");
    assert.match(duplicateCheck?.summary ?? "", /duplicates/);
  });

  it("fails readiness when external lookup timeout configuration is invalid", () => {
    const report = buildRecruiterMcpReadinessReport({
      ...completeEnv(),
      GREENHOUSE_RECRUITER_IDENTITY_LOOKUP_TIMEOUT_MS: "0",
    } as NodeJS.ProcessEnv);
    const whitespaceReport = buildRecruiterMcpReadinessReport({
      ...completeEnv(),
      GREENHOUSE_RECRUITER_REVOCATION_LOOKUP_TIMEOUT_MS: "5000 ",
    } as NodeJS.ProcessEnv);

    const check = report.checks.find((entry) => entry.name === "external_lookup_timeouts");
    const whitespaceCheck = whitespaceReport.checks.find((entry) => entry.name === "external_lookup_timeouts");
    assert.equal(report.ok, false);
    assert.equal(check?.status, "fail");
    assert.match(check?.summary ?? "", /IDENTITY_LOOKUP_TIMEOUT_MS/);
    assert.equal(whitespaceReport.ok, false);
    assert.equal(whitespaceCheck?.status, "fail");
    assert.match(whitespaceCheck?.summary ?? "", /REVOCATION_LOOKUP_TIMEOUT_MS/);
  });

  it("fails readiness when the hosted HTTP body limit configuration is invalid", () => {
    const report = buildRecruiterMcpReadinessReport({
      ...completeEnv(),
      GREENHOUSE_RECRUITER_MAX_HTTP_BODY_BYTES: "0",
    } as NodeJS.ProcessEnv);
    const whitespaceReport = buildRecruiterMcpReadinessReport({
      ...completeEnv(),
      GREENHOUSE_RECRUITER_MAX_HTTP_BODY_BYTES: "262144 ",
    } as NodeJS.ProcessEnv);

    const check = report.checks.find((entry) => entry.name === "http_body_limit");
    const whitespaceCheck = whitespaceReport.checks.find((entry) => entry.name === "http_body_limit");
    assert.equal(report.ok, false);
    assert.equal(check?.status, "fail");
    assert.match(check?.summary ?? "", /MAX_HTTP_BODY_BYTES/);
    assert.equal(whitespaceReport.ok, false);
    assert.equal(whitespaceCheck?.status, "fail");
    assert.match(whitespaceCheck?.summary ?? "", /MAX_HTTP_BODY_BYTES/);
  });

  it("fails readiness when hosted endpoint route configuration is invalid", () => {
    const report = buildRecruiterMcpReadinessReport({
      ...completeEnv(),
      GREENHOUSE_RECRUITER_MCP_PATH: "mcp",
    } as NodeJS.ProcessEnv);

    const check = report.checks.find((entry) => entry.name === "http_endpoint_config");
    assert.equal(report.ok, false);
    assert.equal(check?.status, "fail");
    assert.match(check?.summary ?? "", /MCP_PATH/);
  });

  it("fails readiness when hosted endpoint routes collide", () => {
    const report = buildRecruiterMcpReadinessReport({
      ...completeEnv(),
      GREENHOUSE_RECRUITER_MCP_PATH: "/mcp",
      GREENHOUSE_RECRUITER_READY_PATH: "/mcp",
    } as NodeJS.ProcessEnv);

    const check = report.checks.find((entry) => entry.name === "http_endpoint_config");
    assert.equal(report.ok, false);
    assert.equal(check?.status, "fail");
    assert.match(check?.summary ?? "", /distinct routes/);
  });

  it("fails readiness when the hosted MCP port configuration is invalid", () => {
    const report = buildRecruiterMcpReadinessReport({
      ...completeEnv(),
      GREENHOUSE_RECRUITER_MCP_PORT: "3333abc",
    } as NodeJS.ProcessEnv);

    const check = report.checks.find((entry) => entry.name === "http_endpoint_config");
    assert.equal(report.ok, false);
    assert.equal(check?.status, "fail");
    assert.match(check?.summary ?? "", /MCP_PORT/);
  });

  it("fails readiness when hosted HTTP timeout configuration is invalid", () => {
    const report = buildRecruiterMcpReadinessReport({
      ...completeEnv(),
      GREENHOUSE_RECRUITER_HTTP_HEADERS_TIMEOUT_MS: "0",
    } as NodeJS.ProcessEnv);

    const check = report.checks.find((entry) => entry.name === "http_server_timeouts");
    assert.equal(report.ok, false);
    assert.equal(check?.status, "fail");
    assert.match(check?.summary ?? "", /HTTP_HEADERS_TIMEOUT_MS/);
  });

  it("fails readiness when hosted HTTP headers timeout exceeds request timeout", () => {
    const report = buildRecruiterMcpReadinessReport({
      ...completeEnv(),
      GREENHOUSE_RECRUITER_HTTP_HEADERS_TIMEOUT_MS: "20000",
      GREENHOUSE_RECRUITER_HTTP_REQUEST_TIMEOUT_MS: "10000",
    } as NodeJS.ProcessEnv);

    const check = report.checks.find((entry) => entry.name === "http_server_timeouts");
    assert.equal(report.ok, false);
    assert.equal(check?.status, "fail");
    assert.match(check?.summary ?? "", /less than or equal/);
  });

  it("passes readiness for a BOUNDED nonzero permission TTL and fails above the bound (T1.2)", () => {
    // Bounded short TTL is an accepted hosted posture: Greenhouse deactivation doesn't revoke
    // user_job_permissions anyway (vendored contract), and the cache collapses the per-page
    // permission re-sweep that feeds the shared-token 429 cascade.
    const bounded = buildRecruiterMcpReadinessReport({
      ...completeEnv(),
      GREENHOUSE_RECRUITER_FORCE_PERMISSION_TTL_ZERO: undefined,
      GREENHOUSE_RECRUITER_PERMISSION_TTL_MS: "120000",
    } as NodeJS.ProcessEnv);
    const boundedCheck = bounded.checks.find((entry) => entry.name === "permission_freshness");
    assert.equal(boundedCheck?.status, "pass");
    assert.match(boundedCheck?.summary ?? "", /bounded/);

    // Above the 5-minute bound still fails closed — a fat-fingered TTL can't make permissions
    // hours stale.
    const unbounded = buildRecruiterMcpReadinessReport({
      ...completeEnv(),
      GREENHOUSE_RECRUITER_FORCE_PERMISSION_TTL_ZERO: undefined,
      GREENHOUSE_RECRUITER_PERMISSION_TTL_MS: "600000",
    } as NodeJS.ProcessEnv);
    const unboundedCheck = unbounded.checks.find((entry) => entry.name === "permission_freshness");
    assert.equal(unbounded.ok, false);
    assert.equal(unboundedCheck?.status, "fail");
    assert.match(unboundedCheck?.summary ?? "", /must be ≤300000ms/);
  });

  it("fails readiness when hosted permission TTL config is not exact", () => {
    const whitespaceReport = buildRecruiterMcpReadinessReport({
      ...completeEnv(),
      GREENHOUSE_RECRUITER_FORCE_PERMISSION_TTL_ZERO: undefined,
      GREENHOUSE_RECRUITER_PERMISSION_TTL_MS: "0 ",
    } as NodeJS.ProcessEnv);
    const unsafeReport = buildRecruiterMcpReadinessReport({
      ...completeEnv(),
      GREENHOUSE_RECRUITER_FORCE_PERMISSION_TTL_ZERO: undefined,
      GREENHOUSE_RECRUITER_PERMISSION_TTL_MS: "9007199254740993",
    } as NodeJS.ProcessEnv);

    const whitespaceCheck = whitespaceReport.checks.find((entry) => entry.name === "permission_freshness");
    const unsafeCheck = unsafeReport.checks.find((entry) => entry.name === "permission_freshness");
    assert.equal(whitespaceReport.ok, false);
    assert.equal(whitespaceCheck?.status, "fail");
    assert.match(whitespaceCheck?.summary ?? "", /safe integer/);
    assert.equal(unsafeReport.ok, false);
    assert.equal(unsafeCheck?.status, "fail");
    assert.match(unsafeCheck?.summary ?? "", /safe integer/);
  });

  it("allows a configured permission TTL only when the force-zero rollout override is set", () => {
    const report = buildRecruiterMcpReadinessReport({
      ...completeEnv(),
      GREENHOUSE_RECRUITER_PERMISSION_TTL_MS: "120000",
      GREENHOUSE_RECRUITER_FORCE_PERMISSION_TTL_ZERO: "true",
    } as NodeJS.ProcessEnv);

    const check = report.checks.find((entry) => entry.name === "permission_freshness");
    assert.equal(report.ok, true);
    assert.equal(check?.status, "pass");
    assert.match(check?.summary ?? "", /forced to zero/);
  });

  it("passes readiness for an explicit positive operator allowlist", () => {
    const report = buildRecruiterMcpReadinessReport({
      ...completeEnv(),
      OPERATOR_ACTOR_IDS: "900,901",
    } as NodeJS.ProcessEnv);

    const check = report.checks.find((entry) => entry.name === "operator_allowlist");
    assert.equal(report.ok, true);
    assert.equal(check?.status, "pass");
    assert.match(check?.summary ?? "", /2 explicit/);
  });

  it("fails readiness when the operator actor allowlist contains malformed entries", () => {
    const report = buildRecruiterMcpReadinessReport({
      ...completeEnv(),
      OPERATOR_ACTOR_IDS: "900,nope,-3",
    } as NodeJS.ProcessEnv);

    const check = report.checks.find((entry) => entry.name === "operator_allowlist");
    assert.equal(report.ok, false);
    assert.equal(check?.status, "fail");
    assert.match(check?.summary ?? "", /positive Greenhouse user ids/);
    // Malformed allowlist entries must never be reflected back into the report. Anchor the
    // numeric token with a trailing word boundary so this leak-check cannot collide with an
    // unrelated substring such as the generatedAt date ("2026-06-30" contains "-30"); a real
    // echo of "-3" as a standalone value (followed by a quote/comma) is still caught.
    assert.doesNotMatch(JSON.stringify(report), /\bnope\b|-3\b/);
  });

  it("fails readiness when no supported remote desktop surface is configured", () => {
    const report = buildRecruiterMcpReadinessReport({
      ...completeEnv(),
      GREENHOUSE_RECRUITER_REMOTE_SURFACES: "mobile_app",
    } as NodeJS.ProcessEnv);

    const surfaceCheck = report.checks.find((check) => check.name === "remote_surfaces");
    assert.equal(report.ok, false);
    assert.equal(surfaceCheck?.status, "fail");
    assert.deepEqual(report.configuredSurfaces, []);
  });

  it("fails readiness instead of ignoring unsupported remote surface values", () => {
    const report = buildRecruiterMcpReadinessReport({
      ...completeEnv(),
      GREENHOUSE_RECRUITER_REMOTE_SURFACES: "chatgpt_desktop,mobile_app",
    } as NodeJS.ProcessEnv);

    const surfaceCheck = report.checks.find((check) => check.name === "remote_surfaces");
    assert.equal(report.ok, false);
    assert.equal(surfaceCheck?.status, "fail");
    assert.match(surfaceCheck?.summary ?? "", /unsupported values/);
    assert.deepEqual(report.configuredSurfaces, ["chatgpt_desktop"]);
  });

  it("fails readiness when remote surface config is not exact", () => {
    const whitespaceReport = buildRecruiterMcpReadinessReport({
      ...completeEnv(),
      GREENHOUSE_RECRUITER_REMOTE_SURFACES: "chatgpt_desktop, claude_desktop",
    } as NodeJS.ProcessEnv);
    const duplicateReport = buildRecruiterMcpReadinessReport({
      ...completeEnv(),
      GREENHOUSE_RECRUITER_REMOTE_SURFACES: "chatgpt_desktop,chatgpt_desktop",
    } as NodeJS.ProcessEnv);

    const whitespaceCheck = whitespaceReport.checks.find((check) => check.name === "remote_surfaces");
    const duplicateCheck = duplicateReport.checks.find((check) => check.name === "remote_surfaces");
    assert.equal(whitespaceReport.ok, false);
    assert.equal(whitespaceCheck?.status, "fail");
    assert.match(whitespaceCheck?.summary ?? "", /without whitespace/);
    assert.equal(duplicateReport.ok, false);
    assert.equal(duplicateCheck?.status, "fail");
    assert.match(duplicateCheck?.summary ?? "", /duplicates/);
  });

  it("fails readiness when hosted env contains desktop-only tokens or trusted preview targets", () => {
    const report = buildRecruiterMcpReadinessReport({
      ...completeEnv(),
      GREENHOUSE_RECRUITER_SESSION_TOKEN: "durable-user-token",
      GREENHOUSE_RECRUITER_REMOTE_AUTH_TOKEN: "remote-validation-token",
      GREENHOUSE_RECRUITER_REMOTE_READY_TOKEN: "remote-ready-validation-token",
      GREENHOUSE_RECRUITER_TRUSTED_ACT_AS_USER_ID: "321",
    } as NodeJS.ProcessEnv);

    const check = report.checks.find((entry) => entry.name === "hosted_env_hygiene");
    assert.equal(report.ok, false);
    assert.equal(check?.status, "fail");
    assert.match(check?.summary ?? "", /GREENHOUSE_RECRUITER_SESSION_TOKEN/);
    assert.match(check?.summary ?? "", /GREENHOUSE_RECRUITER_REMOTE_AUTH_TOKEN/);
    assert.match(check?.summary ?? "", /GREENHOUSE_RECRUITER_REMOTE_READY_TOKEN/);
    assert.match(check?.summary ?? "", /GREENHOUSE_RECRUITER_TRUSTED_ACT_AS_USER_ID/);
    assert.doesNotMatch(JSON.stringify(report), /durable-user-token|remote-validation-token|remote-ready-validation-token/);
  });

  it("fails readiness when remote test-surface sessions are enabled", () => {
    const report = buildRecruiterMcpReadinessReport({
      ...completeEnv(),
      GREENHOUSE_RECRUITER_ALLOW_TEST_SURFACE: "true",
    } as NodeJS.ProcessEnv);

    const check = report.checks.find((entry) => entry.name === "test_surface_disabled");
    assert.equal(report.ok, false);
    assert.equal(check?.status, "fail");
    assert.match(check?.summary ?? "", /must not be enabled/);
  });

  it("emits exactly the canonical readiness check catalog, in order (single-source-of-truth lock)", () => {
    // Locks RECRUITER_MCP_READINESS_CHECK_NAMES to the report's real output so the rollout gate's
    // catalog-derived REQUIRED_PRODUCTION_ENV_CHECKS can never silently drift from the actual checks.
    const report = buildRecruiterMcpReadinessReport(completeEnv(), () => Date.parse("2026-06-23T12:00:00.000Z"));
    assert.deepEqual(report.checks.map((entry) => entry.name), [...RECRUITER_MCP_READINESS_CHECK_NAMES]);
  });

  it("fails audit_sink when no durable mount is declared (verifies durable, not merely shaped)", () => {
    const report = buildRecruiterMcpReadinessReport({
      ...completeEnv(),
      GREENHOUSE_RECRUITER_AUDIT_DURABLE_MOUNT_PATH: undefined,
    } as NodeJS.ProcessEnv);
    const check = report.checks.find((entry) => entry.name === "audit_sink");
    assert.equal(report.ok, false);
    assert.equal(check?.status, "fail");
    assert.match(check?.summary ?? "", /GREENHOUSE_RECRUITER_AUDIT_DURABLE_MOUNT_PATH/);
  });

  it("fails audit_sink when the audit path is not under the declared durable mount", () => {
    const report = buildRecruiterMcpReadinessReport({
      ...completeEnv(),
      GREENHOUSE_RECRUITER_AUDIT_DURABLE_MOUNT_PATH: "/different-mount",
    } as NodeJS.ProcessEnv);
    const check = report.checks.find((entry) => entry.name === "audit_sink");
    assert.equal(report.ok, false);
    assert.equal(check?.status, "fail");
    assert.match(check?.summary ?? "", /must live under/);
  });
});

function completeEnv(): NodeJS.ProcessEnv {
  return {
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
    GREENHOUSE_RECRUITER_AUDIT_JSONL_PATH: "/secure/greenhouse-recruiter-audit.jsonl",
    GREENHOUSE_RECRUITER_AUDIT_DURABLE_MOUNT_PATH: "/secure",
    GREENHOUSE_RECRUITER_CORS_ORIGIN: "https://chatgpt.com,https://claude.ai",
    GREENHOUSE_RECRUITER_ALLOWED_TOOLS: PILOT_TOOL_NAMES.join(","),
    GREENHOUSE_RECRUITER_FORCE_PERMISSION_TTL_ZERO: "true",
    GREENHOUSE_RECRUITER_RATE_LIMIT_DISABLED: "false",
  } as NodeJS.ProcessEnv;
}
