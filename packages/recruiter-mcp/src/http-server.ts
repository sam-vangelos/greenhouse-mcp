import http from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { MIN_READYZ_TOKEN_LENGTH, buildRecruiterMcpReadinessReport } from "./readiness.js";
import { extractBearerToken, handleRemoteMcpRequest, writeJson } from "./remote.js";
import { readHttpEndpointConfig, readHttpServerTimeoutConfig } from "./http-request.js";
import { readBooleanEnvFlag } from "./env.js";
import { parseCorsOrigins } from "./cors.js";
import { buildVersionInfo } from "./version.js";
import { maybeStartAuditSummaryTimer } from "./audit-summary.js";
import { maybeStartPipelineSnapshotTimer } from "./pipeline-snapshot.js";

// Fixed, unauthenticated build-identity route so the running commit is visible from
// outside (the "deployed sha unknowable" gap). Served before the /mcp branch; the
// endpoint-config distinctness check keeps /healthz|/readyz|/mcp off this literal.
const VERSION_PATH = "/version";

export async function startHttpRecruiterMcp(env: NodeJS.ProcessEnv = process.env): Promise<http.Server> {
  const endpointConfig = readHttpEndpointConfig(env);
  const { port, mcpPath, healthPath, readyPath } = endpointConfig;
  const timeoutConfig = readHttpServerTimeoutConfig(env);
  const server = http.createServer(async (req, res) => {
    try {
      const path = req.url ? new URL(req.url, "http://localhost").pathname : undefined;
      const corsAllowed = setHostedResponseHeaders(req, res, env);
      if (!corsAllowed) {
        writeJson(res, 403, { error: "cors_origin_not_allowed" });
        return;
      }
      if (req.method === "OPTIONS") {
        if (path === healthPath || path === readyPath || path === mcpPath) {
          res.writeHead(204);
          res.end();
          return;
        }
        writeJson(res, 404, { error: "not_found" });
        return;
      }
      if (path === healthPath) {
        if (req.method !== "GET" && req.method !== "HEAD") {
          writeJson(res, 405, { error: "method_not_allowed" });
          return;
        }
        const { version, commit } = buildVersionInfo(env);
        writeJson(res, 200, { ok: true, status: "ok", version, commit });
        return;
      }
      if (path === VERSION_PATH) {
        if (req.method !== "GET" && req.method !== "HEAD") {
          writeJson(res, 405, { error: "method_not_allowed" });
          return;
        }
        writeJson(res, 200, buildVersionInfo(env));
        return;
      }
      if (path === readyPath) {
        if (req.method !== "GET" && req.method !== "HEAD") {
          writeJson(res, 405, { error: "method_not_allowed" });
          return;
        }
        const authStatus = authorizeReadinessRequest(req, env);
        if (authStatus === "not_configured") {
          writeJson(res, 503, { ok: false, status: "not_ready", error: "readyz_auth_not_configured" });
          return;
        }
        if (authStatus === "denied") {
          writeJson(res, 401, { error: "readyz_unauthorized" });
          return;
        }
        const report = buildRecruiterMcpReadinessReport(env);
        writeJson(res, report.ok ? 200 : 503, report);
        return;
      }
      if (path !== mcpPath) {
        writeJson(res, 404, { error: "not_found" });
        return;
      }
      if (readBooleanEnvFlag(env, "GREENHOUSE_RECRUITER_MCP_DISABLED")) {
        writeJson(res, 503, {
          jsonrpc: "2.0",
          error: { code: -32004, message: "Recruiter Greenhouse MCP is disabled." },
          id: null,
        });
        return;
      }
      if (req.method !== "POST" && req.method !== "GET" && req.method !== "DELETE") {
        writeJson(res, 405, { error: "method_not_allowed" });
        return;
      }
      await handleRemoteMcpRequest(req, res, env);
    } catch (error) {
      const correlationId = randomUUID();
      const errorName = sanitizeLogToken(error instanceof Error && error.name ? error.name : typeof error);
      console.error(`[greenhouse-recruiter-mcp] remote request failed correlation_id=${correlationId} error_name=${errorName}`);
      writeJson(res, 500, {
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error", data: { correlationId } },
        id: null,
      });
    }
  });
  server.headersTimeout = timeoutConfig.headersTimeoutMs;
  server.requestTimeout = timeoutConfig.requestTimeoutMs;
  server.keepAliveTimeout = timeoutConfig.keepAliveTimeoutMs;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => resolve());
  });
  console.error(`[greenhouse-recruiter-mcp] streamable HTTP listening on :${port}${mcpPath}`);
  // Dormant unless GREENHOUSE_RECRUITER_AUDIT_SUMMARY_WEBHOOK_URL is set (service-health rollup).
  maybeStartAuditSummaryTimer(env);
  // Dormant unless GREENHOUSE_RECRUITER_SNAPSHOT_ENABLED (the temporal logbook's schedule half).
  maybeStartPipelineSnapshotTimer(env);
  return server;
}


function setHostedResponseHeaders(req: http.IncomingMessage, res: http.ServerResponse, env: NodeJS.ProcessEnv): boolean {
  const corsConfig = parseCorsOrigins(env.GREENHOUSE_RECRUITER_CORS_ORIGIN);
  const configuredOrigins = corsConfig.origins;
  const requestOrigin = Array.isArray(req.headers.origin) ? undefined : req.headers.origin;
  const duplicatedOrigin = Array.isArray(req.headers.origin);
  if (corsConfig.configured) {
    res.setHeader("vary", "origin");
  }
  res.setHeader("access-control-allow-methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("access-control-allow-headers", "authorization,content-type,mcp-session-id,last-event-id");
  res.setHeader("access-control-max-age", "600");
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-content-type-options", "nosniff");
  if (corsConfig.invalid.length > 0 || duplicatedOrigin) return false;
  const responseOrigin = requestOrigin && configuredOrigins.includes(requestOrigin) ? requestOrigin : undefined;
  if (responseOrigin) {
    res.setHeader("access-control-allow-origin", responseOrigin);
  }
  return !requestOrigin || configuredOrigins.includes(requestOrigin);
}

type ReadinessAuthorizationStatus = "authorized" | "denied" | "not_configured";

function authorizeReadinessRequest(req: http.IncomingMessage, env: NodeJS.ProcessEnv): ReadinessAuthorizationStatus {
  if (readBooleanEnvFlag(env, "GREENHOUSE_RECRUITER_ALLOW_PUBLIC_READYZ_FOR_DEV")) return "authorized";
  const expected = env.GREENHOUSE_RECRUITER_READYZ_TOKEN;
  const normalizedExpected = expected?.trim();
  if (!normalizedExpected || normalizedExpected !== expected || normalizedExpected.length < MIN_READYZ_TOKEN_LENGTH) return "not_configured";
  const actual = extractBearerToken(req.headers.authorization);
  if (!actual) return "denied";
  return timingSafeStringEqual(actual, normalizedExpected) ? "authorized" : "denied";
}

function timingSafeStringEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function sanitizeLogToken(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_.:-]/g, "_");
  return sanitized.length > 0 ? sanitized.slice(0, 80) : "unknown";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startHttpRecruiterMcp().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[greenhouse-recruiter-mcp] http startup failed: ${message}`);
    process.exit(1);
  });
}
