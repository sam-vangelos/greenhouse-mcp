import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createScopedGreenhouseReader,
  DEFAULT_FILTER_REGISTRY,
  type ApiResponse,
  type RawReadClient,
  type ReadParams,
} from "../../scoped-core/src/index.js";
import { getEvidenceEndpointAdapter, SCOPED_TOOL_SCOPE_POLICIES } from "../src/tools/scoped-endpoint-adapters.js";

/**
 * The registrations week two added, locked by IDENTITY rather than by presence.
 *
 * The test-honesty pass found the shape of the hole: `assert.ok(DEFAULT_FILTER_REGISTRY.has(name))`
 * and `deepEqual(dep.targetEndpoint, ...)` both pass while the registration is scoped by something
 * else entirely — rebinding `list_user_job_permissions` to the UNSCOPED global-reference reader (an
 * org-wide map of who can see every req) passed 1,625 + 218 tests, and pointing a join at a real
 * field that reaches no job passed too. So each new reader is pinned to the exact filter it must run
 * and the exact chain it must walk, and the row-filtered ones are then run through a REAL scoped
 * reader on a job the actor does not hold.
 */

interface RegistrationLock {
  tool: string;
  scopedTool: string;
  /**
   * The registration whose row filter this one must BE. Filter identity, not filter presence: the
   * filters are module-private, so the lock names a canonical reader that runs the same one — if a
   * registration is rebound to a different (or absent) filter, this fails.
   */
  sameFilterAs: string | null;
  /** True when scoping runs through the executable policy graph instead of a row filter. */
  policyDriven: boolean;
  dependencies: Array<Record<string, string>>;
}

const SCOPE = (field: string, sourceFilter: string, targetEndpoint: string, targetField = "id", targetFilter = "ids") =>
  ({ field, sourceFilter, targetEndpoint, targetField, targetFilter, purpose: "scope" });

const REGISTRATION_LOCKS: RegistrationLock[] = [
  {
    tool: "search_my_job_post_searchable_locations",
    scopedTool: "list_job_post_searchable_locations",
    sameFilterAs: null,
    policyDriven: true,
    dependencies: [SCOPE("job_post_id", "job_post_ids", "/v3/job_posts")],
  },
  {
    tool: "search_my_applied_candidate_tags",
    scopedTool: "list_applied_candidate_tags",
    sameFilterAs: "list_candidate_educations",
    policyDriven: false,
    dependencies: [SCOPE("candidate_id", "candidate_ids", "/v3/applications", "candidate_id", "candidate_ids")],
  },
  { tool: "search_my_user_roles", scopedTool: "list_user_roles", sameFilterAs: null, policyDriven: false, dependencies: [] },
  { tool: "search_my_email_templates", scopedTool: "list_email_templates", sameFilterAs: null, policyDriven: false, dependencies: [] },
  {
    tool: "search_my_user_job_permissions",
    scopedTool: "list_user_job_permissions",
    // The direct job-scoped filter every job-scoped reader runs. Anything else here — a global
    // reference reader above all — publishes who can see every requisition in the org.
    sameFilterAs: "list_job_owners",
    policyDriven: false,
    dependencies: [],
  },
  { tool: "search_my_future_job_permissions", scopedTool: "list_future_job_permissions", sameFilterAs: null, policyDriven: false, dependencies: [] },
  {
    tool: "search_my_scorecard_candidate_attributes",
    scopedTool: "list_scorecard_candidate_attributes",
    sameFilterAs: "list_scorecard_question_answers",
    policyDriven: false,
    dependencies: [],
  },
  { tool: "search_my_job_candidate_attributes", scopedTool: "list_job_candidate_attributes", sameFilterAs: "list_job_owners", policyDriven: false, dependencies: [] },
  { tool: "search_my_candidate_attribute_types", scopedTool: "list_candidate_attribute_types", sameFilterAs: "list_job_owners", policyDriven: false, dependencies: [] },
  {
    tool: "search_my_focus_candidate_attributes",
    scopedTool: "list_focus_candidate_attributes",
    sameFilterAs: null,
    policyDriven: true,
    // job_candidate_attribute_id is a real field on this row and reaches NO job; the chain that does
    // is the interview kit's. A deepEqual on targetEndpoint alone accepted the wrong one.
    dependencies: [SCOPE("interview_kit_id", "interview_kit_ids", "/v3/interview_kits")],
  },
  {
    tool: "search_my_scorecard_question_candidate_attributes",
    scopedTool: "list_scorecard_question_candidate_attributes",
    sameFilterAs: null,
    policyDriven: true,
    dependencies: [
      SCOPE("scorecard_question_id", "scorecard_question_ids", "/v3/scorecard_questions"),
      SCOPE("interview_kit_id", "interview_kit_ids", "/v3/interview_kits"),
    ],
  },
  { tool: "search_my_user_emails", scopedTool: "list_user_emails", sameFilterAs: null, policyDriven: false, dependencies: [] },
  { tool: "search_my_bulk_requests", scopedTool: "list_bulk_requests", sameFilterAs: null, policyDriven: false, dependencies: [] },
  { tool: "search_my_blocked_spam_sources", scopedTool: "list_blocked_spam_sources", sameFilterAs: null, policyDriven: false, dependencies: [] },
  { tool: "search_my_job_board_custom_locations", scopedTool: "list_job_board_custom_locations", sameFilterAs: null, policyDriven: false, dependencies: [] },
  { tool: "get_my_bulk_request", scopedTool: "get_bulk_request", sameFilterAs: null, policyDriven: false, dependencies: [] },
];

