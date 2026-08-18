import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createHarvestPermissionProvider,
  createScopedGreenhouseReader,
  type ActorResolver,
  type ApiResponse,
  type ApiResponseMeta,
  type PermissionProvider,
  type RawReadClient,
  type ExecutableScopePolicy,
  parseActorIdAllowlist,
} from "../src/index.js";

const APPROVER_POLICY: ExecutableScopePolicy = {
  kind: "join_backed",
  dependencies: [
    {
      field: "approver_group_id",
      sourceFilter: "approver_group_ids",
      targetEndpoint: "/v3/approver_groups",
      targetField: "id",
      targetFilter: "ids",
      purpose: "scope",
    },
    {
      field: "approval_flow_id",
      sourceFilter: "approval_flow_ids",
      targetEndpoint: "/v3/approval_flows",
      targetField: "id",
      targetFilter: "ids",
      purpose: "scope",
    },
  ],
  terminal: { field: "job_id", filter: "job_ids" },
};

const JOB_POST_LOCATION_POLICY: ExecutableScopePolicy = {
  kind: "join_backed",
  dependencies: [{
    field: "job_post_id",
    sourceFilter: "job_post_ids",
    targetEndpoint: "/v3/job_posts",
    targetField: "id",
    targetFilter: "ids",
    purpose: "scope",
  }],
  terminal: { field: "job_id", filter: "job_ids" },
};

const PROSPECT_POOL_POLICY: ExecutableScopePolicy = {
  kind: "direct",
  terminal: { field: "job_ids", filter: "job_ids", multiple: true },
  redactToPermittedJobIds: true,
};

const APPLICATION_POLICY: ExecutableScopePolicy = {
  kind: "direct",
  terminal: {
    field: "job_id",
    filter: "job_ids",
    compatibility: { kind: "single_nested_id", field: "jobs", idField: "id" },
  },
};

interface RawCall {
  path: string;
  params?: Record<string, unknown>;
  cursor?: string;
}

function response<T>(
  data: T,
  nextCursor: string | null = null,
  meta?: ApiResponseMeta
): ApiResponse<T> {
  return { data, nextCursor, meta };
}

function actorResolver(): ActorResolver<number> {
  return {
    resolveActor(actorId) {
      return actorId;
    },
  };
}

function permissionProvider(
  jobIdsForActor: Map<number, number[] | "all">,
  calls: number[] = []
): PermissionProvider {
  return {
    async getPermittedJobIds(actorId: number) {
      calls.push(actorId);
      const permissions = jobIdsForActor.get(actorId) ?? [];
      return permissions === "all" ? { kind: "all" as const } : new Set(permissions);
    },
  };
}

/**
 * Answer the "View Private Candidates" lookup the way `/v3/candidates` does.
 *
 * Every application-shaped read now resolves its candidate's `private` flag through
 * `/candidates?ids=<comma list>&fields=id,private`. Tests whose subject is job scoping declare
 * their candidates non-private once through this wrapper instead of restating the lookup; tests
 * whose subject IS privacy pass the private ids explicitly. Ids absent from `privateCandidateIds`
 * come back `private: false`, so nothing here can hide a gate that failed to run — an ungated read
 * would return the row either way, and the dedicated privacy tests assert the withholding.
 */
function withCandidatePrivacy(
  handler: (path: string, params?: Record<string, unknown>, cursor?: string) => unknown,
  privateCandidateIds: ReadonlySet<number> = new Set()
): (path: string, params?: Record<string, unknown>, cursor?: string) => unknown {
  return (path, params, cursor) => {
    if (path === "/candidates" && params?.fields === "id,private") {
      return String(params?.ids ?? "")
        .split(",")
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0)
        .map((id) => ({ id, private: privateCandidateIds.has(id) }));
    }
    return handler(path, params, cursor);
  };
}

function rawReader(
  handler: (path: string, params?: Record<string, unknown>, cursor?: string) => unknown
): RawReadClient & { calls: RawCall[] } {
  const calls: RawCall[] = [];
  return {
    calls,
    async read<T = unknown>(
      path: string,
      params?: Record<string, unknown>,
      cursor?: string
    ): Promise<ApiResponse<T>> {
      calls.push({ path, params, cursor });
      const value = handler(path, params, cursor);
      if (
        value &&
        typeof value === "object" &&
        "data" in value &&
        "nextCursor" in value
      ) {
        return value as ApiResponse<T>;
      }
      return response(value as T);
    },
  };
}

