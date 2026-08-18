import { isAbsolute, relative } from "node:path";
import type { RecruiterSurface } from "./types.js";
import { validateAuditJsonlPath } from "./audit.js";
import { MIN_SESSION_SECRET_LENGTH, hasLeadingOrTrailingWhitespace, isStrongSessionSecret } from "./auth.js";
import { readLookupTimeoutMs } from "./fetch-timeout.js";
import { readHttpBodyLimitBytes, readHttpEndpointConfig, readHttpServerTimeoutConfig } from "./http-request.js";
import { createRecruiterToolConfig, isToolEnabled, validateRecruiterToolLimitEnv } from "./limits.js";
import { validateRateLimiterEnv } from "./rate-limit.js";
import { assertCanonicalSupabaseProjectRef, normalizeOptionalSupabaseIdentifier, normalizeSupabaseApiKey } from "./supabase-config.js";
import { readBooleanEnvFlag, validateBooleanEnvFlags } from "./env.js";
import { parseCorsOrigins } from "./cors.js";
import { DEFAULT_REMOTE_SURFACES, parseRemoteSurfaceAllowlist } from "./surfaces.js";
import { GREENHOUSE_RECRUITER_STATE_BACKEND_ENV, SUPPORTED_STATE_BACKEND, readRecruiterStateBackend } from "./state-backend.js";
import { MIN_SCOPE_SIGNING_SECRET_LENGTH, SCOPE_SIGNING_SECRET_ENV } from "./resolvers/job-scope/scope-handle.js";
import { PILOT_TOOL_NAMES, RECRUITER_TOOL_DEFINITIONS } from "./tools/register.js";

export type ReadinessCheckStatus = "pass" | "warn" | "fail";

export interface ReadinessCheck {
  name: string;
  status: ReadinessCheckStatus;
  summary: string;
}

export interface RecruiterMcpReadinessReport {
  ok: boolean;
  status: "ready" | "not_ready";
  generatedAt: string;
  checks: ReadinessCheck[];
  configuredSurfaces: RecruiterSurface[];
}

export const MIN_READYZ_TOKEN_LENGTH = 32;

// Upper bound on the hosted permission-cache TTL (T1.2). Bounded so a fat-fingered value can't
// silently make permissions hours stale; 5 minutes ≪ any real Greenhouse-side revocation latency.
export const MAX_HOSTED_PERMISSION_TTL_MS = 300_000;

// Canonical, ordered list of every check `buildRecruiterMcpReadinessReport` emits, in emit order.
// SINGLE SOURCE OF TRUTH for the hosted readiness catalog: the rollout gate derives
// REQUIRED_PRODUCTION_ENV_CHECKS from this instead of hand-maintaining a parallel list that silently
// dropped `scope_signing_secret`. `readiness.test.ts` locks this constant to the report's actual
// output, so adding / removing / renaming a readiness check without updating this list fails the
// suite — the drift class cannot reopen.
export const RECRUITER_MCP_READINESS_CHECK_NAMES = [
  "boolean_env_flags",
  "server_enabled",
  "greenhouse_client_id",
  "greenhouse_client_secret",
  "session_secret",
  "scope_signing_secret",
  "detailed_readiness_auth",
  "state_backend",
  "token_revocation_source",
  "identity_directory",
  "audit_sink",
  "rate_limiter",
  "runtime_limits",
  "tool_catalog",
  "cors_origin_allowlist",
  "http_body_limit",
  "http_endpoint_config",
  "http_server_timeouts",
  "external_lookup_timeouts",
  "permission_freshness",
  "operator_allowlist",
  "remote_surfaces",
  "test_surface_disabled",
  "hosted_env_hygiene",
] as const;

const HOSTED_ENV_FORBIDDEN_VARS = [
  "GREENHOUSE_RECRUITER_SESSION_TOKEN",
  "GREENHOUSE_RECRUITER_REMOTE_AUTH_TOKEN",
  "GREENHOUSE_RECRUITER_REMOTE_READY_TOKEN",
  "GREENHOUSE_RECRUITER_ACTIVE_SESSION_TOKEN",
  "GREENHOUSE_RECRUITER_REVOKED_SESSION_TOKEN",
  "GREENHOUSE_RECRUITER_TRUSTED_ACT_AS_USER_ID",
];

