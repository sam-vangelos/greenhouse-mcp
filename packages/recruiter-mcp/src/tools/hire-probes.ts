/**
 * The three live probes that ride along with H0.
 *
 * None of them is a new binary. Each is the same shape as the package's other live probes
 * — OAuth2 client-credentials token exchange against `https://auth.greenhouse.io/token`, then a
 * bearer GET against `https://harvest.greenhouse.io/v3` — so an operator can run each as a
 * one-liner and record the answer on CLO-269. Every one is a GET; nothing mutates.
 *
 * Get a token once (never echo it; `$TOKEN` stays in the shell):
 *
 *   TOKEN=$(curl -s -X POST https://auth.greenhouse.io/token \
 *     -d grant_type=client_credentials -d client_id="$GREENHOUSE_CLIENT_ID" \
 *     -d client_secret="$GREENHOUSE_CLIENT_SECRET" | python3 -c 'import json,sys;print(json.load(sys.stdin)["access_token"])')
 *
 * (a) OFFER COMPENSATION PRIVACY — decides whether PO10 (offer against the posted band) can exist
 *     on the recruiter surface at all. Prints the offer custom-field DEFINITIONS, which carry no
 *     candidate data, so the body is safe to read:
 *
 *   curl -s -H "Authorization: Bearer $TOKEN" \
 *     'https://harvest.greenhouse.io/v3/custom_fields?field_type=offer&active=true&per_page=200' \
 *     | python3 -c 'import json,sys;print(json.dumps([{k:f.get(k) for k in ("id","name","name_key","value_type","private")} for f in json.load(sys.stdin)],indent=1))'
 *
 *     Feed that array to `classifyOfferCompensationPrivacy` below for the verdict.
 *
 * (b) EEOC SCOPE — decides whether the deferred demographic mode is possible at all. BEHAVIOURAL,
 *     not a token inspection: the token's shape is unknown and decoding it would materialize a
 *     secret. Record the STATUS CODE only; `/v3/eeoc` returns row-level demographic responses tied
 *     to a candidate, the most sensitive body in the API, and it must never be printed:
 *
 *   curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" \
 *     'https://harvest.greenhouse.io/v3/eeoc?per_page=1'
 *
 * (c) USER_JOB_PERMISSIONS READABILITY — unblocks R2d's first binding ("who else can see this
 *     req"). Status code only, same discipline:
 *
 *   curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" \
 *     'https://harvest.greenhouse.io/v3/user_job_permissions?per_page=1'
 *
 * For (b) and (c): 200 means the credential holds the scope, 401/403 means it does not, and
 * anything else is inconclusive and should be recorded verbatim as the code it returned.
 */

export type OfferCompensationPrivacyVerdict = "withheld" | "available" | "inconclusive";

export interface OfferCompensationFieldRow {
  id?: number;
  name?: string;
  name_key?: string;
  value_type?: string;
  private?: boolean;
}

export interface OfferCompensationPrivacyProbe {
  verdict: OfferCompensationPrivacyVerdict;
  reason: string;
  matched: OfferCompensationFieldRow[];
}

// The compensation vocabulary a tenant actually uses on an offer field. Matched against `name` and
// `name_key` together, so a tenant that renamed the display label but kept the key still matches.
const COMPENSATION_NAME_PATTERN = /\b(salary|base[_\s-]?pay|basepay|compensation|comp|bonus|equity|stipend|ctc)\b/i;
// The two value_types Greenhouse gives a money field. A currency-typed offer field IS compensation
// whatever the tenant called it.
const COMPENSATION_VALUE_TYPES = new Set(["currency", "currency_range"]);

/**
 * Is the tenant's offer compensation flagged private?
 *
 * TRI-STATE on purpose. `withheld` and `available` are answers PO10 can be planned on; everything
 * else is `inconclusive`, which is also an answer — it says "do not plan PO10 on this yet", and it
 * covers the three ways this read can fail to settle the question:
 *
 *   - nothing on the offer surface looks like compensation (the field may be named something this
 *     pattern does not know, or the tenant may hold pay outside Greenhouse);
 *   - the matching fields DISAGREE, so "is comp private" has no single answer;
 *   - a matching definition carries no `private` flag at all, so the read never learned it.
 *
 * Guessing either way here would be the fabrication the whole build forbids: a false `available`
 * plans a recipe that returns nothing, and a false `withheld` withholds a capability for a
 * constraint nobody demonstrated.
 */
export function classifyOfferCompensationPrivacy(rows: unknown): OfferCompensationPrivacyProbe {
  const definitions = Array.isArray(rows) ? rows.filter(isRecord) : [];
  const matched: OfferCompensationFieldRow[] = [];
  let missingPrivateFlag = 0;

  for (const row of definitions) {
    // field_type is the probe's own filter (`?field_type=offer`), re-checked here because a caller
    // that pasted an unfiltered dump would otherwise classify a JOB pay field as an offer one.
    if (typeof row.field_type === "string" && row.field_type !== "offer") continue;
    const label = `${stringOrEmpty(row.name)} ${stringOrEmpty(row.name_key)}`;
    const valueType = stringOrEmpty(row.value_type);
    if (!COMPENSATION_NAME_PATTERN.test(label) && !COMPENSATION_VALUE_TYPES.has(valueType)) continue;
    if (typeof row.private !== "boolean") missingPrivateFlag += 1;
    matched.push({
      ...(typeof row.id === "number" ? { id: row.id } : {}),
      ...(typeof row.name === "string" ? { name: row.name } : {}),
      ...(typeof row.name_key === "string" ? { name_key: row.name_key } : {}),
      ...(valueType.length > 0 ? { value_type: valueType } : {}),
      ...(typeof row.private === "boolean" ? { private: row.private } : {}),
    });
  }

  if (matched.length === 0) {
    return {
      verdict: "inconclusive",
      reason: "no offer custom field in Greenhouse looks like compensation (no currency value_type and no compensation-shaped name), so this read cannot say whether offer pay is private.",
      matched,
    };
  }
  if (missingPrivateFlag > 0) {
    return {
      verdict: "inconclusive",
      reason: `${missingPrivateFlag} matching offer compensation field(s) carried no private flag at all, so this read never learned whether they are restricted.`,
      matched,
    };
  }
  const privateCount = matched.filter((row) => row.private === true).length;
  if (privateCount === matched.length) {
    return {
      verdict: "withheld",
      reason: `all ${matched.length} matching offer compensation field(s) are flagged private, so their values are stripped for every actor without Greenhouse's View Private permission.`,
      matched,
    };
  }
  if (privateCount === 0) {
    return {
      verdict: "available",
      reason: `all ${matched.length} matching offer compensation field(s) are readable, so offer compensation passes through on the offer row.`,
      matched,
    };
  }
  return {
    verdict: "inconclusive",
    reason: `the matching offer compensation fields disagree — ${privateCount} of ${matched.length} are flagged private — so there is no single answer for whether offer pay is private.`,
    matched,
  };
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