describe("scoped Greenhouse read wrapper", () => {
  it("lets operator actors read unscoped data without loading permissions", async () => {
    const raw = rawReader((path) => {
      assert.equal(path, "/applications");
      return [
        { id: 10, job_id: 1 },
        { id: 20, job_id: 2 },
      ];
    });
    const permissionCalls: number[] = [];
    const scoped = createScopedGreenhouseReader({
      actorResolver: actorResolver(),
      permissionProvider: permissionProvider(new Map([[100, [1]]]), permissionCalls),
      rawReader: raw,
      operatorActorIds: new Set([900]),
    });

    const result = await scoped.scopedRead(900, "list_applications", {});

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.scoped, false);
    assert.deepStrictEqual(result.ok && result.data, [
      { id: 10, job_id: 1 },
      { id: 20, job_id: 2 },
    ]);
    assert.deepStrictEqual(permissionCalls, []);
  });

  it("filters recruiter application reads to permitted jobs and drops unresolved rows", async () => {
    const raw = rawReader(withCandidatePrivacy(() => [
      { id: 10, job_id: 1, candidate_id: 501 },
      { id: 20, job_id: 2, candidate_id: 502 },
      { id: 30, candidate_id: 7 },
    ]));
    const scoped = createScopedGreenhouseReader({
      actorResolver: actorResolver(),
      permissionProvider: permissionProvider(new Map([[100, [1]]])),
      rawReader: raw,
      operatorActorIds: new Set([900]),
    });

    const result = await scoped.scopedRead(100, "list_applications", {});

    assert.equal(result.ok, true);
    assert.deepStrictEqual(result.ok && result.data, [{ id: 10, job_id: 1, candidate_id: 501 }]);
    assert.deepStrictEqual(result.ok && result.rowCounts, {
      raw: 3,
      returned: 1,
      permissionExcluded: 1,
      unresolved: 1,
      status: "incomplete_scope_resolution",
    });
  });

  it("counts malformed primary rows as unresolved instead of reporting a clean read", async () => {
    const raw = rawReader(withCandidatePrivacy(() => [
      { id: 10, job_id: 1, candidate_id: 501 },
      "malformed-row",
      null,
    ]));
    const scoped = createScopedGreenhouseReader({
      actorResolver: actorResolver(),
      permissionProvider: permissionProvider(new Map([[100, [1]]])),
      rawReader: raw,
      scopePolicyRegistry: new Map([["list_applications", {
        kind: "direct",
        terminal: { field: "job_id", filter: "job_ids" },
      }]]),
    });

    const result = await scoped.scopedRead(100, "list_applications", {});

    assert.equal(result.ok, true);
    assert.deepStrictEqual(result.ok && result.data, [{ id: 10, job_id: 1, candidate_id: 501 }]);
    assert.deepStrictEqual(result.ok && result.rowCounts, {
      raw: 3,
      returned: 1,
      permissionExcluded: 0,
      unresolved: 2,
      status: "incomplete_scope_resolution",
    });
  });

  it("accepts only the declared unambiguous application job compatibility shape", async () => {
    // Only the rows that survive job scoping carry candidate_id: the privacy gate resolves the
    // candidate behind each KEPT row, and the rows below it are dropped before it ever runs.
    const raw = rawReader(withCandidatePrivacy(() => [
      { id: 1, jobs: [{ id: 1, name: "Permitted" }], candidate_id: 501 },
      { id: 2, job_id: 1, candidate_id: 502 },
      { id: 3, job_id: 1, jobs: [{ id: 1 }], candidate_id: 503 },
      { id: 4, jobs: [] },
      { id: 5, jobs: [{ id: 1 }, { id: 1 }] },
      { id: 6, jobs: [{ id: "invalid" }] },
      { id: 7, job_id: 1, jobs: [{ id: 2 }] },
      { id: 8, job: { id: 1 } },
      { id: 9, application: { job: { id: 1 } } },
      { id: 10, job_id: "invalid", jobs: [{ id: 1 }] },
      { id: 11, jobs: [{ id: 2 }] },
    ]));
    const scoped = createScopedGreenhouseReader({
      actorResolver: actorResolver(),
      permissionProvider: permissionProvider(new Map([[100, [1]]])),
      rawReader: raw,
      scopePolicyRegistry: new Map([["list_applications", APPLICATION_POLICY]]),
    });

    const result = await scoped.scopedRead(100, "list_applications", {});

    assert.equal(result.ok, true);
    assert.deepStrictEqual(result.ok && result.data, [
      { id: 1, jobs: [{ id: 1, name: "Permitted" }], candidate_id: 501 },
      { id: 2, job_id: 1, candidate_id: 502 },
      { id: 3, job_id: 1, jobs: [{ id: 1 }], candidate_id: 503 },
    ]);
    assert.deepStrictEqual(result.ok && result.rowCounts, {
      raw: 11,
      returned: 3,
      permissionExcluded: 1,
      unresolved: 7,
      status: "incomplete_scope_resolution",
    });
  });

  it("resolves child authorization through the application parent's compatibility shape", async () => {
    const raw = rawReader(withCandidatePrivacy((path, params) => {
      if (path === "/application_stages") {
        return [
          { id: 21, application_id: 10, jobs: [{ id: 999 }] },
          { id: 22, jobs: [{ id: 1 }] },
        ];
      }
      assert.equal(path, "/applications");
      assert.deepStrictEqual(params, { ids: "10", per_page: 100 });
      return [{ id: 10, jobs: [{ id: 1 }], candidate_id: 501 }];
    }));
    const scoped = createScopedGreenhouseReader({
      actorResolver: actorResolver(),
      permissionProvider: permissionProvider(new Map([[100, [1]]])),
      rawReader: raw,
      scopePolicyRegistry: new Map([["list_applications", APPLICATION_POLICY]]),
    });

    const result = await scoped.scopedRead(100, "list_application_stages", {});

    assert.equal(result.ok, true);
    assert.deepStrictEqual(result.ok && result.data, [
      { id: 21, application_id: 10, jobs: [{ id: 999 }] },
    ]);
    assert.deepStrictEqual(result.ok && result.rowCounts, {
      raw: 2,
      returned: 1,
      permissionExcluded: 0,
      unresolved: 1,
      status: "incomplete_scope_resolution",
    });
  });

  it("reports the applied jobs permission set only through the trusted audit observer", async () => {
    const raw = rawReader(() => [{ id: 10, job_id: 1 }]);
    const scoped = createScopedGreenhouseReader({
      actorResolver: actorResolver(),
      permissionProvider: permissionProvider(new Map([[100, [1, 912]]] )),
      rawReader: raw,
    });
    let observed: number[] | null = null;

    const result = await scoped.scopedRead(100, "list_applications", {}, {
      onPermissionScopeResolved(scope) {
        observed = scope.kind === "jobs" ? [...scope.jobIds].sort((a, b) => a - b) : null;
      },
    });

    assert.deepEqual(observed, [1, 912]);
    assert.doesNotMatch(JSON.stringify(result), /\b912\b/);
  });

  it("preserves client response metadata after scoped filtering", async () => {
    const meta: ApiResponseMeta = {
      retry: {
        attempts: 2,
        rateLimitRetries: 1,
        sleptMs: 1000,
        retryAfterSeconds: [1],
      },
      rateLimit: {
        limit: 100,
        remaining: 0,
        resetAt: 2_000_000_000_000,
        observedAt: 1_800_000_000_000,
      },
    };
    const raw = rawReader(withCandidatePrivacy((path) =>
      path === "/candidates"
        ? []
        : response(
            [
              { id: 10, job_id: 1, candidate_id: 501 },
              { id: 20, job_id: 2, candidate_id: 502 },
            ],
            "cursor-2",
            meta
          )
    ));
    const scoped = createScopedGreenhouseReader({
      actorResolver: actorResolver(),
      permissionProvider: permissionProvider(new Map([[100, [1]]])),
      rawReader: raw,
    });

    const result = await scoped.scopedRead(100, "list_applications", {});

    assert.equal(result.ok, true);
    assert.deepStrictEqual(result.ok && result.data, [{ id: 10, job_id: 1, candidate_id: 501 }]);
    assert.equal(result.ok && result.nextCursor, "cursor-2");
    assert.deepStrictEqual(result.ok && result.meta, meta);
  });

  it("keeps an empty permitted set as deny-all instead of pass-through", async () => {
    const raw = rawReader(() => [
      { id: 10, job_id: 1 },
      { id: 20, job_id: 2 },
    ]);
    const scoped = createScopedGreenhouseReader({
      actorResolver: actorResolver(),
      permissionProvider: permissionProvider(new Map([[100, []]])),
      rawReader: raw,
    });

    const result = await scoped.scopedRead(100, "list_applications", {});

    assert.equal(result.ok, true);
    assert.deepStrictEqual(result.ok && result.data, []);
  });

  it("returns unscoped data for real all-access permission scopes", async () => {
    const permissionCalls: number[] = [];
    const raw = rawReader(() => [
      { id: 10, job_id: 1 },
      { id: 20, job_id: 2 },
    ]);
    const scoped = createScopedGreenhouseReader({
      actorResolver: actorResolver(),
      permissionProvider: permissionProvider(new Map([[100, "all"]]), permissionCalls),
      rawReader: raw,
    });

    const result = await scoped.scopedRead(100, "list_applications", {});

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.scoped, false);
    assert.deepStrictEqual(result.ok && result.data, [
      { id: 10, job_id: 1 },
      { id: 20, job_id: 2 },
    ]);
    assert.deepStrictEqual(result.ok && result.rowCounts, {
      raw: 2,
      returned: 2,
      permissionExcluded: 0,
      unresolved: 0,
      status: "complete",
    });
    assert.deepStrictEqual(permissionCalls, [100]);
  });

  it("denies safely when permission lookup fails and does not read raw data", async () => {
    const raw = rawReader(() => {
      throw new Error("raw reader should not be called");
    });
    const scoped = createScopedGreenhouseReader({
      actorResolver: actorResolver(),
      permissionProvider: {
        async getPermittedJobIds() {
          throw new Error("permission backend unavailable");
        },
      },
      rawReader: raw,
    });

    const result = await scoped.scopedRead(100, "list_applications", {});

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.denial.code, "PERMISSION_LOOKUP_FAILED");
    assert.equal(raw.calls.length, 0);
  });

  it("loads permissions fresh for the next scopedRead when permissions change", async () => {
    let permitted = [1, 2];
    const permissionCalls: number[] = [];
    const raw = rawReader(withCandidatePrivacy(() => [
      { id: 10, job_id: 1, candidate_id: 501 },
      { id: 20, job_id: 2, candidate_id: 502 },
    ]));
    const scoped = createScopedGreenhouseReader({
      actorResolver: actorResolver(),
      permissionProvider: {
        async getPermittedJobIds(actorId: number) {
          permissionCalls.push(actorId);
          return new Set(permitted);
        },
      },
      rawReader: raw,
    });

    const first = await scoped.scopedRead(100, "list_applications", {});
    permitted = [1];
    const second = await scoped.scopedRead(100, "list_applications", {});

    assert.deepStrictEqual(first.ok && first.data, [
      { id: 10, job_id: 1, candidate_id: 501 },
      { id: 20, job_id: 2, candidate_id: 502 },
    ]);
    assert.deepStrictEqual(second.ok && second.data, [{ id: 10, job_id: 1, candidate_id: 501 }]);
    assert.deepStrictEqual(permissionCalls, [100, 100]);
  });

  it("returns an explicit denial for unregistered tools and never calls raw read", async () => {
    const raw = rawReader(() => {
      throw new Error("raw reader should not be called");
    });
    const scoped = createScopedGreenhouseReader({
      actorResolver: actorResolver(),
      permissionProvider: permissionProvider(new Map([[100, [1]]])),
      rawReader: raw,
    });

    const result = await scoped.scopedRead(100, "list_email_templates", {});

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.denial.code, "TOOL_NOT_AVAILABLE");
    assert.equal(raw.calls.length, 0);
  });

  it("filters candidate application arrays to permitted jobs and drops candidates with no permitted application", async () => {
    const raw = rawReader(() => [
      {
        id: 501,
        private: false,
        applications: [
          { id: 10, job_id: 1 },
          { id: 20, job_id: 2 },
        ],
      },
      {
        id: 502,
        private: false,
        applications: [{ id: 30, job_id: 2 }],
      },
    ]);
    const scoped = createScopedGreenhouseReader({
      actorResolver: actorResolver(),
      permissionProvider: permissionProvider(new Map([[100, [1]]])),
      rawReader: raw,
    });

    const result = await scoped.scopedRead(100, "list_candidates", {});

    assert.equal(result.ok, true);
    assert.deepStrictEqual(result.ok && result.data, [
      {
        id: 501,
        private: false,
        applications: [{ id: 10, job_id: 1 }],
      },
    ]);
  });

  it("scopes candidate rows without embedded job ids through candidate applications", async () => {
    const raw = rawReader((path, params) => {
      if (path === "/candidates") {
        return [{ id: 501, private: false }, { id: 502, private: false }];
      }
      assert.equal(path, "/applications");
      if (params?.candidate_ids === "501") {
        return [{ id: 10, candidate_id: 501, job_id: 1 }];
      }
      if (params?.candidate_ids === "502") {
        return [{ id: 20, candidate_id: 502, job_id: 2 }];
      }
      return [];
    });
    const scoped = createScopedGreenhouseReader({
      actorResolver: actorResolver(),
      permissionProvider: permissionProvider(new Map([[100, [1]]])),
      rawReader: raw,
    });

    const result = await scoped.scopedRead(100, "list_candidates", {});

    assert.equal(result.ok, true);
    assert.deepStrictEqual(result.ok && result.data, [{ id: 501, private: false }]);
    assert.deepStrictEqual(
      raw.calls.map((call) => [call.path, call.params?.candidate_ids]),
      [
        ["/candidates", undefined],
        ["/applications", "501"],
        ["/applications", "502"],
      ]
    );
  });

  it("scopes scorecards and notes through application or candidate associations", async () => {
    // Every candidate reachable from a scorecard/note/attachment must declare its
    // View-Private-Candidates state; an unreadable candidate fails closed. withCandidatePrivacy
    // answers `/candidates?fields=id,private` (comma-batched or single) — all non-private here.
    const raw = rawReader(withCandidatePrivacy((path, params) => {
      if (path === "/scorecards") {
        return [
          { id: 701, application_id: 10 },
          { id: 702, application_id: 20 },
          { id: 703 },
          { id: 704, application_id: 10, private: true },
          { id: 705, application_id: 10, visibility: "privately_visible" },
        ];
      }
      if (path === "/notes") {
        return [
          { id: 801, application_id: 10, visibility: "publicly_visible" },
          { id: 802, candidate_id: 502, visibility: "publicly_visible" },
          { id: 803, application_id: 10, visibility: "privately_visible" },
          { id: 804, application_id: 10, visibility: "admin_only_visible" },
          { id: 805, application_id: 10 },
          { id: 502, visibility: "publicly_visible" },
          { id: 807, candidate_id: 503, visibility: "publicly_visible" },
        ];
      }
      if (path === "/applications" && params?.ids === "10") {
        return [{ id: 10, job_id: 1, candidate_id: 501 }];
      }
      if (path === "/applications" && params?.ids === "20") {
        return [{ id: 20, job_id: 2, candidate_id: 504 }];
      }
      if (path === "/applications" && params?.candidate_ids === "502") {
        return [{ id: 30, candidate_id: 502, job_id: 1 }];
      }
      if (path === "/applications" && params?.candidate_ids === "503") {
        return [{ id: 40, candidate_id: 503, job_id: 2 }];
      }
      return [];
    }));
    const scoped = createScopedGreenhouseReader({
      actorResolver: actorResolver(),
      permissionProvider: permissionProvider(new Map([[100, [1]]])),
      rawReader: raw,
    });

    const scorecards = await scoped.scopedRead(100, "list_scorecards", {});
    const notes = await scoped.scopedRead(100, "list_notes", {});

    assert.deepStrictEqual(scorecards.ok && scorecards.data, [
      { id: 701, application_id: 10 },
    ]);
    assert.deepStrictEqual(notes.ok && notes.data, [
      { id: 801, application_id: 10, visibility: "publicly_visible" },
      { id: 802, candidate_id: 502, visibility: "publicly_visible" },
    ]);
  });

  it("scopes attachments by application strictly, with a candidate fallback only when there is no application_id", async () => {
    const raw = rawReader(withCandidatePrivacy((path, params) => {
      if (path === "/attachments") {
        return [
          { id: 901, application_id: 10, filename: "a.pdf" },
          // application_id present but on a non-permitted job: must DROP, even though candidate 502
          // has a permitted application — an attachment tied to a specific application is bounded by
          // THAT application's job, never widened through the shared candidate (no-leak guarantee).
          { id: 902, application_id: 20, candidate_id: 502, filename: "b.pdf" },
          // candidate-level attachment (no application_id): falls back to the candidate's permitted apps.
          { id: 903, candidate_id: 502, filename: "c.pdf" },
          { id: 904, candidate_id: 503, filename: "d.pdf" },
          { id: 905, filename: "e.pdf" },
        ];
      }
      if (path === "/applications" && params?.ids === "10") return [{ id: 10, candidate_id: 501, job_id: 1 }];
      if (path === "/applications" && params?.ids === "20") return [{ id: 20, candidate_id: 502, job_id: 2 }];
      if (path === "/applications" && params?.candidate_ids === "502") return [{ id: 30, candidate_id: 502, job_id: 1 }];
      if (path === "/applications" && params?.candidate_ids === "503") return [{ id: 40, candidate_id: 503, job_id: 2 }];
      return [];
    }));
    const scoped = createScopedGreenhouseReader({
      actorResolver: actorResolver(),
      permissionProvider: permissionProvider(new Map([[100, [1]]])),
      rawReader: raw,
    });

    const attachments = await scoped.scopedRead(100, "list_attachments", {});

    assert.deepStrictEqual(attachments.ok && attachments.data, [
      { id: 901, application_id: 10, filename: "a.pdf" },
      { id: 903, candidate_id: 502, filename: "c.pdf" },
    ]);
  });

  it("resolves application-backed children through the documented application before considering any job-shaped fields", async () => {
    const raw = rawReader(withCandidatePrivacy((path, params) => {
      if (["/scorecards", "/notes", "/attachments"].includes(path)) {
        const visibility = path === "/notes" ? { visibility: "publicly_visible" } : {};
        return [
          // The parent is permitted. Undocumented child job fields do not replace that parent.
          { id: 1, application_id: 10, job_id: 2, ...visibility },
          // The parent is forbidden. Stray allowed-job shapes must never self-authorize the child.
          { id: 2, application_id: 20, job_id: 1, job_ids: [1], job: { id: 1 }, ...visibility },
          // A malformed parent application cannot be rescued by an undocumented direct job field.
          { id: 3, application_id: 30, job_id: 1, ...visibility },
          // A present but malformed application_id cannot fall back to the candidate or direct job.
          { id: 4, application_id: "bad", candidate_id: 502, job_id: 1, ...visibility },
        ];
      }
      if (path === "/applications" && params?.ids === "10") {
        return [{ id: 10, job_id: 1, candidate_id: 501 }];
      }
      if (path === "/applications" && params?.ids === "20") {
        return [{ id: 20, job_id: 2, candidate_id: 502 }];
      }
      if (path === "/applications" && params?.ids === "30") {
        return [{ id: 30, job_ids: [1], job: { id: 1 }, candidate_id: 503 }];
      }
      if (path === "/applications" && params?.candidate_ids === "502") {
        return [{ id: 40, candidate_id: 502, job_id: 1 }];
      }
      return [];
    }));
    const scoped = createScopedGreenhouseReader({
      actorResolver: actorResolver(),
      permissionProvider: permissionProvider(new Map([[100, [1]]])),
      rawReader: raw,
    });

    for (const toolName of ["list_scorecards", "list_notes", "list_attachments"]) {
      const result = await scoped.scopedRead(100, toolName, {});

      assert.deepStrictEqual(result.ok && result.data, [
        {
          id: 1,
          application_id: 10,
          job_id: 2,
          ...(toolName === "list_notes" ? { visibility: "publicly_visible" } : {}),
        },
      ]);
      assert.deepStrictEqual(result.ok && result.rowCounts, {
        raw: 4,
        returned: 1,
        permissionExcluded: 1,
        unresolved: 2,
        status: "incomplete_scope_resolution",
      });
    }

    assert.equal(
      raw.calls.some((call) => call.path === "/applications" && call.params?.candidate_ids === "502"),
      false,
      "a malformed application_id must not fall through to candidate-level authorization"
    );
    assert.deepStrictEqual(
      raw.calls
        .filter((call) => call.path === "/applications")
        .map((call) => call.params?.ids),
      ["10", "20", "30", "10", "20", "30", "10", "20", "30"]
    );
  });

  it("does not let alternate job shapes override the documented job_id on direct-scoped rows", async () => {
    const raw = rawReader(withCandidatePrivacy((path) => {
      if (path === "/applications" || path === "/offers") {
        return [
          { id: 1, job_id: 1, candidate_id: 501 },
          { id: 2, job_id: 2, job_ids: [1], job: { id: 1 }, candidate_id: 502 },
          { id: 3, job_ids: [1], job: { id: 1 }, candidate_id: 503 },
        ];
      }
      return [];
    }));
    const scoped = createScopedGreenhouseReader({
      actorResolver: actorResolver(),
      permissionProvider: permissionProvider(new Map([[100, [1]]])),
      rawReader: raw,
    });

    for (const toolName of ["list_applications", "list_offers"]) {
      const result = await scoped.scopedRead(100, toolName, {});

      assert.deepStrictEqual(result.ok && result.data, [{ id: 1, job_id: 1, candidate_id: 501 }]);
      assert.deepStrictEqual(result.ok && result.rowCounts, {
        raw: 3,
        returned: 1,
        permissionExcluded: 1,
        unresolved: 1,
        status: "incomplete_scope_resolution",
      });
    }
  });

  it("filters new job-scoped and application-backed read domains to permitted jobs", async () => {
    const raw = rawReader(withCandidatePrivacy((path, params) => {
      if (path === "/job_owners") return [{ id: 1, job_id: 1 }, { id: 2, job_id: 2 }];
      if (path === "/openings") return [{ id: 3, job_id: 1 }, { id: 4, job_id: 2 }];
      if (path === "/job_interview_stages") return [{ id: 5, job_id: 1 }, { id: 6, job_id: 2 }];
      if (path === "/job_interviews") return [{ id: 7, job_id: 1 }, { id: 8, job_id: 2 }];
      if (path === "/tracking_links") return [{ id: 9, job_id: 1 }, { id: 10, job_id: 2 }];
      if (path === "/job_hiring_managers") return [{ id: 16, job_id: 1, user_id: 50 }, { id: 17, job_id: 2, user_id: 51 }];
      if (path === "/job_notes") return [{ id: 18, job_id: 1, visibility: "publicly_visible", body: "x" }, { id: 19, job_id: 2, visibility: "publicly_visible", body: "y" }];
      if (path === "/job_posts") return [{ id: 20, job_id: 1, title: "A" }, { id: 21, job_id: 2, title: "B" }];
      if (path === "/interviews") {
        return [
          { id: 11, application_id: 100 },
          { id: 12, application_id: 200 },
          { id: 13, job_id: 1 },
        ];
      }
      if (path === "/rejection_details") {
        return [
          { id: 14, application_id: 100 },
          { id: 15, application_id: 200 },
        ];
      }
      if (path === "/applications" && params?.ids === "100") return [{ id: 100, job_id: 1, candidate_id: 501 }];
      if (path === "/applications" && params?.ids === "200") return [{ id: 200, job_id: 2, candidate_id: 502 }];
      return [];
    }));
    const scoped = createScopedGreenhouseReader({
      actorResolver: actorResolver(),
      permissionProvider: permissionProvider(new Map([[100, [1]]])),
      rawReader: raw,
    });

    const owners = await scoped.scopedRead(100, "list_job_owners", {});
    const openings = await scoped.scopedRead(100, "list_openings", {});
    const stages = await scoped.scopedRead(100, "list_job_interview_stages", {});
    const jobInterviews = await scoped.scopedRead(100, "list_job_interviews", {});
    const interviews = await scoped.scopedRead(100, "list_interviews", {});
    const rejections = await scoped.scopedRead(100, "list_rejection_details", {});
    const tracking = await scoped.scopedRead(100, "list_tracking_links", {});
    const hiringManagers = await scoped.scopedRead(100, "list_job_hiring_managers", {});
    const jobNotes = await scoped.scopedRead(100, "list_job_notes", {});
    const jobPosts = await scoped.scopedRead(100, "list_job_posts", {});

    assert.deepStrictEqual(owners.ok && owners.data, [{ id: 1, job_id: 1 }]);
    assert.deepStrictEqual(openings.ok && openings.data, [{ id: 3, job_id: 1 }]);
    assert.deepStrictEqual(stages.ok && stages.data, [{ id: 5, job_id: 1 }]);
    assert.deepStrictEqual(jobInterviews.ok && jobInterviews.data, [{ id: 7, job_id: 1 }]);
    assert.deepStrictEqual(interviews.ok && interviews.data, [{ id: 11, application_id: 100 }, { id: 13, job_id: 1 }]);
    assert.deepStrictEqual(rejections.ok && rejections.data, [{ id: 14, application_id: 100 }]);
    assert.deepStrictEqual(tracking.ok && tracking.data, [{ id: 9, job_id: 1 }]);
    // The three new job-scoped accountability reads bind to filterDirectJobScopedRow: the row on the
    // non-permitted job 2 is dropped. (The reader only scopes; the job_note body-visibility gate is a
    // recruiter-side projection concern, so the body passes through here.)
    assert.deepStrictEqual(hiringManagers.ok && hiringManagers.data, [{ id: 16, job_id: 1, user_id: 50 }]);
    assert.deepStrictEqual(jobNotes.ok && jobNotes.data, [{ id: 18, job_id: 1, visibility: "publicly_visible", body: "x" }]);
    assert.deepStrictEqual(jobPosts.ok && jobPosts.data, [{ id: 20, job_id: 1, title: "A" }]);
  });

  it("strips a caller-supplied fields selector at the reader boundary so it cannot blind a scope filter", async () => {
    const raw = rawReader(() => [{ id: 901, application_id: 10, filename: "a.pdf" }]);
    const scoped = createScopedGreenhouseReader({
      actorResolver: actorResolver(),
      permissionProvider: permissionProvider(new Map([[100, [1]]])),
      rawReader: raw,
    });

    // A caller asks /attachments to project ONLY filename — which would omit application_id, the field
    // filterAttachmentRow scopes through. The reader must drop `fields` before the read so the FK is
    // always present and the scope check cannot be blinded.
    await scoped.scopedRead(100, "list_attachments", { fields: "filename", application_ids: "10" });

    assert.equal(raw.calls.length >= 1, true);
    assert.equal("fields" in (raw.calls[0]!.params ?? {}), false);
    assert.equal(raw.calls[0]!.params?.application_ids, "10");
  });

  it("scopes candidate education/employment history through the candidate's permitted applications", async () => {
    const raw = rawReader(withCandidatePrivacy((path, params) => {
      if (path === "/candidate_educations") {
        return [
          { id: 1, candidate_id: 501, degree_custom_field_option_id: 9 },
          { id: 2, candidate_id: 502, degree_custom_field_option_id: 9 },
          { id: 3, degree_custom_field_option_id: 9 }, // no candidate_id -> fail closed
        ];
      }
      if (path === "/candidate_employments") {
        return [
          { id: 4, candidate_id: 501, company_name: "Acme", title: "Engineer" },
          { id: 5, candidate_id: 502, company_name: "Other", title: "Engineer" },
        ];
      }
      if (path === "/applications" && params?.candidate_ids === "501") return [{ id: 30, candidate_id: 501, job_id: 1 }];
      if (path === "/applications" && params?.candidate_ids === "502") return [{ id: 40, candidate_id: 502, job_id: 2 }];
      return [];
    }));
    const scoped = createScopedGreenhouseReader({
      actorResolver: actorResolver(),
      permissionProvider: permissionProvider(new Map([[100, [1]]])),
      rawReader: raw,
    });

    const educations = await scoped.scopedRead(100, "list_candidate_educations", {});
    const employments = await scoped.scopedRead(100, "list_candidate_employments", {});

    // Only history for candidate 501 (an application on permitted job 1) survives; candidate 502 (job 2)
    // and the candidate_id-less row drop.
    assert.deepStrictEqual(educations.ok && educations.data, [
      { id: 1, candidate_id: 501, degree_custom_field_option_id: 9 },
    ]);
    assert.deepStrictEqual(employments.ok && employments.data, [
      { id: 4, candidate_id: 501, company_name: "Acme", title: "Engineer" },
    ]);
  });

  it("scopes interviewers through their interview and scorecard answers through their scorecard", async () => {
    const raw = rawReader(withCandidatePrivacy((path, params) => {
      if (path === "/interviewers") {
        return [
          { id: 1, interview_id: 11, scorecard_id: 21, user_id: 50, response_status: "accepted", email: "a@example.com" },
          { id: 2, interview_id: 12, user_id: 51, response_status: "needs_action", email: "b@example.com" },
          { id: 3, user_id: 52 }, // no interview_id -> fail closed
        ];
      }
      if (path === "/scorecard_question_answers") {
        return [
          { id: 4, scorecard_id: 31, scorecard_question_id: 5, answer: "Strong on system design" },
          { id: 5, scorecard_id: 32, scorecard_question_id: 5, answer: "Weak" },
          // scorecard 33 resolves to an application that cannot be loaded (read returns nothing) ->
          // the application->job scope cannot be confirmed, so the answer drops (fail closed).
          { id: 6, scorecard_id: 33, scorecard_question_id: 5, answer: "unresolvable scorecard" },
          { id: 7, scorecard_question_id: 5, answer: "no scorecard id" }, // fail closed
        ];
      }
      if (path === "/interviews" && params?.ids === "11") return [{ id: 11, application_id: 100 }];
      if (path === "/interviews" && params?.ids === "12") return [{ id: 12, application_id: 200 }];
      if (path === "/scorecards" && params?.ids === "31") return [{ id: 31, application_id: 100 }];
      if (path === "/scorecards" && params?.ids === "32") return [{ id: 32, application_id: 200 }];
      // scorecard 33 points at application 999, which the applications read does not return:
      // the scope join cannot resolve a permitted job, so the answer must drop.
      if (path === "/scorecards" && params?.ids === "33") return [{ id: 33, application_id: 999 }];
      if (path === "/applications" && params?.ids === "100") return [{ id: 100, job_id: 1, candidate_id: 501 }];
      if (path === "/applications" && params?.ids === "200") return [{ id: 200, job_id: 2, candidate_id: 502 }];
      return [];
    }));
    const scoped = createScopedGreenhouseReader({
      actorResolver: actorResolver(),
      permissionProvider: permissionProvider(new Map([[100, [1]]])),
      rawReader: raw,
    });

    const interviewers = await scoped.scopedRead(100, "list_interviewers", {});
    const answers = await scoped.scopedRead(100, "list_scorecard_question_answers", {});

    // Only the interviewer whose interview resolves to permitted job 1 survives; the non-permitted-job
    // interview and the interview_id-less row drop. (response_status is the calendar-invite RSVP enum
    // accepted/declined/tentative/needs_action — not a scorecard-submission marker.)
    assert.deepStrictEqual(interviewers.ok && interviewers.data, [
      { id: 1, interview_id: 11, scorecard_id: 21, user_id: 50, response_status: "accepted", email: "a@example.com" },
    ]);
    // Only the answer whose scorecard resolves through its application to permitted job 1 survives;
    // the non-permitted-job answer, the unresolvable-application answer, and the scorecard_id-less row
    // all drop. (v3 has no row-level private-scorecard flag; the access boundary here is purely the
    // scorecard->application->permitted-job join.)
    assert.deepStrictEqual(answers.ok && answers.data, [
      { id: 4, scorecard_id: 31, scorecard_question_id: 5, answer: "Strong on system design" },
    ]);
  });

  it("scopes application_stages funnel rows through the permitted application join (load-bearing S7)", async () => {
    // Two stage rows carrying NO job_id of their own. Row 4001 belongs to
    // application 100 (on permitted job 1); row 4002 belongs to application 200
    // (on non-permitted job 2). A naive unscoped/global-reference registration
    // would return BOTH rows — this lock fails unless the read scopes via the
    // application-backed join and drops the non-permitted stage row.
    const raw = rawReader(withCandidatePrivacy((path, params) => {
      if (path === "/application_stages") {
        return [
          { id: 4001, application_id: 100, job_interview_stage_id: 7, days_in_stage: 4, current: false },
          { id: 4002, application_id: 200, job_interview_stage_id: 9, days_in_stage: 2, current: true },
        ];
      }
      if (path === "/applications" && params?.ids === "100") return [{ id: 100, job_id: 1, candidate_id: 501 }];
      if (path === "/applications" && params?.ids === "200") return [{ id: 200, job_id: 2, candidate_id: 502 }];
      return [];
    }));
    const scoped = createScopedGreenhouseReader({
      actorResolver: actorResolver(),
      permissionProvider: permissionProvider(new Map([[100, [1]]])),
      rawReader: raw,
    });

    const stages = await scoped.scopedRead(100, "list_application_stages", {});

    assert.equal(stages.ok, true);
    assert.deepStrictEqual(stages.ok && stages.data, [
      { id: 4001, application_id: 100, job_interview_stage_id: 7, days_in_stage: 4, current: false },
    ]);
    assert.equal(stages.ok && stages.rowCounts.raw, 2);
    assert.equal(stages.ok && stages.rowCounts.returned, 1);
  });

  it("follows the registered approver parent chain and excludes a cross-job sibling", async () => {
    const raw = rawReader((path, params) => {
      if (path === "/approvers") {
        return [
          { id: 1, approver_group_id: 10, user_id: 1001 },
          { id: 2, approver_group_id: 20, user_id: 1002 },
        ];
      }
      if (path === "/approver_groups") {
        assert.equal(params?.ids, "10,20");
        return [
          { id: 10, approval_flow_id: 100 },
          { id: 20, approval_flow_id: 200 },
        ];
      }
      if (path === "/approval_flows") {
        assert.equal(params?.ids, "100,200");
        return [
          { id: 100, job_id: 1 },
          { id: 200, job_id: 2 },
        ];
      }
      return [];
    });
    const scoped = createScopedGreenhouseReader({
      actorResolver: actorResolver(),
      permissionProvider: permissionProvider(new Map([[100, [1]]])),
      rawReader: raw,
      scopePolicyRegistry: new Map([["list_approvers", APPROVER_POLICY]]),
    });

    const result = await scoped.scopedRead(100, "list_approvers", {});

    assert.equal(result.ok, true);
    assert.deepStrictEqual(result.ok && result.data, [
      { id: 1, approver_group_id: 10, user_id: 1001 },
    ]);
    assert.equal(result.ok && result.rowCounts.permissionExcluded, 1);
    assert.equal(result.ok && result.rowCounts.status, "complete");
  });

  it("redacts forbidden ids from a mixed prospect-pool job_ids row", async () => {
    const raw = rawReader((path) => {
      assert.equal(path, "/prospect_pools");
      return [
        { id: 1, name: "Mixed", job_ids: [2, 1] },
        { id: 2, name: "Forbidden", job_ids: [2] },
      ];
    });
    const scoped = createScopedGreenhouseReader({
      actorResolver: actorResolver(),
      permissionProvider: permissionProvider(new Map([[100, [1]]])),
      rawReader: raw,
      scopePolicyRegistry: new Map([["list_prospect_pools", PROSPECT_POOL_POLICY]]),
    });

    const result = await scoped.scopedRead(100, "list_prospect_pools", {});

    assert.deepStrictEqual(result.ok && result.data, [
      { id: 1, name: "Mixed", job_ids: [1] },
    ]);
    assert.equal(result.ok && result.rowCounts.permissionExcluded, 1);
  });

  it("marks a missing policy parent incomplete and denies a failed parent read", async () => {
    const missingRaw = rawReader((path) => {
      if (path === "/job_post_locations") return [{ id: 1, job_post_id: 999 }];
      if (path === "/job_posts") return [];
      return [];
    });
    const missingScoped = createScopedGreenhouseReader({
      actorResolver: actorResolver(),
      permissionProvider: permissionProvider(new Map([[100, [1]]])),
      rawReader: missingRaw,
      scopePolicyRegistry: new Map([["list_job_post_locations", JOB_POST_LOCATION_POLICY]]),
    });
    const missing = await missingScoped.scopedRead(100, "list_job_post_locations", {});
    assert.equal(missing.ok, true);
    assert.deepStrictEqual(missing.ok && missing.data, []);
    assert.equal(missing.ok && missing.rowCounts.unresolved, 1);
    assert.equal(missing.ok && missing.rowCounts.status, "incomplete_scope_resolution");

    const failedRaw = rawReader((path) => {
      if (path === "/job_post_locations") return [{ id: 1, job_post_id: 999 }];
      throw new Error("parent unavailable");
    });
    const failedScoped = createScopedGreenhouseReader({
      actorResolver: actorResolver(),
      permissionProvider: permissionProvider(new Map([[100, [1]]])),
      rawReader: failedRaw,
      scopePolicyRegistry: new Map([["list_job_post_locations", JOB_POST_LOCATION_POLICY]]),
    });
    const failed = await failedScoped.scopedRead(100, "list_job_post_locations", {});
    assert.equal(failed.ok, false);
    assert.equal(failed.ok === false && failed.denial.code, "PERMISSION_JOIN_FAILED");
  });

  it("loads 500 unique permission parents in 50-id batches with at most three in flight", async () => {
    let active = 0;
    let maxActive = 0;
    const parentCalls: RawCall[] = [];
    const raw: RawReadClient = {
      async read<T>(
        path: string,
        params?: Record<string, string | number | boolean | undefined>,
        cursor?: string
      ): Promise<ApiResponse<T>> {
        if (path === "/job_post_locations") {
          return response(
            Array.from({ length: 500 }, (_, index) => ({ id: index + 1, job_post_id: index + 1 })) as T
          );
        }
        assert.equal(path, "/job_posts");
        assert.equal(cursor, undefined);
        parentCalls.push({ path, params, cursor });
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
        const ids = String(params?.ids).split(",").map(Number);
        return response(ids.map((id) => ({ id, job_id: id === 1 ? 1 : 2 })) as T);
      },
    };
    const scoped = createScopedGreenhouseReader({
      actorResolver: actorResolver(),
      permissionProvider: permissionProvider(new Map([[100, [1]]])),
      rawReader: raw,
      scopePolicyRegistry: new Map([["list_job_post_locations", JOB_POST_LOCATION_POLICY]]),
    });

    const result = await scoped.scopedRead(100, "list_job_post_locations", {});

    assert.equal(result.ok && Array.isArray(result.data) && result.data.length, 1);
    assert.equal(parentCalls.length, 10);
    assert.equal(parentCalls.every((call) => String(call.params?.ids).split(",").length <= 50), true);
    assert.equal(maxActive <= 3, true);
  });

  it("loads a shared permission parent once for repeated child references in one scoped read", async () => {
    let parentCalls = 0;
    const raw = rawReader((path) => {
      if (path === "/job_post_locations") {
        return [
          { id: 1, job_post_id: 10 },
          { id: 2, job_post_id: 10 },
        ];
      }
      assert.equal(path, "/job_posts");
      parentCalls += 1;
      return [{ id: 10, job_id: 1 }];
    });
    const scoped = createScopedGreenhouseReader({
      actorResolver: actorResolver(),
      permissionProvider: permissionProvider(new Map([[100, [1]]])),
      rawReader: raw,
      scopePolicyRegistry: new Map([["list_job_post_locations", JOB_POST_LOCATION_POLICY]]),
    });

    const result = await scoped.scopedRead(100, "list_job_post_locations", {});

    assert.equal(result.ok && Array.isArray(result.data) && result.data.length, 2);
    assert.equal(parentCalls, 1);
  });

  it("threads cancellation through permission, primary, and paginated parent reads", async () => {
    const controller = new AbortController();
    let permissionSignal: AbortSignal | undefined;
    const seenSignals: Array<AbortSignal | undefined> = [];
    const raw: RawReadClient = {
      async read<T>(
        path: string,
        _params?: Record<string, string | number | boolean | undefined>,
        cursor?: string,
        signal?: AbortSignal
      ): Promise<ApiResponse<T>> {
        seenSignals.push(signal);
        if (path === "/job_post_locations") {
          return response([{ id: 1, job_post_id: 10 }] as T);
        }
        assert.equal(path, "/job_posts");
        assert.equal(cursor, undefined);
        controller.abort(new DOMException("cancelled", "AbortError"));
        return response([{ id: 10, job_id: 1 }] as T, "parent-page-2");
      },
    };
    const scoped = createScopedGreenhouseReader({
      actorResolver: actorResolver(),
      permissionProvider: {
        async getPermittedJobIds(_actorId, signal) {
          permissionSignal = signal;
          return new Set([1]);
        },
      },
      rawReader: raw,
      scopePolicyRegistry: new Map([["list_job_post_locations", JOB_POST_LOCATION_POLICY]]),
    });

    await assert.rejects(
      scoped.scopedRead(100, "list_job_post_locations", {}, { signal: controller.signal }),
      (error: unknown) => error instanceof Error && error.name === "AbortError"
    );
    assert.equal(permissionSignal, controller.signal);
    assert.equal(seenSignals.every((signal) => signal === controller.signal), true);
    assert.equal(seenSignals.length, 2, "abort before following the parent cursor");
  });

  it("exposes global-reference reads without fake job filtering while stripping identity params", async () => {
    const raw = rawReader((path, params) => {
      if (path === "/users") return [{ id: 77, name: "Recruiter" }];
      if (path === "/rejection_reasons") return [{ id: 9, name: "Skills mismatch" }];
      // Reference dictionaries wired in the timidity cluster-4 work. All are global_reference: they
      // must pass through unfiltered even though the actor is scoped to job 1 only.
      if (path === "/departments") return [{ id: 30, name: "Engineering" }];
      if (path === "/offices") return [{ id: 40, name: "NYC" }];
      if (path === "/close_reasons") return [{ id: 50, name: "Filled internally" }];
      if (path === "/custom_field_options") return [{ id: 60, name: "Senior", custom_field_id: 7 }];
      if (path === "/custom_fields") return [{ id: 7, name: "Seniority" }];
      if (path === "/pay_inputs") return [{ id: 8, title: "Base Salary" }];
      return [];
    });
    const scoped = createScopedGreenhouseReader({
      actorResolver: actorResolver(),
      permissionProvider: permissionProvider(new Map([[100, [1]]])),
      rawReader: raw,
    });

    const users = await scoped.scopedRead(100, "list_users", {
      ids: "77",
      email: "someone@example.com",
      actAsUser: 900,
      user_id: 77,
    });
    const reasons = await scoped.scopedRead(100, "list_rejection_reasons", {});
    const departments = await scoped.scopedRead(100, "list_departments", {});
    const offices = await scoped.scopedRead(100, "list_offices", {});
    const closeReasons = await scoped.scopedRead(100, "list_close_reasons", {});
    const customFieldOptions = await scoped.scopedRead(100, "list_custom_field_options", {});
    const customFields = await scoped.scopedRead(100, "list_custom_fields", {});
    const payInputs = await scoped.scopedRead(100, "list_pay_inputs", {});

    assert.deepStrictEqual(users.ok && users.data, [{ id: 77, name: "Recruiter" }]);
    assert.deepStrictEqual(reasons.ok && reasons.data, [{ id: 9, name: "Skills mismatch" }]);
    // Each new reference dictionary binding exists and passes through unfiltered.
    assert.deepStrictEqual(departments.ok && departments.data, [{ id: 30, name: "Engineering" }]);
    assert.deepStrictEqual(offices.ok && offices.data, [{ id: 40, name: "NYC" }]);
    assert.deepStrictEqual(closeReasons.ok && closeReasons.data, [{ id: 50, name: "Filled internally" }]);
    assert.deepStrictEqual(customFieldOptions.ok && customFieldOptions.data, [{ id: 60, name: "Senior", custom_field_id: 7 }]);
    assert.deepStrictEqual(customFields.ok && customFields.data, [{ id: 7, name: "Seniority" }]);
    assert.deepStrictEqual(payInputs.ok && payInputs.data, [{ id: 8, title: "Base Salary" }]);
    assert.deepStrictEqual(raw.calls[0], {
      path: "/users",
      params: { ids: "77" },
      cursor: undefined,
    });
  });

  it("leaves non-public notes untouched for unscoped operators", async () => {
    const raw = rawReader(() => [
      { id: 801, application_id: 10, visibility: "privately_visible" },
      { id: 802, application_id: 10 },
    ]);
    const scoped = createScopedGreenhouseReader({
      actorResolver: actorResolver(),
      permissionProvider: permissionProvider(new Map([[100, [1]]])),
      rawReader: raw,
      operatorActorIds: new Set([900]),
    });

    const result = await scoped.scopedRead(900, "list_notes", {});

    assert.equal(result.ok, true);
    assert.deepStrictEqual(result.ok && result.data, [
      { id: 801, application_id: 10, visibility: "privately_visible" },
      { id: 802, application_id: 10 },
    ]);
  });

  it("returns write tools as not available through the default-deny registry", async () => {
    const raw = rawReader(() => {
      throw new Error("raw reader should not be called");
    });
    const scoped = createScopedGreenhouseReader({
      actorResolver: actorResolver(),
      permissionProvider: permissionProvider(new Map([[100, [1]]])),
      rawReader: raw,
    });

    const result = await scoped.scopedRead(100, "reject_application", { id: 10 });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.denial.code, "TOOL_NOT_AVAILABLE");
    assert.equal(raw.calls.length, 0);
  });

  it("maps only real MCP read tools to their registered endpoints", async () => {
    const raw = rawReader((_path, params) => (params?.ids === "10" ? [{ id: 10, job_id: 1 }] : []));
    const scoped = createScopedGreenhouseReader({
      actorResolver: actorResolver(),
      permissionProvider: permissionProvider(new Map([[100, [1]]])),
      rawReader: raw,
      operatorActorIds: new Set([900]),
    });

    await scoped.scopedRead(900, "list_applications", { status: "active" });
    await scoped.scopedRead(900, "get_application", { id: 10 });
    await scoped.scopedRead(900, "list_candidates", {});
    await scoped.scopedRead(900, "get_candidate", { id: 10 });
    await scoped.scopedRead(900, "list_scorecards", {});
    await scoped.scopedRead(900, "list_notes", {});
    await scoped.scopedRead(900, "list_jobs", {});
    await scoped.scopedRead(900, "get_job", { id: 10 });
    const activity = await scoped.scopedRead(900, "list_activity", {});

    assert.equal(activity.ok, false);
    assert.equal(activity.ok === false && activity.denial.code, "TOOL_NOT_AVAILABLE");
    assert.deepStrictEqual(
      raw.calls.map((call) => [call.path, call.params]),
      [
        ["/applications", { status: "active" }],
        ["/applications", { ids: "10", per_page: 100 }],
        ["/candidates", {}],
        ["/candidates", { ids: "10", per_page: 100 }],
        ["/scorecards", {}],
        ["/notes", {}],
        ["/jobs", {}],
        ["/jobs", { ids: "10", per_page: 100 }],
      ]
    );
  });

  it("returns only exact list-by-id rows from scoped get tools", async () => {
    const raw = rawReader((path, params) => {
      if (path === "/jobs" && params?.ids === "10") {
        return [{ id: 999 }, { id: 10 }];
      }
      if (path === "/applications" && params?.ids === "100") {
        return [
          { id: 999, job_id: 10, candidate_id: 999 },
          { id: 100, job_id: 10, candidate_id: 200 },
        ];
      }
      if (path === "/candidates" && params?.ids === "200") {
        return [
          { id: 999, private: false, applications: [{ id: 9990, job_id: 10 }] },
          { id: 200, private: false, applications: [{ id: 100, job_id: 10 }] },
        ];
      }
      // The application privacy gate resolves the candidate behind the application row.
      if (path === "/candidates") return [{ id: 200, private: false }];
      return [];
    });
    const scoped = createScopedGreenhouseReader({
      actorResolver: actorResolver(),
      permissionProvider: permissionProvider(new Map([[100, [10]]])),
      rawReader: raw,
    });

    const job = await scoped.scopedRead(100, "get_job", { id: 10 });
    const application = await scoped.scopedRead(100, "get_application", { id: 100 });
    const candidate = await scoped.scopedRead(100, "get_candidate", { id: 200 });
    const missing = await scoped.scopedRead(100, "get_job", { id: 123 });

    assert.deepStrictEqual(job.ok && job.data, { id: 10 });
    assert.deepStrictEqual(application.ok && application.data, { id: 100, job_id: 10, candidate_id: 200 });
    assert.deepStrictEqual(candidate.ok && candidate.data, { id: 200, private: false, applications: [{ id: 100, job_id: 10 }] });
    assert.equal(missing.ok && missing.data, null);
  });

  it("returns null for get_application when the exact row is outside permitted jobs", async () => {
    const raw = rawReader((path, params) => {
      assert.equal(path, "/applications");
      assert.equal(params?.ids, "100");
      return [{ id: 100, job_id: 20 }];
    });
    const scoped = createScopedGreenhouseReader({
      actorResolver: actorResolver(),
      permissionProvider: permissionProvider(new Map([[100, [10]]])),
      rawReader: raw,
    });

    const result = await scoped.scopedRead(100, "get_application", { id: 100 });

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.data, null);
  });

  it("returns null for get_candidate when the exact row is outside permitted jobs", async () => {
    const raw = rawReader((path, params) => {
      assert.equal(path, "/candidates");
      assert.equal(params?.ids, "200");
      // `private: false` is required for this test to exercise what its name claims. Without it the
      // candidate-row privacy gate fails closed on the missing flag and withholds the row BEFORE the
      // job-scope check ever runs, so the test passed on the privacy path while asserting the scope
      // path. It only became visible when privacy withholds started being counted separately.
      return [{ id: 200, private: false, applications: [{ id: 100, job_id: 20 }] }];
    });
    const scoped = createScopedGreenhouseReader({
      actorResolver: actorResolver(),
      permissionProvider: permissionProvider(new Map([[100, [10]]])),
      rawReader: raw,
    });

    const result = await scoped.scopedRead(100, "get_candidate", { id: 200 });

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.data, null);
    assert.equal(result.ok && result.rowCounts.permissionExcluded, 1);
  });

  it("lets operators preview a recruiter scope with actAsUser", async () => {
    const raw = rawReader((path) => {
      if (path === "/candidates") {
        return [
          { id: 501, private: false },
          { id: 502, private: false },
        ];
      }
      return [
        { id: 10, job_id: 1, candidate_id: 501 },
        { id: 20, job_id: 2, candidate_id: 502 },
      ];
    });
    const scoped = createScopedGreenhouseReader({
      actorResolver: actorResolver(),
      permissionProvider: permissionProvider(new Map([[100, [1]]])),
      rawReader: raw,
      operatorActorIds: new Set([900]),
    });

    const result = await scoped.scopedRead(
      900,
      "list_applications",
      {},
      { actAsUser: 100 }
    );

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.actorId, 900);
    assert.equal(result.ok && result.effectiveActorId, 100);
    assert.equal(result.ok && result.scoped, true);
    assert.deepStrictEqual(result.ok && result.data, [{ id: 10, job_id: 1, candidate_id: 501 }]);
  });

  it("denies non-operator actAsUser even when params contain identity-looking fields", async () => {
    const raw = rawReader(() => {
      throw new Error("raw reader should not be called");
    });
    const scoped = createScopedGreenhouseReader({
      actorResolver: actorResolver(),
      permissionProvider: permissionProvider(new Map([[100, [1]]])),
      rawReader: raw,
      operatorActorIds: new Set([900]),
    });

    const result = await scoped.scopedRead(
      100,
      "list_applications",
      { on_behalf_of_user_id: 900, actAsUserId: 900 },
      { actAsUser: 900 }
    );

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.denial.code, "ACTOR_DENIED");
    assert.equal(raw.calls.length, 0);
  });

  it("does not forward model-supplied identity params to the raw reader", async () => {
    const raw = rawReader(() => [{ id: 10, job_id: 1 }]);
    const scoped = createScopedGreenhouseReader({
      actorResolver: actorResolver(),
      permissionProvider: permissionProvider(new Map([[100, [1]]])),
      rawReader: raw,
    });

    await scoped.scopedRead(100, "list_applications", {
      on_behalf_of_user_id: 900,
      "on-behalf-of-user-id": 901,
      actor_id: 900,
      ActorID: 901,
      status: "active",
      ACT_AS_USER: 902,
      GreenhouseUserID: 903,
      "effective-greenhouse-user-id": 904,
    });

    assert.deepStrictEqual(raw.calls[0], {
      path: "/applications",
      params: { status: "active" },
      cursor: undefined,
    });
  });

  it("denies application-backed reads when a permission parent lookup fails", async () => {
    const raw = rawReader((path, params) => {
      if (path === "/scorecards") {
        return [
          { id: 701, application_id: 10 },
          { id: 702, application_id: 20 },
        ];
      }
      if (path === "/applications" && params?.ids === "10") {
        throw new Error("application lookup unavailable");
      }
      if (path === "/applications" && params?.ids === "20") {
        return [{ id: 20, job_id: 1 }];
      }
      return [];
    });
    const scoped = createScopedGreenhouseReader({
      actorResolver: actorResolver(),
      permissionProvider: permissionProvider(new Map([[100, [1]]])),
      rawReader: raw,
    });

    const result = await scoped.scopedRead(100, "list_scorecards", {});

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.denial.code, "PERMISSION_JOIN_FAILED");
  });

  it("denies candidate-level reads when a permission parent lookup fails", async () => {
    const raw = rawReader((path, params) => {
      if (path === "/notes") {
        return [{ id: 801, candidate_id: 501, visibility: "publicly_visible" }];
      }
      // The candidate is visible, so the read reaches the application join that this test fails.
      if (path === "/candidates") {
        return [{ id: Number(params?.ids), private: false }];
      }
      if (path === "/applications") {
        throw new Error("candidate application lookup unavailable");
      }
      return [];
    });
    const scoped = createScopedGreenhouseReader({
      actorResolver: actorResolver(),
      permissionProvider: permissionProvider(new Map([[100, [1]]])),
      rawReader: raw,
    });

    const result = await scoped.scopedRead(100, "list_notes", {});

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.denial.code, "PERMISSION_JOIN_FAILED");
  });

  // Greenhouse restricts a candidate flagged `private` to holders of "View Private Candidates".
  // Job permission does NOT grant it, and these reads run under an org-wide service credential, so
  // Greenhouse's own gate never fires. This layer is the only enforcer — revert it and a scoped
  // recruiter reads confidential searches and internal transfers, including full resume text.
  it("drops private candidates and every candidate-backed row that hangs off them", async () => {
    const raw = rawReader((path, params) => {
      if (path === "/candidates" && params?.ids === undefined) {
        return [
          { id: 501, private: false, applications: [{ id: 10, job_id: 1 }] },
          // Private, and on a job this recruiter IS permitted on. Job permission must not suffice.
          { id: 502, private: true, applications: [{ id: 20, job_id: 1 }] },
        ];
      }
      // `ids` is a comma-separated list in v3, and the privacy lookup batches, so this answers a
      // list the way the real endpoint does rather than assuming one id per request.
      if (path === "/candidates") {
        return String(params?.ids)
          .split(",")
          .map((id) => Number(id))
          .filter((id) => Number.isInteger(id) && id > 0)
          .map((id) => ({ id, private: id === 502 }));
      }
      if (path === "/candidate_educations") {
        return [
          { id: 1, candidate_id: 501, degree_custom_field_option_id: 9 },
          { id: 2, candidate_id: 502, degree_custom_field_option_id: 9 },
        ];
      }
      if (path === "/attachments") {
        return [
          { id: 901, application_id: 10, candidate_id: 501, filename: "ok.pdf" },
          // Attachment on a PERMITTED application, but the candidate is private.
          { id: 902, application_id: 20, candidate_id: 502, filename: "confidential.pdf" },
        ];
      }
      if (path === "/applications" && params?.ids === "10") return [{ id: 10, candidate_id: 501, job_id: 1 }];
      if (path === "/applications" && params?.ids === "20") return [{ id: 20, candidate_id: 502, job_id: 1 }];
      if (path === "/applications" && params?.candidate_ids === "501") return [{ id: 10, candidate_id: 501, job_id: 1 }];
      if (path === "/applications" && params?.candidate_ids === "502") return [{ id: 20, candidate_id: 502, job_id: 1 }];
      return [];
    });
    const scoped = createScopedGreenhouseReader({
      actorResolver: actorResolver(),
      permissionProvider: permissionProvider(new Map([[100, [1]]])),
      rawReader: raw,
    });

    const candidates = await scoped.scopedRead(100, "list_candidates", {});
    const educations = await scoped.scopedRead(100, "list_candidate_educations", {});
    const attachments = await scoped.scopedRead(100, "list_attachments", {});

    assert.deepStrictEqual(
      candidates.ok && (candidates.data as Record<string, unknown>[]).map((row) => row.id),
      [501],
      "a private candidate is withheld even on a permitted job"
    );
    assert.deepStrictEqual(
      educations.ok && (educations.data as Record<string, unknown>[]).map((row) => row.id),
      [1],
      "candidate-backed history for a private candidate is withheld"
    );
    assert.deepStrictEqual(
      attachments.ok && (attachments.data as Record<string, unknown>[]).map((row) => row.id),
      [901],
      "an attachment on a permitted application is withheld when its candidate is private"
    );
  });

  it("withholds the application-shaped substance of a private candidate on a permitted job", async () => {
    // The gap this locks: job permission alone let a scoped recruiter enumerate a PRIVATE
    // candidate's application, stage history, scorecards, rejection reason, prospect details and
    // OFFER (with compensation) — every one of them reachable without ever reading a candidate row.
    // Candidate 502 is private and sits on job 1, which this recruiter IS permitted on.
    const raw = rawReader(withCandidatePrivacy((path, params) => {
      if (path === "/applications" && params?.ids === "20") {
        return [{ id: 20, job_id: 1, candidate_id: 502 }];
      }
      if (path === "/applications") {
        return [
          { id: 10, job_id: 1, candidate_id: 501 },
          { id: 20, job_id: 1, candidate_id: 502 },
        ];
      }
      if (path === "/application_stages") {
        return [
          { id: 31, application_id: 10, job_interview_stage_id: 7 },
          { id: 32, application_id: 20, job_interview_stage_id: 7 },
        ];
      }
      if (path === "/scorecards") {
        return [
          { id: 41, application_id: 10 },
          { id: 42, application_id: 20 },
        ];
      }
      if (path === "/rejection_details") {
        return [
          { id: 51, application_id: 10, rejection_reason_id: 3 },
          { id: 52, application_id: 20, rejection_reason_id: 3 },
        ];
      }
      if (path === "/prospect_details") {
        return [
          { id: 61, application_id: 10 },
          { id: 62, application_id: 20 },
        ];
      }
      if (path === "/offers") {
        return [
          { id: 71, job_id: 1, application_id: 10, candidate_id: 501, custom_fields: { base: 200000 } },
          { id: 72, job_id: 1, application_id: 20, candidate_id: 502, custom_fields: { base: 400000 } },
        ];
      }
      return [];
    }, new Set([502])));
    const scoped = createScopedGreenhouseReader({
      actorResolver: actorResolver(),
      permissionProvider: permissionProvider(new Map([[100, [1]]])),
      rawReader: raw,
    });

    const keptIds = async (toolName: string, params: Record<string, unknown> = {}) => {
      const result = await scoped.scopedRead(100, toolName, params);
      assert.equal(result.ok, true, `${toolName} should not deny outright`);
      const data = result.ok ? result.data : null;
      return (Array.isArray(data) ? data : data === null ? [] : [data]).map(
        (row) => (row as Record<string, unknown>).id
      );
    };

    assert.deepStrictEqual(await keptIds("list_applications"), [10], "the private candidate's application");
    assert.deepStrictEqual(await keptIds("list_application_stages"), [31], "their stage history");
    assert.deepStrictEqual(await keptIds("list_scorecards"), [41], "their scorecards");
    assert.deepStrictEqual(await keptIds("list_rejection_details"), [51], "their rejection reason");
    assert.deepStrictEqual(await keptIds("list_prospect_details"), [61], "their prospect details");
    assert.deepStrictEqual(await keptIds("list_offers"), [71], "their offer and its compensation");
    assert.deepStrictEqual(await keptIds("get_application", { id: 20 }), [], "get_application by id");
  });

  it("withholds a private candidate's application even when the tool is scope-policy driven", async () => {
    // list_applications, get_application and list_application_stages all carry a scope policy in
    // production, and a policy-driven tool takes filterWithScopePolicy and NEVER runs its row
    // filter. A privacy gate written only into the row filters would silently not run on exactly
    // the three highest-traffic readers of candidate substance. This is that bypass, locked.
    const raw = rawReader(withCandidatePrivacy((path, params) => {
      if (path === "/applications" && params?.ids === "20") {
        return [{ id: 20, job_id: 1, candidate_id: 502 }];
      }
      if (path === "/applications") {
        return [
          { id: 10, job_id: 1, candidate_id: 501 },
          { id: 20, job_id: 1, candidate_id: 502 },
        ];
      }
      if (path === "/application_stages") {
        return [
          { id: 31, application_id: 10, job_interview_stage_id: 7 },
          { id: 32, application_id: 20, job_interview_stage_id: 7 },
        ];
      }
      return [];
    }, new Set([502])));
    const scoped = createScopedGreenhouseReader({
      actorResolver: actorResolver(),
      permissionProvider: permissionProvider(new Map([[100, [1]]])),
      rawReader: raw,
      // Exactly what production supplies for these tools.
      scopePolicyRegistry: new Map<string, ExecutableScopePolicy>([
        ["list_applications", APPLICATION_POLICY],
        ["get_application", APPLICATION_POLICY],
        ["list_application_stages", {
          kind: "join_backed",
          dependencies: [{
            field: "application_id",
            sourceFilter: "application_ids",
            targetEndpoint: "/applications",
            targetField: "id",
            targetFilter: "ids",
            purpose: "scope",
          }],
          terminal: { field: "job_id", filter: "job_ids" },
        }],
      ]),
    });

    const applications = await scoped.scopedRead(100, "list_applications", {});
    const stages = await scoped.scopedRead(100, "list_application_stages", {});
    const one = await scoped.scopedRead(100, "get_application", { id: 20 });

    assert.deepStrictEqual(
      applications.ok && (applications.data as Record<string, unknown>[]).map((row) => row.id),
      [10],
      "the policy-driven list path must gate the private candidate"
    );
    assert.deepStrictEqual(
      stages.ok && (stages.data as Record<string, unknown>[]).map((row) => row.id),
      [31],
      "the join-backed policy path must gate the private candidate"
    );
    assert.equal(one.ok && one.data, null, "the policy-driven get path must gate the private candidate");
    // The withheld rows are reported as permission exclusions, not as clean reads.
    assert.equal(applications.ok && applications.rowCounts.permissionExcluded, 1);
    assert.equal(applications.ok && applications.rowCounts.returned, 1);
  });

  it("resolves candidate privacy in one batched read per page rather than one read per row", async () => {
    // The gate must not turn a page of applications into N sequential joins inside the request
    // deadline — a latency regression that would withdraw the capability it is protecting.
    const rows = Array.from({ length: 120 }, (_, index) => ({
      id: index + 1,
      job_id: 1,
      candidate_id: 1000 + index,
    }));
    const raw = rawReader(withCandidatePrivacy((path) => (path === "/applications" ? rows : [])));
    const scoped = createScopedGreenhouseReader({
      actorResolver: actorResolver(),
      permissionProvider: permissionProvider(new Map([[100, [1]]])),
      rawReader: raw,
    });

    const result = await scoped.scopedRead(100, "list_applications", {});

    assert.equal(result.ok && (result.data as unknown[]).length, 120);
    const candidateReads = raw.calls.filter((call) => call.path === "/candidates");
    assert.equal(candidateReads.length, 3, "120 candidates resolve in three 50-id batches, not 120 reads");
    assert.deepStrictEqual(
      candidateReads.map((call) => String(call.params?.ids).split(",").length),
      [50, 50, 20]
    );
    for (const call of candidateReads) {
      assert.equal(call.params?.fields, "id,private");
    }
  });

  it("admits a private candidate on a job the actor holds the Private role on, and nowhere else", async () => {
    // Greenhouse ships a built-in "Private" Job Admin role, and /user_job_permissions rows carry
    // the role_id that names it. A recruiter the org granted Job Admin: Private on a job is
    // entitled to that job's private candidates — withholding them was this layer denying access
    // the organization had already granted. Job 1 carries the Private role; job 2 does not.
    const raw = rawReader(withCandidatePrivacy((path, params) => {
      if (path === "/user_job_permissions") {
        return [
          { user_id: 100, job_id: 1, role_id: 77 },
          { user_id: 100, job_id: 2, role_id: 88 },
        ];
      }
      if (path === "/user_roles") {
        return [
          { id: 77, role_type: "job_admin", name: "Private" },
          { id: 88, role_type: "job_admin", name: "Standard" },
          // A customer role whose name merely CONTAINS the word must not become a grant.
          { id: 99, role_type: "job_admin", name: "Private Equity Recruiter" },
        ];
      }
      if (path === "/applications") {
        return [
          { id: 10, job_id: 1, candidate_id: 502 },
          { id: 20, job_id: 2, candidate_id: 503 },
        ];
      }
      if (path === "/offers") {
        return [
          { id: 71, job_id: 1, application_id: 10, candidate_id: 502, custom_fields: { base: 400000 } },
          { id: 72, job_id: 2, application_id: 20, candidate_id: 503, custom_fields: { base: 300000 } },
        ];
      }
      if (path === "/candidates") {
        return [
          { id: 502, private: true, applications: [{ id: 10, job_id: 1 }] },
          { id: 503, private: true, applications: [{ id: 20, job_id: 2 }] },
        ];
      }
      return [];
    }, new Set([502, 503])));
    const scoped = createScopedGreenhouseReader({
      actorResolver: actorResolver(),
      permissionProvider: createHarvestPermissionProvider({ rawReader: raw }),
      rawReader: raw,
    });

    const applications = await scoped.scopedRead(100, "list_applications", {});
    const offers = await scoped.scopedRead(100, "list_offers", {});
    const candidates = await scoped.scopedRead(100, "list_candidates", {});

    assert.deepStrictEqual(
      applications.ok && (applications.data as Record<string, unknown>[]).map((row) => row.id),
      [10],
      "the private candidate on the Private-role job is admitted; the one on the Standard-role job is not"
    );
    assert.deepStrictEqual(
      offers.ok && (offers.data as Record<string, unknown>[]).map((row) => row.id),
      [71],
      "the same rule governs the offer and its compensation"
    );
    assert.deepStrictEqual(
      candidates.ok && (candidates.data as Record<string, unknown>[]).map((row) => row.id),
      [502],
      "and the candidate row itself"
    );
  });

  it("does not let one request's cancellation cost a CONCURRENT request its private-candidate admission", async () => {
    // The role dictionary is shared across actors. Caching the in-flight PROMISE would hand a
    // cancelled request's AbortError to every request already waiting on it: the waiter finds its
    // OWN signal un-aborted, falls through to the fail-soft empty set, and silently loses private
    // admission for a request nobody cancelled. Only a completed read is cached.
    //
    // The two reads must genuinely overlap. Sequentially the bug hides — the rejected promise
    // clears itself, so the next request simply starts a fresh one and succeeds.
    const controller = new AbortController();
    let releaseRoles: (() => void) | undefined;
    const rolesInFlight = new Promise<void>((resolve) => { releaseRoles = resolve; });
    let rolesRequested: (() => void) | undefined;
    const rolesStarted = new Promise<void>((resolve) => { rolesRequested = resolve; });

    const raw: RawReadClient = {
      async read<T = unknown>(path: string, params?: Record<string, unknown>, _cursor?: string, signal?: AbortSignal): Promise<ApiResponse<T>> {
        if (path === "/user_roles") {
          rolesRequested?.();
          // Hold the dictionary read open so a second request can join this same lookup, then let
          // the abort land on whoever is waiting.
          await rolesInFlight;
          signal?.throwIfAborted();
          return { data: [{ id: 77, role_type: "job_admin", name: "Private" }] as T, nextCursor: null };
        }
        if (path === "/user_job_permissions") {
          return { data: [{ user_id: 100, job_id: 1, role_id: 77 }] as T, nextCursor: null };
        }
        if (path === "/applications") {
          return { data: [{ id: 10, job_id: 1, candidate_id: 502 }] as T, nextCursor: null };
        }
        if (path === "/candidates") {
          return { data: [{ id: 502, private: true }] as T, nextCursor: null };
        }
        return { data: [] as unknown as T, nextCursor: null };
      },
    };
    const scoped = createScopedGreenhouseReader({
      actorResolver: actorResolver(),
      permissionProvider: createHarvestPermissionProvider({ rawReader: raw }),
      rawReader: raw,
    });

    const cancelled = scoped
      .scopedRead(100, "list_applications", {}, { signal: controller.signal })
      .catch(() => undefined);
    await rolesStarted;
    const concurrent = scoped.scopedRead(100, "list_applications", {});
    // Give the second request a turn to reach the same dictionary lookup before the abort lands.
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    releaseRoles?.();

    await cancelled;
    const result = await concurrent;

    assert.deepStrictEqual(
      result.ok && (result.data as Record<string, unknown>[]).map((row) => row.id),
      [10],
      "the uncancelled request keeps the private-candidate admission its Private role grants"
    );
  });

  it("withholds every private candidate when the role dictionary cannot be read", async () => {
    // A failed role lookup must never widen: unknown capability is no capability.
    const raw = rawReader(withCandidatePrivacy((path) => {
      if (path === "/user_job_permissions") return [{ user_id: 100, job_id: 1, role_id: 77 }];
      if (path === "/user_roles") throw new Error("role dictionary unavailable");
      if (path === "/applications") return [{ id: 10, job_id: 1, candidate_id: 502 }];
      return [];
    }, new Set([502])));
    const scoped = createScopedGreenhouseReader({
      actorResolver: actorResolver(),
      permissionProvider: createHarvestPermissionProvider({ rawReader: raw }),
      rawReader: raw,
    });

    const result = await scoped.scopedRead(100, "list_applications", {});

    assert.equal(result.ok, true, "the read still succeeds — job scope is unaffected");
    assert.deepStrictEqual(result.ok && result.data, [], "but no private candidate is admitted");
  });

  it("keeps the private-capable subset when the permission answer comes from the cache", async () => {
    // The scope is cloned on the way out of the TTL cache, and the clone used to return a bare Set
    // — which cannot carry the subset. Private capability would then exist on the first read of a
    // TTL window and silently vanish on every one after it.
    const raw = rawReader(withCandidatePrivacy((path) => {
      if (path === "/user_job_permissions") return [{ user_id: 100, job_id: 1, role_id: 77 }];
      if (path === "/user_roles") return [{ id: 77, role_type: "job_admin", name: "Private" }];
      if (path === "/applications") return [{ id: 10, job_id: 1, candidate_id: 502 }];
      return [];
    }, new Set([502])));
    const scoped = createScopedGreenhouseReader({
      actorResolver: actorResolver(),
      permissionProvider: createHarvestPermissionProvider({ rawReader: raw, ttlMs: 60_000 }),
      rawReader: raw,
    });

    const first = await scoped.scopedRead(100, "list_applications", {});
    const cached = await scoped.scopedRead(100, "list_applications", {});

    assert.deepStrictEqual(first.ok && (first.data as Record<string, unknown>[]).map((row) => row.id), [10]);
    assert.deepStrictEqual(
      cached.ok && (cached.data as Record<string, unknown>[]).map((row) => row.id),
      [10],
      "the cached permission answer must carry the private-capable subset too"
    );
    assert.equal(
      raw.calls.filter((call) => call.path === "/user_job_permissions").length,
      1,
      "and it must genuinely be the cached answer"
    );
  });

  it("filters an excluded job out of an org-wide read while leaving everything else org-wide", async () => {
    // {kind:"all"} with exclusions is the site-admin/confidential case: still org-wide, but the
    // legacy confidential jobs Greenhouse restricts are withheld. Job 2 is excluded; every other
    // job in the tenant — including ones no grant ever mentioned — must still come through.
    const raw = rawReader(withCandidatePrivacy((path) => {
      if (path === "/applications") {
        return [
          { id: 10, job_id: 1, candidate_id: 501 },
          { id: 20, job_id: 2, candidate_id: 502 },
          { id: 30, job_id: 3, candidate_id: 503 },
          { id: 40, job_id: 99999, candidate_id: 504 },
        ];
      }
      return [];
    }));
    const scoped = createScopedGreenhouseReader({
      actorResolver: actorResolver(),
      permissionProvider: {
        async getPermittedJobIds() {
          return { kind: "all", excludedJobIds: new Set([2]) };
        },
      },
      rawReader: raw,
    });

    const result = await scoped.scopedRead(100, "list_applications", {});

    assert.equal(result.ok, true);
    assert.deepStrictEqual(
      result.ok && (result.data as Record<string, unknown>[]).map((row) => row.id),
      [10, 30, 40],
      "only the excluded job's row is withheld"
    );
    assert.deepEqual(
      result.ok && result.permissionScope,
      { kind: "all", permittedJobCount: null },
      "the scope is still reported as org-wide, because it is"
    );
    assert.equal(result.ok && result.rowCounts.permissionExcluded, 1);
  });

  it("keeps an org-wide read raw and unfiltered when nothing is excluded", async () => {
    // The fast path must survive: a tenant with no confidential jobs pays nothing for this.
    //
    // What this test does NOT assert: that an org-wide actor is entitled to private candidates.
    // It once did, via a bare "no privacy joins on a raw org-wide read" — which read as an
    // endorsement of an inference nobody had sourced. Greenhouse's own documentation says the
    // opposite: "A Site Admin user requires the user-specific permission Can create and view
    // private candidates" (support article 115002695663). No API exposes whether a given admin holds
    // it, so the org-side answer is still open; see the phase-1 fold ledger. Until it is answered
    // the join count below is a statement about the fast path's SHAPE, nothing more.
    const raw = rawReader(() => [
      { id: 10, job_id: 1 },
      { id: 20, job_id: 2 },
    ]);
    const scoped = createScopedGreenhouseReader({
      actorResolver: actorResolver(),
      permissionProvider: {
        async getPermittedJobIds() {
          return { kind: "all", excludedJobIds: new Set<number>() };
        },
      },
      rawReader: raw,
    });

    const result = await scoped.scopedRead(100, "list_applications", {});

    assert.equal(result.ok && result.scoped, false, "no exclusions means no filtering pass at all");
    assert.deepStrictEqual(result.ok && result.data, [
      { id: 10, job_id: 1 },
      { id: 20, job_id: 2 },
    ]);
    assert.equal(
      raw.calls.filter((call) => call.path === "/candidates").length,
      0,
      "the fast path performs no per-row parent joins of ANY kind — that is what makes it the fast " +
        "path. This is a consequence of skipping the filtering pass, not a ruling that org-wide " +
        "actors may read private candidates; when that question is answered, the fix belongs in the " +
        "scope resolver and this assertion changes with it."
    );
  });

  it("does not let a compat-shaped application borrow private access from another of the candidate's jobs", async () => {
    // Configured the way production is: `list_applications` is POLICY-driven, and the policy's
    // terminal is what declares the `jobs: [{ id }]` compatibility shape production has been observed
    // returning. That matters twice over — the default terminal carries no compatibility, so without
    // the policy this scenario cannot even arise, and a policy-driven tool never runs its row filter,
    // so the privacy decision here comes from the universal backstop. Both are the real path.
    //
    // The defect: scope resolved the compat shape through the terminal while the privacy gate read
    // `row.job_id` by hand. A compat-shaped row therefore looked jobless to the gate and fell through
    // to the candidate-wide fallback, which admits when ANY of the candidate's applications sits on a
    // private-capable job. This actor holds Private on job 1 only, and row 20 is on job 2.
    const applicationsPolicy = new Map([
      [
        "list_applications",
        {
          kind: "direct" as const,
          terminal: {
            field: "job_id",
            filter: "job_ids",
            compatibility: { kind: "single_nested_id" as const, field: "jobs", idField: "id" },
          },
        },
      ],
    ]);
    const raw = rawReader(withCandidatePrivacy((path, params) => {
      if (path === "/user_job_permissions") {
        return [
          { user_id: 100, job_id: 1, role_id: 77 },
          { user_id: 100, job_id: 2, role_id: 88 },
        ];
      }
      if (path === "/user_roles") {
        return [
          { id: 77, role_type: "job_admin", name: "Private" },
          { id: 88, role_type: "job_admin", name: "Standard" },
        ];
      }
      if (path === "/applications") {
        // The candidate-wide fallback reads by candidate_ids, and candidate 501 also has an
        // application on job 1 where the actor IS private-capable. That is the borrowed grant.
        if (params?.candidate_ids !== undefined) {
          return [
            { id: 10, job_id: 1, candidate_id: 501 },
            { id: 20, jobs: [{ id: 2 }], candidate_id: 501 },
          ];
        }
        // Both rows in the page, and row 10 is the POSITIVE CONTROL. Its presence in the expected
        // output is what proves private capability really resolved on job 1 — without it this test
        // would also pass against an actor who holds no private capability at all, which is a
        // different code path and the exact way a lock in this repo becomes a decoration.
        return [
          { id: 10, job_id: 1, candidate_id: 501 },
          { id: 20, jobs: [{ id: 2 }], candidate_id: 501 },
        ];
      }
      return [];
    }, new Set([501])));
    const scoped = createScopedGreenhouseReader({
      actorResolver: actorResolver(),
      permissionProvider: createHarvestPermissionProvider({ rawReader: raw }),
      rawReader: raw,
      scopePolicyRegistry: applicationsPolicy,
    });

    const result = await scoped.scopedRead(100, "list_applications", {});

    assert.deepStrictEqual(
      result.ok && (result.data as Record<string, unknown>[]).map((row) => row.id),
      [10],
      "row 10 is admitted on job 1, where this actor holds Private; the compat-shaped row 20 sits on " +
        "job 2 and must NOT borrow job 1's grant through the candidate-wide fallback. Its job has to " +
        "be resolved by the same resolver scope uses, not by a hand-rolled row.job_id read."
    );
  });

  it("resolves the private flag through the authorization reader, never the data reader", async () => {
    // In production `rawReader` is the short-TTL data cache while the private flag decides whether a
    // row is withheld. Caching an authorization input stacks a second, unaccounted staleness layer
    // on top of the permission TTL — which scoped-reader.ts forbids in writing for permission reads,
    // and then did anyway for this one.
    const data = rawReader((path) => {
      if (path === "/candidate_employments") return [{ id: 4, candidate_id: 501, company_name: "Acme" }];
      if (path === "/applications") return [{ id: 10, job_id: 1, candidate_id: 501 }];
      return [];
    });
    const authorization = rawReader(withCandidatePrivacy(() => [], new Set([501])));
    const scoped = createScopedGreenhouseReader({
      actorResolver: actorResolver(),
      permissionProvider: permissionProvider(new Map([[100, [1]]])),
      rawReader: data,
      authorizationReader: authorization,
    });

    const result = await scoped.scopedRead(100, "list_candidate_employments", {});

    assert.equal(
      data.calls.filter((call) => call.params?.fields === "id,private").length,
      0,
      "no privacy lookup may reach the cached data reader"
    );
    assert.ok(
      authorization.calls.some(
        (call) => call.path === "/candidates" && call.params?.fields === "id,private"
      ),
      "the privacy lookup goes to the uncached authorization reader"
    );
    assert.deepStrictEqual(
      result.ok && result.data,
      [],
      "and the verdict still withholds the private candidate's employment row"
    );
  });

  it("reports a privacy-withheld point get exactly as it reports an id that does not exist", async () => {
    // Both return data:null, so the row counts are the only thing left that could tell them apart —
    // and telling them apart confirms that a specific person exists and carries the restricted flag.
    const handler = (privateIds: ReadonlySet<number>) =>
      withCandidatePrivacy((path, params) => {
        if (path === "/applications") {
          return String(params?.ids ?? "") === "20"
            ? [{ id: 20, job_id: 1, candidate_id: 501 }]
            : [];
        }
        return [];
      }, privateIds);

    const scopedFor = (privateIds: ReadonlySet<number>) =>
      createScopedGreenhouseReader({
        actorResolver: actorResolver(),
        permissionProvider: permissionProvider(new Map([[100, [1]]])),
        rawReader: rawReader(handler(privateIds)),
      });

    const hidden = await scopedFor(new Set([501])).scopedRead(100, "get_application", { id: 20 });
    const missing = await scopedFor(new Set()).scopedRead(100, "get_application", { id: 99 });

    assert.equal(hidden.ok && hidden.data, null, "the private candidate's application is withheld");
    assert.equal(missing.ok && missing.data, null, "and id 99 does not exist");
    assert.deepStrictEqual(
      hidden.ok && hidden.rowCounts,
      missing.ok && missing.rowCounts,
      "raw:1/permissionExcluded:1 against raw:0/permissionExcluded:0 is a per-person existence " +
        "oracle for the restricted flag — the two must be indistinguishable"
    );
  });

  it("fails closed when candidate privacy cannot be established", async () => {
    const raw = rawReader((path, params) => {
      // A candidate row with no `private` field at all, and a candidate-backed row whose candidate
      // cannot be read. Neither may be treated as "not private".
      if (path === "/candidates" && params?.ids === undefined) return [{ id: 501, applications: [{ id: 10, job_id: 1 }] }];
      if (path === "/candidates") return [];
      if (path === "/candidate_employments") return [{ id: 4, candidate_id: 501, company_name: "Acme" }];
      if (path === "/applications") return [{ id: 10, candidate_id: 501, job_id: 1 }];
      return [];
    });
    const scoped = createScopedGreenhouseReader({
      actorResolver: actorResolver(),
      permissionProvider: permissionProvider(new Map([[100, [1]]])),
      rawReader: raw,
    });

    const candidates = await scoped.scopedRead(100, "list_candidates", {});
    const employments = await scoped.scopedRead(100, "list_candidate_employments", {});

    assert.deepStrictEqual(candidates.ok && candidates.data, [], "a candidate row without the flag is withheld");
    assert.deepStrictEqual(employments.ok && employments.data, [], "an unreadable candidate is treated as private");
  });
});