describe("week-two registrations are pinned to the filter and the chain they must run", () => {
  for (const lock of REGISTRATION_LOCKS) {
    it(`${lock.tool} runs the exact scoping it was registered with`, () => {
      const adapter = getEvidenceEndpointAdapter(lock.tool);
      assert.ok(adapter, "adapter");
      assert.equal(adapter.scopedToolName, lock.scopedTool);

      const registration = DEFAULT_FILTER_REGISTRY.get(lock.scopedTool);
      assert.ok(registration, "scoped-core registration");

      if (lock.sameFilterAs === null) {
        assert.equal(registration.rowFilter, undefined, `${lock.tool} must have no row filter`);
      } else {
        const canonical = DEFAULT_FILTER_REGISTRY.get(lock.sameFilterAs);
        assert.ok(canonical?.rowFilter, `${lock.sameFilterAs} is the canonical registration for this filter`);
        assert.equal(
          registration.rowFilter,
          canonical.rowFilter,
          `${lock.tool} must run the SAME row filter as ${lock.sameFilterAs}, not merely have one`
        );
      }

      assert.equal(SCOPED_TOOL_SCOPE_POLICIES.has(lock.scopedTool), lock.policyDriven);
      // The WHOLE dependency, not just its target: a join that names a real field reaching no job
      // passes a targetEndpoint-only comparison.
      assert.deepEqual(adapter.joinDependencies, lock.dependencies);
    });
  }
});

// ---------------------------------------------------------------------------
// The row-filtered half, through a REAL scoped reader rather than a fake one
// ---------------------------------------------------------------------------

interface DirectScopeCase {
  scopedTool: string;
  path: string;
  permittedRow: Record<string, unknown>;
  forbiddenRow: Record<string, unknown>;
}

const DIRECT_SCOPE_CASES: DirectScopeCase[] = [
  {
    scopedTool: "list_user_job_permissions",
    path: "/user_job_permissions",
    permittedRow: { id: 1, job_id: 1, user_id: 77, role_id: 4 },
    forbiddenRow: { id: 2, job_id: 2, user_id: 78, role_id: 4 },
  },
  {
    scopedTool: "list_job_candidate_attributes",
    path: "/job_candidate_attributes",
    permittedRow: { id: 10, job_id: 1, name: "Systems depth" },
    forbiddenRow: { id: 11, job_id: 2, name: "Systems depth" },
  },
  {
    scopedTool: "list_candidate_attribute_types",
    path: "/candidate_attribute_types",
    permittedRow: { id: 20, job_id: 1, name: "Technical" },
    forbiddenRow: { id: 21, job_id: 2, name: "Technical" },
  },
];

describe("a week-two row-filtered reader excludes a job the actor does not hold", () => {
  for (const testCase of DIRECT_SCOPE_CASES) {
    it(`${testCase.scopedTool} keeps job A and excludes job B`, async () => {
      const calls: Array<{ path: string; params?: ReadParams }> = [];
      const raw: RawReadClient = {
        async read<T>(path: string, params?: ReadParams): Promise<ApiResponse<T>> {
          calls.push({ path, params });
          if (path === testCase.path) return { data: [testCase.permittedRow, testCase.forbiddenRow] as T, nextCursor: null };
          return { data: [] as T, nextCursor: null };
        },
      };
      const scoped = createScopedGreenhouseReader({
        actorResolver: { resolveActor: () => 100 },
        permissionProvider: { getPermittedJobIds: async () => new Set([1]) },
        rawReader: raw,
      });

      const result = await scoped.scopedRead(100, testCase.scopedTool, {});

      assert.equal(result.ok, true);
      assert.deepEqual(result.ok && result.data, [testCase.permittedRow]);
      assert.equal(result.ok && result.rowCounts.permissionExcluded, 1, "the other job's row is excluded, not merely absent");
      assert.equal(result.ok && result.rowCounts.raw, 2);
      assert.equal(calls[0]?.path, testCase.path);
    });
  }

  it("a candidate-backed week-two reader reaches its job through the candidate's applications", async () => {
    const raw: RawReadClient = {
      async read<T>(path: string, params?: ReadParams): Promise<ApiResponse<T>> {
        if (path === "/applied_candidate_tags") {
          return { data: [
            { id: 1, candidate_id: 501, candidate_tag_id: 8 },
            { id: 2, candidate_id: 502, candidate_tag_id: 8 },
          ] as T, nextCursor: null };
        }
        if (path === "/applications") {
          return { data: [
            { id: 1000, job_id: 1, candidate_id: 501 },
            { id: 2000, job_id: 2, candidate_id: 502 },
          ] as T, nextCursor: null };
        }
        if (path === "/candidates") return { data: [{ id: 501, private: false }] as T, nextCursor: null };
        return { data: [] as T, nextCursor: null };
      },
    };
    const scoped = createScopedGreenhouseReader({
      actorResolver: { resolveActor: () => 100 },
      permissionProvider: { getPermittedJobIds: async () => new Set([1]) },
      rawReader: raw,
    });

    const result = await scoped.scopedRead(100, "list_applied_candidate_tags", {});

    assert.equal(result.ok, true);
    assert.deepEqual(result.ok && result.data, [{ id: 1, candidate_id: 501, candidate_tag_id: 8 }]);
    assert.equal(result.ok && result.rowCounts.permissionExcluded, 1);
  });
});
