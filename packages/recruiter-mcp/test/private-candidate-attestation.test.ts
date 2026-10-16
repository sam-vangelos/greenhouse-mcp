import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPrivateCandidateAttestationLookup,
  createPrivateCandidateAttestationStamp,
  PRIVATE_CANDIDATE_ATTESTATION_COLUMNS,
} from "../src/private-candidate-attestation.js";
import { createHarvestPermissionProvider, type PermissionLookupResult, type RawReadClient } from "../../scoped-core/src/index.js";
import { createSiteAdminAwarePermissionProvider } from "../src/site-admin-permission.js";
import { buildIdentityBootstrapPlan } from "../src/identity-bootstrap.js";
import { createOauthEnrollment } from "../src/oauth-enroll.js";
import {
  applyIdentityReconciliationPlan,
  buildIdentityReconciliationPlan,
  fetchResolvedDirectoryRows,
} from "../src/identity-reconciliation.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION = join(HERE, "../supabase/migrations/0008_private_candidate_attestation.sql");

const SUPABASE_URL = "https://exampleprojectref000.supabase.co";
const ENV = {
  GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_URL: SUPABASE_URL,
  GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_KEY: "test-service-role-key",
} as NodeJS.ProcessEnv;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// ---------------------------------------------------------------------------
// B8 — migration 0008 is re-runnable and additive only
// ---------------------------------------------------------------------------

describe("B8: migration 0008_private_candidate_attestation", () => {
  const sql = readFileSync(MIGRATION, "utf8");
  // Statements only. The header comment explains the `add column if not exists` rule and the RLS
  // inheritance in prose, and a scan that read the prose would pass on the explanation rather than
  // on the SQL.
  const normalized = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join(" ")
    .replace(/\s+/g, " ")
    .toLowerCase();

  it("adds exactly the three attestation columns, each with `if not exists`", () => {
    const additions = [...normalized.matchAll(/add column(?: if not exists)? ([a-z_]+)/g)];
    assert.deepEqual(
      additions.map((match) => match[1]),
      ["private_candidates_attested", "private_candidates_attested_at", "private_candidates_attested_by"]
    );
    assert.equal(
      normalized.split("add column if not exists").length - 1,
      3,
      "every `add column` must carry `if not exists` — the migration is applied by hand and re-applied on rebuilds"
    );
  });

  it("contains no bare `add column` and no destructive statement", () => {
    assert.ok(!/add column(?! if not exists)/.test(normalized), "a bare `add column` breaks re-runnability");
    assert.ok(!/\bdrop\b/.test(normalized), "0008 is additive; nothing is dropped");
    assert.ok(!/\bgrant\b/.test(normalized) && !/row level security/.test(normalized),
      "RLS and grants are set in 0001 and inherited by new columns");
  });

  it("declares the three column names the code reads and writes", () => {
    for (const column of PRIVATE_CANDIDATE_ATTESTATION_COLUMNS) {
      assert.ok(normalized.includes(column), `migration must add ${column}`);
      assert.ok(normalized.includes(`comment on column recruiter_identity_directory.${column}`),
        `${column} must be documented in the database, not only here`);
    }
  });

  it("defaults the boolean to false so every pre-existing row is unattested", () => {
    assert.match(normalized, /private_candidates_attested boolean not null default false/);
  });
});

// ---------------------------------------------------------------------------
// B9 — the attestation lookup: true only for exactly-one-row-true, never throws
// ---------------------------------------------------------------------------

