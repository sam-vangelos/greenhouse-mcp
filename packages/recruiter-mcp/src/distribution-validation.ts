import { isClientSurfaceCompatible, isRecruiterClient, normalizeSessionIssuedAt, normalizeSessionTokenId } from "./auth.js";
import type { RecruiterClient, RecruiterSurface } from "./types.js";
import { createRecruiterToolConfig, isToolEnabled } from "./limits.js";
import { compareRecruiterToolNames, PILOT_TOOL_NAMES, RECRUITER_TOOL_DEFINITIONS } from "./tools/register.js";
import { RECRUITER_MCP_READINESS_CHECK_NAMES } from "./readiness.js";

export interface DistributionValidationCheck {
  name: string;
  status: "pass" | "fail";
  summary: string;
  details?: Record<string, unknown>;
}

export interface DistributionValidationReport {
  ok: boolean;
  status: "ready" | "not_ready";
  checkedAt: string;
  mcpUrl: string;
  healthUrl: string;
  readinessUrl: string;
  versionUrl: string;
  expectedCommit?: string;
  observedCommit?: string;
  sessionSurface?: RecruiterSurface;
  sessionClient?: RecruiterClient;
  sessionTokenId?: string;
  sessionIssuedAt?: string;
  checks: DistributionValidationCheck[];
  toolNames: string[];
}

export interface RemoteDistributionValidationOptions {
  mcpUrl: string;
  token?: string;
  healthUrl?: string;
  readinessUrl?: string;
  readinessToken?: string;
  versionUrl?: string;
  expectedCommit?: string;
  expectedToolNames?: string[];
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

const DEFAULT_MCP_URL = "http://127.0.0.1:3333/mcp";
const DEFAULT_EXPECTED_TOOL_NAMES = [...PILOT_TOOL_NAMES];
const FORBIDDEN_TOOL_PATTERNS = [
  new RegExp("^" + "patch" + "_"),
  exactToolName("reject", "application"),
  exactToolName("move", "application", "to", "stage"),
  exactToolName("create", "offer", "draft"),
  exactToolName("update", "application", "assignment"),
  new RegExp("^" + "api" + "Post" + "$"),
  new RegExp("^" + "api" + "Patch" + "$"),
  new RegExp("^" + "api" + "Delete" + "$"),
];

export async function runRemoteDistributionValidation(
  options: RemoteDistributionValidationOptions
): Promise<DistributionValidationReport> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const mcpUrl = normalizeUrl(options.mcpUrl || DEFAULT_MCP_URL);
  const healthUrl = normalizeUrl(options.healthUrl ?? siblingUrl(mcpUrl, "/healthz"));
  const readinessUrl = normalizeUrl(options.readinessUrl ?? siblingUrl(mcpUrl, "/readyz"));
  const versionUrl = normalizeUrl(options.versionUrl ?? siblingUrl(mcpUrl, "/version"));
  const checks: DistributionValidationCheck[] = [];
  const toolNames: string[] = [];
  const sessionMetadata = readSessionMetadataFromToken(options.token);

  if (!options.token) {
    checks.push({ name: "auth_token", status: "fail", summary: "A durable recruiter session token is required for remote MCP validation." });
    return report(options, mcpUrl, healthUrl, readinessUrl, versionUrl, checks, toolNames, sessionMetadata);
  }

  const metadataCheck = validateSessionMetadata(sessionMetadata);
  checks.push(metadataCheck);
  if (metadataCheck.status === "fail") {
    return report(options, mcpUrl, healthUrl, readinessUrl, versionUrl, checks, toolNames, sessionMetadata);
  }

  checks.push(await validateHealth(fetchImpl, healthUrl));
  checks.push(await validateReadinessProtection(fetchImpl, readinessUrl));
  checks.push(await validateReadiness(fetchImpl, readinessUrl, options.readinessToken));
  const versionCheck = await validateVersion(fetchImpl, versionUrl, options.expectedCommit);
  checks.push(versionCheck.check);

  const initialize = await postMcp(fetchImpl, mcpUrl, options.token, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "greenhouse-recruiter-distribution-validation", version: "0.1.0" },
    },
  });
  checks.push(validateInitialize(initialize));

  const toolList = await postMcp(fetchImpl, mcpUrl, options.token, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  });
  const extracted = extractToolNames(toolList);
  toolNames.push(...extracted.toolNames);
  checks.push(extracted.check);
  checks.push(...validateRemoteToolCatalog(toolNames, options.expectedToolNames ?? DEFAULT_EXPECTED_TOOL_NAMES));
  checks.push(validateRemoteToolAnnotations(extracted.tools));

  return report(options, mcpUrl, healthUrl, readinessUrl, versionUrl, checks, toolNames, sessionMetadata, versionCheck.observedCommit);
}

export async function runRemoteDistributionValidationFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: Pick<RemoteDistributionValidationOptions, "fetchImpl" | "now"> = {}
): Promise<DistributionValidationReport> {
  const token = env.GREENHOUSE_RECRUITER_REMOTE_AUTH_TOKEN ?? env.GREENHOUSE_RECRUITER_SESSION_TOKEN;
  return runRemoteDistributionValidation({
    mcpUrl: env.GREENHOUSE_RECRUITER_REMOTE_MCP_URL ?? DEFAULT_MCP_URL,
    healthUrl: env.GREENHOUSE_RECRUITER_REMOTE_HEALTH_URL,
    readinessUrl: env.GREENHOUSE_RECRUITER_REMOTE_READY_URL,
    readinessToken: env.GREENHOUSE_RECRUITER_REMOTE_READY_TOKEN ?? env.GREENHOUSE_RECRUITER_READYZ_TOKEN,
    versionUrl: env.GREENHOUSE_RECRUITER_REMOTE_VERSION_URL,
    expectedCommit: env.GREENHOUSE_RECRUITER_EXPECTED_COMMIT_SHA,
    token,
    expectedToolNames: expectedToolNamesFromEnv(env, token),
    fetchImpl: options.fetchImpl,
    now: options.now,
  });
}

function expectedToolNamesFromEnv(env: NodeJS.ProcessEnv, token: string | undefined): string[] {
  const explicit = parseNameList(env.GREENHOUSE_RECRUITER_VALIDATE_EXPECT_TOOLS);
  if (explicit) return explicit;
  const hasRuntimeCatalogControls = [
    "GREENHOUSE_RECRUITER_ALLOWED_TOOLS",
    "GREENHOUSE_RECRUITER_DISABLE_TOOLS",
    "GREENHOUSE_RECRUITER_DISABLE_EVIDENCE",
    "GREENHOUSE_RECRUITER_DISABLE_ANALYTICS",
    "GREENHOUSE_RECRUITER_DISABLE_CLAUDE_DESKTOP",
    "GREENHOUSE_RECRUITER_DISABLE_CHATGPT_DESKTOP",
    "GREENHOUSE_RECRUITER_MCP_DISABLED",
  ].some((name) => env[name] !== undefined);
  if (!hasRuntimeCatalogControls) return DEFAULT_EXPECTED_TOOL_NAMES;
  const config = createRecruiterToolConfig(env, RECRUITER_TOOL_DEFINITIONS.map((tool) => tool.name));
  const surface = readSessionMetadataFromToken(token).surface ?? "claude_desktop";
  return RECRUITER_TOOL_DEFINITIONS
    .filter((tool) => isToolEnabled(config, surface, tool.name, tool.kind))
    .sort((left, right) => compareRecruiterToolNames(left.name, right.name))
    .map((tool) => tool.name);
}

