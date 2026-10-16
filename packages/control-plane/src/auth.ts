/**
 * OAuth2 client credentials token management for Greenhouse Harvest v3 API.
 */

const TOKEN_URL = "https://auth.greenhouse.io/token";

interface TokenResponse {
  token_type: string;
  access_token: string;
  expires_at: string;
}

let cachedToken: string | null = null;
let tokenExpiresAt: number = 0;
// Single-flight guard: Greenhouse client_credentials has single-active-token
// semantics (a new token revokes the prior). Without this, N concurrent callers
// past the freshness check below would each POST /token and self-revoke each
// other's tokens. Concurrent callers instead share one in-flight refresh.
let inFlightToken: Promise<string> | null = null;

/**
 * Reset cached auth state. Used for test isolation AND, in production, to drop a
 * revoked token so the next read refetches a fresh one (see client-readonly.ts
 * 401 handling).
 */
export function _resetAuthState(): void {
  cachedToken = null;
  tokenExpiresAt = 0;
  inFlightToken = null;
}

function newAuthCorrelationId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function handleTokenNonOkResponse(res: Response): Promise<never> {
  const correlationId = newAuthCorrelationId();
  let bodyText: string;
  try {
    bodyText = await res.text();
  } catch {
    bodyText = "<unreadable>";
  }
  const statusText = res.statusText ?? "";
  console.error(
    `[greenhouse-mcp] TOKEN_ERROR ${correlationId} ${res.status} body=${bodyText}`
  );
  throw new Error(
    `Failed to obtain access token: ${res.status} ${statusText} [correlation_id=${correlationId}]`
  );
}

export async function getAccessToken(
  clientId: string,
  clientSecret: string
): Promise<string> {
  // Return cached token if still valid (with 60s buffer)
  if (cachedToken && Date.now() < tokenExpiresAt - 60_000) {
    return cachedToken;
  }
  // Coalesce concurrent refreshes into a single token request so we don't
  // stampede /token and self-revoke under single-active-token semantics.
  if (inFlightToken) {
    return inFlightToken;
  }
  inFlightToken = fetchAccessToken(clientId, clientSecret).finally(() => {
    inFlightToken = null;
  });
  return inFlightToken;
}

async function fetchAccessToken(
  clientId: string,
  clientSecret: string
): Promise<string> {
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString(
    "base64"
  );

  // Per-request timeout mirrors client-readonly's requestTimeoutMs (duplicated here — auth is
  // imported BY client-readonly, so importing back would be circular). A hung mint fails fast;
  // single-flight clears and the next call re-mints.
  const timeoutRaw = Number.parseInt(process.env.GREENHOUSE_REQUEST_TIMEOUT_MS ?? "", 10);
  const timeoutMs = Number.isSafeInteger(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : 20_000;

  let res: Response;
  try {
    res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[greenhouse-mcp] TOKEN FETCH FAILED: ${msg}`);
    if (err instanceof Error && err.cause) {
      console.error(`[greenhouse-mcp] cause: ${JSON.stringify(err.cause)}`);
    }
    throw new Error(`Failed to obtain access token: ${msg}`);
  }

  if (!res.ok) {
    await handleTokenNonOkResponse(res);
  }

  const data = (await res.json()) as TokenResponse;
  cachedToken = data.access_token;
  tokenExpiresAt = new Date(data.expires_at).getTime();

  console.error(`[greenhouse-mcp] Token obtained, expires at ${data.expires_at}`);
  return cachedToken;
}
