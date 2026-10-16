import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createHarvestPermissionProvider,
  createScopedGreenhouseReader,
  type ActorResolver,
  type ApiResponse,
  type PermissionLookupResult,
  type PermissionProvider,
  type RawReadClient,
} from "../src/index.js";

/**
 * The private-candidate attestation gate (CLO-273, lane B).
 *
 * Greenhouse gates a private candidate on a user-specific permission Harvest v3 does not expose,
 * so all-access here is an INFERENCE (site_admin, or an all-jobs role marker) that says nothing
 * about it. These tests pin both halves: an ATTESTED all-access actor and an attested operator read
 * exactly what they read before, byte for byte; an UNATTESTED one keeps everything except the
 * private candidates their own Greenhouse roles do not reach.
 */

interface RawCall {
  path: string;
  params?: Record<string, unknown>;
  cursor?: string;
}

const CANDIDATES = [
  { id: 501, first_name: "Ada", private: false },
  { id: 502, first_name: "Bo", private: false },
  { id: 503, first_name: "Cy", private: false },
  { id: 504, first_name: "Di", private: true },
  { id: 505, first_name: "Eve", private: true },
];

// A candidate with NO application at all and nothing private about them. The job-scope filter path
// drops this shape as `missingParent`; the unattested branch must not.
const UNAPPLIED_CANDIDATE = { id: 506, first_name: "Fay", private: false };

const APPLICATIONS = [
  { id: 1001, job_id: 7, candidate_id: 501 },
  { id: 1002, job_id: 7, candidate_id: 502 },
  { id: 1003, job_id: 9, candidate_id: 503 },
  { id: 1004, job_id: 7, candidate_id: 504 },
  { id: 1005, job_id: 9, candidate_id: 505 },
];

function idsOf(params: Record<string, unknown> | undefined, key: string): number[] {
  return String(params?.[key] ?? "")
    .split(",")
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0);
}

/** The tenant, answered the way `/v3/candidates` and `/v3/applications` answer. */
function tenantHandler(path: string, params?: Record<string, unknown>): unknown {
  const everyCandidate = [...CANDIDATES, UNAPPLIED_CANDIDATE];
  if (path === "/candidates") {
    if (params?.ids !== undefined) {
      const wanted = new Set(idsOf(params, "ids"));
      const rows = everyCandidate.filter((row) => wanted.has(row.id));
      return params.fields === "id,private" ? rows.map((row) => ({ id: row.id, private: row.private })) : rows;
    }
    return CANDIDATES;
  }
  if (path === "/applications") {
    if (params?.candidate_ids !== undefined) {
      const wanted = new Set(idsOf(params, "candidate_ids"));
      return APPLICATIONS.filter((row) => wanted.has(row.candidate_id));
    }
    if (params?.ids !== undefined) {
      const wanted = new Set(idsOf(params, "ids"));
      return APPLICATIONS.filter((row) => wanted.has(row.id));
    }
    return APPLICATIONS;
  }
  return [];
}

function rawReader(
  handler: (path: string, params?: Record<string, unknown>, cursor?: string) => unknown = tenantHandler
): RawReadClient & { calls: RawCall[] } {
  const calls: RawCall[] = [];
  return {
    calls,
    async read<T = unknown>(path: string, params?: Record<string, unknown>, cursor?: string): Promise<ApiResponse<T>> {
      calls.push({ path, params, cursor });
      return { data: handler(path, params, cursor) as T, nextCursor: null };
    },
  };
}

function actorResolver(): ActorResolver<number> {
  return { resolveActor: (actorId) => actorId };
}

function providerReturning(scope: unknown): PermissionProvider {
  return { async getPermittedJobIds(): Promise<PermissionLookupResult> { return scope as PermissionLookupResult; } };
}