export function validateRemoteToolCatalog(
  toolNames: string[],
  expectedToolNames: string[] = DEFAULT_EXPECTED_TOOL_NAMES
): DistributionValidationCheck[] {
  const toolSet = new Set(toolNames);
  const expectedSet = new Set(expectedToolNames);
  const missing = expectedToolNames.filter((name) => !toolSet.has(name));
  const unexpected = toolNames.filter((name) => !expectedSet.has(name));
  const duplicates = duplicateNames(toolNames);
  const expectedDuplicates = duplicateNames(expectedToolNames);
  const orderMatch = toolNames.every((name, index) => name === expectedToolNames[index]);
  const forbidden = toolNames.filter((name) => FORBIDDEN_TOOL_PATTERNS.some((pattern) => pattern.test(name)));
  return [
    missing.length === 0
      ? {
          name: "expected_tool_catalog",
          status: "pass",
          summary: `Remote MCP exposes all ${expectedToolNames.length} expected recruiter tools.`,
          details: { expectedToolCount: expectedToolNames.length, actualToolCount: toolNames.length },
        }
      : {
          name: "expected_tool_catalog",
          status: "fail",
          summary: "Remote MCP is missing expected recruiter tools.",
          details: { missing },
        },
    unexpected.length === 0
      ? { name: "no_unexpected_tools", status: "pass", summary: "Remote MCP tool catalog exposes only the approved recruiter tools." }
      : {
          name: "no_unexpected_tools",
          status: "fail",
          summary: "Remote MCP tool catalog contains unexpected tools outside the approved recruiter catalog.",
          details: { unexpected },
        },
    missing.length === 0 && unexpected.length === 0 && duplicates.length === 0 && expectedDuplicates.length === 0 && toolNames.length === expectedToolNames.length && orderMatch
      ? {
          name: "exact_tool_catalog",
          status: "pass",
          summary: `Remote MCP tool catalog exactly matches all ${expectedToolNames.length} unique approved recruiter tools.`,
          details: { expectedToolCount: expectedToolNames.length, actualToolCount: toolNames.length, orderMatch },
        }
      : {
          name: "exact_tool_catalog",
          status: "fail",
          summary: "Remote MCP tool catalog is not an exact duplicate-free match for the approved recruiter catalog.",
          details: {
            expectedToolCount: expectedToolNames.length,
            actualToolCount: toolNames.length,
            missing,
            unexpected,
            duplicates,
            expectedDuplicates,
            orderMatch,
          },
        },
    forbidden.length === 0
      ? { name: "no_write_tools", status: "pass", summary: "Remote MCP tool catalog contains no write/admin tools." }
      : {
          name: "no_write_tools",
          status: "fail",
          summary: "Remote MCP tool catalog contains forbidden write/admin tool names.",
          details: { forbidden },
        },
  ];
}

function duplicateNames(names: string[]): string[] {
  return [...new Set(names.filter((name, index) => names.indexOf(name) !== index))];
}

export interface RemoteToolMetadata {
  name: string;
  annotations?: Record<string, unknown>;
}

export function validateRemoteToolAnnotations(tools: RemoteToolMetadata[]): DistributionValidationCheck {
  const missingReadOnly = tools
    .filter((tool) => !isRecord(tool.annotations) || tool.annotations.readOnlyHint !== true)
    .map((tool) => tool.name);
  const destructive = tools
    .filter((tool) => isRecord(tool.annotations) && tool.annotations.destructiveHint !== false)
    .map((tool) => tool.name);
  const notIdempotent = tools
    .filter((tool) => isRecord(tool.annotations) && tool.annotations.idempotentHint !== true)
    .map((tool) => tool.name);
  if (missingReadOnly.length === 0 && destructive.length === 0 && notIdempotent.length === 0) {
    return {
      name: "read_only_tool_annotations",
      status: "pass",
      summary: "Remote MCP tool catalog marks every recruiter tool as read-only, non-destructive, and idempotent.",
      details: { toolCount: tools.length },
    };
  }
  return {
    name: "read_only_tool_annotations",
    status: "fail",
    summary: "Remote MCP tool catalog is missing required read-only safety annotations.",
    details: { missingReadOnly, destructive, notIdempotent },
  };
}

export async function startRemoteDistributionValidationCli(
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const report = await runRemoteDistributionValidationFromEnv(env);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) {
    process.exitCode = 1;
  }
}

async function validateHealth(fetchImpl: typeof fetch, healthUrl: string): Promise<DistributionValidationCheck> {
  try {
    const response = await fetchImpl(healthUrl, { method: "GET", redirect: "error" });
    const body = await safeJson(response);
    if (response.ok && isRecord(body) && body.ok === true) {
      return { name: "healthz", status: "pass", summary: "Remote recruiter MCP health endpoint is live." };
    }
    return {
      name: "healthz",
      status: "fail",
      summary: `Remote recruiter MCP health endpoint returned HTTP ${response.status}.`,
    };
  } catch {
    return { name: "healthz", status: "fail", summary: "Remote recruiter MCP health endpoint could not be reached." };
  }
}

