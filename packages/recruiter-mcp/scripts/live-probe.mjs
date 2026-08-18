#!/usr/bin/env node
/**
 * live-probe.mjs — Slice K live-probe prep (on-demand ops tool, NOT in CI).
 *
 * Settles six open factual questions about live Greenhouse + Supabase data in a
 * single run, so the campaign can replace assumptions with measurements:
 *
 *   Q1  stage_latency dwell population (#56): do live application stages carry the
 *       entered_at / exited_at / days_in_stage fields the dwell recipe needs?
 *   Q2  stage_conversion buildability (#16): is there enough stage history to build
 *       an A->B funnel (multi-row history + sort_order to order stages)?
 *   Q3  /v3/user_job_permissions all-access shape (#26): what does a known site
 *       admin's permission list actually look like — enumeration, marker, or empty?
 *   Q4  prospect magnitude: rough prospect vs non-prospect application counts.
 *   Q5  deployed Supabase project confirmation: does the runtime identity connection
 *       resolve to the canonical recruiter-identity project ref?
 *   Q6  reverse-direction check: does the analytics Supabase project already hold the
 *       two recruiter-identity tables (it must NOT)?
 *
 * READ-ONLY AND SAFE TO RUN IN PROD. Every Greenhouse call is a GET; every Supabase
 * call is a PostgREST `select ... limit 1`. The only POST is the standard OAuth2
 * client-credentials token exchange (it mints a short-lived read token, mutates
 * nothing). No write, patch, delete, or upsert is ever issued.
 *
 * Each question fails SOFT: one question erroring (missing creds, network, 4xx) is
 * labeled "COULD NOT ANSWER" and never aborts the others.
 *
 * ---------------------------------------------------------------------------
 * EXACT COMMAND (run from the repo root):
 *
 *   GREENHOUSE_CLIENT_ID=...                              # Q1-Q4 (Harvest v3 OAuth2 client id)
 *   GREENHOUSE_CLIENT_SECRET=...                          # Q1-Q4 (Harvest v3 OAuth2 client secret)
 *   PROBE_SITE_ADMIN_USER_ID=...                          # Q3   (a known Greenhouse user id that IS a site admin)
 *   GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_URL=https://exampleprojectref000.supabase.co  # Q5 (runtime identity project REST origin)
 *   GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_KEY=...        # Q5   (read key for that project: service_role, or any key with select on recruiter_identity_directory)
 *   PROBE_ANALYTICS_SUPABASE_URL=https://otherprojectref00000.supabase.co               # Q6 (analytics project REST origin)
 *   PROBE_ANALYTICS_SUPABASE_KEY=...                      # Q6   (service_role key for the analytics project — needed to tell "table absent" from "RLS-hidden")
 *   node packages/recruiter-mcp/scripts/live-probe.mjs
 *
 * Optional flags:
 *   --stage-pages=N     pages of 500 application_stages to sample for Q1/Q2 (default 4 = 2000 rows)
 *   --prospect-pages=N  page cap per prospect class for Q4 (default 10 = up to 5000 each; counts above the cap are reported as "N+ (capped)")
 *   --help              print this header and exit
 *
 * You may supply only a subset of credentials; questions whose inputs are missing
 * report "COULD NOT ANSWER (missing env: ...)" and the rest still run.
 *
 * Grounding (verified against the vendored Harvest v3 contract — fields are never invented):
 *   - docs/harvest-v3-api/raw/reference/0013-get_v3-application-stages.md
 *       application_stages rows carry: application_id, job_interview_stage_id, entered_at,
 *       exited_at (date-time, nullable), days_in_stage (integer), current (boolean).
 *       Doc: "This endpoint is the canonical source for stage-history reporting ... the fact table."
 *   - docs/harvest-v3-api/raw/reference/0015-get_v3-applications.md
 *       application rows (additionalProperties:false) carry NO stage-entry timestamp — only
 *       created_at / updated_at / last_activity_at / rejected_at, plus current stage_id/stage_name.
 *       Query params used here: prospect (boolean), per_page (<=500), fields (enum incl. id, prospect).
 *   - docs/harvest-v3-api/raw/reference/0166-get_v3-user-job-permissions.md
 *       rows: id, user_id, job_id, role_id, automated, created_at, updated_at. Doc: "Site admins
 *       are not represented here — they have implicit access to every non-confidential job."
 *   - docs/harvest-v3-api/raw/reference/0169-get_v3-users.md
 *       users carry a `site_admin` boolean = "unrestricted access to every non-confidential job".
 *       (This is the structured signal that replaces any free-text all-access heuristic.)
 *   - docs/harvest-v3-api/raw/reference/0108-get_v3-job-interview-stages.md
 *       stages carry `sort_order` (integer) + name; filter with job_ids. Needed to order A before B.
 *   - packages/control-plane/src/auth.ts / client.ts — OAuth2 token exchange + Bearer GET + Link cursor
 *       pagination modeled here directly (self-contained; does not import package internals).
 *   - scripts/greenhouse-mcp-supabase-guard.mjs — canonical ref exampleprojectref000 (Greenhouse MCP),
 *       analytics ref otherprojectref00000 (recruiting-ops-analytics).
 *   - packages/recruiter-mcp/supabase/migrations/0001_recruiter_identity_directory.sql — identity tables
 *       recruiter_identity_directory + recruiter_mcp_session_revocation.
 * ---------------------------------------------------------------------------
 */