function readerFor(options: {
  scope?: unknown;
  raw?: RawReadClient & { calls: RawCall[] };
  operatorActorIds?: Set<number>;
  attestation?: (userId: number, signal?: AbortSignal) => Promise<boolean>;
  providerByActor?: Map<number, unknown>;
}) {
  const raw = options.raw ?? rawReader();
  const permissionProvider: PermissionProvider = options.providerByActor
    ? {
        async getPermittedJobIds(actorId: number): Promise<PermissionLookupResult> {
          return options.providerByActor!.get(actorId) as PermissionLookupResult;
        },
      }
    : providerReturning(options.scope);
  return {
    raw,
    scoped: createScopedGreenhouseReader<number>({
      actorResolver: actorResolver(),
      permissionProvider,
      rawReader: raw,
      ...(options.operatorActorIds ? { operatorActorIds: options.operatorActorIds } : {}),
      ...(options.attestation ? { privateCandidateAttestation: options.attestation } : {}),
    } as Parameters<typeof createScopedGreenhouseReader>[0]),
  };
}

function rowIds(data: unknown): number[] {
  return (data as Array<{ id: number }>).map((row) => row.id);
}

// ---------------------------------------------------------------------------
// B1 / B1b — the unattested all-access branch withholds private rows, batched
// ---------------------------------------------------------------------------

describe("B1: unattested all-access, list_candidates", () => {
  it("returns the public rows, counts the withheld ones, and says so in the envelope", async () => {
    const { raw, scoped } = readerFor({ scope: { kind: "all" } });
    const result = await scoped.scopedRead(100, "list_candidates", {});

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepStrictEqual(rowIds(result.data), [501, 502, 503]);
    assert.equal(result.rowCounts.privacyWithheld, 2);
    assert.equal(result.rowCounts.returned, 3);
    assert.equal(result.rowCounts.raw, 5);
    assert.equal(result.scoped, true, "rows were withheld, so this read was not unscoped");
    assert.deepStrictEqual(result.permissionScope, {
      kind: "all",
      permittedJobCount: null,
      privateCandidatesWithheld: true,
    });
    // Exactly one call: a `/v3/candidates` row carries `private` in its default field set, so the
    // gate reads the flag off the page it already has. An inequality here would pass just as
    // happily against a gate that fell back to one privacy read per row.
    assert.deepStrictEqual(raw.calls.map((call) => call.path), ["/candidates"]);
  });
});

describe("B1b: unattested all-access, an application-backed read", () => {
  it("withholds the applications of private candidates through one batched candidate lookup", async () => {
    const { raw, scoped } = readerFor({ scope: { kind: "all" } });
    const result = await scoped.scopedRead(100, "list_applications", {});

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepStrictEqual(rowIds(result.data), [1001, 1002, 1003]);
    assert.equal(result.rowCounts.privacyWithheld, 2);
    assert.equal(raw.calls.length, 2, "one page read plus one batched /candidates privacy read");
    const privacyRead = raw.calls[1]!;
    assert.equal(privacyRead.path, "/candidates");
    assert.equal(privacyRead.params?.fields, "id,private");
    assert.deepStrictEqual(idsOf(privacyRead.params, "ids"), [501, 502, 503, 504, 505]);
  });

  it("costs one page read plus ceil(n/50) batched candidate reads on a 100-row page", async () => {
    const rows = Array.from({ length: 100 }, (_, index) => ({
      id: 2000 + index,
      job_id: 7,
      candidate_id: 3000 + index,
    }));
    const raw = rawReader((path, params) => {
      if (path === "/applications") return rows;
      if (path === "/candidates") {
        // Twenty of the hundred are private.
        return idsOf(params, "ids").map((id) => ({ id, private: (id - 3000) % 5 === 0 }));
      }
      return [];
    });
    const { scoped } = readerFor({ scope: { kind: "all" }, raw });

    const result = await scoped.scopedRead(100, "list_applications", {});
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.rowCounts.returned, 80);
    assert.equal(result.rowCounts.privacyWithheld, 20);
    assert.equal(raw.calls.length, 3, "1 page + ceil(100/50) batched privacy reads — never one read per row");
  });
});

// ---------------------------------------------------------------------------
// B2 / B2b — an attested actor reads exactly what they read before
// ---------------------------------------------------------------------------