describe("B9: private-candidate attestation lookup", () => {
  it("is true only when exactly one resolved row carries the flag as literal true", async () => {
    let requestedUrl = "";
    const lookup = createPrivateCandidateAttestationLookup(ENV, async (input) => {
      requestedUrl = String(input);
      return jsonResponse([{ private_candidates_attested: true }]);
    });
    assert.equal(await lookup(7100000001), true);
    const url = new URL(requestedUrl);
    assert.equal(url.pathname, "/rest/v1/recruiter_identity_directory");
    assert.equal(url.searchParams.get("select"), "private_candidates_attested");
    assert.equal(url.searchParams.get("greenhouse_user_id"), "eq.7100000001");
    assert.equal(url.searchParams.get("status"), "eq.resolved");
    assert.equal(url.searchParams.get("limit"), "2", "two rows are read so a duplicate is detectable, never assumed away");
  });

  it("returns false — and never rejects — for every other outcome", async () => {
    const cases: Array<[string, () => Promise<Response>]> = [
      ["zero rows", async () => jsonResponse([])],
      ["two rows", async () => jsonResponse([{ private_candidates_attested: true }, { private_candidates_attested: true }])],
      ["flag false", async () => jsonResponse([{ private_candidates_attested: false }])],
      ["flag null", async () => jsonResponse([{ private_candidates_attested: null }])],
      ["flag missing", async () => jsonResponse([{}])],
      ["flag is the string true", async () => jsonResponse([{ private_candidates_attested: "true" }])],
      ["400 with 42703 undefined column", async () => new Response(
        JSON.stringify({ code: "42703", message: `column "private_candidates_attested" does not exist` }),
        { status: 400 }
      )],
      ["500", async () => new Response("upstream failure", { status: 500 })],
      ["non-array body", async () => jsonResponse({ private_candidates_attested: true })],
      ["malformed JSON", async () => new Response("{not json", { status: 200, headers: { "content-type": "application/json" } })],
      ["network error", async () => { throw new Error("ECONNRESET"); }],
      ["timeout", async () => { const error = new Error("lookup timed out"); error.name = "ExternalLookupTimeoutError"; throw error; }],
    ];
    for (const [label, impl] of cases) {
      const warnings: string[] = [];
      const lookup = createPrivateCandidateAttestationLookup(
        { ...ENV, GREENHOUSE_RECRUITER_PRIVATE_CANDIDATE_ATTESTATION_WARN: "capture" },
        impl as unknown as typeof fetch,
        (message) => warnings.push(message)
      );
      assert.equal(await lookup(7100000001), false, label);
      assert.ok(!warnings.some((warning) => warning.includes("test-service-role-key")), `${label}: warnings must never carry the key`);
    }
  });

  it("warns once per failure class per lookup rather than once per read", async () => {
    const warnings: string[] = [];
    const lookup = createPrivateCandidateAttestationLookup(ENV, async () => new Response("boom", { status: 500 }), (message) => warnings.push(message));
    await lookup(1);
    await lookup(2);
    await lookup(3);
    assert.equal(warnings.length, 1, "one warning per distinct failure class, not one per read");
  });

  it("returns false without a request when the directory is not Supabase-backed, or the id is not a positive integer", async () => {
    let calls = 0;
    const unconfigured = createPrivateCandidateAttestationLookup({} as NodeJS.ProcessEnv, async () => { calls += 1; return jsonResponse([]); });
    assert.equal(await unconfigured(7100000001), false);
    const configured = createPrivateCandidateAttestationLookup(ENV, async () => { calls += 1; return jsonResponse([{ private_candidates_attested: true }]); });
    assert.equal(await configured(0), false);
    assert.equal(await configured(-1), false);
    assert.equal(await configured(1.5), false);
    assert.equal(calls, 0, "neither an unconfigured directory nor an invalid id may reach the network");
  });
});

// ---------------------------------------------------------------------------
// B13 — the provider stamp
// ---------------------------------------------------------------------------

function rawReader(handler: (path: string, params?: Record<string, unknown>) => unknown): RawReadClient {
  return {
    async read<T>(path: string, params?: Record<string, unknown>) {
      return { data: handler(path, params) as T, nextCursor: null };
    },
  };
}