export function buildRecruiterMcpReadinessReport(
  env: NodeJS.ProcessEnv = process.env,
  now: () => number = () => Date.now()
): RecruiterMcpReadinessReport {
  const checks: ReadinessCheck[] = [];
  checks.push(booleanEnvFlagSyntaxCheck(env));
  checks.push(booleanCheck("server_enabled", !readReadinessBooleanFlag(env, "GREENHOUSE_RECRUITER_MCP_DISABLED"), "Recruiter MCP server is enabled.", "Recruiter MCP server is disabled by GREENHOUSE_RECRUITER_MCP_DISABLED."));
  checks.push(greenhouseCredentialCheck("greenhouse_client_id", env.GREENHOUSE_CLIENT_ID, "GREENHOUSE_CLIENT_ID is configured."));
  checks.push(greenhouseCredentialCheck("greenhouse_client_secret", env.GREENHOUSE_CLIENT_SECRET, "GREENHOUSE_CLIENT_SECRET is configured."));
  checks.push(sessionSecretCheck(env));
  checks.push(scopeSigningSecretCheck(env));
  checks.push(readinessAuthCheck(env));
  checks.push(stateBackendCheck(env));
  checks.push(tokenRevocationSourceCheck(env));
  checks.push(identitySourceCheck(env));
  checks.push(auditSinkCheck(env));
  checks.push(rateLimiterCheck(env));
  checks.push(runtimeLimitCheck(env));
  checks.push(toolCatalogCheck(env));
  checks.push(corsOriginCheck(env));
  checks.push(httpBodyLimitCheck(env));
  checks.push(httpEndpointCheck(env));
  checks.push(httpServerTimeoutCheck(env));
  checks.push(externalLookupTimeoutCheck(env));
  checks.push(permissionFreshnessCheck(env));
  checks.push(operatorAllowlistCheck(env));
  const surfaceCheck = remoteSurfaceCheck(env);
  checks.push(surfaceCheck.check);
  checks.push(booleanCheck(
    "test_surface_disabled",
    !readReadinessBooleanFlag(env, "GREENHOUSE_RECRUITER_ALLOW_TEST_SURFACE"),
    "Remote test surface sessions are disabled.",
    "GREENHOUSE_RECRUITER_ALLOW_TEST_SURFACE must not be enabled for hosted recruiter MCP distribution."
  ));
  checks.push(hostedEnvHygieneCheck(env));
  const ok = checks.every((check) => check.status !== "fail");
  return {
    ok,
    status: ok ? "ready" : "not_ready",
    generatedAt: new Date(now()).toISOString(),
    checks,
    configuredSurfaces: surfaceCheck.surfaces,
  };
}

function greenhouseCredentialCheck(name: string, value: string | undefined, successSummary: string): ReadinessCheck {
  if (!hasEnvValue(value)) {
    return booleanCheck(name, false, successSummary, `${nameToEnv(name)} is required.`);
  }
  if (value.trim() !== value) {
    return {
      name,
      status: "fail",
      summary: `${nameToEnv(name)} must not contain leading or trailing whitespace.`,
    };
  }
  return booleanCheck(name, true, successSummary, `${nameToEnv(name)} is required.`);
}

function booleanCheck(name: string, ok: boolean, successSummary: string, failureSummary: string): ReadinessCheck {
  return { name, status: ok ? "pass" : "fail", summary: ok ? successSummary : failureSummary };
}

function booleanEnvFlagSyntaxCheck(env: NodeJS.ProcessEnv): ReadinessCheck {
  try {
    validateBooleanEnvFlags(env);
    return {
      name: "boolean_env_flags",
      status: "pass",
      summary: "Boolean environment flags are exact true/false values.",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      name: "boolean_env_flags",
      status: "fail",
      summary: message,
    };
  }
}

function readReadinessBooleanFlag(env: NodeJS.ProcessEnv, name: string): boolean {
  try {
    return readBooleanEnvFlag(env, name);
  } catch {
    return false;
  }
}

function stateBackendCheck(env: NodeJS.ProcessEnv): ReadinessCheck {
  try {
    const backend = readRecruiterStateBackend(env);
    if (backend === SUPPORTED_STATE_BACKEND) {
      return {
        name: "state_backend",
        status: "pass",
        summary: "Implemented recruiter state backend is configured: supabase_postgrest.",
      };
    }
    return {
      name: "state_backend",
      status: "fail",
      summary: `${GREENHOUSE_RECRUITER_STATE_BACKEND_ENV}=${SUPPORTED_STATE_BACKEND} is required for hosted recruiter MCP distribution.`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      name: "state_backend",
      status: "fail",
      summary: message,
    };
  }
}

