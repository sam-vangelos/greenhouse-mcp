import type { GreenhouseGateway, GreenhouseRow, MutationResponse } from "./types.js";

const TOKEN_URL = "https://auth.greenhouse.io/token";
const API_ORIGIN = "https://harvest.greenhouse.io";
const READ_TIMEOUT_MS = 10_000;
const MUTATION_TIMEOUT_MS = 15_000;
const MAX_LIST_PAGES = 20;

const MUTATION_PATHS: ReadonlyArray<[MutationResponseMethod, RegExp]> = [
  ["PATCH", /^\/applications\/[1-9]\d*$/],
  ["POST", /^\/applications\/[1-9]\d*\/(move|reject|unreject)$/],
  ["POST", /^\/job_owners$/],
  ["DELETE", /^\/job_owners\/[1-9]\d*$/],
  ["POST", /^\/notes$/],
  ["POST", /^\/job_notes$/],
  ["PATCH", /^\/job_notes\/[1-9]\d*$/],
  ["DELETE", /^\/job_notes\/[1-9]\d*$/],
  ["PATCH", /^\/candidates\/[1-9]\d*$/],
  ["POST", /^\/offers$/],
  ["PATCH", /^\/offers\/[1-9]\d*$/],
];

type MutationResponseMethod = "POST" | "PATCH" | "DELETE";
export type AttributionMode = "service_user" | "per_human";

export class GreenhouseError extends Error {
  readonly status: number | null;
  readonly requestId: string | null;
  readonly ambiguous: boolean;

  constructor(message: string, options: { status?: number | null; requestId?: string | null; ambiguous?: boolean } = {}) {
    super(message);
    this.name = "GreenhouseError";
    this.status = options.status ?? null;
    this.requestId = options.requestId ?? null;
    this.ambiguous = options.ambiguous ?? false;
  }
}

export interface GreenhouseGatewayConfig {
  clientId: string;
  clientSecret: string;
  attributionMode: AttributionMode;
  fetchImpl?: typeof fetch;
  now?: () => number;
  readTimeoutMs?: number;
  mutationTimeoutMs?: number;
}

interface CachedToken { value: string; expiresAtMs: number }