describe("B13: the permission-provider attestation stamp", () => {
  // A site admin: absent from /user_job_permissions except for one explicit Private Job Admin grant
  // on job 7, `site_admin: true` on /users, and no confidential jobs in the tenant.
  function siteAdminChain() {
    const raw = rawReader((path, params) => {
      if (path === "/users") return [{ id: 100, site_admin: true, deactivated: false }];
      if (path === "/jobs") return [];
      if (path === "/user_job_permissions") {
        return String(params?.user_ids) === "100" ? [{ user_id: 100, job_id: 7, role_id: 900 }] : [];
      }
      if (path === "/user_roles") return [{ id: 900, name: "Private", role_type: "job_admin" }];
      return [];
    });
    const base = createHarvestPermissionProvider({ rawReader: raw });
    return { base, chained: createSiteAdminAwarePermissionProvider({ base, rawReader: raw }) };
  }

  it("stamps an attested all-access answer from the site-admin path", async () => {
    const { base, chained } = siteAdminChain();
    const stamp = createPrivateCandidateAttestationStamp({ chained, base, isAttested: async () => true });
    const scope = await stamp.getPermittedJobIds(100) as { kind: string; privateCandidatesAttested?: boolean };
    assert.equal(scope.kind, "all");
    assert.equal(scope.privateCandidatesAttested, true);
  });

  it("stamps an unattested all-access answer with the actor's explicit private-capable jobs", async () => {
    const { base, chained } = siteAdminChain();
    const stamp = createPrivateCandidateAttestationStamp({ chained, base, isAttested: async () => false });
    const scope = await stamp.getPermittedJobIds(100) as {
      kind: string;
      privateCandidatesAttested?: boolean;
      privateCapableJobIds?: ReadonlySet<number>;
    };
    assert.equal(scope.kind, "all");
    assert.equal(scope.privateCandidatesAttested, false);
    assert.deepEqual([...(scope.privateCapableJobIds ?? [])], [7],
      "an unattested all-access actor keeps the private access their per-job Greenhouse roles grant");
  });

  it("stamps an all-access answer that came from the base provider's all-jobs role marker", async () => {
    const raw = rawReader((path) => {
      if (path === "/users") return [{ id: 100, site_admin: false }];
      if (path === "/user_job_permissions") return [{ user_id: 100, role: { name: "All Jobs" } }];
      return [];
    });
    const base = createHarvestPermissionProvider({ rawReader: raw });
    const chained = createSiteAdminAwarePermissionProvider({ base, rawReader: raw });
    const stamp = createPrivateCandidateAttestationStamp({ chained, base, isAttested: async () => true });
    const scope = await stamp.getPermittedJobIds(100) as { kind: string; privateCandidatesAttested?: boolean };
    assert.equal(scope.kind, "all");
    assert.equal(scope.privateCandidatesAttested, true);
  });

  it("leaves a job-scoped answer untouched and never asks for an attestation", async () => {
    let asked = 0;
    // The chain's exact object, so the assertion below is identity rather than a disjunction that
    // both a Set and a `{kind:"jobs"}` object satisfy — the shape a stamp that rebuilt the answer
    // would also satisfy.
    const chainAnswer: PermissionLookupResult = { kind: "jobs", jobIds: new Set([3]) };
    const chained = { async getPermittedJobIds(): Promise<PermissionLookupResult> { return chainAnswer; } };
    const base = { async getPermittedJobIds(): Promise<PermissionLookupResult> { return chainAnswer; } };
    const stamp = createPrivateCandidateAttestationStamp({ chained, base, isAttested: async () => { asked += 1; return true; } });
    const scope = await stamp.getPermittedJobIds(100);
    assert.strictEqual(scope, chainAnswer, "a non-all answer is handed back untouched, not rebuilt");
    assert.equal(asked, 0, "a job-scoped actor has no org-wide grant to attest");
  });

  it("never mutates the object the chain returned, and hands back a fresh object each call", async () => {
    const chainedScope: Record<string, unknown> = { kind: "all" };
    const chained = { async getPermittedJobIds(): Promise<PermissionLookupResult> { return chainedScope as never; } };
    const base = { async getPermittedJobIds(): Promise<PermissionLookupResult> { return new Set<number>(); } };
    const stamp = createPrivateCandidateAttestationStamp({ chained, base, isAttested: async () => true });
    const first = await stamp.getPermittedJobIds(100);
    const second = await stamp.getPermittedJobIds(100);
    assert.notEqual(first, chainedScope, "stamping must never write onto the memoized chain answer");
    assert.notEqual(first, second);
    assert.deepEqual(Object.keys(chainedScope), ["kind"], "the chain's own object is unchanged");
  });
});

// ---------------------------------------------------------------------------
// B10 — the identity writers
// ---------------------------------------------------------------------------

