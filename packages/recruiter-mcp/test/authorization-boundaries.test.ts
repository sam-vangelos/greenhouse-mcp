import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createScopedGreenhouseReader,
  type ApiResponse,
  type RawReadClient,
  type ReadParams,
} from "../../scoped-core/src/index.js";
import { SCOPED_TOOL_SCOPE_POLICIES } from "../src/tools/scoped-endpoint-adapters.js";

type Row = Record<string, unknown>;

interface BoundaryCase {
  name: string;
  toolName: string;
  sourcePath: string;
  sourceRows: Row[];
  parentRows: Record<string, Row[]>;
  expectedRows: Row[];
  expectedParentPaths: string[];
}

interface RawCall {
  path: string;
  params?: ReadParams;
  cursor?: string;
}

function response<T>(data: T, nextCursor: string | null = null): ApiResponse<T> {
  return { data, nextCursor };
}

function fixtureReader(testCase: BoundaryCase): RawReadClient & { calls: RawCall[] } {
  const calls: RawCall[] = [];
  return {
    calls,
    async read<T>(path: string, params?: ReadParams, cursor?: string): Promise<ApiResponse<T>> {
      calls.push({ path, params, cursor });
      if (path === testCase.sourcePath) return response(testCase.sourceRows as T);
      const rows = testCase.parentRows[path];
      assert.ok(rows, `${testCase.name}: unexpected parent read ${path}`);
      assert.equal(cursor, undefined);
      assert.equal(typeof params?.ids, "string", `${testCase.name}: parent reads must be ID-bounded`);
      assert.equal(params?.per_page, 500);
      return response(rows as T);
    },
  };
}

function scopedReader(rawReader: RawReadClient, toolName: string) {
  const policy = SCOPED_TOOL_SCOPE_POLICIES.get(toolName);
  assert.ok(policy, `${toolName} must have an executable authorization policy`);
  return createScopedGreenhouseReader({
    actorResolver: { resolveActor: () => 100 },
    permissionProvider: { getPermittedJobIds: async () => new Set([1]) },
    rawReader,
    scopePolicyRegistry: new Map([[toolName, policy]]),
  });
}

