const TOKEN_URL = "https://auth.greenhouse.io/token";
const API_ORIGIN = "https://harvest.greenhouse.io";

export async function probePerHumanTokens(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch
): Promise<Record<string, unknown>> {
  const clientId = required(env, "GREENHOUSE_ACTION_CLIENT_ID");
  const clientSecret = required(env, "GREENHOUSE_ACTION_CLIENT_SECRET");
  const primary = positiveId(required(env, "GREENHOUSE_ACTION_PROBE_PRIMARY_USER_ID"));
  const secondary = positiveId(required(env, "GREENHOUSE_ACTION_PROBE_SECONDARY_USER_ID"));
  if (primary === secondary) throw new Error("Probe user IDs must be different.");

  const [sameA, sameB] = await Promise.all([
    mint(clientId, clientSecret, primary, fetchImpl),
    mint(clientId, clientSecret, primary, fetchImpl),
  ]);
  const [differentPrimary, differentSecondary] = await Promise.all([
    mint(clientId, clientSecret, primary, fetchImpl),
    mint(clientId, clientSecret, secondary, fetchImpl),
  ]);
  assertJwtSubject(sameA, primary);
  assertJwtSubject(sameB, primary);
  assertJwtSubject(differentPrimary, primary);
  assertJwtSubject(differentSecondary, secondary);

  const tokens = [sameA, sameB, differentPrimary, differentSecondary];
  await Promise.all(tokens.map((token, index) => verifyToken(
    token,
    index === 3 ? secondary : primary,
    fetchImpl
  )));

  const newest = await mint(clientId, clientSecret, primary, fetchImpl);
  assertJwtSubject(newest, primary);
  await Promise.all([...tokens, newest].map((token, index) => verifyToken(
    token,
    index === 3 ? secondary : primary,
    fetchImpl
  )));

  return {
    passed: true,
    same_subject_concurrent_tokens_remain_valid: true,
    different_subject_concurrent_tokens_remain_valid: true,
    minting_another_token_does_not_revoke_prior_tokens: true,
    jwt_subjects_match_requested_users: true,
    note: "A sandbox assignment and Greenhouse UI audit check are still required before enabling per_human mode.",
  };
}

async function mint(
  clientId: string,
  clientSecret: string,
  subject: number,
  fetchImpl: typeof fetch
): Promise<string> {
  const body = new URLSearchParams({ grant_type: "client_credentials", sub: String(subject) });
  const response = await fetchImpl(TOKEN_URL, {
    method: "POST",
    redirect: "error",
    headers: {
      authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: body.toString(),
  });
  if (!response.ok) throw new Error(`Token probe mint failed with HTTP ${response.status}.`);
  const data = await response.json() as unknown;
  if (!isRecord(data) || typeof data.access_token !== "string" || data.access_token.length === 0) {
    throw new Error("Token probe mint returned an invalid response.");
  }
  return data.access_token;
}

async function verifyToken(token: string, userId: number, fetchImpl: typeof fetch): Promise<void> {
  const url = new URL("/v3/users", API_ORIGIN);
  url.searchParams.set("ids", String(userId));
  url.searchParams.set("fields", "id");
  const response = await fetchImpl(url, {
    method: "GET",
    redirect: "error",
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
  });
  await response.body?.cancel().catch(() => undefined);
  if (!response.ok) throw new Error(`Token probe validation failed with HTTP ${response.status}.`);
}

function assertJwtSubject(token: string, expected: number): void {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) throw new Error("Greenhouse access token was not a JWT.");
  let payload: unknown;
  try { payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as unknown; }
  catch { throw new Error("Greenhouse access token JWT payload was invalid."); }
  if (!isRecord(payload) || String(payload.sub) !== String(expected)) {
    throw new Error("Greenhouse access token subject did not match the requested user.");
  }
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value || value.trim() !== value) throw new Error(`${name} is required and must be trimmed.`);
  return value;
}

function positiveId(value: string): number {
  if (!/^[1-9]\d*$/.test(value)) throw new Error("Probe user IDs must be positive integers.");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("Probe user IDs must be safe positive integers.");
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  probePerHumanTokens()
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : "Token probe failed.");
      process.exitCode = 1;
    });
}