describe("B10: identity writers and the attestation columns", () => {
  it("bootstrap's upsert payload carries none of the three columns — an upsert must never clear a live attestation", () => {
    const plan = buildIdentityBootstrapPlan({
      rosterEmails: ["someone@example.com"],
      greenhouseUsers: [{ id: 7100000001, primary_email: "someone@example.com" }],
      allowedDomains: ["example.com"],
      source: "operator_bootstrap",
      generatedAt: "2026-09-03T00:00:00.000Z",
    });
    assert.equal(plan.resolved.length, 1, plan.denied.map((entry) => entry.reason).join("; "));
    const keys = Object.keys(plan.resolved[0]!.row);
    for (const column of PRIVATE_CANDIDATE_ATTESTATION_COLUMNS) {
      assert.ok(!keys.includes(column), `re-bootstrapping a recruiter must not resurrect or clear ${column}`);
    }
  });

  it("the oauth enrollment insert carries none of the three columns — a new enrollment takes the database default", async () => {
    // Asserted on the PAYLOAD the enrollment actually POSTs, through a fake directory. The previous
    // version grepped oauth-enroll.ts for the column names, which would have passed just as
    // happily if the enrollment had started writing them through a variable.
    const posted: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (input: URL | string, init: RequestInit = {}) => {
      const url = new URL(String(input));
      if ((init.method ?? "GET") === "POST" && url.pathname.includes("recruiter_identity_directory")) {
        const body = JSON.parse(String(init.body)) as unknown;
        for (const row of Array.isArray(body) ? body : [body]) posted.push(row as Record<string, unknown>);
        return jsonResponse([{ greenhouse_user_id: 7100000001 }], 201);
      }
      return jsonResponse([]);
    }) as unknown as typeof fetch;

    const enrollment = createOauthEnrollment({
      readUsersByPrimaryEmail: async () => [{ id: 7100000001, primary_email: "new@example.com" }],
      readFullRoster: async () => ({ users: [], complete: true }),
      directory: {
        supabaseUrl: SUPABASE_URL,
        apiKey: "test-service-role-key",
        table: "recruiter_identity_directory",
        timeoutMs: 5_000,
        fetchImpl,
      },
      allowedDomains: ["example.com"],
      disabled: false,
    });
    const outcome = await enrollment.enroll("new@example.com");

    assert.equal(outcome.status, "enrolled", JSON.stringify(outcome));
    assert.equal(posted.length, 1, "the enrollment must have inserted exactly one directory row");
    for (const column of PRIVATE_CANDIDATE_ATTESTATION_COLUMNS) {
      assert.ok(!(column in posted[0]!), `a new enrollment must take the database default for ${column}, not set it`);
    }
  });

  it("reconciliation's deprovision PATCH clears all three columns", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const plan = buildIdentityReconciliationPlan({
      directoryRows: [{ greenhouseUserId: 7100000001, primaryEmail: "gone@example.com", status: "resolved" }],
      greenhouseUsers: [{ id: 7100000001, primary_email: "gone@example.com", deactivated: true }],
      rosterComplete: true,
      rosterAsOf: "2026-09-03T00:00:00.000Z",
    });
    assert.equal(plan.revoked.length + plan.tombstoned.length, 1);
    await applyIdentityReconciliationPlan(plan, {
      supabaseUrl: SUPABASE_URL,
      apiKey: "test-service-role-key",
      appliedAt: "2026-09-03T00:00:00.000Z",
      fetchImpl: (async (_input: unknown, init: RequestInit) => {
        if (init?.method === "PATCH") bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return jsonResponse([]);
      }) as unknown as typeof fetch,
    });
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0]!.private_candidates_attested, false);
    assert.equal(bodies[0]!.private_candidates_attested_at, null);
    assert.equal(
      bodies[0]!.private_candidates_attested_by,
      null,
      "the column names the OPERATOR who attested, so clearing it writes null — the cause is recorded " +
        "in evidence_detail, where the rest of the deprovisioning provenance already lives"
    );
    assert.deepEqual(bodies[0]!.evidence_detail, {
      source: "identity_directory_reconciliation",
      action: "revoke",
      reason: "Greenhouse user is deactivated in the roster.",
    });
  });
});

// ---------------------------------------------------------------------------
// B21 — the base provider runs ONCE per stamp, and the site-admin path stops
//       discarding its private-capable answer
// ---------------------------------------------------------------------------