describe("B2: attested all-access is byte-identical to the unfiltered read", () => {
  // Captured against the code BEFORE the gate existed: an org-wide scope with nothing excluded
  // takes the raw fast path, reports scoped:false, and counts nothing as excluded.
  const EXPECTED_ENVELOPE = {
    ok: true,
    toolName: "list_candidates",
    actorId: 100,
    effectiveActorId: 100,
    scoped: false,
    permissionScope: { kind: "all", permittedJobCount: null },
    rowCounts: { raw: 5, returned: 5, permissionExcluded: 0, unresolved: 0, status: "complete" },
    data: CANDIDATES,
    nextCursor: null,
    meta: undefined,
  };

  it("returns every row and the pre-change envelope, routed through the provider answer", async () => {
    const { raw, scoped } = readerFor({ scope: { kind: "all", privateCandidatesAttested: true } });
    const result = await scoped.scopedRead(100, "list_candidates", {});
    assert.deepStrictEqual(result, EXPECTED_ENVELOPE);
    assert.equal(raw.calls.length, 1, "the attested fast path stays a single unfiltered read");
  });
});

describe("B2b: the flag survives normalization, and a malformed one is refused", () => {
  it("keeps the attestation across the provider-answer clone, exclusions included", async () => {
    const { scoped } = readerFor({
      scope: {
        kind: "all",
        excludedJobIds: new Set([9]),
        privateCandidatesAttested: true,
      },
    });
    const result = await scoped.scopedRead(100, "list_applications", {});
    assert.equal(result.ok, true);
    if (!result.ok) return;
    // Job 9 is excluded by Greenhouse's own confidential-job rule; job 7's private candidate is
    // still visible, because the actor is attested.
    assert.deepStrictEqual(rowIds(result.data), [1001, 1002, 1004]);
    assert.deepStrictEqual(result.permissionScope, { kind: "all", permittedJobCount: null });
  });

  it("keeps an unattested actor's explicit private-capable jobs across the clone", async () => {
    const { scoped } = readerFor({
      scope: { kind: "all", privateCandidatesAttested: false, privateCapableJobIds: new Set([7]) },
    });
    const result = await scoped.scopedRead(100, "list_applications", {});
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepStrictEqual(rowIds(result.data), [1001, 1002, 1003, 1004],
      "the private candidate on job 7 is reachable through the actor's own Greenhouse role");
  });

  it("refuses a provider answer whose attestation is not a boolean, or whose private set is not a set", async () => {
    for (const scope of [
      { kind: "all", privateCandidatesAttested: "true" },
      { kind: "all", privateCandidatesAttested: 1 },
      { kind: "all", privateCapableJobIds: 7 },
    ]) {
      const { scoped } = readerFor({ scope });
      const result = await scoped.scopedRead(100, "list_candidates", {});
      assert.equal(result.ok, false, JSON.stringify(scope));
      assert.equal(result.ok === false && result.denial.code, "PERMISSION_LOOKUP_FAILED");
    }
  });

  it("treats an absent flag as unattested", async () => {
    const { scoped } = readerFor({ scope: { kind: "all" } });
    const result = await scoped.scopedRead(100, "list_candidates", {});
    assert.equal(result.ok && result.rowCounts.privacyWithheld, 2);
  });
});

// ---------------------------------------------------------------------------
// B3 / B3b — point gets
// ---------------------------------------------------------------------------

describe("B3: a withheld point get is indistinguishable from a nonexistent id", () => {
  it("reports the same envelope for a private candidate and for an id that does not exist", async () => {
    const hidden = await readerFor({ scope: { kind: "all" } }).scoped.scopedRead(100, "get_candidate", { id: 504 });
    const missing = await readerFor({ scope: { kind: "all" } }).scoped.scopedRead(100, "get_candidate", { id: 999 });
    assert.equal(hidden.ok && hidden.data, null);
    assert.equal(missing.ok && missing.data, null);
    assert.deepStrictEqual(hidden, missing,
      "counts that separate 'withheld' from 'never existed' are a per-person existence oracle for the private flag");
  });

  it("returns the row to an attested actor", async () => {
    const { scoped } = readerFor({ scope: { kind: "all", privateCandidatesAttested: true } });
    const result = await scoped.scopedRead(100, "get_candidate", { id: 504 });
    assert.deepStrictEqual(result.ok && result.data, CANDIDATES[3]);
  });
});

