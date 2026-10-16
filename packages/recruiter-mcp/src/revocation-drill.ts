import { isClientSurfaceCompatible, isRecruiterClient, normalizeSessionIssuedAt, normalizeSessionTokenId } from "./auth.js";
import { parseMcpResponsePayload } from "./distribution-validation.js";
import type { RecruiterClient, RecruiterSurface } from "./types.js";

export interface SessionRevocationDrillCheck {
  name: string;
  status: "pass" | "fail";
  summary: string;
  details?: Record<string, unknown>;
}

export interface SessionRevocationDrillReport {
  reportVersion: 2;
  ok: boolean;
  status: "pass" | "fail";
  checkedAt: string;
  mcpUrl: string;
  activeSessionSurface?: RecruiterSurface;
  activeSessionClient?: RecruiterClient;
  activeSessionTokenId?: string;
  activeSessionIssuedAt?: string;
  revokedSessionSurface?: RecruiterSurface;
  revokedSessionClient?: RecruiterClient;
  revokedSessionTokenId?: string;
  revokedSessionIssuedAt?: string;
  containsTokens: false;
  checks: SessionRevocationDrillCheck[];
}

export interface SessionRevocationDrillOptions {
  mcpUrl: string;
  activeToken?: string;
  revokedToken?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

const DEFAULT_MCP_URL = "http://127.0.0.1:3333/mcp";

export async function runSessionRevocationDrill(
  options: SessionRevocationDrillOptions
): Promise<SessionRevocationDrillReport> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const mcpUrl = normalizeUrl(options.mcpUrl || DEFAULT_MCP_URL);
  const activeMetadata = readSessionMetadataFromToken(options.activeToken);
  const revokedMetadata = readSessionMetadataFromToken(options.revokedToken);
  const checks: SessionRevocationDrillCheck[] = [];

  const activeMetadataCheck = validateTokenMetadata("active_token_metadata", activeMetadata);
  const revokedMetadataCheck = validateTokenMetadata("revoked_token_metadata", revokedMetadata);
  checks.push(activeMetadataCheck);
  checks.push(revokedMetadataCheck);
  const matchingClientCheck = validateMatchingClientIdentity(activeMetadata, revokedMetadata);
  checks.push(matchingClientCheck);
  const distinctTokenIdsCheck = validateDistinctTokenIds(activeMetadata.tokenId, revokedMetadata.tokenId);
  checks.push(distinctTokenIdsCheck);

  const canProbeRemote = Boolean(options.activeToken)
    && Boolean(options.revokedToken)
    && activeMetadataCheck.status === "pass"
    && revokedMetadataCheck.status === "pass"
    && matchingClientCheck.status === "pass"
    && distinctTokenIdsCheck.status === "pass";

  if (canProbeRemote && options.activeToken) {
    const activeInitialize = await postInitialize(fetchImpl, mcpUrl, options.activeToken);
    checks.push(validateActiveInitialize(activeInitialize));
  } else if (!options.activeToken) {
    checks.push({ name: "active_initialize", status: "fail", summary: "An active durable session token is required for the revocation drill." });
  } else {
    checks.push({ name: "active_initialize", status: "fail", summary: "Active/revoked token metadata is incomplete; remote initialize was not attempted." });
  }

  if (canProbeRemote && options.revokedToken) {
    const revokedInitialize = await postInitialize(fetchImpl, mcpUrl, options.revokedToken);
    checks.push(validateRevokedInitializeDenied(revokedInitialize));
  } else if (!options.revokedToken) {
    checks.push({ name: "revoked_initialize_denied", status: "fail", summary: "A revoked durable session token is required for the revocation drill." });
  } else {
    checks.push({ name: "revoked_initialize_denied", status: "fail", summary: "Active/revoked token metadata is incomplete; remote initialize was not attempted." });
  }

  const ok = checks.every((check) => check.status === "pass");
  return {
    reportVersion: 2,
    ok,
    status: ok ? "pass" : "fail",
    checkedAt: (options.now ?? (() => new Date()))().toISOString(),
    mcpUrl,
    activeSessionSurface: activeMetadata.surface,
    activeSessionClient: activeMetadata.client,
    activeSessionTokenId: activeMetadata.tokenId,
    activeSessionIssuedAt: activeMetadata.issuedAt,
    revokedSessionSurface: revokedMetadata.surface,
    revokedSessionClient: revokedMetadata.client,
    revokedSessionTokenId: revokedMetadata.tokenId,
    revokedSessionIssuedAt: revokedMetadata.issuedAt,
    containsTokens: false,
    checks,
  };
}

export async function runSessionRevocationDrillFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: Pick<SessionRevocationDrillOptions, "fetchImpl" | "now"> = {}
): Promise<SessionRevocationDrillReport> {
  return runSessionRevocationDrill({
    mcpUrl: env.GREENHOUSE_RECRUITER_REMOTE_MCP_URL ?? DEFAULT_MCP_URL,
    activeToken: env.GREENHOUSE_RECRUITER_ACTIVE_SESSION_TOKEN ?? env.GREENHOUSE_RECRUITER_SESSION_TOKEN,
    revokedToken: env.GREENHOUSE_RECRUITER_REVOKED_SESSION_TOKEN,
    fetchImpl: options.fetchImpl,
    now: options.now,
  });
}

