import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_FILTER_REGISTRY, createScopedGreenhouseReader, type ApiResponse, type RawReadClient } from "../../scoped-core/src/index.js";
import { HARVEST_CONTRACT_AVAILABLE, assertContractParams, assertContractRow, endpointContract } from "./support/harvest-contract.js";

/**
 * A quasi-Greenhouse: a fake whose row shapes and query parameters are checked against the VENDORED
 * OpenAPI contract rather than against my own memory of it.
 *
 * Every other fake in this suite is hand-written, which means each row shape is one somebody chose.
 * That is precisely how a green suite ships a shape bug — the code and the fixture agree with each
 * other and both disagree with Greenhouse, which is the failure this repo has already had once
 * (`greenhouse-mcp-projection-defects`: silent nulls from wrong field names that shape-only tests
 * could not see). Here the contract is the referee:
 *
 *   - a row carrying a field the endpoint does not define FAILS (invented shape),
 *   - a defined field with the wrong type FAILS,
 *   - a query parameter the endpoint does not document FAILS (a filter Greenhouse would ignore,
 *     which does not narrow a read — it silently widens it).
 *
 * What it cannot do is tell us what is IN the tenant. Whether the tenant has confidential jobs, or
 * custom private-capable roles, or a private candidate on a scoped recruiter's reqs, are facts about
 * data, and only the live probe answers those. This closes the shape half of the gap.
 */

const ACTOR = 100;

interface FakeTenant {
  [path: string]: Record<string, unknown>[];
}

/** A raw reader that refuses to return, or be asked for, anything the contract does not allow. */
function contractCheckedReader(tenant: FakeTenant): RawReadClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async read<T = unknown>(path: string, params?: Record<string, unknown>): Promise<ApiResponse<T>> {
      calls.push(path);
      const defined = Object.fromEntries(
        Object.entries(params ?? {}).filter(([, value]) => value !== undefined)
      );
      assertContractParams(path, defined);

      const rows = (tenant[path] ?? []).filter((row) => matchesFilters(row, defined));
      for (const row of rows) assertContractRow(path, row, `tenant fixture for ${path}`);
      return { data: rows as T, nextCursor: null };
    },
  };
}

/** Honour the documented id/parent filters the reader actually sends. */
function matchesFilters(row: Record<string, unknown>, params: Record<string, unknown>): boolean {
  const idList = (value: unknown) => String(value).split(",").map((entry) => Number(entry.trim()));
  if (params.ids !== undefined && !idList(params.ids).includes(Number(row.id))) return false;
  if (params.candidate_ids !== undefined && !idList(params.candidate_ids).includes(Number(row.candidate_id))) return false;
  if (params.application_ids !== undefined && !idList(params.application_ids).includes(Number(row.application_id))) return false;
  if (params.job_ids !== undefined && !idList(params.job_ids).includes(Number(row.job_id))) return false;
  if (params.user_ids !== undefined && !idList(params.user_ids).includes(Number(row.user_id))) return false;
  if (params.confidential !== undefined && row.confidential !== (params.confidential === true || params.confidential === "true")) return false;
  return true;
}

/**
 * One tenant, shaped like the case that matters: a recruiter permitted on job 1 and job 2, a
 * private candidate on each, and the Private Job Admin role held on job 1 only.
 */
function privacyTenant(): FakeTenant {
  return {
    "/user_job_permissions": [
      { id: 1, user_id: ACTOR, job_id: 1, role_id: 77 },
      { id: 2, user_id: ACTOR, job_id: 2, role_id: 88 },
    ],
    "/user_roles": [
      { id: 77, role_type: "job_admin", name: "Private" },
      { id: 88, role_type: "job_admin", name: "Standard" },
    ],
    "/applications": [
      { id: 10, job_id: 1, candidate_id: 501 },
      { id: 20, job_id: 2, candidate_id: 502 },
      { id: 30, job_id: 3, candidate_id: 503 },
    ],
    "/candidates": [
      { id: 501, private: true },
      { id: 502, private: true },
      { id: 503, private: false },
    ],
    "/offers": [
      { id: 71, job_id: 1, application_id: 10, candidate_id: 501 },
      { id: 72, job_id: 2, application_id: 20, candidate_id: 502 },
    ],
    "/application_stages": [
      { id: 41, application_id: 10 },
      { id: 42, application_id: 20 },
    ],
    "/rejection_details": [
      { id: 51, application_id: 10 },
      { id: 52, application_id: 20 },
    ],
  };
}