function identitySourceCheck(env: NodeJS.ProcessEnv): ReadinessCheck {
  const rawJson = env.GREENHOUSE_RECRUITER_IDENTITY_JSON;
  const supabaseUrl = env.GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_URL;
  const supabaseKey = env.GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_KEY;
  if (rawJson) {
    try {
      const parsed = JSON.parse(rawJson) as unknown;
      if (!Array.isArray(parsed)) {
        return { name: "identity_directory", status: "fail", summary: "GREENHOUSE_RECRUITER_IDENTITY_JSON must be a JSON array." };
      }
      if (parsed.length === 0) {
        return { name: "identity_directory", status: "fail", summary: "GREENHOUSE_RECRUITER_IDENTITY_JSON is empty; no recruiter can resolve." };
      }
      if (readReadinessBooleanFlag(env, "GREENHOUSE_RECRUITER_ALLOW_STATIC_IDENTITY_FOR_DEV")) {
        return {
          name: "identity_directory",
          status: "fail",
          summary: "Static identity JSON is dev/test-only and cannot satisfy hosted org-distribution readiness; set an implemented state backend and Supabase/PostgREST identity env instead.",
        };
      }
      return {
        name: "identity_directory",
        status: "fail",
        summary: "GREENHOUSE_RECRUITER_IDENTITY_JSON is a pilot adapter and must not satisfy hosted org-distribution readiness; set Supabase/PostgREST identity env instead.",
      };
    } catch {
      return { name: "identity_directory", status: "fail", summary: "GREENHOUSE_RECRUITER_IDENTITY_JSON is not valid JSON." };
    }
  }
  if (hasEnvValue(supabaseUrl) || hasEnvValue(supabaseKey)) {
    if (!hasEnvValue(supabaseUrl) || !hasEnvValue(supabaseKey)) {
      return {
        name: "identity_directory",
        status: "fail",
        summary: "GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_URL and GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_KEY must be set together.",
      };
    }
    try {
      normalizeSupabaseApiKey(supabaseKey, "Supabase identity directory");
      validateSupabaseConfig({
        url: supabaseUrl,
        urlLabel: "Supabase identity directory",
        table: env.GREENHOUSE_RECRUITER_IDENTITY_TABLE,
        defaultTable: "recruiter_identity_directory",
        tableLabel: "Supabase identity directory table",
        identifiers: [
          [env.GREENHOUSE_RECRUITER_IDENTITY_GREENHOUSE_USER_ID_COLUMN, "greenhouse_user_id", "Supabase identity Greenhouse user id column"],
          // Validated for shape like the rest, not for existence: the directory tolerates a table
          // that has no row-id column (identity.ts) and only loses write eligibility for it. A
          // malformed override is still misconfiguration and still fails readiness.
          [env.GREENHOUSE_RECRUITER_IDENTITY_DIRECTORY_ID_COLUMN, "id", "Supabase identity directory id column"],
          [env.GREENHOUSE_RECRUITER_IDENTITY_EMAIL_COLUMN, "primary_email", "Supabase identity email column"],
          [env.GREENHOUSE_RECRUITER_IDENTITY_SUBJECT_COLUMN, "google_subject", "Supabase identity subject column"],
          [env.GREENHOUSE_RECRUITER_IDENTITY_STATUS_COLUMN, "status", "Supabase identity status column"],
        ],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { name: "identity_directory", status: "fail", summary: message };
    }
    return { name: "identity_directory", status: "pass", summary: "Supabase identity directory is configured." };
  }
  return {
    name: "identity_directory",
    status: "fail",
    summary: "A production recruiter identity source is required: GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_URL and GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_KEY.",
  };
}

function sessionSecretCheck(env: NodeJS.ProcessEnv): ReadinessCheck {
  const value = env.GREENHOUSE_RECRUITER_SESSION_SECRET;
  if (!value || value.trim().length === 0) {
    return { name: "session_secret", status: "fail", summary: "GREENHOUSE_RECRUITER_SESSION_SECRET is required." };
  }
  if (hasLeadingOrTrailingWhitespace(value)) {
    return {
      name: "session_secret",
      status: "fail",
      summary: "GREENHOUSE_RECRUITER_SESSION_SECRET must not contain leading or trailing whitespace.",
    };
  }
  if (!isStrongSessionSecret(value)) {
    return {
      name: "session_secret",
      status: "fail",
      summary: `GREENHOUSE_RECRUITER_SESSION_SECRET must be at least ${MIN_SESSION_SECRET_LENGTH} characters.`,
    };
  }
  return { name: "session_secret", status: "pass", summary: "GREENHOUSE_RECRUITER_SESSION_SECRET is configured with sufficient length." };
}

function scopeSigningSecretCheck(env: NodeJS.ProcessEnv): ReadinessCheck {
  const value = env[SCOPE_SIGNING_SECRET_ENV];
  if (!value || value.trim().length === 0) {
    return {
      name: "scope_signing_secret",
      status: "fail",
      summary: `${SCOPE_SIGNING_SECRET_ENV} is required for hosted multi-instance scope_handle and confirmation_token validation.`,
    };
  }
  if (value.trim() !== value) {
    return {
      name: "scope_signing_secret",
      status: "fail",
      summary: `${SCOPE_SIGNING_SECRET_ENV} must not contain leading or trailing whitespace.`,
    };
  }
  if (value.length < MIN_SCOPE_SIGNING_SECRET_LENGTH) {
    return {
      name: "scope_signing_secret",
      status: "fail",
      summary: `${SCOPE_SIGNING_SECRET_ENV} must be at least ${MIN_SCOPE_SIGNING_SECRET_LENGTH} characters.`,
    };
  }
  return {
    name: "scope_signing_secret",
    status: "pass",
    summary: `${SCOPE_SIGNING_SECRET_ENV} is configured for hosted scope artifacts.`,
  };
}

function readinessAuthCheck(env: NodeJS.ProcessEnv): ReadinessCheck {
  if (readReadinessBooleanFlag(env, "GREENHOUSE_RECRUITER_ALLOW_PUBLIC_READYZ_FOR_DEV")) {
    return {
      name: "detailed_readiness_auth",
      status: "fail",
      summary: "GREENHOUSE_RECRUITER_ALLOW_PUBLIC_READYZ_FOR_DEV must not be enabled for hosted recruiter MCP distribution.",
    };
  }
  const value = env.GREENHOUSE_RECRUITER_READYZ_TOKEN;
  const trimmed = value?.trim();
  if (!trimmed) {
    return {
      name: "detailed_readiness_auth",
      status: "fail",
      summary: "GREENHOUSE_RECRUITER_READYZ_TOKEN is required to protect detailed hosted readiness output.",
    };
  }
  if (trimmed !== value) {
    return {
      name: "detailed_readiness_auth",
      status: "fail",
      summary: "GREENHOUSE_RECRUITER_READYZ_TOKEN must not contain leading or trailing whitespace.",
    };
  }
  if (trimmed.length < MIN_READYZ_TOKEN_LENGTH) {
    return {
      name: "detailed_readiness_auth",
      status: "fail",
      summary: `GREENHOUSE_RECRUITER_READYZ_TOKEN must be at least ${MIN_READYZ_TOKEN_LENGTH} characters.`,
    };
  }
  return {
    name: "detailed_readiness_auth",
    status: "pass",
    summary: "Detailed hosted readiness output is protected by a separate bearer token.",
  };
}

function tokenRevocationSourceCheck(env: NodeJS.ProcessEnv): ReadinessCheck {
  const supabaseUrl = env.GREENHOUSE_RECRUITER_REVOCATION_SUPABASE_URL;
  const supabaseKey = env.GREENHOUSE_RECRUITER_REVOCATION_SUPABASE_KEY;
  if (!hasEnvValue(supabaseUrl) && !hasEnvValue(supabaseKey)) {
    return {
      name: "token_revocation_source",
      status: "fail",
      summary: "A production token revocation source is required: GREENHOUSE_RECRUITER_REVOCATION_SUPABASE_URL and GREENHOUSE_RECRUITER_REVOCATION_SUPABASE_KEY.",
    };
  }
  if (!hasEnvValue(supabaseUrl) || !hasEnvValue(supabaseKey)) {
    return {
      name: "token_revocation_source",
      status: "fail",
      summary: "GREENHOUSE_RECRUITER_REVOCATION_SUPABASE_URL and GREENHOUSE_RECRUITER_REVOCATION_SUPABASE_KEY must be set together.",
    };
  }
  try {
    normalizeSupabaseApiKey(supabaseKey, "Supabase token revocation");
    validateSupabaseConfig({
      url: supabaseUrl,
      urlLabel: "Supabase token revocation",
      table: env.GREENHOUSE_RECRUITER_REVOCATION_TABLE,
      defaultTable: "recruiter_mcp_session_revocation",
      tableLabel: "Supabase session revocation table",
      identifiers: [
        [env.GREENHOUSE_RECRUITER_REVOCATION_TOKEN_ID_COLUMN, "token_id", "Supabase session revocation token id column"],
        [env.GREENHOUSE_RECRUITER_REVOCATION_STATUS_COLUMN, "status", "Supabase session revocation status column"],
        [env.GREENHOUSE_RECRUITER_REVOCATION_REVOKED_AT_COLUMN, "revoked_at", "Supabase session revocation revoked-at column"],
        [env.GREENHOUSE_RECRUITER_REVOCATION_REVOKED_BY_COLUMN, "revoked_by", "Supabase session revocation revoked-by column"],
        [env.GREENHOUSE_RECRUITER_REVOCATION_REASON_COLUMN, "reason", "Supabase session revocation reason column"],
        [env.GREENHOUSE_RECRUITER_REVOCATION_EVIDENCE_DETAIL_COLUMN, "evidence_detail", "Supabase session revocation evidence-detail column"],
      ],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { name: "token_revocation_source", status: "fail", summary: message };
  }
  return {
    name: "token_revocation_source",
    status: "pass",
    summary: "Supabase token revocation source is configured for durable-session kill switches.",
  };
}

function auditSinkCheck(env: NodeJS.ProcessEnv): ReadinessCheck {
  const value = env.GREENHOUSE_RECRUITER_AUDIT_JSONL_PATH;
  if (!value || value.trim().length === 0) {
    return {
      name: "audit_sink",
      status: "fail",
      summary: "GREENHOUSE_RECRUITER_AUDIT_JSONL_PATH is required for hosted recruiter MCP distribution.",
    };
  }
  let normalizedAuditPath: string;
  try {
    normalizedAuditPath = validateAuditJsonlPath(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      name: "audit_sink",
      status: "fail",
      summary: message,
    };
  }
  // Durability: a shaped absolute .jsonl path is not enough — on an ephemeral container filesystem
  // (the default for a redeploy) the retained audit trail is lost. The operator must DECLARE the
  // durable mount (the EFS volume mounted at /app/audit in the AWS pilot), and the audit path must
  // resolve under it. This is stronger than "merely shaped" (a /tmp-style path with no declared mount
  // fails), but it verifies the DECLARATION + containment, not physical attachment — confirm the
  // volume is actually mounted at deploy (df/mount). See the FLAG in the Slice I commit message.
  const durabilityResult = auditDurabilityResult(env, normalizedAuditPath);
  if (durabilityResult) {
    return durabilityResult;
  }
  return {
    name: "audit_sink",
    status: "pass",
    summary: "Retained JSONL audit sink is configured on the declared durable mount.",
  };
}

export const AUDIT_DURABLE_MOUNT_PATH_ENV = "GREENHOUSE_RECRUITER_AUDIT_DURABLE_MOUNT_PATH";

// Returns a failing ReadinessCheck when the audit sink is not configured under a declared durable
// mount, or null when it is. Durable here = the operator declared a mount and the audit path resolves
// under it (the DECLARATION; physical attachment is a deploy-time check). Pure path math (no
// filesystem I/O), so it is safe to run per readiness request / per /mcp gate.
function auditDurabilityResult(env: NodeJS.ProcessEnv, normalizedAuditPath: string): ReadinessCheck | null {
  const rawMount = env[AUDIT_DURABLE_MOUNT_PATH_ENV];
  if (!rawMount || rawMount.trim().length === 0) {
    return {
      name: "audit_sink",
      status: "fail",
      summary: `${AUDIT_DURABLE_MOUNT_PATH_ENV} is required so the retained audit sink is routed to declared durable storage (e.g. a mounted EFS/persistent volume) rather than left on the ephemeral container filesystem.`,
    };
  }
  const mount = rawMount.trim();
  if (mount !== rawMount || !isAbsolute(mount)) {
    return {
      name: "audit_sink",
      status: "fail",
      summary: `${AUDIT_DURABLE_MOUNT_PATH_ENV} must be an absolute path to the durable mount with no surrounding whitespace.`,
    };
  }
  if (!isPathUnderDurableMount(normalizedAuditPath, mount)) {
    return {
      name: "audit_sink",
      status: "fail",
      summary: `GREENHOUSE_RECRUITER_AUDIT_JSONL_PATH must live under ${AUDIT_DURABLE_MOUNT_PATH_ENV} so retained audit records survive a redeploy.`,
    };
  }
  return null;
}

function isPathUnderDurableMount(auditPath: string, mount: string): boolean {
  const rel = relative(mount, auditPath);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

// True only when the audit path is configured under the declared durable mount (the durability
// DECLARATION; physical attachment is verified at deploy). Exported for the per-request /mcp gate
// (remote.ts), which refuses scoped reads when the audit sink is not declared durable. Path-presence
// and path-shape are gated separately (audit_sink check / the request audit preflight); this isolates
// the durability dimension. Pure path math, no I/O.
export function isAuditSinkDurable(env: NodeJS.ProcessEnv): boolean {
  const value = env.GREENHOUSE_RECRUITER_AUDIT_JSONL_PATH;
  if (!value || value.trim().length === 0) return false;
  let normalizedAuditPath: string;
  try {
    normalizedAuditPath = validateAuditJsonlPath(value);
  } catch {
    return false;
  }
  return auditDurabilityResult(env, normalizedAuditPath) === null;
}

function rateLimiterCheck(env: NodeJS.ProcessEnv): ReadinessCheck {
  if (readReadinessBooleanFlag(env, "GREENHOUSE_RECRUITER_RATE_LIMIT_DISABLED")) {
    return {
      name: "rate_limiter",
      status: "fail",
      summary: "GREENHOUSE_RECRUITER_RATE_LIMIT_DISABLED must not be true for hosted recruiter MCP distribution.",
    };
  }
  try {
    validateRateLimiterEnv(env);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      name: "rate_limiter",
      status: "fail",
      summary: message,
    };
  }
  return {
    name: "rate_limiter",
    status: "pass",
    summary: "Per-session rate limiting is enabled before scoped Greenhouse reads.",
  };
}

function runtimeLimitCheck(env: NodeJS.ProcessEnv): ReadinessCheck {
  try {
    validateRecruiterToolLimitEnv(env);
    return {
      name: "runtime_limits",
      status: "pass",
      summary: "Recruiter MCP runtime row, page, ranking, lookback, and duration limits are valid.",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      name: "runtime_limits",
      status: "fail",
      summary: message,
    };
  }
}

function toolCatalogCheck(env: NodeJS.ProcessEnv): ReadinessCheck {
  try {
    const config = createRecruiterToolConfig(env, RECRUITER_TOOL_DEFINITIONS.map((tool) => tool.name));
    const expected: readonly string[] = PILOT_TOOL_NAMES;
    const activeBySurface = (["claude_desktop", "chatgpt_desktop"] as const).map((surface) => ({
      surface,
      names: RECRUITER_TOOL_DEFINITIONS
        .filter((tool) => isToolEnabled(config, surface, tool.name, tool.kind))
        .map((tool) => tool.name)
        .sort((left, right) => expected.indexOf(left) - expected.indexOf(right)),
    }));
    const mismatched = activeBySurface.filter(({ names }) =>
      names.length !== expected.length || names.some((name, index) => name !== expected[index])
    );
    if (mismatched.length > 0) {
      return {
        name: "tool_catalog",
        status: "fail",
        summary: `Hosted recruiter MCP must expose the exact ordered ${expected.length}-tool production allowlist on every desktop surface.`,
      };
    }
    return {
      name: "tool_catalog",
      status: "pass",
      summary: `Recruiter MCP tool controls resolve to the exact ordered ${expected.length}-tool production allowlist on every desktop surface.`,
    };
  } catch (error) {
    return {
      name: "tool_catalog",
      status: "fail",
      summary: error instanceof Error ? error.message : String(error),
    };
  }
}

function corsOriginCheck(env: NodeJS.ProcessEnv): ReadinessCheck {
  const raw = env.GREENHOUSE_RECRUITER_CORS_ORIGIN;
  if (raw === undefined || raw.length === 0) {
    return {
      name: "cors_origin_allowlist",
      status: "fail",
      summary: "GREENHOUSE_RECRUITER_CORS_ORIGIN is required for hosted recruiter MCP browser-origin distribution.",
    };
  }
  const parsed = parseCorsOrigins(raw);
  if (parsed.invalid.includes("*")) {
    return {
      name: "cors_origin_allowlist",
      status: "fail",
      summary: "GREENHOUSE_RECRUITER_CORS_ORIGIN must not use wildcard '*' for hosted recruiter MCP distribution.",
    };
  }
  if (parsed.invalid.length > 0) {
    return {
      name: "cors_origin_allowlist",
      status: "fail",
      summary: "GREENHOUSE_RECRUITER_CORS_ORIGIN must contain exact comma-separated HTTPS origins without whitespace, duplicates, wildcard values, paths, query strings, fragments, or non-HTTPS origins.",
    };
  }
  if (parsed.origins.length === 0) {
    return {
      name: "cors_origin_allowlist",
      status: "fail",
      summary: "GREENHOUSE_RECRUITER_CORS_ORIGIN must include at least one approved desktop or broker origin.",
    };
  }
  return {
    name: "cors_origin_allowlist",
    status: "pass",
    summary: "Hosted browser-origin CORS allowlist is explicit and non-wildcard.",
  };
}

function externalLookupTimeoutCheck(env: NodeJS.ProcessEnv): ReadinessCheck {
  try {
    readLookupTimeoutMs(
      env.GREENHOUSE_RECRUITER_IDENTITY_LOOKUP_TIMEOUT_MS,
      "GREENHOUSE_RECRUITER_IDENTITY_LOOKUP_TIMEOUT_MS"
    );
    readLookupTimeoutMs(
      env.GREENHOUSE_RECRUITER_REVOCATION_LOOKUP_TIMEOUT_MS,
      "GREENHOUSE_RECRUITER_REVOCATION_LOOKUP_TIMEOUT_MS"
    );
    return {
      name: "external_lookup_timeouts",
      status: "pass",
      summary: "Identity and revocation lookup timeout configuration is valid.",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      name: "external_lookup_timeouts",
      status: "fail",
      summary: message,
    };
  }
}

function httpBodyLimitCheck(env: NodeJS.ProcessEnv): ReadinessCheck {
  try {
    const maxBytes = readHttpBodyLimitBytes(env);
    return {
      name: "http_body_limit",
      status: "pass",
      summary: `Hosted MCP POST body limit is ${maxBytes} bytes.`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      name: "http_body_limit",
      status: "fail",
      summary: message,
    };
  }
}

function httpEndpointCheck(env: NodeJS.ProcessEnv): ReadinessCheck {
  try {
    const config = readHttpEndpointConfig(env);
    return {
      name: "http_endpoint_config",
      status: "pass",
      summary: `Hosted HTTP endpoint routes are valid: mcp=${config.mcpPath}, health=${config.healthPath}, readiness=${config.readyPath}.`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      name: "http_endpoint_config",
      status: "fail",
      summary: message,
    };
  }
}

function httpServerTimeoutCheck(env: NodeJS.ProcessEnv): ReadinessCheck {
  try {
    const config = readHttpServerTimeoutConfig(env);
    return {
      name: "http_server_timeouts",
      status: "pass",
      summary: `Hosted HTTP incoming request timeouts are configured: headers=${config.headersTimeoutMs}ms, request=${config.requestTimeoutMs}ms, keepAlive=${config.keepAliveTimeoutMs}ms.`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      name: "http_server_timeouts",
      status: "fail",
      summary: message,
    };
  }
}

function validateSupabaseConfig(input: {
  url: string;
  urlLabel: string;
  table: string | undefined;
  defaultTable: string;
  tableLabel: string;
  identifiers: Array<[string | undefined, string, string]>;
}): void {
  assertCanonicalSupabaseProjectRef(input.url, input.urlLabel);
  normalizeOptionalSupabaseIdentifier(input.table, input.defaultTable, input.tableLabel);
  for (const [value, fallback, label] of input.identifiers) {
    normalizeOptionalSupabaseIdentifier(value, fallback, label);
  }
}

function permissionFreshnessCheck(env: NodeJS.ProcessEnv): ReadinessCheck {
  if (readReadinessBooleanFlag(env, "GREENHOUSE_RECRUITER_FORCE_PERMISSION_TTL_ZERO")) {
    return {
      name: "permission_freshness",
      status: "pass",
      summary: "Permission cache TTL is forced to zero for hosted rollout freshness.",
    };
  }
  const raw = env.GREENHOUSE_RECRUITER_PERMISSION_TTL_MS;
  if (raw === undefined || raw.trim().length === 0) {
    return {
      name: "permission_freshness",
      status: "pass",
      summary: "Permission cache TTL is the bounded 60000ms default; revocation still applies per request and session identity resolves fresh per call.",
    };
  }
  if (raw.trim() !== raw || !/^\d+$/.test(raw)) {
    return {
      name: "permission_freshness",
      status: "fail",
      summary: "GREENHOUSE_RECRUITER_PERMISSION_TTL_MS must be a non-negative safe integer and should be 0 for hosted distribution.",
    };
  }
  if (raw === "0") {
    return {
      name: "permission_freshness",
      status: "pass",
      summary: "Permission cache TTL is zero; Greenhouse job permissions are resolved fresh per scoped read.",
    };
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed)) {
    return {
      name: "permission_freshness",
      status: "fail",
      summary: "GREENHOUSE_RECRUITER_PERMISSION_TTL_MS must be a non-negative safe integer and should be 0 for hosted distribution.",
    };
  }
  // A bounded short TTL is an accepted hosted posture (T1.2): Greenhouse deactivation does not
  // revoke user_job_permissions anyway (the vendored contract), so a ≤5-minute cache gives up no
  // real freshness while collapsing the per-page permission re-sweep that feeds the shared-token
  // 429 cascade. Anything above the bound still fails closed.
  if (parsed <= MAX_HOSTED_PERMISSION_TTL_MS) {
    return {
      name: "permission_freshness",
      status: "pass",
      summary: `Permission cache TTL is ${parsed}ms (bounded ≤${MAX_HOSTED_PERMISSION_TTL_MS}ms); revocation still applies per request and session identity resolves fresh per call.`,
    };
  }
  return {
    name: "permission_freshness",
    status: "fail",
    summary: `GREENHOUSE_RECRUITER_PERMISSION_TTL_MS must be ≤${MAX_HOSTED_PERMISSION_TTL_MS}ms (or 0 / forced zero) for hosted recruiter MCP distribution.`,
  };
}

function operatorAllowlistCheck(env: NodeJS.ProcessEnv): ReadinessCheck {
  const raw = env.OPERATOR_ACTOR_IDS;
  if (raw === undefined || raw.trim().length === 0) {
    return {
      name: "operator_allowlist",
      status: "pass",
      summary: "No operator actors are configured for unscoped passthrough.",
    };
  }
  const tokens = raw.split(",").map((token) => token.trim()).filter(Boolean);
  const invalid = tokens.filter((token) => !/^[1-9]\d*$/.test(token));
  if (invalid.length > 0) {
    return {
      name: "operator_allowlist",
      status: "fail",
      summary: "OPERATOR_ACTOR_IDS must contain only comma-separated positive Greenhouse user ids.",
    };
  }
  return {
    name: "operator_allowlist",
    status: "pass",
    summary: `Operator unscoped passthrough allowlist contains ${tokens.length} explicit Greenhouse user id(s).`,
  };
}

function hostedEnvHygieneCheck(env: NodeJS.ProcessEnv): ReadinessCheck {
  const present = HOSTED_ENV_FORBIDDEN_VARS.filter((name) => {
    const value = env[name];
    return typeof value === "string" && value.trim().length > 0;
  });
  if (present.length === 0) {
    return {
      name: "hosted_env_hygiene",
      status: "pass",
      summary: "Hosted server environment does not contain desktop-only session tokens or trusted preview targets.",
    };
  }
  return {
    name: "hosted_env_hygiene",
    status: "fail",
    summary: `Remove desktop/validation-only environment variable(s) from the hosted server: ${present.join(", ")}.`,
  };
}

function remoteSurfaceCheck(env: NodeJS.ProcessEnv): { check: ReadinessCheck; surfaces: RecruiterSurface[] } {
  const parsed = parseRemoteSurfaceAllowlist(env.GREENHOUSE_RECRUITER_REMOTE_SURFACES);
  if (!parsed.configured) {
    return {
      check: { name: "remote_surfaces", status: "pass", summary: "Default remote surfaces are enabled: chatgpt_desktop, claude_desktop." },
      surfaces: DEFAULT_REMOTE_SURFACES,
    };
  }
  if (parsed.invalid.length > 0) {
    return {
      check: {
        name: "remote_surfaces",
        status: "fail",
        summary: "GREENHOUSE_RECRUITER_REMOTE_SURFACES must contain exact comma-separated supported surfaces without whitespace, empty entries, duplicates, or unsupported values.",
      },
      surfaces: parsed.surfaces,
    };
  }
  if (parsed.surfaces.length === 0) {
    return {
      check: { name: "remote_surfaces", status: "fail", summary: "GREENHOUSE_RECRUITER_REMOTE_SURFACES contains no supported surfaces." },
      surfaces: [],
    };
  }
  return {
    check: {
      name: "remote_surfaces",
      status: "pass",
      summary: `Configured remote surfaces: ${parsed.surfaces.join(", ")}.`,
    },
    surfaces: parsed.surfaces,
  };
}

function nameToEnv(name: string): string {
  switch (name) {
    case "greenhouse_client_id": return "GREENHOUSE_CLIENT_ID";
    case "greenhouse_client_secret": return "GREENHOUSE_CLIENT_SECRET";
    case "session_secret": return "GREENHOUSE_RECRUITER_SESSION_SECRET";
    default: return name.toUpperCase();
  }
}

function hasEnvValue(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