async function validateReadiness(fetchImpl: typeof fetch, readinessUrl: string, readinessToken: string | undefined): Promise<DistributionValidationCheck> {
  if (!readinessToken) {
    return { name: "readyz", status: "fail", summary: "A separate readiness bearer token is required to validate protected detailed /readyz output." };
  }
  try {
    const response = await fetchImpl(readinessUrl, { method: "GET", headers: { authorization: `Bearer ${readinessToken}` }, redirect: "error" });
    const body = await safeJson(response);
    if (response.ok && isRecord(body) && body.ok === true && body.status === "ready") {
      const validation = validateReadinessChecks(body.checks);
      if (validation.ok) {
        return { name: "readyz", status: "pass", summary: "Remote recruiter MCP readiness endpoint reports ready with no warning checks." };
      }
      return {
        name: "readyz",
        status: "fail",
        summary: "Remote recruiter MCP readiness endpoint did not return the exact current all-pass readiness check catalog.",
        details: validation.details,
      };
    }
    return {
      name: "readyz",
      status: "fail",
      summary: `Remote recruiter MCP readiness endpoint is not ready (HTTP ${response.status}).`,
      details: isRecord(body) ? { status: body.status, checks: body.checks } : undefined,
    };
  } catch {
    return { name: "readyz", status: "fail", summary: "Remote recruiter MCP readiness endpoint could not be reached." };
  }
}

async function validateReadinessProtection(fetchImpl: typeof fetch, readinessUrl: string): Promise<DistributionValidationCheck> {
  try {
    const response = await fetchImpl(readinessUrl, { method: "GET", redirect: "error" });
    await response.body?.cancel().catch(() => undefined);
    return response.status === 401 || response.status === 403
      ? { name: "readyz_unauthorized_denied", status: "pass", summary: "Detailed /readyz denies unauthenticated requests." }
      : {
          name: "readyz_unauthorized_denied",
          status: "fail",
          summary: `Detailed /readyz did not deny an unauthenticated request (HTTP ${response.status}).`,
        };
  } catch {
    return { name: "readyz_unauthorized_denied", status: "fail", summary: "Unauthenticated /readyz protection could not be observed." };
  }
}

async function validateVersion(
  fetchImpl: typeof fetch,
  versionUrl: string,
  expectedCommit: string | undefined
): Promise<{ check: DistributionValidationCheck; observedCommit?: string }> {
  const normalizedExpected = expectedCommit?.trim().toLowerCase();
  if (!normalizedExpected || !/^[0-9a-f]{40}$/.test(normalizedExpected)) {
    return {
      check: {
        name: "version_commit",
        status: "fail",
        summary: "Distribution validation requires an exact 40-character expected candidate commit SHA.",
      },
    };
  }
  try {
    const response = await fetchImpl(versionUrl, { method: "GET", redirect: "error" });
    const body = await safeJson(response);
    const observedCommit = isRecord(body) && typeof body.commit === "string"
      ? body.commit.trim().toLowerCase()
      : undefined;
    const matches = response.ok
      && isRecord(body)
      && body.name === "greenhouse-recruiter-mcp"
      && typeof body.version === "string"
      && body.version.length > 0
      && observedCommit === normalizedExpected;
    return matches
      ? {
          check: {
            name: "version_commit",
            status: "pass",
            summary: "Remote /version reports the exact expected candidate commit SHA.",
            details: { expectedCommit: normalizedExpected, observedCommit },
          },
          observedCommit,
        }
      : {
          check: {
            name: "version_commit",
            status: "fail",
            summary: "Remote /version does not report the exact expected candidate commit SHA.",
            details: { expectedCommit: normalizedExpected, observedCommit: observedCommit ?? null, httpStatus: response.status },
          },
          observedCommit,
        };
  } catch {
    return {
      check: {
        name: "version_commit",
        status: "fail",
        summary: "Remote /version could not be reached.",
        details: { expectedCommit: normalizedExpected },
      },
    };
  }
}

function validateReadinessChecks(
  checks: unknown
): { ok: true } | { ok: false; details: Record<string, unknown> } {
  if (!Array.isArray(checks) || checks.length === 0) {
    return { ok: false, details: { reason: "checks_missing_or_empty" } };
  }
  const wellFormed = checks.filter((check) =>
    isRecord(check)
    && typeof check.name === "string"
    && typeof check.summary === "string"
    && (check.status === "pass" || check.status === "warn" || check.status === "fail")
  ) as Array<Record<string, unknown>>;
  const names = wellFormed.map((check) => check.name as string);
  const expected = [...RECRUITER_MCP_READINESS_CHECK_NAMES];
  const missing = expected.filter((name) => !names.includes(name));
  const unexpected = names.filter((name) => !expected.includes(name as never));
  const duplicates = [...new Set(names.filter((name, index) => names.indexOf(name) !== index))];
  const nonPassing = wellFormed
    .filter((check) => check.status !== "pass")
    .map((check) => check.name as string);
  const malformedCount = checks.length - wellFormed.length;
  if (
    malformedCount === 0
    && missing.length === 0
    && unexpected.length === 0
    && duplicates.length === 0
    && nonPassing.length === 0
    && names.length === expected.length
  ) {
    return { ok: true };
  }
  return {
    ok: false,
    details: { malformedCount, missing, unexpected, duplicates, nonPassing },
  };
}