function readerFor(tenant: FakeTenant) {
  const raw = contractCheckedReader(tenant);
  const scoped = createScopedGreenhouseReader({
    actorResolver: { resolveActor: (id: number) => id },
    permissionProvider: {
      async getPermittedJobIds(userId: number) {
        // Deliberately the REAL provider path is exercised elsewhere; here the scope is derived from
        // the same permission rows so the tenant stays the single source of truth.
        const jobs = new Set(
          (tenant["/user_job_permissions"] ?? [])
            .filter((row) => row.user_id === userId)
            .map((row) => Number(row.job_id))
        );
        const privateRoleIds = new Set(
          (tenant["/user_roles"] ?? [])
            .filter((row) => row.role_type === "job_admin" && String(row.name).toLowerCase() === "private")
            .map((row) => Number(row.id))
        );
        const privateCapableJobIds = new Set(
          (tenant["/user_job_permissions"] ?? [])
            .filter((row) => row.user_id === userId && privateRoleIds.has(Number(row.role_id)))
            .map((row) => Number(row.job_id))
        );
        return { kind: "jobs" as const, jobIds: jobs, privateCapableJobIds };
      },
    },
    rawReader: raw,
  });
  return { raw, scoped };
}

const ids = (result: unknown) => {
  const data = (result as { ok: boolean; data?: unknown }).data;
  return (Array.isArray(data) ? data : data ? [data] : []).map((row) => (row as { id: number }).id);
};