describe("B3b: the unattested branch never inherits the job-scope filter's drops", () => {
  it("returns a public candidate who has no applications at all", async () => {
    const { scoped } = readerFor({ scope: { kind: "all" } });
    const result = await scoped.scopedRead(100, "get_candidate", { id: 506 });
    assert.deepStrictEqual(result.ok && result.data, UNAPPLIED_CANDIDATE,
      "a candidate with no application is `missingParent` to the job-scope filter; withholding them " +
        "would be the gate taking rows the actor is entitled to");
    assert.equal(result.ok && result.rowCounts.unresolved, 0);
    assert.equal(result.ok && result.rowCounts.status, "complete");
  });
});

// ---------------------------------------------------------------------------
// B5 — the direct-operator path
// ---------------------------------------------------------------------------

describe("B5: the operator path is gated by the same attestation", () => {
  const OPERATORS = new Set([900]);

  it("keeps an attested operator's raw envelope byte-identical", async () => {
    const { raw, scoped } = readerFor({
      scope: { kind: "all" },
      operatorActorIds: OPERATORS,
      attestation: async () => true,
    });
    const result = await scoped.scopedRead(900, "list_candidates", {});
    assert.deepStrictEqual(result, {
      ok: true,
      toolName: "list_candidates",
      actorId: 900,
      effectiveActorId: 900,
      scoped: false,
      permissionScope: { kind: "operator", permittedJobCount: null },
      rowCounts: { raw: 5, returned: 5, permissionExcluded: 0, unresolved: 0, status: "complete" },
      data: CANDIDATES,
      nextCursor: null,
      meta: undefined,
    });
    assert.equal(raw.calls.length, 1);
  });

  it("withholds private rows from an unattested operator", async () => {
    const { scoped } = readerFor({
      scope: { kind: "all" },
      operatorActorIds: OPERATORS,
      attestation: async () => false,
    });
    const result = await scoped.scopedRead(900, "list_candidates", {});
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepStrictEqual(rowIds(result.data), [501, 502, 503]);
    // scoped stays FALSE for an operator: three release-gate predicates require it. The
    // withholding is disclosed on permissionScope instead. See B16.
    assert.equal(result.scoped, false);
    assert.deepStrictEqual(result.permissionScope, {
      kind: "operator",
      permittedJobCount: null,
      privateCandidatesWithheld: true,
    });
  });

  it("treats a missing attestation lookup as unattested", async () => {
    const { scoped } = readerFor({ scope: { kind: "all" }, operatorActorIds: OPERATORS });
    const result = await scoped.scopedRead(900, "list_candidates", {});
    assert.deepStrictEqual(rowIds(result.ok ? result.data : []), [501, 502, 503],
      "no lookup configured means the permission cannot be established, which is not a grant");
  });

  it("uses the EFFECTIVE actor's attestation under actAsUser, not the operator's", async () => {
    const { scoped } = readerFor({
      providerByActor: new Map<number, unknown>([[100, { kind: "all", privateCandidatesAttested: true }]]),
      operatorActorIds: OPERATORS,
      // The operator's own lookup says no. It must not decide a read performed AS someone else.
      attestation: async () => false,
    });
    const result = await scoped.scopedRead(900, "list_candidates", {}, { actAsUser: 100 });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepStrictEqual(rowIds(result.data), [501, 502, 503, 504, 505]);
    assert.equal(result.effectiveActorId, 100);
  });
});

// ---------------------------------------------------------------------------
// B6 — job scopes are untouched
// ---------------------------------------------------------------------------

describe("B6: a job-scoped recruiter is unaffected by the attestation", () => {
  it("still sees the private candidates their Private Job Admin role reaches, and no others", async () => {
    const { scoped } = readerFor({
      scope: { kind: "jobs", jobIds: new Set([7]), privateCapableJobIds: new Set([7]) },
    });
    const result = await scoped.scopedRead(100, "list_candidates", {});
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepStrictEqual(rowIds(result.data), [501, 502, 504]);
    assert.deepStrictEqual(result.permissionScope, { kind: "jobs", permittedJobCount: 1 });
    assert.equal(
      (result.permissionScope as { privateCandidatesWithheld?: boolean }).privateCandidatesWithheld,
      undefined,
      "the disclosure belongs to the org-wide branch; a job scope was never org-wide"
    );
  });
});

