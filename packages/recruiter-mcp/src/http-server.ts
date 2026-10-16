import http from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { MIN_READYZ_TOKEN_LENGTH, buildRecruiterMcpReadinessReport } from "./readiness.js";
import { extractBearerToken, handleRemoteMcpRequest, writeJson } from "./remote.js";
import { PUBLIC_READY_PATH, VERSION_ROUTE_PATH, readHttpEndpointConfig, readHttpServerTimeoutConfig } from "./http-request.js";
import { readBooleanEnvFlag } from "./env.js";
import { parseCorsOrigins } from "./cors.js";
import { buildVersionInfo } from "./version.js";
import { maybeStartAuditSummaryTimer } from "./audit-summary.js";
import { maybeStartPipelineSnapshotTimer, stopPipelineSnapshotTimer } from "./pipeline-snapshot.js";
import { createOauthAuthorizeHandlers } from "./oauth-authorize.js";
import { createOauthTokenHandler } from "./oauth-token.js";
import { readOauthAuthorizationConfig } from "./oauth-config.js";
import {
  OAUTH_AUTHORIZE_PATH,
  OAUTH_CALLBACK_PATH,
  OAUTH_TOKEN_PATH,
  isOauthDiscoveryPath,
  resolveOauthDiscoveryDocument,
} from "./oauth-metadata.js";

// Fixed, unauthenticated build-identity route so the running commit is visible from
// outside (the "deployed sha unknowable" gap). Served before the /mcp branch; the
// endpoint-config reserved-route check (http-request.ts) keeps /healthz|/readyz|/mcp off
// this literal and off the /.well-known/ OAuth discovery routes.
const VERSION_PATH = VERSION_ROUTE_PATH;

// Absolute drain budget once SIGTERM/SIGINT arrives. Cloud Run SIGKILLs 10s after SIGTERM, so the
// default and the cap both sit inside that window with margin for the force-close and process exit.
const DEFAULT_SHUTDOWN_GRACE_MS = 7_000;
const MAX_SHUTDOWN_GRACE_MS = 8_000;
// After the grace deadline force-drops surviving connections, give their handlers this brief,
// bounded window to unwind — destroying the socket aborts the in-flight upstream read, and the
// abort must reach the request's finally (audit + transport cleanup) before the process exits.
const FORCE_CLOSE_SETTLE_MS = 500;

// Per-server shutdown state. Kept in a WeakMap rather than on the http.Server so the returned object
// stays a plain http.Server for every existing caller and test, while the drain path can find the
// draining flag, the in-flight counter, and the timers this server owns.
interface HttpRecruiterMcpLifecycle {
  draining: boolean;
  activeRequests: number;
  readonly idleWaiters: Set<() => void>;
  readonly shutdownGraceMs: number;
  auditSummaryTimer: NodeJS.Timeout | null;
  snapshotTimer: NodeJS.Timeout | null;
  shutdown?: Promise<void>;
}

const serverLifecycles = new WeakMap<http.Server, HttpRecruiterMcpLifecycle>();

