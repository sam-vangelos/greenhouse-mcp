import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isAuditUnavailableError, preflightRetainedAuditSinkFromEnv } from "./audit.js";
import { createSessionValidatorFromEnv, type SessionValidationResult } from "./auth.js";
import { createOauthAccessTokenValidatorFromEnv } from "./oauth-access-token.js";
import { readOauthAuthorizationConfig } from "./oauth-config.js";
import { oauthResourceMetadataUrl } from "./oauth-metadata.js";
import { HttpRequestBodyError, readBoundedJsonBody, readHttpBodyLimitBytes } from "./http-request.js";
import { createRecruiterMcpServer } from "./server.js";
import { mountActionPlane } from "./action-plane.js";
import type { RecruiterSurface } from "./types.js";
import { readBooleanEnvFlag } from "./env.js";
import { parseRemoteSurfaceAllowlist } from "./surfaces.js";
import { isAuditSinkDurable } from "./readiness.js";

export function extractBearerToken(header: string | string[] | undefined): string | undefined {
  if (typeof header !== "string") return undefined;
  const match = header.match(/^Bearer ([^\s]+)$/i);
  return match?.[1];
}

export async function validateRemoteAuthorization(
  authorizationHeader: string | string[] | undefined,
  env: NodeJS.ProcessEnv = process.env
): Promise<SessionValidationResult> {
  const token = extractBearerToken(authorizationHeader);
  if (!token) {
    return { status: "invalid", reason: "Missing recruiter MCP session token." };
  }
  // The bearer fork: legacy session tokens are exactly 2 dot-segments (auth.ts rejects 3), so
  // a 3-segment OAuth access token forks cleanly on dot-count — and ONLY when the OAuth env
  // family is fully valid. On an OAuth-less deployment a 3-segment token falls through to the
  // legacy validator and earns today's exact "Malformed recruiter MCP session token." answer.
  if (token.split(".").length === 3) {
    const oauthConfigResult = readOauthAuthorizationConfig(env);
    if (oauthConfigResult.state === "configured") {
      const oauthValidator = createOauthAccessTokenValidatorFromEnv(env, oauthConfigResult.config);
      if ("status" in oauthValidator) return oauthValidator;
      return oauthValidator.validate(token);
    }
  }
  const validator = createSessionValidatorFromEnv(env, { requireRevocationProvider: true });
  if ("status" in validator) return validator;
  return validator.validate(token);
}

export function isRemoteSurfaceAllowed(
  surface: RecruiterSurface,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const configured = parseRemoteSurfaceAllowlist(env.GREENHOUSE_RECRUITER_REMOTE_SURFACES);
  if (configured.invalid.length > 0) return false;
  if (surface === "test") {
    return readBooleanEnvFlag(env, "GREENHOUSE_RECRUITER_ALLOW_TEST_SURFACE");
  }
  return configured.allowed.has(surface);
}