describe("scoped reads against a contract-checked quasi-Greenhouse", { skip: HARVEST_CONTRACT_AVAILABLE ? false : "docs/harvest-v3-api mirror not vendored in this repository — provide a local mirror to run the contract-checked suite" }, () => {
  it("gates private candidates exactly where Greenhouse would, on shapes the contract vouches for", async () => {
    const { scoped } = readerFor(privacyTenant());

    // Candidate 501 is private on job 1, where the actor holds the Private role: visible.
    // Candidate 502 is private on job 2, where they do not: withheld.
    // Candidate 503 is on job 3, outside scope entirely: withheld by job scope, not privacy.
    assert.deepEqual(ids(await scoped.scopedRead(ACTOR, "list_applications", {})), [10]);
    assert.deepEqual(ids(await scoped.scopedRead(ACTOR, "list_offers", {})), [71]);
    assert.deepEqual(ids(await scoped.scopedRead(ACTOR, "list_application_stages", {})), [41]);
    assert.deepEqual(ids(await scoped.scopedRead(ACTOR, "list_rejection_details", {})), [51]);
  });

  it("sends only query parameters Greenhouse documents", async () => {
    // An undocumented filter is not a narrower read — Greenhouse ignores it and returns everything,
    // so the scope filter then works over a WIDER set than the caller believes. The fake throws on
    // any such parameter, so this passing is the assertion.
    const { scoped, raw } = readerFor(privacyTenant());

    for (const tool of ["list_applications", "list_offers", "list_application_stages", "list_candidates"]) {
      const result = await scoped.scopedRead(ACTOR, tool, {});
      assert.equal((result as { ok: boolean }).ok, true, `${tool} should not deny`);
    }
    assert.ok(raw.calls.length > 0);
  });

  it("proves the fake would reject the shape bug a hand-written fixture hides", () => {
    // The guard rail itself. `/v3/application_stages` carries application_id and no candidate_id —
    // a fixture that seeds one looks plausible and proves nothing, because the code never reads it.
    assert.throws(
      () => assertContractRow("/application_stages", { id: 1, application_id: 10, candidate_id: 501 }),
      /has no field "candidate_id"/
    );
    // And the field the privacy gate genuinely depends on IS on applications, which is why the gate
    // can resolve a candidate from an application row at all.
    assert.ok("candidate_id" in endpointContract("/applications").properties);
    assert.ok("private" in endpointContract("/candidates").properties);
    assert.ok("confidential" in endpointContract("/jobs").properties);
    assert.ok("role_id" in endpointContract("/user_job_permissions").properties);
  });

  it("sends no undocumented query parameter on ANY registered tool", async () => {
    // Swept across the whole catalog rather than the handful this file exercises by name. An
    // undocumented filter is the dangerous direction of wrong: Greenhouse ignores it and answers
    // with everything, so the reader scopes a wider set than it believes it asked for.
    const violations: string[] = [];
    const paths = new Set<string>();
    // Rows must come BACK, or the follow-on reads never happen: the privacy batch, the application
    // and candidate joins, and the parent hops all only run when there is a row to scope. A sweep
    // over an empty tenant would exercise the first request of each tool and nothing after it —
    // which is how the earlier version of this test passed against an injected bad parameter.
    const rowsFor = (path: string): Record<string, unknown>[] => {
      switch (path) {
        case "/applications": return [{ id: 10, job_id: 1, candidate_id: 501 }];
        case "/candidates": return [{ id: 501, private: false }];
        case "/interviews": return [{ id: 61, application_id: 10, job_id: 1 }];
        case "/scorecards": return [{ id: 41, application_id: 10 }];
        case "/scorecard_question_answers": return [{ id: 81, scorecard_id: 41 }];
        case "/interview_kits": return [{ id: 91, job_id: 1 }];
        case "/job_posts": return [{ id: 21, job_id: 1 }];
        case "/approval_flows": return [{ id: 31, job_id: 1 }];
        case "/approver_groups": return [{ id: 32, approval_flow_id: 31 }];
        case "/prospect_pools": return [{ id: 51 }];
        case "/scorecard_questions": return [{ id: 71, interview_kit_id: 91 }];
        case "/scorecard_question_answer_options": return [{ id: 101, scorecard_question_answer_id: 81 }];
        case "/application_stages": return [{ id: 111, application_id: 10, job_interview_stage_id: 7 }];
        default: {
          // job_id is the common scoping key, but only where the contract defines it — the checker
          // caught this fallback inventing it on /application_stages, which carries application_id.
          const row: Record<string, unknown> = { id: 1 };
          if ("job_id" in endpointContract(path).properties) row.job_id = 1;
          return [row];
        }
      }
    };
    const raw: RawReadClient = {
      async read<T = unknown>(path: string, params?: Record<string, unknown>): Promise<ApiResponse<T>> {
        paths.add(path);
        const defined = Object.fromEntries(
          Object.entries(params ?? {}).filter(([, value]) => value !== undefined)
        );
        try {
          assertContractParams(path, defined);
        } catch (error) {
          violations.push((error as Error).message.split("\n")[0]!);
        }
        const rows = rowsFor(path);
        // The rows are themselves contract-checked, so this sweep cannot pass by feeding the reader
        // a shape Greenhouse would never produce.
        for (const row of rows) assertContractRow(path, row, `sweep fixture for ${path}`);
        return { data: rows as T, nextCursor: null };
      },
    };
    const scoped = createScopedGreenhouseReader({
      actorResolver: { resolveActor: (id: number) => id },
      permissionProvider: { async getPermittedJobIds() { return new Set([1]); } },
      rawReader: raw,
    });

    for (const tool of DEFAULT_FILTER_REGISTRY.keys()) {
      await scoped.scopedRead(ACTOR, tool, tool.startsWith("get_") ? { id: 1 } : {});
    }

    assert.deepEqual([...new Set(violations)], []);
    // The join hops must actually have been reached, or the sweep proved far less than it appears.
    for (const joined of ["/candidates", "/applications", "/scorecards"]) {
      assert.ok(paths.has(joined), `the sweep never reached ${joined}, so it did not cover the joins`);
    }
  });

  it("records the live-vs-vendored drift measured against the real tenant", () => {
    // Both entries below were MEASURED on 2026-07-27, not assumed, and both were false positives in
    // this referee before they were recorded — it would have rejected a row Greenhouse really
    // returns and a parameter our own reader correctly sends.
    const applications = endpointContract("/applications");

    // (1) Live application rows carry job_interview_stage_id; the vendored schema does not declare
    // it and is additionalProperties:false.
    assert.ok(
      "job_interview_stage_id" in applications.properties,
      "the live application row shape must be accepted, or the referee rejects real data"
    );

    // (2) job_interview_stage_ids works live and is undocumented. It also MATTERS: the documented
    // `stage_ids` filters on the application's own `stage_id`, which is unique per application, so
    // passing a job-interview-stage id to it returns zero rows and NO error. Measured on job
    // 5059946004: stage_ids=11925559004 -> 0 rows; job_interview_stage_ids=11925559004 -> 100 rows.
    // A stage bucket selected with the documented filter is silently empty.
    assert.ok(
      applications.queryParams.has("job_interview_stage_ids"),
      "the only correct stage-bucket filter must be accepted"
    );
    assert.ok(
      applications.queryParams.has("stage_ids"),
      "stage_ids is real too — it just means something else, and that is the trap"
    );
  });

  it("keeps a permitted non-private candidate readable — the over-withhold check", async () => {
    // A gate that withholds everything also passes every "is it withheld?" test. This is the other
    // direction: an ordinary candidate on a permitted job must survive untouched.
    const tenant = privacyTenant();
    tenant["/candidates"] = [
      { id: 501, private: false },
      { id: 502, private: true },
      { id: 503, private: false },
    ];
    const { scoped } = readerFor(tenant);

    assert.deepEqual(
      ids(await scoped.scopedRead(ACTOR, "list_applications", {})),
      [10],
      "candidate 501 is not private and sits on a permitted job"
    );
  });
});
