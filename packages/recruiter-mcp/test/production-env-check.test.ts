import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseProductionEnvFile, runProductionEnvCheck } from "../src/production-env-check.js";
import { PILOT_TOOL_NAMES } from "../src/tools/register.js";

const STRONG_SESSION_SECRET = "session-secret-value-with-at-least-32-chars";
const STRONG_SCOPE_SIGNING_SECRET = "scope-signing-secret-value-at-least-32-chars";
const READYZ_TOKEN = "readiness-token-value-with-at-least-32-chars";

describe("production env preflight", () => {
  it("validates an exact env file without exposing secret values", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-production-env-check-"));
    const envFile = join(dir, "production.env");
    await writeFile(envFile, productionEnvText(), "utf8");

    const report = await runProductionEnvCheck({
      envFile,
      now: () => Date.parse("2026-06-23T12:00:00.000Z"),
    });

    assert.equal(report.ok, true);
    assert.equal(report.status, "ready");
    assert.equal(report.source, "env_file");
    assert.equal(report.envFile, envFile);
    assert.deepEqual(report.configuredSurfaces, ["chatgpt_desktop", "claude_desktop"]);
    const serialized = JSON.stringify(report);
    assert.doesNotMatch(serialized, /client-secret-value/);
    assert.doesNotMatch(serialized, /session-secret-value/);
    assert.doesNotMatch(serialized, /scope-signing-secret-value/);
    assert.doesNotMatch(serialized, /readiness-token-value/);
    assert.doesNotMatch(serialized, /service-role-key-value/);
    assert.doesNotMatch(serialized, /revocation-key-value/);
  });

  it("validates process env when no env file is supplied", async () => {
    const report = await runProductionEnvCheck({
      env: completeEnv(),
      now: () => Date.parse("2026-06-23T12:00:00.000Z"),
    });

    assert.equal(report.ok, true);
    assert.equal(report.status, "ready");
    assert.equal(report.source, "process_env");
    assert.equal(report.envFile, undefined);
  });

  it("does not merge process env values into env-file validation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-production-env-check-"));
    const envFile = join(dir, "production.env");
    await writeFile(envFile, productionEnvText(), "utf8");

    const report = await runProductionEnvCheck({
      envFile,
      env: {
        ...completeEnv(),
        GREENHOUSE_RECRUITER_SESSION_TOKEN: "desktop-token-that-must-not-contaminate-file-check",
      } as NodeJS.ProcessEnv,
    });

    assert.equal(report.ok, true);
    assert.equal(report.checks.find((check) => check.name === "hosted_env_hygiene")?.status, "pass");
  });

  it("rejects malformed env file lines without echoing values", () => {
    assert.throws(
      () => parseProductionEnvFile("GREENHOUSE_CLIENT_SECRET=super-secret\n BAD=value\n", "production.env"),
      /production\.env:2: environment entries must not contain leading or trailing whitespace\./
    );
    assert.throws(
      () => parseProductionEnvFile("export GREENHOUSE_CLIENT_SECRET=super-secret\n", "production.env"),
      /production\.env:1: export syntax is not supported/
    );
    assert.throws(
      () => parseProductionEnvFile("GREENHOUSE_CLIENT_SECRET=one\nGREENHOUSE_CLIENT_SECRET=two\n", "production.env"),
      /production\.env:2: duplicate environment key GREENHOUSE_CLIENT_SECRET\./
    );
    assert.throws(
      () => parseProductionEnvFile("GREENHOUSE_CLIENT_SECRET=\"super-secret\"\n", "production.env"),
      /production\.env:1: quoted values are not supported/
    );
  });

  it("preserves values exactly after the first equals sign", () => {
    const parsed = parseProductionEnvFile("# comment\n  # indented comment\nTOKEN=value=with=equals\nEMPTY=\n", "production.env");

    assert.deepEqual(parsed, {
      TOKEN: "value=with=equals",
      EMPTY: "",
    });
  });
});

function productionEnvText(): string {
  return `${Object.entries(completeEnv()).map(([key, value]) => `${key}=${value ?? ""}`).join("\n")}\n`;
}

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