describe("B21: one base-provider sweep per stamp", () => {
  function countingChain(rows: {
    users: unknown[];
    jobs?: unknown[];
    permissions: unknown[];
    roles?: unknown[];
  }) {
    const sweeps: string[] = [];
    const raw = rawReader((path, params) => {
      if (path === "/users") return rows.users;
      if (path === "/jobs") return rows.jobs ?? [];
      if (path === "/user_job_permissions") {
        sweeps.push(String(params?.user_ids ?? "cursor"));
        return rows.permissions;
      }
      if (path === "/user_roles") return rows.roles ?? [];
      return [];
    });
    const base = createHarvestPermissionProvider({ rawReader: raw });
    return { sweeps, base, chained: createSiteAdminAwarePermissionProvider({ base, rawReader: raw }) };
  }

  it("sweeps /user_job_permissions once for an unattested site admin with confidential jobs", async () => {
    const { sweeps, base, chained } = countingChain({
      users: [{ id: 100, site_admin: true, deactivated: false }],
      jobs: [{ id: 42, confidential: true }],
      permissions: [{ user_id: 100, job_id: 7, role_id: 900 }],
      roles: [{ id: 900, name: "Private", role_type: "job_admin" }],
    });
    const stamp = createPrivateCandidateAttestationStamp({ chained, base, isAttested: async () => false });
    const scope = await stamp.getPermittedJobIds(100) as {
      kind: string;
      excludedJobIds?: ReadonlySet<number>;
      privateCapableJobIds?: ReadonlySet<number>;
    };

    assert.equal(scope.kind, "all");
    assert.deepEqual([...(scope.excludedJobIds ?? [])], [42]);
    assert.deepEqual([...(scope.privateCapableJobIds ?? [])], [7]);
    assert.equal(sweeps.length, 1,
      "the site-admin wrapper already read the grants for the confidential check; the stamp must reuse that answer");
  });

  it("carries the private-capable jobs the site-admin wrapper resolved, without a second sweep", async () => {
    const { sweeps, base, chained } = countingChain({
      users: [{ id: 100, site_admin: true, deactivated: false }],
      jobs: [{ id: 42, confidential: true }],
      permissions: [{ user_id: 100, job_id: 7, role_id: 900 }],
      roles: [{ id: 900, name: "Private", role_type: "job_admin" }],
    });
    const chainedScope = await chained.getPermittedJobIds(100) as { privateCapableJobIds?: ReadonlySet<number> };
    assert.deepEqual([...(chainedScope.privateCapableJobIds ?? [])], [7],
      "the wrapper widens the actor to `all` and used to throw the private-capable answer away");
    assert.equal(sweeps.length, 1);
    void base;
  });

  it("keeps the private-capable jobs behind an all-jobs role marker without asking base twice", async () => {
    const { sweeps, base, chained } = countingChain({
      users: [{ id: 100, site_admin: false }],
      permissions: [
        { user_id: 100, role: { name: "All Jobs" } },
        { user_id: 100, job_id: 7, role_id: 900 },
      ],
      roles: [{ id: 900, name: "Private", role_type: "job_admin" }],
    });
    const stamp = createPrivateCandidateAttestationStamp({ chained, base, isAttested: async () => false });
    const scope = await stamp.getPermittedJobIds(100) as {
      kind: string;
      privateCapableJobIds?: ReadonlySet<number>;
    };
    assert.equal(scope.kind, "all");
    assert.deepEqual([...(scope.privateCapableJobIds ?? [])], [7]);
    assert.equal(sweeps.length, 1, "the marker answer already carries the grants; a second base call is pure cost");
  });

  it("asks base at most once when the chain answered `all` with nothing to reuse", async () => {
    let baseCalls = 0;
    const chained = { async getPermittedJobIds(): Promise<PermissionLookupResult> { return { kind: "all" }; } };
    const base = {
      async getPermittedJobIds(): Promise<PermissionLookupResult> {
        baseCalls += 1;
        return { kind: "jobs", jobIds: new Set([7]), privateCapableJobIds: new Set([7]) };
      },
    };
    const stamp = createPrivateCandidateAttestationStamp({ chained, base, isAttested: async () => false });
    const scope = await stamp.getPermittedJobIds(100) as { privateCapableJobIds?: ReadonlySet<number> };
    assert.deepEqual([...(scope.privateCapableJobIds ?? [])], [7]);
    assert.equal(baseCalls, 1);
  });

  it("costs no base call at all for an ATTESTED actor", async () => {
    let baseCalls = 0;
    const chained = { async getPermittedJobIds(): Promise<PermissionLookupResult> { return { kind: "all" }; } };
    const base = {
      async getPermittedJobIds(): Promise<PermissionLookupResult> {
        baseCalls += 1;
        return new Set<number>();
      },
    };
    const stamp = createPrivateCandidateAttestationStamp({ chained, base, isAttested: async () => true });
    await stamp.getPermittedJobIds(100);
    assert.equal(baseCalls, 0);
  });
});

// ---------------------------------------------------------------------------
// B22 — the deprovision PATCH survives an unmigrated table, and keeps the
//       provenance of the attestation it clears
// ---------------------------------------------------------------------------