// ---------------------------------------------------------------------------
// Grounded constants
// ---------------------------------------------------------------------------

const GH_TOKEN_URL = "https://auth.greenhouse.io/token"; // packages/control-plane/src/auth.ts
const GH_API_BASE = "https://harvest.greenhouse.io/v3"; // packages/control-plane/src/client.ts

// scripts/greenhouse-mcp-supabase-guard.mjs
const CANONICAL_SUPABASE_REF = "exampleprojectref000"; // "Greenhouse MCP" — recruiter identity project
const ANALYTICS_SUPABASE_REF = "otherprojectref00000"; // "recruiting-ops-analytics"

// packages/recruiter-mcp/supabase/migrations/0001_recruiter_identity_directory.sql
const IDENTITY_TABLES = ["recruiter_identity_directory", "recruiter_mcp_session_revocation"];

// ---------------------------------------------------------------------------
// CLI / env
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  printHeader();
  process.exit(0);
}

function intFlag(name, fallback) {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  const n = Number.parseInt(hit.split("=")[1], 10);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

const STAGE_SAMPLE_PAGES = intFlag("stage-pages", 4);
const PROSPECT_PAGE_CAP = intFlag("prospect-pages", 10);

const env = process.env;

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

const RULE = "=".repeat(74);

function section(label) {
  console.log(`\n${RULE}\n${label}\n${RULE}`);
}
function finding(text) {
  console.log(`FINDING: ${text}`);
}
function evidence(obj) {
  console.log("EVIDENCE:");
  for (const line of JSON.stringify(obj, null, 2).split("\n")) console.log(`  ${line}`);
}
function couldNotAnswer(reason) {
  console.log(`COULD NOT ANSWER: ${reason}`);
}

class MissingEnv extends Error {}
function requireEnv(...names) {
  const missing = names.filter((n) => !env[n] || String(env[n]).trim() === "");
  if (missing.length > 0) throw new MissingEnv(`missing env: ${missing.join(", ")}`);
}

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return "<unreadable>";
  }
}

// ---------------------------------------------------------------------------
// Greenhouse Harvest v3 (read-only; modeled on packages/control-plane/src/{auth,client}.ts)
// ---------------------------------------------------------------------------