// ---------------------------------------------------------------------------
// B14 — an unattested all-access actor keeps their per-job private grants
// ---------------------------------------------------------------------------

describe("B14: unattested all-access keeps the private access Greenhouse's per-job roles grant", () => {
  it("sees private candidates on a private-capable job and nowhere else", async () => {
    const { scoped } = readerFor({
      scope: { kind: "all", privateCapableJobIds: new Set([7]) },
    });
    const result = await scoped.scopedRead(100, "list_candidates", {});
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepStrictEqual(rowIds(result.data), [501, 502, 503, 504],
      "504 sits on job 7, where this actor holds Greenhouse's Private Job Admin role");
    assert.equal(result.rowCounts.privacyWithheld, 1, "only 505, on job 9, is withheld");
  });

  it("gives an attested actor both, with no envelope disclosure at all", async () => {
    const { scoped } = readerFor({
      scope: { kind: "all", privateCandidatesAttested: true, privateCapableJobIds: new Set([7]) },
    });
    const result = await scoped.scopedRead(100, "list_candidates", {});
    assert.deepStrictEqual(rowIds(result.ok ? result.data : []), [501, 502, 503, 504, 505]);
    assert.deepStrictEqual(result.ok && result.permissionScope, { kind: "all", permittedJobCount: null });
  });
});

// ---------------------------------------------------------------------------
// B15 — unattested all-access WITH confidential exclusions never enters the engine
// ---------------------------------------------------------------------------

describe("B15: unattested all-access with exclusions keeps its own branch", () => {
  it("excludes the confidential job's rows, withholds private rows, and keeps a candidate with no applications", async () => {
    // The unfiltered page includes the applicationless candidate, which is the shape the job-scope
    // engine drops as `missingParent`.
    const raw = rawReader((path, params) =>
      path === "/candidates" && params?.ids === undefined
        ? [...CANDIDATES, UNAPPLIED_CANDIDATE]
        : tenantHandler(path, params)
    );
    const { scoped } = readerFor({ scope: { kind: "all", excludedJobIds: new Set([9]) }, raw });
    const result = await scoped.scopedRead(100, "list_candidates", {});

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepStrictEqual(rowIds(result.data), [501, 502, 506],
      "503 sits on the confidential job 9; 504/505 are private; 506 has no application at all and " +
        "the job-scope engine's missingParent drop is exactly what this branch must not inherit");
    // Only 504 is withheld BY PRIVACY: 505 is private too, but it sits on the confidential job the
    // exclusion step already removed, and a row can only be withheld once.
    assert.equal(result.rowCounts.privacyWithheld, 1);
    assert.equal(result.rowCounts.permissionExcluded, 3, "503 and 505 on the confidential job, plus 504 for privacy");
    assert.equal(result.rowCounts.unresolved, 0);
    assert.equal(result.rowCounts.status, "complete");
    assert.deepStrictEqual(result.permissionScope, {
      kind: "all",
      permittedJobCount: null,
      privateCandidatesWithheld: true,
    });
  });

  it("never denies the whole page when one row's parent read fails", async () => {
    const raw = rawReader((path, params) => {
      if (path === "/applications" && params?.candidate_ids !== undefined) {
        if (idsOf(params, "candidate_ids").includes(503)) throw new Error("upstream 500");
      }
      return tenantHandler(path, params);
    });
    const { scoped } = readerFor({ scope: { kind: "all", excludedJobIds: new Set([9]) }, raw });
    const result = await scoped.scopedRead(100, "list_candidates", {});

    assert.equal(result.ok, true, "a failed join on one row must not become PERMISSION_JOIN_FAILED for the page");
    if (!result.ok) return;
    assert.ok(rowIds(result.data).includes(501));
    assert.ok(!rowIds(result.data).includes(503), "the row whose job could not be established is dropped, not kept");
    assert.equal(result.rowCounts.status, "incomplete_scope_resolution");
    assert.ok((result.rowCounts.unresolved ?? 0) > 0);
  });

  it("still honours the actor's own private-capable job inside the exclusion branch", async () => {
    const { scoped } = readerFor({
      scope: { kind: "all", excludedJobIds: new Set([9]), privateCapableJobIds: new Set([7]) },
    });
    const result = await scoped.scopedRead(100, "list_applications", {});
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepStrictEqual(rowIds(result.data), [1001, 1002, 1004],
      "job 9 is confidential; 1004's private candidate sits on job 7, where the actor holds the Private role");
  });
});