export function writeJson(res: ServerResponse, statusCode: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(statusCode, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export type RemoteAuthDenialCode = "MISSING_SESSION_TOKEN" | "SESSION_REVOKED" | "SESSION_NOT_VERIFIED";

export interface PublicRemoteAuthDenial {
  code: -32001;
  message: string;
  data: { denialCode: RemoteAuthDenialCode };
}

export function toPublicRemoteAuthDenial(reason: string): PublicRemoteAuthDenial {
  if (/^Missing recruiter MCP session token\./.test(reason)) {
    return {
      code: -32001,
      message: "Missing recruiter MCP session token.",
      data: { denialCode: "MISSING_SESSION_TOKEN" },
    };
  }
  if (/session token has been revoked\./i.test(reason)) {
    return {
      code: -32001,
      message: "Recruiter MCP session token has been revoked.",
      data: { denialCode: "SESSION_REVOKED" },
    };
  }
  return {
    code: -32001,
    message: "Recruiter MCP session could not be verified.",
    data: { denialCode: "SESSION_NOT_VERIFIED" },
  };
}

export interface PublicRemoteAuditDenial {
  code: -32004;
  message: string;
  data: { denialCode: "AUDIT_UNAVAILABLE" };
}

export function toPublicRemoteAuditDenial(): PublicRemoteAuditDenial {
  return {
    code: -32004,
    message: "Recruiter MCP audit sink is unavailable.",
    data: { denialCode: "AUDIT_UNAVAILABLE" },
  };
}

export async function handleRemoteMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  env: NodeJS.ProcessEnv = process.env,
  parsedBody?: unknown
): Promise<void> {
  const sessionResult = await validateRemoteAuthorization(req.headers.authorization, env);
  if (sessionResult.status !== "valid") {
    // Discovery contract: the only signal Claude honors is a transport-level 401 whose
    // WWW-Authenticate names the protected-resource metadata (never a 200-with-error). Set
    // BEFORE writeJson — pre-set headers survive writeHead. Gated on a fully valid OAuth env;
    // legacy-only deployments keep today's byte-identical bare 401.
    const oauthConfigResult = readOauthAuthorizationConfig(env);
    if (oauthConfigResult.state === "configured") {
      res.setHeader(
        "WWW-Authenticate",
        `Bearer resource_metadata="${oauthResourceMetadataUrl(oauthConfigResult.config)}"`
      );
    }
    writeJson(res, 401, {
      jsonrpc: "2.0",
      error: toPublicRemoteAuthDenial(sessionResult.reason),
      id: null,
    });
    return;
  }
  if (!isRemoteSurfaceAllowed(sessionResult.session.surface, env)) {
    writeJson(res, 403, {
      jsonrpc: "2.0",
      error: { code: -32003, message: "Remote recruiter MCP session surface is not allowed." },
      id: null,
    });
    return;
  }

  let body = parsedBody;
  if (req.method === "POST" && body === undefined) {
    try {
      body = await readBoundedJsonBody(req, readHttpBodyLimitBytes(env));
    } catch (error) {
      if (error instanceof HttpRequestBodyError) {
        writeJson(res, error.statusCode, {
          jsonrpc: "2.0",
          error: { code: error.jsonRpcCode, message: error.publicMessage },
          id: null,
        });
        return;
      }
      throw error;
    }
  }

  let auditSink;
  try {
    auditSink = await preflightRetainedAuditSinkFromEnv(env);
  } catch (error) {
    // Name-only operator breadcrumb for the 503: the CAUSE's error name when the audit layer
    // wrapped one, else the error's own name — never the message, never config values.
    const causeName = isAuditUnavailableError(error) && error.cause instanceof Error
      ? error.cause.name
      : error instanceof Error && error.name ? error.name : typeof error;
    console.error(`[greenhouse-recruiter-mcp] audit preflight failed error_name=${causeName}`);
    writeJson(res, 503, {
      jsonrpc: "2.0",
      error: toPublicRemoteAuditDenial(),
      id: readJsonRpcRequestId(body),
    });
    return;
  }

  // /mcp readiness gate: refuse to serve the scoped recruiter MCP unless the audit sink is DECLARED
  // durable. The preflight above proves the sink is WRITABLE; this requires it be on the declared
  // durable mount, so a writable-but-ephemeral path (e.g. /tmp on a container that loses it on
  // redeploy) cannot serve with a perishable audit trail. This gates the whole authenticated /mcp
  // surface (initialize / tools/list / tool calls), not only the PII-bearing reads, because a server
  // that cannot durably audit should not operate at all. Ordered AFTER auth + transport validation
  // (so unauthenticated / malformed requests still get their normal 4xx) and AFTER the writability
  // preflight (so missing / invalid / not-appendable audit still returns AUDIT_UNAVAILABLE).
  if (!isAuditSinkDurable(env)) {
    writeJson(res, 503, {
      jsonrpc: "2.0",
      error: { code: -32004, message: "Recruiter Greenhouse MCP audit sink is not on durable storage; scoped reads are blocked until the retained audit trail is durable." },
      id: readJsonRpcRequestId(body),
    });
    return;
  }

  const requestAbort = new AbortController();
  const abortRequest = () => requestAbort.abort();
  const abortOnPrematureResponseClose = () => {
    if (!res.writableEnded) abortRequest();
  };
  req.once("aborted", abortRequest);
  res.once("close", abortOnPrematureResponseClose);

  // Resolved before construction because the entitlement lookup is a network read and the server
  // constructor is synchronous. A null mount is the normal case and leaves the catalog untouched.
  const actionPlane = await mountActionPlane({ session: sessionResult.session, env });
  const { server } = createRecruiterMcpServer({
    session: sessionResult.session,
    env,
    auditSink,
    signal: requestAbort.signal,
    ...(actionPlane ? { actionPlane } : {}),
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } finally {
    req.off("aborted", abortRequest);
    res.off("close", abortOnPrematureResponseClose);
    await transport.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}

function readJsonRpcRequestId(body: unknown): string | number | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const id = (body as { id?: unknown }).id;
  if (id === null || typeof id === "string" || typeof id === "number") return id;
  return null;
}