describe("B22: deprovisioning against a table migration 0008 has not reached", () => {
  function planFor(row: Record<string, unknown> = {}) {
    return buildIdentityReconciliationPlan({
      directoryRows: [
        {
          greenhouseUserId: 7100000001,
          primaryEmail: "gone@example.com",
          status: "resolved",
          ...row,
        } as never,
      ],
      greenhouseUsers: [{ id: 7100000001, primary_email: "gone@example.com", deactivated: true }],
      rosterComplete: true,
      rosterAsOf: "2026-09-03T00:00:00.000Z",
    });
  }

  it("retries without the attestation columns and still deactivates the row", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const report = await applyIdentityReconciliationPlan(planFor(), {
      supabaseUrl: SUPABASE_URL,
      apiKey: "test-service-role-key",
      appliedAt: "2026-09-03T00:00:00.000Z",
      fetchImpl: (async (_input: unknown, init: RequestInit) => {
        if (init?.method !== "PATCH") return jsonResponse([]);
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        bodies.push(body);
        if ("private_candidates_attested" in body) {
          return new Response(
            JSON.stringify({ code: "PGRST204", message: "Could not find the 'private_candidates_attested' column" }),
            { status: 400, headers: { "content-type": "application/json" } }
          );
        }
        return jsonResponse([]);
      }) as unknown as typeof fetch,
    });

    assert.equal(bodies.length, 2, "the first PATCH names the new columns; the retry drops them");
    assert.deepEqual(Object.keys(bodies[1]!).sort(), ["evidence_detail", "last_verified_at", "status"]);
    assert.equal(report.oauthRevocations.length, 1,
      "the OAuth sweep must still run — aborting on the first 400 left the session alive, which is fail-OPEN");
    assert.equal(report.entries?.[0]?.attestationCleared, false);
  });

  it("reports attestationCleared true on the ordinary path", async () => {
    const report = await applyIdentityReconciliationPlan(planFor(), {
      supabaseUrl: SUPABASE_URL,
      apiKey: "test-service-role-key",
      appliedAt: "2026-09-03T00:00:00.000Z",
      fetchImpl: (async () => jsonResponse([])) as unknown as typeof fetch,
    });
    assert.equal(report.entries?.[0]?.attestationCleared, true);
  });

  it("still throws, with the response body, on a 400 that is not a missing column", async () => {
    await assert.rejects(
      () =>
        applyIdentityReconciliationPlan(planFor(), {
          supabaseUrl: SUPABASE_URL,
          apiKey: "test-service-role-key",
          fetchImpl: (async (_input: unknown, init: RequestInit) =>
            init?.method === "PATCH"
              ? new Response(JSON.stringify({ code: "23505", message: "duplicate key" }), { status: 400 })
              : jsonResponse([])) as unknown as typeof fetch,
        }),
      /duplicate key/
    );
  });

  it("nulls the attested_by column and preserves the prior attestation as evidence", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    await applyIdentityReconciliationPlan(
      planFor({
        privateCandidatesAttested: true,
        privateCandidatesAttestedAt: "2026-09-01T10:00:00.000Z",
        privateCandidatesAttestedBy: "Avery Morgan (attested 2026-09-01)",
      }),
      {
        supabaseUrl: SUPABASE_URL,
        apiKey: "test-service-role-key",
        appliedAt: "2026-09-03T00:00:00.000Z",
        fetchImpl: (async (_input: unknown, init: RequestInit) => {
          if (init?.method === "PATCH") bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
          return jsonResponse([]);
        }) as unknown as typeof fetch,
      }
    );
    assert.equal(bodies[0]!.private_candidates_attested, false);
    assert.equal(bodies[0]!.private_candidates_attested_at, null);
    assert.equal(bodies[0]!.private_candidates_attested_by, null,
      "migration 0008 documents attested_by as null when unattested, and the CLI's --clear writes null");
    assert.deepEqual((bodies[0]!.evidence_detail as Record<string, unknown>).priorAttestation, {
      attested: true,
      at: "2026-09-01T10:00:00.000Z",
      by: "Avery Morgan (attested 2026-09-01)",
    });
  });

  it("reads the three columns in the plan select, and falls back when they do not exist", async () => {
    const selects: string[] = [];
    const rows = await fetchResolvedDirectoryRows({
      supabaseUrl: SUPABASE_URL,
      apiKey: "test-service-role-key",
      fetchImpl: (async (input: unknown) => {
        const select = new URL(String(input)).searchParams.get("select") ?? "";
        selects.push(select);
        if (select.includes("private_candidates_attested")) {
          return new Response(
            JSON.stringify({ code: "42703", message: 'column "private_candidates_attested" does not exist' }),
            { status: 400, headers: { "content-type": "application/json" } }
          );
        }
        return jsonResponse([
          { greenhouse_user_id: 1, primary_email: "a@example.com", status: "resolved" },
        ]);
      }) as unknown as typeof fetch,
    });
    assert.equal(selects.length, 2);
    assert.ok(selects[0]!.includes("private_candidates_attested"));
    assert.ok(!selects[1]!.includes("private_candidates_attested"));
    assert.equal(rows.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Fold 2 — the stamp path survives a directory that is down (item 4), and an
//          exclusion tenant with no Private roles costs one sweep (item 14)
// ---------------------------------------------------------------------------

describe("fold 2: a rejecting attestation lookup is unattested, not a read failure", () => {
  it("treats a lookup that THROWS as unattested and still recovers the explicit private-capable jobs", async () => {
    let baseCalls = 0;
    const chained = { async getPermittedJobIds(): Promise<PermissionLookupResult> { return { kind: "all" }; } };
    const base = {
      async getPermittedJobIds(): Promise<PermissionLookupResult> {
        baseCalls += 1;
        return { kind: "jobs", jobIds: new Set([7]), privateCapableJobIds: new Set([7]) };
      },
    };
    const stamp = createPrivateCandidateAttestationStamp({
      chained,
      base,
      isAttested: async () => {
        throw new Error("supabase unreachable");
      },
    });
    const scope = await stamp.getPermittedJobIds(100) as {
      kind: string;
      privateCandidatesAttested?: boolean;
      privateCapableJobIds?: ReadonlySet<number>;
    };
    assert.equal(scope.kind, "all");
    assert.equal(scope.privateCandidatesAttested, false);
    assert.deepEqual([...(scope.privateCapableJobIds ?? [])], [7],
      "a directory blip must not also cost the actor the reqs Greenhouse already granted them");
    assert.equal(baseCalls, 1);
  });

  it("propagates an abort rather than swallowing it as unattested", async () => {
    const controller = new AbortController();
    const chained = { async getPermittedJobIds(): Promise<PermissionLookupResult> { return { kind: "all" }; } };
    const base = { async getPermittedJobIds(): Promise<PermissionLookupResult> { return new Set<number>(); } };
    const stamp = createPrivateCandidateAttestationStamp({
      chained,
      base,
      isAttested: async () => {
        controller.abort(new Error("caller gave up"));
        controller.signal.throwIfAborted();
        return false;
      },
    });
    await assert.rejects(() => stamp.getPermittedJobIds(100, controller.signal), /caller gave up/);
  });
});

describe("fold 2: an exclusion tenant with no Private roles costs one base sweep, not two", () => {
  it("carries an explicit empty private-capable set so the stamp has nothing to re-fetch", async () => {
    const sweeps: string[] = [];
    const raw = rawReader((path, params) => {
      if (path === "/users") return [{ id: 100, site_admin: true, deactivated: false }];
      if (path === "/jobs") return [{ id: 42, confidential: true }];
      if (path === "/user_job_permissions") {
        sweeps.push(String(params?.user_ids ?? "cursor"));
        // Grants, but none of them through a private-capable role.
        return [{ user_id: 100, job_id: 7, role_id: 901 }];
      }
      if (path === "/user_roles") return [{ id: 901, name: "Job Admin: Standard", role_type: "job_admin" }];
      return [];
    });
    const base = createHarvestPermissionProvider({ rawReader: raw });
    const chained = createSiteAdminAwarePermissionProvider({ base, rawReader: raw });
    const stamp = createPrivateCandidateAttestationStamp({ chained, base, isAttested: async () => false });
    const scope = await stamp.getPermittedJobIds(100) as {
      kind: string;
      privateCapableJobIds?: ReadonlySet<number>;
    };
    assert.equal(scope.kind, "all");
    assert.deepEqual([...(scope.privateCapableJobIds ?? [])], []);
    assert.equal(sweeps.length, 1,
      "the wrapper resolved 'no private-capable jobs'; the stamp must read that as an answer, not as silence");
  });
});