export function createGreenhouseGateway(config: GreenhouseGatewayConfig): GreenhouseGateway {
  const clientId = requireTrimmed(config.clientId, "Greenhouse action client ID");
  const clientSecret = requireTrimmed(config.clientSecret, "Greenhouse action client secret");
  const fetchImpl = config.fetchImpl ?? fetch;
  const now = config.now ?? Date.now;
  const readTimeoutMs = config.readTimeoutMs ?? READ_TIMEOUT_MS;
  const mutationTimeoutMs = config.mutationTimeoutMs ?? MUTATION_TIMEOUT_MS;
  const cache = new Map<string, CachedToken>();
  const inFlight = new Map<string, Promise<string>>();

  async function tokenFor(sub?: number): Promise<string> {
    const key = tokenKey(sub);
    const cached = cache.get(key);
    if (cached && cached.expiresAtMs - 60_000 > now()) return cached.value;
    const pending = inFlight.get(key);
    if (pending) return pending;
    const created = mintToken(sub).finally(() => inFlight.delete(key));
    inFlight.set(key, created);
    return created;
  }

  async function mintToken(sub?: number): Promise<string> {
    const body = new URLSearchParams({ grant_type: "client_credentials" });
    if (sub !== undefined) body.set("sub", String(sub));
    const data = await fetchWithDeadline(fetchImpl, TOKEN_URL, {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: body.toString(),
    }, readTimeoutMs, false, async (response) => {
      if (!response.ok) throw new GreenhouseError(`Greenhouse token request failed with HTTP ${response.status}.`, { status: response.status });
      return parseJson(response);
    });
    const accessToken = isRecord(data) && typeof data.access_token === "string" && data.access_token.length > 0
      ? data.access_token : null;
    const expiresAtMs = isRecord(data) && typeof data.expires_at === "string" ? Date.parse(data.expires_at) : Number.NaN;
    if (!accessToken || !Number.isFinite(expiresAtMs)) throw new GreenhouseError("Greenhouse token response was invalid.");
    cache.set(tokenKey(sub), { value: accessToken, expiresAtMs });
    return accessToken;
  }

  // A received 401 proves Greenhouse rejected the request before execution, so one fresh-token attempt is safe.
  async function withAuthRefresh<T>(sub: number | undefined, request: (token: string) => Promise<T>): Promise<T> {
    const token = await tokenFor(sub);
    try {
      return await request(token);
    } catch (error) {
      if (!(error instanceof GreenhouseError) || error.status !== 401) throw error;
      if (cache.get(tokenKey(sub))?.value === token) cache.delete(tokenKey(sub));
      return request(await tokenFor(sub));
    }
  }

  async function requestList(path: string, params: Record<string, string>, actorUserId: number): Promise<GreenhouseRow[]> {
    if (!/^\/[a-z][a-z0-9_/-]*$/.test(path) || path.includes("//")) throw new GreenhouseError("Greenhouse read path is invalid.");
    const first = new URL(`/v3${path}`, API_ORIGIN);
    for (const [key, value] of Object.entries(params)) first.searchParams.set(key, value);
    const rows: GreenhouseRow[] = [];
    let url: URL | null = first;
    for (let page = 0; url && page < MAX_LIST_PAGES; page += 1) {
      const pageResult = await withAuthRefresh(
        config.attributionMode === "per_human" ? actorUserId : undefined,
        (token) => fetchWithDeadline(fetchImpl, url!.toString(), {
          method: "GET",
          redirect: "error",
          headers: {
            authorization: `Bearer ${token}`,
            accept: "application/json",
          },
        }, readTimeoutMs, false, async (response) => {
          if (!response.ok) {
            await response.body?.cancel().catch(() => undefined);
            throw new GreenhouseError(`Greenhouse supporting read failed with HTTP ${response.status}.`, {
              status: response.status,
              requestId: requestId(response),
            });
          }
          return { data: await parseJson(response), link: response.headers.get("link") };
        })
      );
      const data = pageResult.data;
      if (!Array.isArray(data) || !data.every(isRecord)) throw new GreenhouseError("Greenhouse supporting read returned an invalid response.");
      rows.push(...data);
      url = nextPage(pageResult.link);
    }
    if (url) throw new GreenhouseError("Greenhouse supporting read exceeded the pagination limit.");
    return rows;
  }

  return {
    async probe(): Promise<void> {
      await tokenFor();
    },

    list: requestList,

    async mutate(input): Promise<MutationResponse> {
      if (!MUTATION_PATHS.some(([method, pattern]) => method === input.method && pattern.test(input.path))) {
        throw new GreenhouseError("Greenhouse mutation path is not owned by the action catalog.");
      }
      return withAuthRefresh(
        config.attributionMode === "per_human" ? input.actorUserId : undefined,
        (token) => fetchWithDeadline(fetchImpl, new URL(`/v3${input.path}`, API_ORIGIN).toString(), {
          method: input.method,
          redirect: "error",
          headers: {
            authorization: `Bearer ${token}`,
            accept: "application/json",
            ...(input.body ? { "content-type": "application/json" } : {}),
          },
          ...(input.body ? { body: JSON.stringify(input.body) } : {}),
        }, mutationTimeoutMs, true, async (response) => {
          const upstreamRequestId = requestId(response);
          if (!response.ok) {
            await response.body?.cancel().catch(() => undefined);
            throw new GreenhouseError(`Greenhouse mutation returned HTTP ${response.status}.`, {
              status: response.status,
              requestId: upstreamRequestId,
              ambiguous: response.status === 408 || response.status >= 500,
            });
          }
          return {
            status: response.status,
            requestId: upstreamRequestId,
            body: await parseOptionalJson(response),
          };
        })
      );
    },
  };
}

function tokenKey(sub?: number): string {
  return sub === undefined ? "isu" : `sub:${sub}`;
}