// ---------------------------------------------------------------------------
// B16 — the operator branch keeps scoped:false (three release-gate predicates require it)
// ---------------------------------------------------------------------------

describe("B16: an unattested operator read still reports scoped:false", () => {
  it("carries the disclosure on permissionScope, not by flipping the scoped flag", async () => {
    const { scoped } = readerFor({
      scope: { kind: "all" },
      operatorActorIds: new Set([900]),
      attestation: async () => false,
    });
    const result = await scoped.scopedRead(900, "list_candidates", {});
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.scoped, false,
      "leakage-sample.ts:160, rollout-gate.ts:775 and rollout-gate.ts:3203 all require scoped===false " +
        "for an operator; the withholding is disclosed on permissionScope instead");
    assert.deepStrictEqual(result.permissionScope, {
      kind: "operator",
      permittedJobCount: null,
      privateCandidatesWithheld: true,
    });
  });
});

// ---------------------------------------------------------------------------
// B17 — the unattested operator gets their OWN private-capable jobs, not an empty set
// ---------------------------------------------------------------------------

describe("B17: an unattested operator keeps the private access their Greenhouse roles grant", () => {
  it("resolves the operator's private-capable jobs through the permission provider", async () => {
    const { scoped } = readerFor({
      scope: { kind: "jobs", jobIds: new Set([7]), privateCapableJobIds: new Set([7]) },
      operatorActorIds: new Set([900]),
      attestation: async () => false,
    });
    const result = await scoped.scopedRead(900, "list_candidates", {});
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepStrictEqual(rowIds(result.data), [501, 502, 503, 504],
      "504 sits on job 7, where the operator holds Greenhouse's Private Job Admin role; 505 does not");
    assert.equal(result.rowCounts.privacyWithheld, 1);
  });

  it("fails soft to an empty private-capable set when the provider cannot answer", async () => {
    const scoped = createScopedGreenhouseReader<number>({
      actorResolver: actorResolver(),
      permissionProvider: {
        async getPermittedJobIds(): Promise<PermissionLookupResult> {
          throw new Error("permission provider is down");
        },
      },
      rawReader: rawReader(),
      operatorActorIds: new Set([900]),
      privateCandidateAttestation: async () => false,
    } as Parameters<typeof createScopedGreenhouseReader>[0]);
    const result = await scoped.scopedRead(900, "list_candidates", {});
    assert.equal(result.ok, true, "a permission-provider failure must not deny the operator's read");
    if (!result.ok) return;
    assert.deepStrictEqual(rowIds(result.data), [501, 502, 503]);
  });
});

// ---------------------------------------------------------------------------
// B18 — a rejecting attestation lookup is unattested, never a denial
// ---------------------------------------------------------------------------

describe("B18: a rejecting attestation lookup yields the unattested envelope", () => {
  it("does not throw out of the operator path", async () => {
    const { scoped } = readerFor({
      scope: { kind: "all" },
      operatorActorIds: new Set([900]),
      attestation: async () => {
        throw new Error("directory unreachable");
      },
    });
    const result = await scoped.scopedRead(900, "list_candidates", {});
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepStrictEqual(rowIds(result.data), [501, 502, 503]);
    assert.deepStrictEqual(result.permissionScope, {
      kind: "operator",
      permittedJobCount: null,
      privateCandidatesWithheld: true,
    });
  });

  it("propagates an abort rather than swallowing it", async () => {
    const controller = new AbortController();
    const { scoped } = readerFor({
      scope: { kind: "all" },
      operatorActorIds: new Set([900]),
      attestation: async () => {
        controller.abort(new Error("caller gave up"));
        throw new Error("aborted");
      },
    });
    await assert.rejects(
      () => scoped.scopedRead(900, "list_candidates", {}, { signal: controller.signal }),
      /caller gave up/
    );
  });
});