const BOUNDARY_CASES: BoundaryCase[] = [
  {
    name: "approvers",
    toolName: "list_approvers",
    sourcePath: "/approvers",
    sourceRows: [
      { id: 1, approver_group_id: 10, user_id: 501 },
      { id: 2, approver_group_id: 20, user_id: 502 },
    ],
    parentRows: {
      "/approver_groups": [
        { id: 10, approval_flow_id: 100 },
        { id: 20, approval_flow_id: 200 },
      ],
      "/approval_flows": [
        { id: 100, job_id: 1 },
        { id: 200, job_id: 2 },
      ],
    },
    expectedRows: [{ id: 1, approver_group_id: 10, user_id: 501 }],
    expectedParentPaths: ["/approver_groups", "/approval_flows"],
  },
  {
    name: "approver groups",
    toolName: "list_approver_groups",
    sourcePath: "/approver_groups",
    sourceRows: [
      { id: 10, approval_flow_id: 100 },
      { id: 20, approval_flow_id: 200 },
    ],
    parentRows: {
      "/approval_flows": [
        { id: 100, job_id: 1 },
        { id: 200, job_id: 2 },
      ],
    },
    expectedRows: [{ id: 10, approval_flow_id: 100 }],
    expectedParentPaths: ["/approval_flows"],
  },
  {
    name: "scorecard questions",
    toolName: "list_scorecard_questions",
    sourcePath: "/scorecard_questions",
    sourceRows: [
      { id: 1, interview_kit_id: 10, text: "Permitted" },
      { id: 2, interview_kit_id: 20, text: "Forbidden" },
    ],
    parentRows: {
      "/interview_kits": [
        { id: 10, job_id: 1 },
        { id: 20, job_id: 2 },
      ],
    },
    expectedRows: [{ id: 1, interview_kit_id: 10, text: "Permitted" }],
    expectedParentPaths: ["/interview_kits"],
  },
  {
    name: "scorecard question options",
    toolName: "list_scorecard_question_options",
    sourcePath: "/scorecard_question_options",
    sourceRows: [
      { id: 1, scorecard_question_id: 10, text: "Permitted" },
      { id: 2, scorecard_question_id: 20, text: "Forbidden" },
    ],
    parentRows: {
      "/scorecard_questions": [
        { id: 10, interview_kit_id: 100 },
        { id: 20, interview_kit_id: 200 },
      ],
      "/interview_kits": [
        { id: 100, job_id: 1 },
        { id: 200, job_id: 2 },
      ],
    },
    expectedRows: [{ id: 1, scorecard_question_id: 10, text: "Permitted" }],
    expectedParentPaths: ["/scorecard_questions", "/interview_kits"],
  },
  {
    name: "scorecard answer options",
    toolName: "list_scorecard_question_answer_options",
    sourcePath: "/scorecard_question_answer_options",
    sourceRows: [
      { id: 1, scorecard_question_answer_id: 10, text: "Permitted" },
      { id: 2, scorecard_question_answer_id: 20, text: "Forbidden" },
    ],
    parentRows: {
      "/scorecard_question_answers": [
        { id: 10, scorecard_id: 100 },
        { id: 20, scorecard_id: 200 },
      ],
      "/scorecards": [
        { id: 100, application_id: 1_000 },
        { id: 200, application_id: 2_000 },
      ],
      "/applications": [
        { id: 1_000, jobs: [{ id: 1 }] },
        { id: 2_000, jobs: [{ id: 2 }] },
      ],
    },
    expectedRows: [{ id: 1, scorecard_question_answer_id: 10, text: "Permitted" }],
    expectedParentPaths: ["/scorecard_question_answers", "/scorecards", "/applications"],
  },
  {
    name: "default interviewers",
    toolName: "list_default_interviewers",
    sourcePath: "/default_interviewers",
    sourceRows: [
      { id: 1, interview_kit_id: 10, user_id: 501 },
      { id: 2, interview_kit_id: 20, user_id: 502 },
    ],
    parentRows: {
      "/interview_kits": [
        { id: 10, job_id: 1 },
        { id: 20, job_id: 2 },
      ],
    },
    expectedRows: [{ id: 1, interview_kit_id: 10, user_id: 501 }],
    expectedParentPaths: ["/interview_kits"],
  },
  {
    name: "job-post locations",
    toolName: "list_job_post_locations",
    sourcePath: "/job_post_locations",
    sourceRows: [
      { id: 1, job_post_id: 10, name: "Permitted" },
      { id: 2, job_post_id: 20, name: "Forbidden" },
    ],
    parentRows: {
      "/job_posts": [
        { id: 10, job_id: 1 },
        { id: 20, job_id: 2 },
      ],
    },
    expectedRows: [{ id: 1, job_post_id: 10, name: "Permitted" }],
    expectedParentPaths: ["/job_posts"],
  },
  {
    name: "pay ranges",
    toolName: "list_pay_input_ranges",
    sourcePath: "/pay_input_ranges",
    sourceRows: [
      { id: 1, job_post_id: 10, min_cents: 100 },
      { id: 2, job_post_id: 20, min_cents: 200 },
    ],
    parentRows: {
      "/job_posts": [
        { id: 10, job_id: 1 },
        { id: 20, job_id: 2 },
      ],
    },
    expectedRows: [{ id: 1, job_post_id: 10, min_cents: 100 }],
    expectedParentPaths: ["/job_posts"],
  },
  {
    name: "prospect-pool stages",
    toolName: "list_prospect_pool_stages",
    sourcePath: "/prospect_pool_stages",
    sourceRows: [
      { id: 1, prospect_pool_id: 10, name: "Permitted" },
      { id: 2, prospect_pool_id: 20, name: "Forbidden" },
    ],
    parentRows: {
      "/prospect_pools": [
        { id: 10, job_ids: [1] },
        { id: 20, job_ids: [2] },
      ],
    },
    expectedRows: [{ id: 1, prospect_pool_id: 10, name: "Permitted" }],
    expectedParentPaths: ["/prospect_pools"],
  },
  {
    name: "mixed prospect pools",
    toolName: "list_prospect_pools",
    sourcePath: "/prospect_pools",
    sourceRows: [
      { id: 1, name: "Mixed", job_ids: [2, 1] },
      { id: 2, name: "Forbidden", job_ids: [2] },
    ],
    parentRows: {},
    expectedRows: [{ id: 1, name: "Mixed", job_ids: [1] }],
    expectedParentPaths: [],
  },
];