async function postMcp(
  fetchImpl: typeof fetch,
  mcpUrl: string,
  token: string,
  body: Record<string, unknown>
): Promise<unknown> {
  try {
    const response = await fetchImpl(mcpUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(body),
      redirect: "error",
    });
    if (!response.ok) {
      return { transportError: { status: response.status } };
    }
    const text = await response.text();
    return parseMcpResponsePayload(text);
  } catch {
    return { requestFailed: true };
  }
}

export function parseMcpResponsePayload(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("Remote MCP returned an empty response.");
  }
  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed) as unknown;
  }
  const dataLine = trimmed.split(/\r?\n/).find((line) => line.startsWith("data:"));
  if (!dataLine) {
    throw new Error("Remote MCP response did not contain JSON or SSE data.");
  }
  return JSON.parse(dataLine.replace(/^data:\s*/, "")) as unknown;
}

function validateInitialize(payload: unknown): DistributionValidationCheck {
  if (isRemoteMcpRequestFailure(payload)) {
    return { name: "mcp_initialize", status: "fail", summary: "Remote MCP initialize request failed or returned an unreadable response." };
  }
  if (isRemoteMcpTransportError(payload)) {
    return { name: "mcp_initialize", status: "fail", summary: `Remote MCP initialize returned HTTP ${payload.transportError.status}.` };
  }
  if (isJsonRpcError(payload)) {
    return { name: "mcp_initialize", status: "fail", summary: "Remote MCP initialize returned a JSON-RPC error." };
  }
  const result = isRecord(payload) && isRecord(payload.result) ? payload.result : undefined;
  const serverInfo = result && isRecord(result.serverInfo) ? result.serverInfo : undefined;
  if (serverInfo?.name === "greenhouse-recruiter-mcp") {
    return { name: "mcp_initialize", status: "pass", summary: "Remote MCP initialize returned the recruiter-scoped server identity." };
  }
  return {
    name: "mcp_initialize",
    status: "fail",
    summary: "Remote MCP initialize did not return the recruiter-scoped server identity.",
  };
}

function extractToolNames(payload: unknown): { check: DistributionValidationCheck; toolNames: string[]; tools: RemoteToolMetadata[] } {
  if (isRemoteMcpRequestFailure(payload)) {
    return {
      check: { name: "mcp_tools_list", status: "fail", summary: "Remote MCP tools/list request failed or returned an unreadable response." },
      toolNames: [],
      tools: [],
    };
  }
  if (isRemoteMcpTransportError(payload)) {
    return {
      check: { name: "mcp_tools_list", status: "fail", summary: `Remote MCP tools/list returned HTTP ${payload.transportError.status}.` },
      toolNames: [],
      tools: [],
    };
  }
  if (isJsonRpcError(payload)) {
    return {
      check: { name: "mcp_tools_list", status: "fail", summary: "Remote MCP tools/list returned a JSON-RPC error." },
      toolNames: [],
      tools: [],
    };
  }
  const result = isRecord(payload) && isRecord(payload.result) ? payload.result : undefined;
  const tools = result && Array.isArray(result.tools) ? result.tools : undefined;
  if (!tools) {
    return {
      check: { name: "mcp_tools_list", status: "fail", summary: "Remote MCP tools/list did not return a tools array." },
      toolNames: [],
      tools: [],
    };
  }
  const toolMetadata = tools.flatMap((tool): RemoteToolMetadata[] => {
    if (!isRecord(tool) || typeof tool.name !== "string") return [];
    return [{
      name: tool.name,
      annotations: isRecord(tool.annotations) ? tool.annotations : undefined,
    }];
  });
  const toolNames = toolMetadata.map((tool) => tool.name);
  const invalidToolEntryCount = tools.length - toolMetadata.length;
  return {
    check: {
      name: "mcp_tools_list",
      status: toolNames.length > 0 && invalidToolEntryCount === 0 ? "pass" : "fail",
      summary: toolNames.length > 0 && invalidToolEntryCount === 0
        ? `Remote MCP tools/list returned ${toolNames.length} tool definitions.`
        : "Remote MCP tools/list returned an empty or malformed tool definition.",
      details: { toolCount: toolNames.length, invalidToolEntryCount },
    },
    toolNames,
    tools: toolMetadata,
  };
}

