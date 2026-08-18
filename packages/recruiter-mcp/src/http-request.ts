import type { IncomingMessage } from "node:http";

export const DEFAULT_MAX_HTTP_BODY_BYTES = 262_144;
export const DEFAULT_HTTP_HEADERS_TIMEOUT_MS = 10_000;
// Whole-REQUEST budget: must be >= the analysis budget (limits.maxAnalysisDurationMs, 5m) so the server
// does not socket-kill a comprehensive multi-page read before the recipe self-truncates honestly. The
// header-receipt guard (headersTimeout, 10s) still fends off slowloris; this only lengthens how long a
// *body-complete* request may run. Env-overridable (GREENHOUSE_RECRUITER_HTTP_REQUEST_TIMEOUT_MS).
export const DEFAULT_HTTP_REQUEST_TIMEOUT_MS = 300_000;
export const DEFAULT_HTTP_KEEP_ALIVE_TIMEOUT_MS = 5_000;

export interface HttpServerTimeoutConfig {
  headersTimeoutMs: number;
  requestTimeoutMs: number;
  keepAliveTimeoutMs: number;
}

export interface HttpEndpointConfig {
  port: number;
  mcpPath: string;
  healthPath: string;
  readyPath: string;
}

export class HttpRequestBodyError extends Error {
  statusCode: number;
  jsonRpcCode: number;
  publicMessage: string;

  constructor(statusCode: number, jsonRpcCode: number, publicMessage: string) {
    super(publicMessage);
    this.name = "HttpRequestBodyError";
    this.statusCode = statusCode;
    this.jsonRpcCode = jsonRpcCode;
    this.publicMessage = publicMessage;
  }
}

export function readHttpBodyLimitBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.GREENHOUSE_RECRUITER_MAX_HTTP_BODY_BYTES;
  if (raw === undefined || raw.trim().length === 0) return DEFAULT_MAX_HTTP_BODY_BYTES;
  if (raw.trim() === raw && /^[1-9]\d*$/.test(raw)) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw new Error("GREENHOUSE_RECRUITER_MAX_HTTP_BODY_BYTES must be a positive integer number of bytes.");
}

export function readHttpEndpointConfig(env: NodeJS.ProcessEnv = process.env): HttpEndpointConfig {
  const config = {
    port: readHttpListenPort(env.GREENHOUSE_RECRUITER_MCP_PORT),
    mcpPath: readHttpRoutePath(env.GREENHOUSE_RECRUITER_MCP_PATH, "GREENHOUSE_RECRUITER_MCP_PATH", "/mcp"),
    healthPath: readHttpRoutePath(env.GREENHOUSE_RECRUITER_HEALTH_PATH, "GREENHOUSE_RECRUITER_HEALTH_PATH", "/healthz"),
    readyPath: readHttpRoutePath(env.GREENHOUSE_RECRUITER_READY_PATH, "GREENHOUSE_RECRUITER_READY_PATH", "/readyz"),
  };
  const paths = [config.mcpPath, config.healthPath, config.readyPath];
  if (new Set(paths).size !== paths.length) {
    throw new Error("GREENHOUSE_RECRUITER_MCP_PATH, GREENHOUSE_RECRUITER_HEALTH_PATH, and GREENHOUSE_RECRUITER_READY_PATH must be distinct routes.");
  }
  return config;
}

export function readHttpServerTimeoutConfig(env: NodeJS.ProcessEnv = process.env): HttpServerTimeoutConfig {
  const config = {
    headersTimeoutMs: readPositiveMilliseconds(
      env.GREENHOUSE_RECRUITER_HTTP_HEADERS_TIMEOUT_MS,
      "GREENHOUSE_RECRUITER_HTTP_HEADERS_TIMEOUT_MS",
      DEFAULT_HTTP_HEADERS_TIMEOUT_MS
    ),
    requestTimeoutMs: readPositiveMilliseconds(
      env.GREENHOUSE_RECRUITER_HTTP_REQUEST_TIMEOUT_MS,
      "GREENHOUSE_RECRUITER_HTTP_REQUEST_TIMEOUT_MS",
      DEFAULT_HTTP_REQUEST_TIMEOUT_MS
    ),
    keepAliveTimeoutMs: readPositiveMilliseconds(
      env.GREENHOUSE_RECRUITER_HTTP_KEEP_ALIVE_TIMEOUT_MS,
      "GREENHOUSE_RECRUITER_HTTP_KEEP_ALIVE_TIMEOUT_MS",
      DEFAULT_HTTP_KEEP_ALIVE_TIMEOUT_MS
    ),
  };
  if (config.headersTimeoutMs > config.requestTimeoutMs) {
    throw new Error("GREENHOUSE_RECRUITER_HTTP_HEADERS_TIMEOUT_MS must be less than or equal to GREENHOUSE_RECRUITER_HTTP_REQUEST_TIMEOUT_MS.");
  }
  return config;
}