// ---------------------------------------------------------------------------
// B19 — the base provider's all-jobs marker no longer discards the explicit Private roles
// ---------------------------------------------------------------------------

describe("B19: an all-jobs marker keeps the actor's explicit private-capable grants", () => {
  function permissionRawReader(rows: unknown[], roles: unknown[]): RawReadClient & { calls: RawCall[] } {
    return rawReader((path) => {
      if (path === "/user_job_permissions") return rows;
      if (path === "/user_roles") return roles;
      return [];
    });
  }

  it("returns kind:all AND the private-capable jobs from the same sweep", async () => {
    const raw = permissionRawReader(
      [
        { user_id: 100, role: { name: "All Jobs" } },
        { user_id: 100, job_id: 7, role_id: 55 },
        { user_id: 100, job_id: 9, role_id: 56 },
      ],
      [
        { id: 55, role_type: "job_admin", name: "Private" },
        { id: 56, role_type: "job_admin", name: "Standard" },
      ]
    );
    const provider = createHarvestPermissionProvider({ rawReader: raw });
    const scope = await provider.getPermittedJobIds(100);

    assert.equal((scope as { kind?: string }).kind, "all");
    const privateCapable = (scope as { privateCapableJobIds?: ReadonlySet<number> }).privateCapableJobIds;
    assert.deepStrictEqual([...(privateCapable ?? [])], [7],
      "returning at the marker discarded the explicit Private Job Admin grant on job 7");
  });

  it("still answers a bare kind:all when the actor holds no private-capable role", async () => {
    const raw = permissionRawReader([{ user_id: 100, role: { name: "All Jobs" } }], []);
    const provider = createHarvestPermissionProvider({ rawReader: raw });
    assert.deepStrictEqual(await provider.getPermittedJobIds(100), { kind: "all" });
  });

  it("keeps the private-capable set across the TTL cache clone", async () => {
    const raw = permissionRawReader(
      [
        { user_id: 100, role: { name: "All Jobs" } },
        { user_id: 100, job_id: 7, role_id: 55 },
      ],
      [{ id: 55, role_type: "job_admin", name: "Private" }]
    );
    const provider = createHarvestPermissionProvider({ rawReader: raw, ttlMs: 60_000 });
    await provider.getPermittedJobIds(100);
    const second = await provider.getPermittedJobIds(100);
    assert.deepStrictEqual(
      [...((second as { privateCapableJobIds?: ReadonlySet<number> }).privateCapableJobIds ?? [])],
      [7]
    );
  });
});

// ---------------------------------------------------------------------------
// B20 — the per-job private-access check is batched, not one read per private row
// ---------------------------------------------------------------------------

describe("B20: the per-job private-access exception does not go N+1", () => {
  it("resolves every private candidate's applications in one batched read", async () => {
    const page = Array.from({ length: 30 }, (_, index) => ({
      id: 4000 + index,
      first_name: `P${index}`,
      private: true,
    }));
    const raw = rawReader((path, params) => {
      if (path === "/candidates") return page;
      if (path === "/applications" && params?.candidate_ids !== undefined) {
        return idsOf(params, "candidate_ids").map((candidateId) => ({
          id: 90000 + candidateId,
          job_id: 7,
          candidate_id: candidateId,
        }));
      }
      return [];
    });
    const { scoped } = readerFor({
      scope: { kind: "all", privateCapableJobIds: new Set([7]) },
      raw,
    });
    const result = await scoped.scopedRead(100, "list_candidates", {});

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.rowCounts.returned, 30, "every one sits on the actor's private-capable job");
    assert.ok(
      raw.calls.length <= 2,
      `1 page + 1 batched /applications?candidate_ids=… — saw ${raw.calls.length}: ${raw.calls.map((call) => call.path).join(", ")}`
    );
  });
});