describe("default Harvest permission provider", () => {
  it("loads user job permissions with user_ids and extracts permitted job_id values", async () => {
    const raw = rawReader((path, params, cursor) => {
      assert.equal(path, "/user_job_permissions");
      if (!cursor) {
        assert.deepStrictEqual(params, { user_ids: "100", per_page: 500 });
        return response(
          [
            { id: 1, user_id: 100, job_id: 10, role_id: 2 },
            { id: 2, user_id: 999, job_id: 99, role_id: 2 },
          ],
          "next-page"
        );
      }
      assert.deepStrictEqual(params, {});
      assert.equal(cursor, "next-page");
      return [{ id: 3, user: { id: 100 }, job: { id: 20 }, role_id: 2 }];
    });
    const provider = createHarvestPermissionProvider({ rawReader: raw });

    const permitted = await provider.getPermittedJobIds(100);

    assert.deepStrictEqual([...(permitted as ReadonlySet<number>)], [10, 20]);
  });

  it("returns an all-access signal for explicit all-jobs role grants", async () => {
    const raw = rawReader((path, params) => {
      assert.equal(path, "/user_job_permissions");
      assert.deepStrictEqual(params, { user_ids: "100", per_page: 500 });
      return [
        {
          id: 1,
          user_id: 100,
          job_id: null,
          role: { name: "All Jobs" },
        },
      ];
    });
    const provider = createHarvestPermissionProvider({ rawReader: raw });

    const permitted = await provider.getPermittedJobIds(100);

    assert.deepStrictEqual(permitted, { kind: "all" });
  });

  it("does not grant all-access from an incidental phrase in a bare top-level name/description", async () => {
    const raw = rawReader((path) => {
      assert.equal(path, "/user_job_permissions");
      return [
        { id: 1, user_id: 100, job_id: null, name: "All Jobs Weekly Report", description: "covers site admin escalations" },
      ];
    });
    const provider = createHarvestPermissionProvider({ rawReader: raw });

    const permitted = await provider.getPermittedJobIds(100);

    assert.notDeepStrictEqual(permitted, { kind: "all" }, "an incidental all-jobs/site-admin phrase on an unscoped permission row must not grant org-wide access");
    assert.deepStrictEqual([...(permitted as ReadonlySet<number>)], []);
  });

  it("does not infer all-access from missing or unknown permission rows", async () => {
    const raw = rawReader(() => [
      { id: 1, user_id: 100, role_id: 2 },
    ]);
    const provider = createHarvestPermissionProvider({ rawReader: raw });

    const permitted = await provider.getPermittedJobIds(100);

    assert.deepStrictEqual([...(permitted as ReadonlySet<number>)], []);
  });

  it("parses actor allowlists with the existing positive-integer allowlist idiom", () => {
    const parsed = parseActorIdAllowlist("1, 2, nope, -3, 4");
    assert.deepStrictEqual([...parsed], [1, 2, 4]);
  });
});