function report(
  options: RemoteDistributionValidationOptions,
  mcpUrl: string,
  healthUrl: string,
  readinessUrl: string,
  versionUrl: string,
  checks: DistributionValidationCheck[],
  toolNames: string[],
  sessionMetadata: SessionTokenMetadata,
  observedCommit?: string
): DistributionValidationReport {
  const ok = checks.every((check) => check.status === "pass");
  return {
    ok,
    status: ok ? "ready" : "not_ready",
    checkedAt: (options.now ?? (() => new Date()))().toISOString(),
    mcpUrl,
    healthUrl,
    readinessUrl,
    versionUrl,
    expectedCommit: options.expectedCommit?.trim().toLowerCase(),
    observedCommit,
    sessionSurface: sessionMetadata.surface,
    sessionClient: sessionMetadata.client,
    sessionTokenId: sessionMetadata.tokenId,
    sessionIssuedAt: sessionMetadata.issuedAt,
    checks,
    toolNames,
  };
}

interface SessionTokenMetadata {
  surface?: RecruiterSurface;
  client?: RecruiterClient;
  tokenId?: string;
  issuedAt?: string;
}

function validateSessionMetadata(metadata: SessionTokenMetadata): DistributionValidationCheck {
  const missing: string[] = [];
  if (!metadata.surface) missing.push("surface");
  if (metadata.client !== undefined && (!metadata.surface || !isClientSurfaceCompatible(metadata.client, metadata.surface))) missing.push("compatibleClient");
  if (!metadata.tokenId) missing.push("tokenId");
  if (!metadata.issuedAt) missing.push("issuedAt");
  return missing.length === 0
    ? { name: "session_token_metadata", status: "pass", summary: "Durable session token metadata is exact and usable for rollout evidence." }
    : {
      name: "session_token_metadata",
      status: "fail",
      summary: "Durable session token is missing exact non-secret metadata required for rollout evidence.",
      details: { missing },
    };
}

function readSessionMetadataFromToken(token: string | undefined): SessionTokenMetadata {
  if (!token) return {};
  const payloadPart = token.split(".", 1)[0];
  if (!payloadPart) return {};
  try {
    const parsed = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")) as unknown;
    if (!isRecord(parsed)) return {};
    let tokenId: string | undefined;
    let issuedAt: string | undefined;
    try {
      tokenId = normalizeSessionTokenId(parsed.tokenId);
    } catch {
      tokenId = undefined;
    }
    try {
      issuedAt = normalizeSessionIssuedAt(parsed.issuedAt);
    } catch {
      issuedAt = undefined;
    }
    return {
      surface: isRecruiterSurface(parsed.surface) ? parsed.surface : undefined,
      client: isRecruiterClient(parsed.client) ? parsed.client : undefined,
      tokenId,
      issuedAt,
    };
  } catch {
    return {};
  }
}

function isRecruiterSurface(value: unknown): value is RecruiterSurface {
  return value === "claude_desktop" || value === "chatgpt_desktop" || value === "test";
}

function siblingUrl(rawUrl: string, siblingPath: string): string {
  const url = new URL(rawUrl);
  url.pathname = siblingPath;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function normalizeUrl(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Remote validation URLs must not contain credentials, query strings, or fragments.");
  }
  return url.toString();
}

function exactToolName(...parts: string[]): RegExp {
  return new RegExp(`^${parts.join("_")}$`);
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json() as unknown;
  } catch {
    return undefined;
  }
}

function parseNameList(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const values = raw.split(",").map((entry) => entry.trim()).filter(Boolean);
  return values.length > 0 ? values : undefined;
}

function isJsonRpcError(payload: unknown): payload is { error: { message?: unknown } } {
  return isRecord(payload) && isRecord(payload.error);
}

function isRemoteMcpTransportError(payload: unknown): payload is { transportError: { status: number } } {
  return isRecord(payload)
    && isRecord(payload.transportError)
    && typeof payload.transportError.status === "number";
}

function isRemoteMcpRequestFailure(payload: unknown): payload is { requestFailed: true } {
  return isRecord(payload) && payload.requestFailed === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startRemoteDistributionValidationCli().catch(() => {
    process.stderr.write("[greenhouse-recruiter-validate-distribution] failed before a report could be written.\n");
    process.exit(1);
  });
}