export async function startSessionRevocationDrillCli(
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const report = await runSessionRevocationDrillFromEnv(env);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) {
    process.exitCode = 1;
  }
}

interface SessionTokenMetadata {
  surface?: RecruiterSurface;
  client?: RecruiterClient;
  tokenId?: string;
  issuedAt?: string;
}

interface McpPostResult {
  httpStatus: number;
  ok: boolean;
  payload: unknown;
  denialCode?: string;
}

function validateTokenMetadata(name: string, metadata: SessionTokenMetadata): SessionRevocationDrillCheck {
  const missing: string[] = [];
  if (!metadata.surface) missing.push("surface");
  if (!metadata.client) missing.push("client");
  if (!metadata.tokenId) missing.push("tokenId");
  if (!metadata.issuedAt) missing.push("issuedAt");
  return missing.length === 0
    ? { name, status: "pass", summary: "Session token metadata is present." }
    : { name, status: "fail", summary: "Session token metadata is missing required non-secret fields.", details: { missing } };
}

function validateDistinctTokenIds(activeTokenId: string | undefined, revokedTokenId: string | undefined): SessionRevocationDrillCheck {
  if (activeTokenId && revokedTokenId && activeTokenId !== revokedTokenId) {
    return { name: "distinct_token_ids", status: "pass", summary: "Active and revoked drill tokens are distinct." };
  }
  return {
    name: "distinct_token_ids",
    status: "fail",
    summary: "Revocation drill requires distinct active and revoked token ids.",
    details: { activeTokenId: activeTokenId ?? null, revokedTokenId: revokedTokenId ?? null },
  };
}

function validateMatchingClientIdentity(
  active: SessionTokenMetadata,
  revoked: SessionTokenMetadata
): SessionRevocationDrillCheck {
  if (active.client && revoked.client && active.client === revoked.client && active.surface === revoked.surface) {
    return { name: "matching_client_identity", status: "pass", summary: "Active and revoked drill tokens belong to the same physical client." };
  }
  return {
    name: "matching_client_identity",
    status: "fail",
    summary: "Revocation drill requires active and revoked tokens for the same physical client.",
    details: {
      activeClient: active.client ?? null,
      revokedClient: revoked.client ?? null,
      activeSurface: active.surface ?? null,
      revokedSurface: revoked.surface ?? null,
    },
  };
}

function validateActiveInitialize(result: McpPostResult): SessionRevocationDrillCheck {
  const serverInfo = isRecord(result.payload) && isRecord(result.payload.result) && isRecord(result.payload.result.serverInfo)
    ? result.payload.result.serverInfo
    : undefined;
  if (result.ok && serverInfo?.name === "greenhouse-recruiter-mcp") {
    return { name: "active_initialize", status: "pass", summary: "Active durable session initialized the remote recruiter MCP." };
  }
  return {
    name: "active_initialize",
    status: "fail",
    summary: "Active durable session did not initialize the remote recruiter MCP.",
    details: compactDetails({ httpStatus: result.httpStatus, denialCode: result.denialCode }),
  };
}

function validateRevokedInitializeDenied(result: McpPostResult): SessionRevocationDrillCheck {
  if (!result.ok && (result.httpStatus === 401 || result.httpStatus === 403) && result.denialCode === "SESSION_REVOKED") {
    return { name: "revoked_initialize_denied", status: "pass", summary: "Revoked durable session token was denied by the remote recruiter MCP." };
  }
  return {
    name: "revoked_initialize_denied",
    status: "fail",
    summary: "Revoked durable session token was not denied with a revocation error.",
    details: compactDetails({ httpStatus: result.httpStatus, denialCode: result.denialCode }),
  };
}

async function postInitialize(fetchImpl: typeof fetch, mcpUrl: string, token: string): Promise<McpPostResult> {
  try {
    const response = await fetchImpl(mcpUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "greenhouse-recruiter-revocation-drill", version: "0.1.0" },
        },
      }),
    });
    const text = await response.text();
    const payload = parseResponse(text);
    return { httpStatus: response.status, ok: response.ok, payload, denialCode: readDenialCode(payload) };
  } catch (error) {
    return { httpStatus: 0, ok: false, payload: { transportError: safeErrorName(error) } };
  }
}

function parseResponse(text: string): unknown {
  try {
    return parseMcpResponsePayload(text);
  } catch {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return { parseError: true };
    }
  }
}

function readDenialCode(payload: unknown): string | undefined {
  if (!isRecord(payload) || !isRecord(payload.error) || !isRecord(payload.error.data)) return undefined;
  return typeof payload.error.data.denialCode === "string" ? payload.error.data.denialCode : undefined;
}

function compactDetails(details: { httpStatus: number; denialCode?: string }): Record<string, unknown> {
  return details.denialCode
    ? { httpStatus: details.httpStatus, denialCode: details.denialCode }
    : { httpStatus: details.httpStatus };
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
      client: isRecruiterClient(parsed.client)
        && isRecruiterSurface(parsed.surface)
        && isClientSurfaceCompatible(parsed.client, parsed.surface)
        ? parsed.client
        : undefined,
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

function normalizeUrl(value: string): string {
  return new URL(value).toString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeErrorName(error: unknown): string {
  return error instanceof Error && error.name ? error.name : typeof error;
}