describe("join-backed authorization boundary matrix", () => {
  for (const testCase of BOUNDARY_CASES) {
    it(`keeps job A and excludes job B for ${testCase.name}`, async () => {
      const raw = fixtureReader(testCase);
      const result = await scopedReader(raw, testCase.toolName).scopedRead(100, testCase.toolName, {});

      assert.equal(result.ok, true);
      assert.deepStrictEqual(result.ok && result.data, testCase.expectedRows);
      assert.deepStrictEqual(result.ok && result.rowCounts, {
        raw: 2,
        returned: 1,
        permissionExcluded: 1,
        unresolved: 0,
        status: "complete",
      });
      assert.deepStrictEqual(
        raw.calls.slice(1).map((call) => call.path),
        testCase.expectedParentPaths
      );
    });
  }

  for (const [name, parentRows] of [
    ["missing", []],
    ["malformed", [{ id: 999, title: "parent has no job_id" }]],
  ] as const) {
    it(`marks a ${name} parent incomplete rather than returning a complete clean zero`, async () => {
      const testCase: BoundaryCase = {
        name: `${name} parent`,
        toolName: "list_job_post_locations",
        sourcePath: "/job_post_locations",
        sourceRows: [{ id: 1, job_post_id: 999 }],
        parentRows: { "/job_posts": [...parentRows] },
        expectedRows: [],
        expectedParentPaths: ["/job_posts"],
      };
      const result = await scopedReader(fixtureReader(testCase), testCase.toolName)
        .scopedRead(100, testCase.toolName, {});

      assert.equal(result.ok, true);
      assert.deepStrictEqual(result.ok && result.data, []);
      assert.equal(result.ok && result.rowCounts.raw, 1);
      assert.equal(result.ok && result.rowCounts.returned, 0);
      assert.equal(result.ok && result.rowCounts.unresolved, 1);
      assert.equal(result.ok && result.rowCounts.status, "incomplete_scope_resolution");
    });
  }

  it("fails closed when Greenhouse rejects a registered parent filter", async () => {
    const raw: RawReadClient = {
      async read<T>(path: string): Promise<ApiResponse<T>> {
        if (path === "/job_post_locations") {
          return response([{ id: 1, job_post_id: 10 }] as T);
        }
        const error = new Error("Greenhouse API error: 422 unsupported filter ids");
        error.name = "UnsupportedFilterError";
        throw error;
      },
    };
    const result = await scopedReader(raw, "list_job_post_locations")
      .scopedRead(100, "list_job_post_locations", {});

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.denial.code, "PERMISSION_JOIN_FAILED");
  });

  it("follows parent pagination completely before deciding the A/B boundary", async () => {
    const calls: RawCall[] = [];
    const raw: RawReadClient = {
      async read<T>(path: string, params?: ReadParams, cursor?: string): Promise<ApiResponse<T>> {
        calls.push({ path, params, cursor });
        if (path === "/job_post_locations") {
          return response([
            { id: 1, job_post_id: 10 },
            { id: 2, job_post_id: 20 },
          ] as T);
        }
        assert.equal(path, "/job_posts");
        return cursor === "parent-page-2"
          ? response([{ id: 10, job_id: 1 }] as T)
          : response([{ id: 20, job_id: 2 }] as T, "parent-page-2");
      },
    };
    const result = await scopedReader(raw, "list_job_post_locations")
      .scopedRead(100, "list_job_post_locations", {});

    assert.deepStrictEqual(result.ok && result.data, [{ id: 1, job_post_id: 10 }]);
    assert.deepStrictEqual(calls.slice(1).map((call) => call.cursor), [undefined, "parent-page-2"]);
  });

  for (const fault of ["429", "timeout"] as const) {
    for (const page of ["first", "later"] as const) {
      it(`${page === "first" ? "denies" : "returns an honest partial"} on a ${fault} from the ${page} parent page`, async () => {
        let parentPage = 0;
        const raw: RawReadClient = {
          async read<T>(path: string): Promise<ApiResponse<T>> {
            if (path === "/job_post_locations") {
              return response([
                { id: 1, job_post_id: 10 },
                { id: 2, job_post_id: 20 },
              ] as T);
            }
            assert.equal(path, "/job_posts");
            parentPage += 1;
            if (page === "later" && parentPage === 1) {
              return response([{ id: 10, job_id: 1 }] as T, "parent-page-2");
            }
            const error = new Error(fault === "429" ? "Rate limited" : "Greenhouse request timed out");
            error.name = fault === "429" ? "RateLimitError" : "RequestTimeoutError";
            throw error;
          },
        };
        const result = await scopedReader(raw, "list_job_post_locations")
          .scopedRead(100, "list_job_post_locations", {});

        if (page === "first") {
          assert.equal(result.ok, false);
          assert.equal(result.ok === false && result.denial.code, "PERMISSION_JOIN_FAILED");
        } else {
          assert.equal(result.ok, true);
          assert.deepStrictEqual(result.ok && result.data, [{ id: 1, job_post_id: 10 }]);
          assert.equal(result.ok && result.rowCounts.status, "incomplete_scope_resolution");
          assert.equal(result.ok && result.rowCounts.unresolved, 1);
        }
        assert.equal(parentPage, page === "first" ? 1 : 2);
      });
    }
  }
});