export function createGreenhouseGatewayFromEnv(env: NodeJS.ProcessEnv = process.env, fetchImpl?: typeof fetch): GreenhouseGateway {
  return createGreenhouseGateway({
    clientId: requireEnv(env, "GREENHOUSE_ACTION_CLIENT_ID"),
    clientSecret: requireEnv(env, "GREENHOUSE_ACTION_CLIENT_SECRET"),
    attributionMode: readAttributionMode(env),
    fetchImpl,
  });
}

export function createGreenhouseReconcilerGatewayFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: typeof fetch
): GreenhouseGateway {
  const actionClientId = requireEnv(env, "GREENHOUSE_ACTION_CLIENT_ID");
  const reconcilerClientId = requireEnv(env, "GREENHOUSE_ACTION_RECONCILER_CLIENT_ID");
  if (reconcilerClientId === actionClientId) {
    throw new GreenhouseError("The reconciler must use a different Greenhouse OAuth client ID from the action HTTP service.");
  }
  return createGreenhouseGateway({
    clientId: reconcilerClientId,
    clientSecret: requireEnv(env, "GREENHOUSE_ACTION_RECONCILER_CLIENT_SECRET"),
    attributionMode: readAttributionMode(env),
    fetchImpl,
  });
}

function readAttributionMode(env: NodeJS.ProcessEnv): AttributionMode {
  const attributionMode = env.GREENHOUSE_ACTION_ATTRIBUTION_MODE ?? "service_user";
  if (attributionMode !== "service_user" && attributionMode !== "per_human") {
    throw new GreenhouseError("GREENHOUSE_ACTION_ATTRIBUTION_MODE must be service_user or per_human.");
  }
  if (attributionMode === "per_human" && env.GREENHOUSE_ACTION_PER_HUMAN_TOKEN_PROBE_PASSED !== "true") {
    throw new GreenhouseError("Per-human attribution is blocked until GREENHOUSE_ACTION_PER_HUMAN_TOKEN_PROBE_PASSED is exactly true.");
  }
  return attributionMode;
}

async function fetchWithDeadline<T>(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  mutation: boolean,
  consume: (response: Response) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new GreenhouseError(
        mutation ? "Greenhouse mutation outcome is unknown." : "Greenhouse supporting request failed.",
        { ambiguous: mutation },
      ));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      fetchImpl(url, { ...init, signal: controller.signal }).then(consume),
      timeout,
    ]);
  } catch (error) {
    if (error instanceof GreenhouseError) throw error;
    throw new GreenhouseError(
      mutation ? "Greenhouse mutation outcome is unknown." : "Greenhouse supporting request failed.",
      { ambiguous: mutation }
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function nextPage(link: string | null): URL | null {
  if (!link) return null;
  const match = link.split(",").map((part) => part.trim()).find((part) => /;\s*rel="?next"?$/i.test(part));
  const raw = match?.match(/^<([^>]+)>/)?.[1];
  if (!raw) return null;
  let url: URL;
  try { url = new URL(raw); } catch { throw new GreenhouseError("Greenhouse pagination link was invalid."); }
  if (url.origin !== API_ORIGIN || !url.pathname.startsWith("/v3/") || url.username || url.password || url.hash) {
    throw new GreenhouseError("Greenhouse pagination link left the Harvest API origin.");
  }
  return url;
}

async function parseOptionalJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return null;
  try { return JSON.parse(text) as unknown; } catch { return null; }
}

async function parseJson(response: Response): Promise<unknown> {
  try { return await response.json() as unknown; }
  catch { throw new GreenhouseError("Greenhouse returned invalid JSON.", { status: response.status, requestId: requestId(response) }); }
}

function requestId(response: Response): string | null {
  return response.headers.get("x-request-id") ?? response.headers.get("x-greenhouse-request-id");
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new GreenhouseError(`${name} is required.`);
  return requireTrimmed(value, name);
}

function requireTrimmed(value: string, label: string): string {
  if (value.length === 0 || value.trim() !== value) throw new GreenhouseError(`${label} must be a non-empty trimmed value.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