export async function startHttpRecruiterMcp(env: NodeJS.ProcessEnv = process.env): Promise<http.Server> {
  const endpointConfig = readHttpEndpointConfig(env);
  const { port, mcpPath, healthPath, readyPath } = endpointConfig;
  const timeoutConfig = readHttpServerTimeoutConfig(env);
  const lifecycle: HttpRecruiterMcpLifecycle = {
    draining: false,
    activeRequests: 0,
    idleWaiters: new Set(),
    shutdownGraceMs: readShutdownGraceMs(env),
    auditSummaryTimer: null,
    snapshotTimer: null,
  };
  const server = http.createServer(async (req, res) => {
    try {
      const path = req.url ? new URL(req.url, "http://localhost").pathname : undefined;
      const corsAllowed = setHostedResponseHeaders(req, res, env);
      if (!corsAllowed) {
        writeJson(res, 403, { error: "cors_origin_not_allowed" });
        return;
      }
      // Strictly additive OAuth sign-in layer: absent env -> "absent" and every OAuth route
      // below stays dark (byte-identical 404s); a partial/malformed family -> "invalid", which
      // keeps the routes equally dark while readiness reports the reason.
      const oauthConfigResult = readOauthAuthorizationConfig(env);
      const oauthConfig = oauthConfigResult.state === "configured" ? oauthConfigResult.config : undefined;
      const isMountedOauthPath = oauthConfig !== undefined && path !== undefined && (
        isOauthDiscoveryPath(oauthConfig, path) ||
        path === OAUTH_AUTHORIZE_PATH ||
        path === OAUTH_CALLBACK_PATH ||
        path === OAUTH_TOKEN_PATH
      );
      if (req.method === "OPTIONS") {
        if (path === healthPath || path === readyPath || path === mcpPath || isMountedOauthPath) {
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
      // Public, unauthenticated Cloud Run readiness probe. Boolean-only by design (never the
      // detailed checks the token-gated /readyz surface exposes): 200 while serving, 503 the moment
      // graceful shutdown starts so the load balancer stops routing before the listener closes.
      if (path === PUBLIC_READY_PATH) {
        if (req.method !== "GET" && req.method !== "HEAD") {
          writeJson(res, 405, { error: "method_not_allowed" });
          return;
        }
        const ready = !lifecycle.draining;
        writeJson(res, ready ? 200 : 503, { ok: ready, status: ready ? "ready" : "not_ready" });
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
      // OAuth discovery documents (VERSION_PATH template): RFC 8414 authorization-server
      // metadata plus RFC 9728 protected-resource metadata at BOTH the path-suffixed location
      // (probed first by clients) and the root location. Mounted only when the OAuth env
      // family is fully valid.
      if (oauthConfig !== undefined && path !== undefined) {
        const discoveryDocument = resolveOauthDiscoveryDocument(oauthConfig, path);
        if (discoveryDocument !== undefined) {
          if (req.method !== "GET" && req.method !== "HEAD") {
            writeJson(res, 405, { error: "method_not_allowed" });
            return;
          }
          writeJson(res, 200, discoveryDocument);
          return;
        }
        // The sign-in leg: /authorize hands the browser to Google with a signed pending
        // state; /oauth/callback finishes it — verified email through the identity
        // directory, one-time code into the grant store, redirect back to the client.
        if (path === OAUTH_AUTHORIZE_PATH || path === OAUTH_CALLBACK_PATH) {
          const oauthHandlers = createOauthAuthorizeHandlers(oauthConfig, env);
          if (path === OAUTH_AUTHORIZE_PATH) {
            await oauthHandlers.handleAuthorize(req, res);
          } else {
            await oauthHandlers.handleCallback(req, res);
          }
          return;
        }
        // The machine leg: /token redeems one-time codes (PKCE-checked) and rotates
        // refresh tokens into fresh access-token pairs. Form-urlencoded only.
        if (path === OAUTH_TOKEN_PATH) {
          await createOauthTokenHandler(oauthConfig, env).handleToken(req, res);
          return;
        }
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
      // Graceful shutdown: once draining, refuse NEW MCP work with a retryable 503 so a client on a
      // kept-alive connection retries against a healthy instance instead of racing the closing
      // listener. In-flight calls counted below are still allowed to finish.
      if (lifecycle.draining) {
        res.setHeader("retry-after", "1");
        writeJson(res, 503, {
          jsonrpc: "2.0",
          error: { code: -32006, message: "Recruiter Greenhouse MCP is draining for deployment." },
          id: null,
        });
        return;
      }
      if (req.method !== "POST" && req.method !== "GET" && req.method !== "DELETE") {
        writeJson(res, 405, { error: "method_not_allowed" });
        return;
      }
      lifecycle.activeRequests += 1;
      try {
        await handleRemoteMcpRequest(req, res, env);
      } finally {
        lifecycle.activeRequests -= 1;
        if (lifecycle.activeRequests === 0) {
          for (const resolve of lifecycle.idleWaiters) resolve();
          lifecycle.idleWaiters.clear();
        }
      }
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
  lifecycle.auditSummaryTimer = maybeStartAuditSummaryTimer(env);
  // Dormant unless GREENHOUSE_RECRUITER_SNAPSHOT_ENABLED (the temporal logbook's schedule half).
  lifecycle.snapshotTimer = maybeStartPipelineSnapshotTimer(env);
  serverLifecycles.set(server, lifecycle);
  return server;
}

// Graceful shutdown for a server started by startHttpRecruiterMcp. Flips the draining flag (so
// /ready reports 503 and new MCP work is refused while in-flight calls finish), stops the owned
// timers, drains in-flight requests until they idle or the absolute grace deadline passes, then
// force-drops any survivor (destroying its socket triggers the per-request abort that stops the
// upstream Greenhouse read) and closes the listener. Idempotent: repeat calls return the same
// promise. Safe on a server with no tracked lifecycle (just closes it).
export async function shutdownHttpRecruiterMcp(
  server: http.Server,
  _env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const lifecycle = serverLifecycles.get(server);
  if (!lifecycle) {
    await closeHttpServer(server);
    return;
  }
  if (lifecycle.shutdown) return lifecycle.shutdown;
  lifecycle.shutdown = (async () => {
    lifecycle.draining = true;
    if (lifecycle.auditSummaryTimer) clearInterval(lifecycle.auditSummaryTimer);
    stopPipelineSnapshotTimer(lifecycle.snapshotTimer);
    const deadline = Date.now() + lifecycle.shutdownGraceMs;
    await waitForIdleUntil(lifecycle, deadline);
    // The listener stays open through the drain so /ready keeps answering 503 for the load
    // balancer; only now do we stop accepting and drop whatever sockets remain.
    const closed = closeHttpServer(server);
    server.closeAllConnections?.();
    // Let the force-dropped handlers unwind (abort the upstream read, run their finally) within a
    // bounded tail before the caller exits — resolves the instant the last request goes idle.
    await waitForIdleUntil(lifecycle, Date.now() + FORCE_CLOSE_SETTLE_MS);
    await closed;
    serverLifecycles.delete(server);
  })();
  return lifecycle.shutdown;
}

// Process entrypoint: start the server, then translate SIGTERM/SIGINT into one graceful drain.
// The bin wrapper (PID 1 under Cloud Run) forwards those signals to this child; startHttpRecruiterMcp
// stays the seam every test and the wrapper's health checks use directly.
export async function runHttpRecruiterMcp(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const server = await startHttpRecruiterMcp(env);
  let stopping = false;
  const stop = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    console.error(`[greenhouse-recruiter-mcp] received ${signal}; draining`);
    void shutdownHttpRecruiterMcp(server, env).then(
      () => process.exit(0),
      () => process.exit(1)
    );
  };
  process.once("SIGTERM", () => stop("SIGTERM"));
  process.once("SIGINT", () => stop("SIGINT"));
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

// Resolves when the server has no in-flight MCP request, or when the absolute deadline passes —
// whichever comes first. Event-driven: the request handler resolves every idle waiter the instant
// the active count reaches zero, so a clean drain returns immediately rather than polling.
async function waitForIdleUntil(lifecycle: HttpRecruiterMcpLifecycle, deadline: number): Promise<void> {
  if (lifecycle.activeRequests === 0) return;
  const remainingMs = Math.max(0, deadline - Date.now());
  await new Promise<void>((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    const finish = () => {
      if (timer) clearTimeout(timer);
      lifecycle.idleWaiters.delete(finish);
      resolve();
    };
    lifecycle.idleWaiters.add(finish);
    timer = setTimeout(finish, remainingMs);
  });
}

function closeHttpServer(server: http.Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}

function readShutdownGraceMs(env: NodeJS.ProcessEnv): number {
  const raw = env.GREENHOUSE_RECRUITER_SHUTDOWN_GRACE_MS;
  if (raw === undefined || raw.length === 0) return DEFAULT_SHUTDOWN_GRACE_MS;
  const invalid = `GREENHOUSE_RECRUITER_SHUTDOWN_GRACE_MS must be an integer from 1 to ${MAX_SHUTDOWN_GRACE_MS}.`;
  if (raw.trim() !== raw || !/^[1-9]\d*$/.test(raw)) throw new Error(invalid);
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed > MAX_SHUTDOWN_GRACE_MS) throw new Error(invalid);
  return parsed;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runHttpRecruiterMcp().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[greenhouse-recruiter-mcp] http startup failed: ${message}`);
    process.exit(1);
  });
}