async function greenhouseToken(clientId, clientSecret) {
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetch(GH_TOKEN_URL, {
    method: "POST", // standard OAuth2 client-credentials exchange — mints a read token, mutates nothing
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) {
    throw new Error(`token endpoint ${res.status} ${res.statusText}: ${(await safeText(res)).slice(0, 200)}`);
  }
  const json = await res.json();
  if (!json || typeof json.access_token !== "string") {
    throw new Error("token response missing access_token");
  }
  return json.access_token;
}

function parseNextCursor(linkHeader) {
  if (!linkHeader) return null;
  const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  if (!match) return null;
  try {
    return new URL(match[1]).searchParams.get("cursor");
  } catch {
    return null;
  }
}

// Per v3 docs, a cursor must be the ONLY query param; first page carries the filters.
async function ghPage(token, path, opts) {
  const url = new URL(`${GH_API_BASE}${path}`);
  if (opts.cursor) {
    url.searchParams.set("cursor", opts.cursor);
  } else if (opts.params) {
    for (const [key, value] of Object.entries(opts.params)) {
      if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
    }
  }
  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (res.status === 429) {
    throw new Error(`rate limited (429) on GET ${path}; re-run later`);
  }
  if (!res.ok) {
    throw new Error(`GET ${path} -> ${res.status} ${res.statusText}: ${(await safeText(res)).slice(0, 200)}`);
  }
  const data = await res.json();
  return {
    rows: Array.isArray(data) ? data : [],
    nextCursor: parseNextCursor(res.headers.get("link")),
  };
}

async function ghPaginate(token, path, params, pageCap) {
  let page = await ghPage(token, path, { params });
  const rows = [...page.rows];
  let pages = 1;
  while (page.nextCursor && pages < pageCap) {
    page = await ghPage(token, path, { cursor: page.nextCursor });
    rows.push(...page.rows);
    pages += 1;
  }
  return { rows, pages, capped: Boolean(page.nextCursor) };
}

// ---------------------------------------------------------------------------
// Supabase PostgREST (read-only select; modeled on mcp/greenhouse/.../auth.ts)
// ---------------------------------------------------------------------------

function supabaseRefFromUrl(rawUrl) {
  try {
    const host = new URL(rawUrl).hostname; // <ref>.supabase.co or db.<ref>.supabase.co
    const labels = host.split(".");
    // Project refs are 20-char lowercase alphanumerics; prefer that over the first label
    // so pooler/db-prefixed hostnames (db.<ref>.supabase.co) still resolve correctly.
    const refLike = labels.find((label) => /^[a-z0-9]{20}$/.test(label));
    return refLike ?? labels[0] ?? null;
  } catch {
    return null;
  }
}

async function supabaseSelect(rawUrl, key, table, columns = "*", limit = 1) {
  const origin = String(rawUrl).replace(/\/+$/, "");
  const url = new URL(`${origin}/rest/v1/${encodeURIComponent(table)}`);
  url.searchParams.set("select", columns);
  url.searchParams.set("limit", String(limit));
  const res = await fetch(url, {
    method: "GET",
    headers: { apikey: key, authorization: `Bearer ${key}`, accept: "application/json" },
  });
  return { status: res.status, body: (await safeText(res)).slice(0, 300) };
}

// Classify a PostgREST probe of one table into present / absent / inconclusive.
function classifyTablePresence({ status, body }) {
  if (status === 200) return { verdict: "PRESENT", note: "table exists and returned rows/empty array", status, body };
  if (status === 404) {
    if (/PGRST205|does not exist|could not find the table/i.test(body)) {
      return { verdict: "ABSENT", note: "relation not found (expected for a clean analytics project)", status, body };
    }
    return { verdict: "INCONCLUSIVE", note: "404 without a clear missing-relation code", status, body };
  }
  if (status === 401 || status === 403) {
    return { verdict: "INCONCLUSIVE", note: "auth/RLS blocked the read — use a service_role key to distinguish absent vs hidden", status, body };
  }
  return { verdict: "INCONCLUSIVE", note: `unexpected status ${status}`, status, body };
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

// Q1 — stage_latency dwell population (#56)
async function q1StageDwell() {
  requireEnv("GREENHOUSE_CLIENT_ID", "GREENHOUSE_CLIENT_SECRET");
  const token = await greenhouseToken(env.GREENHOUSE_CLIENT_ID, env.GREENHOUSE_CLIENT_SECRET);

  const stages = await ghPaginate(token, "/application_stages", { per_page: 500 }, STAGE_SAMPLE_PAGES);
  const total = stages.rows.length;
  let enteredAtPopulated = 0;
  let exitedAtPopulated = 0;
  let daysInStagePresent = 0;
  let daysInStageGtZero = 0;
  let currentRows = 0;
  for (const r of stages.rows) {
    if (r.entered_at) enteredAtPopulated += 1;
    if (r.exited_at) exitedAtPopulated += 1;
    if (typeof r.days_in_stage === "number") {
      daysInStagePresent += 1;
      if (r.days_in_stage > 0) daysInStageGtZero += 1;
    }
    if (r.current === true) currentRows += 1;
  }

  // Confirm /v3/applications itself carries no stage-entry timestamp.
  const appSample = await ghPaginate(token, "/applications", { per_page: 5 }, 1);
  const appKeys = appSample.rows[0] ? Object.keys(appSample.rows[0]).sort() : [];
  const stageTimestampKeysOnApplication = appKeys.filter((k) =>
    ["entered_at", "exited_at", "days_in_stage"].includes(k)
  );

  const computable = total > 0 && enteredAtPopulated > 0 && daysInStageGtZero > 0;
  finding(
    total === 0
      ? "No application_stages rows returned in the sample — cannot characterize dwell population."
      : computable
        ? `Dwell IS computable from live data: of ${total} application_stages rows, entered_at is populated on ${enteredAtPopulated} and days_in_stage>0 on ${daysInStageGtZero}. The fields live on /v3/application_stages (the canonical stage-history fact table), NOT on /v3/applications (which carries no stage-entry timestamp). The dwell recipe (stage_dwell_days requires days_in_stage) must source from /v3/application_stages.`
        : `Dwell is NOT populated in the live sample: of ${total} application_stages rows, entered_at populated on ${enteredAtPopulated}, days_in_stage>0 on ${daysInStageGtZero}. If these are ~0 this explains the all-zero stage_latency (#56). /v3/applications carries no stage-entry timestamp either.`
  );
  evidence({
    sampledRows: total,
    pagesFetched: stages.pages,
    sampleCapped: stages.capped,
    application_stages: {
      entered_at_populated: enteredAtPopulated,
      entered_at_null: total - enteredAtPopulated,
      exited_at_populated: exitedAtPopulated,
      exited_at_null: total - exitedAtPopulated,
      days_in_stage_present: daysInStagePresent,
      days_in_stage_gt_zero: daysInStageGtZero,
      days_in_stage_zero: daysInStagePresent - daysInStageGtZero,
      current_true_rows: currentRows,
    },
    applications_object_keys: appKeys,
    stage_timestamp_keys_on_application: stageTimestampKeysOnApplication, // expected: []
  });
}

// Q2 — stage_conversion buildability (#16)
async function q2StageConversion() {
  requireEnv("GREENHOUSE_CLIENT_ID", "GREENHOUSE_CLIENT_SECRET");
  const token = await greenhouseToken(env.GREENHOUSE_CLIENT_ID, env.GREENHOUSE_CLIENT_SECRET);

  const stages = await ghPaginate(token, "/application_stages", { per_page: 500 }, STAGE_SAMPLE_PAGES);
  const total = stages.rows.length;
  const byApplication = new Map();
  let pastRows = 0;
  let pastRowsWithExitedAt = 0;
  for (const r of stages.rows) {
    const appId = r.application_id;
    byApplication.set(appId, (byApplication.get(appId) ?? 0) + 1);
    if (r.current === false) {
      pastRows += 1;
      if (r.exited_at) pastRowsWithExitedAt += 1;
    }
  }
  const depths = [...byApplication.values()];
  const applicationsCovered = byApplication.size;
  const multiStageApplications = depths.filter((d) => d > 1).length;
  const maxHistoryDepth = depths.length > 0 ? Math.max(...depths) : 0;

  // sort_order needed to order stage A before stage B. Verify on a real job's plan.
  let sortOrderCheck = { attempted: false };
  try {
    const appForJob = await ghPaginate(token, "/applications", { per_page: 25, fields: "id,job_id" }, 1);
    const jobId = appForJob.rows.map((a) => a.job_id).find((id) => typeof id === "number");
    if (jobId !== undefined) {
      const planStages = await ghPaginate(token, "/job_interview_stages", { job_ids: jobId, per_page: 100 }, 1);
      const sample = planStages.rows[0] ? Object.keys(planStages.rows[0]).sort() : [];
      sortOrderCheck = {
        attempted: true,
        jobId,
        stagesInPlan: planStages.rows.length,
        sort_order_present: sample.includes("sort_order"),
        sort_order_values: planStages.rows.map((s) => s.sort_order).slice(0, 12),
        job_interview_stage_keys: sample,
      };
    } else {
      sortOrderCheck = { attempted: true, note: "no job_id available in applications sample to scope job_interview_stages" };
    }
  } catch (err) {
    sortOrderCheck = { attempted: true, error: err instanceof Error ? err.message : String(err) };
  }

  const buildable = multiStageApplications > 0 && pastRowsWithExitedAt > 0 && sortOrderCheck.sort_order_present === true;
  finding(
    total === 0
      ? "No application_stages rows returned — cannot judge conversion buildability."
      : buildable
        ? `A->B conversion IS buildable: ${multiStageApplications}/${applicationsCovered} sampled applications have multi-stage history (max depth ${maxHistoryDepth}), ${pastRowsWithExitedAt} past rows carry exited_at, and job_interview_stages exposes sort_order to order stages. Build it as distinct applications reaching stage A vs reaching stage B, joined on sort_order — matching the not-yet-implemented note in metrics.ts (stage_conversion_rate).`
        : `Conversion buildability is PARTIAL/UNCONFIRMED: multi-stage apps=${multiStageApplications}, past rows with exited_at=${pastRowsWithExitedAt}, sort_order present=${sortOrderCheck.sort_order_present ?? "unknown"}. All three are required for an honest A->B funnel.`
  );
  evidence({
    sampledRows: total,
    pagesFetched: stages.pages,
    sampleCapped: stages.capped,
    applicationsCovered,
    multiStageApplications,
    maxHistoryDepth,
    pastRows,
    pastRowsWithExitedAt,
    sortOrderCheck,
  });
}

// Q3 — /v3/user_job_permissions all-access shape (#26)
async function q3UserJobPermissions() {
  requireEnv("GREENHOUSE_CLIENT_ID", "GREENHOUSE_CLIENT_SECRET", "PROBE_SITE_ADMIN_USER_ID");
  const token = await greenhouseToken(env.GREENHOUSE_CLIENT_ID, env.GREENHOUSE_CLIENT_SECRET);
  const siteAdminId = env.PROBE_SITE_ADMIN_USER_ID;

  const perms = await ghPaginate(token, "/user_job_permissions", { user_ids: siteAdminId, per_page: 500 }, 5);
  const permKeys = perms.rows[0] ? Object.keys(perms.rows[0]).sort() : [];
  const allAccessMarkerKeys = permKeys.filter((k) => /all|every|wildcard|unrestricted|site_admin/i.test(k));

  const users = await ghPaginate(token, "/users", { ids: siteAdminId, per_page: 5 }, 1);
  const userRow =
    users.rows.find((u) => String(u.id) === String(siteAdminId)) ?? users.rows[0] ?? null;
  const siteAdminFlag = userRow ? userRow.site_admin : null;
  const userKeys = userRow ? Object.keys(userRow).sort() : [];

  finding(
    `For site-admin user ${siteAdminId}, /v3/user_job_permissions returned ${perms.rows.length} row(s) with keys [${permKeys.join(", ")}] — there is NO all-access marker field and NO enumeration of every job (a site admin's implicit access is simply absent here). The real signal is /v3/users.site_admin = ${JSON.stringify(siteAdminFlag)}. Replace any free-text heuristic with this structured boolean (already used by site-admin-permission.ts).`
  );
  evidence({
    user_job_permissions: {
      rowCount: perms.rows.length,
      pagesFetched: perms.pages,
      capped: perms.capped,
      rowKeys: permKeys,
      candidate_all_access_marker_keys: allAccessMarkerKeys, // expected: []
      firstRow: perms.rows[0] ?? null,
    },
    users_lookup: {
      matchedUser: Boolean(userRow),
      site_admin: siteAdminFlag,
      userKeys,
    },
  });
}

// Q4 — prospect magnitude
async function q4ProspectMagnitude() {
  requireEnv("GREENHOUSE_CLIENT_ID", "GREENHOUSE_CLIENT_SECRET");
  const token = await greenhouseToken(env.GREENHOUSE_CLIENT_ID, env.GREENHOUSE_CLIENT_SECRET);

  const prospects = await ghPaginate(
    token,
    "/applications",
    { prospect: "true", per_page: 500, fields: "id,prospect" },
    PROSPECT_PAGE_CAP
  );
  const nonProspects = await ghPaginate(
    token,
    "/applications",
    { prospect: "false", per_page: 500, fields: "id,prospect" },
    PROSPECT_PAGE_CAP
  );

  const fmt = (r) => `${r.rows.length}${r.capped ? "+ (capped)" : ""}`;
  finding(
    `Prospect applications: ${fmt(prospects)}; non-prospect (candidate) applications: ${fmt(nonProspects)}.` +
      (prospects.capped || nonProspects.capped
        ? ` One or both counts hit the page cap (--prospect-pages=${PROSPECT_PAGE_CAP}); treat capped values as a lower bound and raise the cap for exact totals.`
        : " Both counts are exact (no page cap hit).")
  );
  evidence({
    pageCap: PROSPECT_PAGE_CAP,
    prospect_true: { count: prospects.rows.length, pages: prospects.pages, capped: prospects.capped },
    prospect_false: { count: nonProspects.rows.length, pages: nonProspects.pages, capped: nonProspects.capped },
  });
}

// Q5 — deployed Supabase project confirmation (runtime identity connection)
async function q5IdentityProject() {
  requireEnv("GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_URL");
  const url = env.GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_URL;
  const key = env.GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_KEY;
  const ref = supabaseRefFromUrl(url);
  const resolves =
    ref === CANONICAL_SUPABASE_REF
      ? "CANONICAL (Greenhouse MCP / recruiter-identity) — correct"
      : ref === ANALYTICS_SUPABASE_REF
        ? "ANALYTICS (recruiting-ops-analytics) — WRONG PROJECT for identity"
        : `UNKNOWN ref (neither canonical nor analytics)`;

  let liveCheck = { attempted: false, note: "GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_KEY not set — ref parsed from URL only" };
  if (key) {
    const r = await supabaseSelect(url, key, IDENTITY_TABLES[0], "greenhouse_user_id", 1);
    liveCheck = {
      attempted: true,
      table: IDENTITY_TABLES[0],
      ...classifyTablePresence(r),
    };
  }

  finding(
    `Runtime identity Supabase URL resolves to project ref "${ref}" -> ${resolves}. Expected canonical ref is ${CANONICAL_SUPABASE_REF}.` +
      (liveCheck.attempted
        ? ` Live reachability of ${IDENTITY_TABLES[0]}: ${liveCheck.verdict} (HTTP ${liveCheck.status}).`
        : " (no key provided, so connection was not live-verified).")
  );
  evidence({
    parsedRef: ref,
    canonicalRef: CANONICAL_SUPABASE_REF,
    analyticsRef: ANALYTICS_SUPABASE_REF,
    resolution: resolves,
    liveCheck,
  });
}

// Q6 — reverse-direction check: analytics project must NOT hold identity tables
async function q6ReverseTableCheck() {
  requireEnv("PROBE_ANALYTICS_SUPABASE_URL", "PROBE_ANALYTICS_SUPABASE_KEY");
  const url = env.PROBE_ANALYTICS_SUPABASE_URL;
  const key = env.PROBE_ANALYTICS_SUPABASE_KEY;
  const ref = supabaseRefFromUrl(url);
  const refNote =
    ref === ANALYTICS_SUPABASE_REF
      ? "matches the expected analytics ref"
      : `WARNING: ref "${ref}" != expected analytics ref ${ANALYTICS_SUPABASE_REF}`;

  const perTable = {};
  for (const table of IDENTITY_TABLES) {
    const r = await supabaseSelect(url, key, table, "*", 1);
    perTable[table] = classifyTablePresence(r);
  }

  const anyPresent = Object.values(perTable).some((t) => t.verdict === "PRESENT");
  const anyInconclusive = Object.values(perTable).some((t) => t.verdict === "INCONCLUSIVE");
  finding(
    anyPresent
      ? `CONTAMINATION: the analytics project (${ref}) already contains at least one recruiter-identity table. It should hold none. ${IDENTITY_TABLES.map((t) => `${t}=${perTable[t].verdict}`).join(", ")}.`
      : anyInconclusive
        ? `Inconclusive: could not confirm absence for every table (likely an RLS/key issue — use the analytics service_role key). ${IDENTITY_TABLES.map((t) => `${t}=${perTable[t].verdict}`).join(", ")}.`
        : `Clean: the analytics project (${ref}) contains NEITHER recruiter-identity table, as required. ${IDENTITY_TABLES.map((t) => `${t}=ABSENT`).join(", ")}.`
  );
  evidence({ analyticsRefCheck: refNote, parsedRef: ref, expectedAnalyticsRef: ANALYTICS_SUPABASE_REF, perTable });
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const QUESTIONS = [
  ["[Q1] stage_latency dwell population (#56)", q1StageDwell],
  ["[Q2] stage_conversion buildability (#16)", q2StageConversion],
  ["[Q3] /v3/user_job_permissions all-access shape (#26)", q3UserJobPermissions],
  ["[Q4] prospect magnitude", q4ProspectMagnitude],
  ["[Q5] deployed Supabase project confirmation", q5IdentityProject],
  ["[Q6] reverse-direction Supabase table check", q6ReverseTableCheck],
];

function printHeader() {
  console.log("live-probe.mjs — read-only Greenhouse + Supabase fact probe (Slice K).");
  console.log("Safe to run in prod: GETs / PostgREST selects only; the single POST is the OAuth2 token exchange.");
  console.log("See the top-of-file comment block for the exact command and required env vars.");
}

async function main() {
  printHeader();
  console.log(`\nStarted ${new Date().toISOString()} | stage-pages=${STAGE_SAMPLE_PAGES} | prospect-pages=${PROSPECT_PAGE_CAP}`);

  let answered = 0;
  for (const [label, fn] of QUESTIONS) {
    section(label);
    try {
      await fn();
      answered += 1;
    } catch (err) {
      if (err instanceof MissingEnv) {
        couldNotAnswer(err.message);
      } else {
        couldNotAnswer(err instanceof Error ? err.message : String(err));
      }
    }
  }

  section(`Done: ${answered}/${QUESTIONS.length} questions answered. No data was mutated.`);
}

main().catch((err) => {
  console.error(`live-probe fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