function readHttpListenPort(value: string | undefined): number {
  if (value !== undefined && value.trim().length > 0 && value.trim() !== value) {
    throw new Error("GREENHOUSE_RECRUITER_MCP_PORT must be an integer from 0 to 65535.");
  }
  const raw = value === undefined || value.trim().length === 0 ? "3333" : value;
  if (!/^\d+$/.test(raw)) {
    throw new Error("GREENHOUSE_RECRUITER_MCP_PORT must be an integer from 0 to 65535.");
  }
  const port = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new Error("GREENHOUSE_RECRUITER_MCP_PORT must be an integer from 0 to 65535.");
  }
  return port;
}

function readHttpRoutePath(value: string | undefined, envName: string, fallback: string): string {
  if (value !== undefined && value.trim().length > 0 && value.trim() !== value) {
    throw new Error(`${envName} must be an absolute non-root path without query string or fragment.`);
  }
  const path = value === undefined || value.trim().length === 0 ? fallback : value;
  if (!path.startsWith("/") || path === "/" || path.includes("?") || path.includes("#")) {
    throw new Error(`${envName} must be an absolute non-root path without query string or fragment.`);
  }
  try {
    const url = new URL(path, "http://localhost");
    if (url.pathname !== path || url.search || url.hash) {
      throw new Error("invalid path");
    }
  } catch {
    throw new Error(`${envName} must be an absolute non-root path without query string or fragment.`);
  }
  return path;
}

export async function readBoundedJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  validateJsonContentType(req.headers["content-type"]);
  const contentLength = parseContentLength(req.headers["content-length"]);
  if (contentLength !== undefined && contentLength > maxBytes) {
    throw bodyTooLarge(maxBytes);
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > maxBytes) {
      throw bodyTooLarge(maxBytes);
    }
    chunks.push(buffer);
  }

  try {
    return JSON.parse(Buffer.concat(chunks, totalBytes).toString("utf8")) as unknown;
  } catch {
    throw new HttpRequestBodyError(400, -32700, "Parse error: Invalid JSON");
  }
}

function validateJsonContentType(raw: string | string[] | undefined): void {
  const value = Array.isArray(raw) ? undefined : raw;
  if (!value || !isJsonContentType(value)) {
    throw new HttpRequestBodyError(415, -32000, "Unsupported Media Type: Content-Type must be application/json");
  }
}

function isJsonContentType(value: string): boolean {
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/json" || Boolean(mediaType?.endsWith("+json"));
}

function parseContentLength(raw: string | string[] | undefined): number | undefined {
  if (Array.isArray(raw)) {
    throw new HttpRequestBodyError(400, -32600, "Invalid Request: Content-Length must be a non-negative integer");
  }
  const value = raw;
  if (value === undefined) return undefined;
  if (value.trim() !== value || !/^\d+$/.test(value)) {
    throw new HttpRequestBodyError(400, -32600, "Invalid Request: Content-Length must be a non-negative integer");
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) {
    throw new HttpRequestBodyError(400, -32600, "Invalid Request: Content-Length is too large");
  }
  return parsed;
}

function bodyTooLarge(maxBytes: number): HttpRequestBodyError {
  return new HttpRequestBodyError(413, -32005, `Request body is too large. Maximum allowed size is ${maxBytes} bytes.`);
}

function readPositiveMilliseconds(value: string | undefined, envName: string, fallback: number): number {
  if (value === undefined || value.trim().length === 0) return fallback;
  if (value.trim() === value && /^[1-9]\d*$/.test(value)) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw new Error(`${envName} must be a positive integer number of milliseconds.`);
}
