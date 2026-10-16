import {
  PRIVATE_CANDIDATES_ATTESTED_AT_COLUMN,
  PRIVATE_CANDIDATES_ATTESTED_BY_COLUMN,
  PRIVATE_CANDIDATES_ATTESTED_COLUMN,
  readPrivateCandidateAttestationAccess,
  type PrivateCandidateAttestationAccess,
} from "./private-candidate-attestation.js";

// greenhouse-recruiter-attest-private-candidates: record (or withdraw) the operator's attestation
// that Greenhouse grants a user the org-wide "Can create and view private candidates" permission
// (CLO-273).
//
// Harvest v3 does not expose that permission, so the read plane cannot derive it; migration 0008
// adds the three columns and this is the only thing that writes them. Deliberately NOT plan/--apply
// gated the way reconcile-identity is: this names one row explicitly, changes three columns on it,
// prints the row before and after, and is undone by `--clear`. A dry-run gate on a one-row
// reversible flip is ceremony, not safety.
//
// Never prints a key. The row it prints carries the recruiter's directory identity, which the
// operator running this already holds.

const SUCCESS_STATUSES = { set: "attested", clear: "cleared" } as const;

export interface AttestPrivateCandidatesArgs {
  greenhouseUserId?: number;
  email?: string;
  by?: string;
  clear: boolean;
}

export interface AttestPrivateCandidatesReport {
  status: (typeof SUCCESS_STATUSES)[keyof typeof SUCCESS_STATUSES];
  table: string;
  greenhouseUserId: number;
  before: Record<string, unknown> | null;
  after: Record<string, unknown>;
  containsTokens: false;
}

const USAGE =
  "Usage: greenhouse-recruiter-attest-private-candidates " +
  "(--greenhouse-user-id <id> | --email recruiter@example.com) (--by \"Name (attested YYYY-MM-DD)\" | --clear). " +
  "Records that Greenhouse grants this user the org-wide \"Can create and view private candidates\" permission; " +
  "--clear withdraws it. Only a status=resolved directory row is ever touched.";

export function parseAttestPrivateCandidatesArgs(args: string[]): AttestPrivateCandidatesArgs {
  const values = new Map<string, string>();
  let clear = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg?.startsWith("--")) continue;
    if (arg === "--clear") {
      clear = true;
      continue;
    }
    const next = args[index + 1];
    if (!next || next.startsWith("--")) continue;
    values.set(arg.slice(2), next);
    index += 1;
  }

  const rawUserId = values.get("greenhouse-user-id");
  const email = values.get("email")?.trim().toLowerCase();
  if ((rawUserId && email) || (!rawUserId && !email)) {
    throw new Error(`Pass exactly one of --greenhouse-user-id or --email. ${USAGE}`);
  }

  let greenhouseUserId: number | undefined;
  if (rawUserId !== undefined) {
    if (!/^[1-9]\d*$/.test(rawUserId)) {
      throw new Error(`--greenhouse-user-id must be a positive Greenhouse user id. ${USAGE}`);
    }
    greenhouseUserId = Number.parseInt(rawUserId, 10);
    if (!Number.isSafeInteger(greenhouseUserId)) {
      throw new Error(`--greenhouse-user-id must be a positive safe integer. ${USAGE}`);
    }
  }

  const by = values.get("by")?.trim();
  if (!clear && !by) {
    throw new Error(`--by is required when recording an attestation (or pass --clear to withdraw one). ${USAGE}`);
  }
  if (clear && by) {
    throw new Error(`--by and --clear are mutually exclusive. ${USAGE}`);
  }

  return {
    ...(greenhouseUserId !== undefined ? { greenhouseUserId } : {}),
    ...(email ? { email } : {}),
    ...(by ? { by } : {}),
    clear,
  };
}

type DirectoryAccess = PrivateCandidateAttestationAccess;

/**
 * Resolved through the SAME reader the runtime lookup uses.
 *
 * The writer and the reader have to agree about which table, which id column and which status value
 * the attestation lives under, and the directory supports overriding all three
 * (`GREENHOUSE_RECRUITER_IDENTITY_*`). This CLI used to hard-code `greenhouse_user_id`, `status` and
 * `resolved`, so on any directory configured with an override the PATCH matched nothing, the
 * "exactly one row" check would have caught it — but only after the operator had been told which
 * columns to set on a row the tool could not find.
 */
function readAccess(env: NodeJS.ProcessEnv): DirectoryAccess {
  const access = readPrivateCandidateAttestationAccess(env);
  if (!access) {
    throw new Error(
      "Set GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_URL and GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_KEY to attest private-candidate access."
    );
  }
  return access;
}

function selectedColumns(access: DirectoryAccess): string {
  return [
    access.greenhouseUserIdColumn,
    access.emailColumn,
    access.statusColumn,
    PRIVATE_CANDIDATES_ATTESTED_COLUMN,
    PRIVATE_CANDIDATES_ATTESTED_AT_COLUMN,
    PRIVATE_CANDIDATES_ATTESTED_BY_COLUMN,
  ].join(",");
}

async function readRows(
  access: DirectoryAccess,
  fetchImpl: typeof fetch,
  filters: Array<[string, string]>,
  select: string
): Promise<Array<Record<string, unknown>>> {
  const url = new URL(`${access.baseUrl}/rest/v1/${encodeURIComponent(access.table)}`);
  url.searchParams.set("select", select);
  for (const [column, filter] of filters) url.searchParams.set(column, filter);
  const response = await fetchImpl(url, {
    method: "GET",
    headers: { apikey: access.apiKey, authorization: `Bearer ${access.apiKey}`, accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Identity directory read failed with status ${response.status}.`);
  }
  const body = (await response.json()) as unknown;
  if (!Array.isArray(body)) {
    throw new Error("Identity directory read returned a non-array response.");
  }
  return body.filter((row): row is Record<string, unknown> => row !== null && typeof row === "object" && !Array.isArray(row));
}

export async function attestPrivateCandidates(
  env: NodeJS.ProcessEnv = process.env,
  args: string[] = process.argv.slice(2),
  fetchImpl: typeof fetch = fetch,
  now: () => Date = () => new Date()
): Promise<AttestPrivateCandidatesReport> {
  const parsed = parseAttestPrivateCandidatesArgs(args);
  const access = readAccess(env);

  // An email is resolved to a Greenhouse user id FIRST, and only when it names exactly one resolved
  // row. `primary_email` is unique only among status='resolved' rows (0001:24-26), so anything else
  // is genuinely ambiguous and must not be resolved by picking one.
  let greenhouseUserId = parsed.greenhouseUserId;
  if (greenhouseUserId === undefined) {
    const matches = await readRows(
      access,
      fetchImpl,
      [[access.emailColumn, `eq.${parsed.email}`], [access.statusColumn, `eq.${access.resolvedStatus}`]],
      [access.greenhouseUserIdColumn, access.emailColumn, access.statusColumn].join(",")
    );
    if (matches.length !== 1) {
      throw new Error(
        `--email ${parsed.email} matched ${matches.length} resolved rows; pass --greenhouse-user-id to name exactly one.`
      );
    }
    const id = matches[0]![access.greenhouseUserIdColumn];
    greenhouseUserId = typeof id === "number" ? id : Number.parseInt(String(id), 10);
    if (!Number.isSafeInteger(greenhouseUserId) || greenhouseUserId <= 0) {
      throw new Error(`--email ${parsed.email} resolved to an unusable greenhouse_user_id.`);
    }
  }

  const filters: Array<[string, string]> = [
    [access.greenhouseUserIdColumn, `eq.${greenhouseUserId}`],
    [access.statusColumn, `eq.${access.resolvedStatus}`],
  ];
  const beforeRows = await readRows(access, fetchImpl, filters, selectedColumns(access));
  const before = beforeRows.length === 1 ? beforeRows[0]! : null;

  const body = parsed.clear
    ? {
        [PRIVATE_CANDIDATES_ATTESTED_COLUMN]: false,
        [PRIVATE_CANDIDATES_ATTESTED_AT_COLUMN]: null,
        [PRIVATE_CANDIDATES_ATTESTED_BY_COLUMN]: null,
      }
    : {
        [PRIVATE_CANDIDATES_ATTESTED_COLUMN]: true,
        [PRIVATE_CANDIDATES_ATTESTED_AT_COLUMN]: now().toISOString(),
        [PRIVATE_CANDIDATES_ATTESTED_BY_COLUMN]: parsed.by,
      };

  const url = new URL(`${access.baseUrl}/rest/v1/${encodeURIComponent(access.table)}`);
  for (const [column, filter] of filters) url.searchParams.set(column, filter);
  const response = await fetchImpl(url, {
    method: "PATCH",
    headers: {
      apikey: access.apiKey,
      authorization: `Bearer ${access.apiKey}`,
      "content-type": "application/json",
      // The representation is the proof. A 204 would leave "how many rows did that change" a guess,
      // and the one answer this command must never guess at is whether it granted access to one
      // person or to none.
      prefer: "return=representation",
      accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Identity directory attestation update failed with status ${response.status}.`);
  }
  const updated = (await response.json()) as unknown;
  // COUNT first, then validate the element. Filtering malformed elements out before counting meant
  // a body of `[row, null]` — two rows changed, one of them unreadable — reported success on the
  // strength of the readable one. The whole point of `return=representation` is not to guess at how
  // many rows this granted access to.
  if (!Array.isArray(updated) || updated.length !== 1) {
    throw new Error(
      `Expected exactly one resolved directory row for greenhouse_user_id ${greenhouseUserId}; the update returned ${
        Array.isArray(updated) ? updated.length : "a non-array response"
      }.`
    );
  }
  const after = updated[0] as unknown;
  if (after === null || typeof after !== "object" || Array.isArray(after)) {
    throw new Error(
      `Expected exactly one resolved directory row for greenhouse_user_id ${greenhouseUserId}; the update returned an unusable row.`
    );
  }

  return {
    status: parsed.clear ? SUCCESS_STATUSES.clear : SUCCESS_STATUSES.set,
    table: access.table,
    greenhouseUserId,
    before,
    after: after as Record<string, unknown>,
    containsTokens: false,
  };
}

export async function startAttestPrivateCandidatesCli(
  env: NodeJS.ProcessEnv = process.env,
  args: string[] = process.argv.slice(2)
): Promise<void> {
  try {
    const report = await attestPrivateCandidates(env, args);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[greenhouse-recruiter-attest-private-candidates] ${message}\n`);
    process.exitCode = 1;
  }
}
