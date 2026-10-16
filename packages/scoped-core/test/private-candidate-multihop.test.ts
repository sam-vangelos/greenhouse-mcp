import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CANDIDATE_ROW_TOOLS,
  CANDIDATE_SUBSTANCE_TOOLS,
  DEFAULT_FILTER_REGISTRY,
  createScopedGreenhouseReader,
  type ActorResolver,
  type ApiResponse,
  type ExecutableScopePolicy,
  type PermissionLookupResult,
  type PermissionProvider,
  type RawReadClient,
} from "../src/index.js";

/**
 * The unattested branch runs no row filter, so every hop a row filter would have taken has to be
 * taken by the privacy resolver instead. These tests walk EVERY tool whose rows are candidate
 * substance, on both unattested branches (org-wide and direct operator), and assert that the row
 * linked to a private candidate is withheld — including the two- and three-hop tools whose rows
 * carry no candidate id and no application id at all.
 */

interface RawCall {
  path: string;
  params?: Record<string, unknown>;
  cursor?: string;
}

const CANDIDATES = [
  { id: 501, first_name: "Ada", private: false },
  { id: 504, first_name: "Di", private: true },
];

const APPLICATIONS = [
  { id: 1001, job_id: 7, candidate_id: 501 },
  { id: 1004, job_id: 7, candidate_id: 504 },
];

const INTERVIEWS = [
  { id: 2001, application_id: 1001 },
  { id: 2002, application_id: 1004 },
  // A job-level interview belongs to no candidate at all. It is not candidate substance and must
  // survive the gate, or the branch would withhold rows nobody's privacy is at stake in.
  { id: 2003, job_id: 7 },
];

const SCORECARDS = [
  { id: 4001, application_id: 1001 },
  { id: 4002, application_id: 1004 },
];

const SCORECARD_QUESTION_ANSWERS = [
  { id: 5001, scorecard_id: 4001 },
  { id: 5002, scorecard_id: 4002 },
];

const SCORECARD_QUESTION_ANSWER_OPTIONS = [
  { id: 6001, scorecard_question_answer_id: 5001 },
  { id: 6002, scorecard_question_answer_id: 5002 },
];

const TABLES: Record<string, Array<Record<string, unknown>>> = {
  "/candidates": CANDIDATES,
  "/applications": APPLICATIONS,
  "/application_stages": [
    { id: 7001, application_id: 1001 },
    { id: 7002, application_id: 1004 },
  ],
  "/scorecards": SCORECARDS,
  "/rejection_details": [
    { id: 7101, application_id: 1001 },
    { id: 7102, application_id: 1004 },
  ],
  "/prospect_details": [
    { id: 7201, application_id: 1001 },
    { id: 7202, application_id: 1004 },
  ],
  "/offers": [
    { id: 7301, job_id: 7, candidate_id: 501 },
    { id: 7302, job_id: 7, candidate_id: 504 },
  ],
  "/notes": [
    { id: 7401, visibility: "public", candidate_id: 501 },
    { id: 7402, visibility: "public", candidate_id: 504 },
  ],
  "/attachments": [
    { id: 7501, candidate_id: 501 },
    { id: 7502, candidate_id: 504 },
  ],
  "/candidate_educations": [
    { id: 7601, candidate_id: 501 },
    { id: 7602, candidate_id: 504 },
  ],
  "/candidate_employments": [
    { id: 7701, candidate_id: 501 },
    { id: 7702, candidate_id: 504 },
  ],
  "/interviews": INTERVIEWS,
  "/interviewers": [
    { id: 3001, interview_id: 2001 },
    { id: 3002, interview_id: 2002 },
    { id: 3003, interview_id: 2003 },
  ],
  "/scorecard_question_answers": SCORECARD_QUESTION_ANSWERS,
  "/scorecard_question_answer_options": SCORECARD_QUESTION_ANSWER_OPTIONS,
};

function idsOf(params: Record<string, unknown> | undefined, key: string): number[] {
  return String(params?.[key] ?? "")
    .split(",")
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0);
}

function tenantHandler(path: string, params?: Record<string, unknown>): unknown {
  const table = TABLES[path];
  if (!table) return [];
  if (path === "/candidates" && params?.ids !== undefined) {
    const wanted = new Set(idsOf(params, "ids"));
    const rows = table.filter((row) => wanted.has(row.id as number));
    return params.fields === "id,private" ? rows.map((row) => ({ id: row.id, private: row.private })) : rows;
  }
  if (params?.ids !== undefined) {
    const wanted = new Set(idsOf(params, "ids"));
    return table.filter((row) => wanted.has(row.id as number));
  }
  if (path === "/applications" && params?.candidate_ids !== undefined) {
    const wanted = new Set(idsOf(params, "candidate_ids"));
    return table.filter((row) => wanted.has(row.candidate_id as number));
  }
  return table;
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

const actorResolver: ActorResolver<number> = { resolveActor: (actorId) => actorId };

// The three policy-driven tools refuse to run without a scope policy; the unattested branch never
// consults one, but the availability check runs before the fork, so the registry has to be here.
const SCOPE_POLICIES = new Map<string, ExecutableScopePolicy>([
  [
    "list_scorecard_question_answer_options",
    {
      kind: "join_backed",
      dependencies: [
        {
          field: "scorecard_question_answer_id",
          sourceFilter: "scorecard_question_answer_ids",
          targetEndpoint: "/v3/scorecard_question_answers",
          targetField: "id",
          targetFilter: "ids",
          purpose: "scope",
        },
      ],
      terminal: { field: "job_id", filter: "job_ids" },
    },
  ],
]);

function readerFor(options: {
  scope?: unknown;
  raw?: RawReadClient & { calls: RawCall[] };
  operatorActorIds?: Set<number>;
  attestation?: (userId: number, signal?: AbortSignal) => Promise<boolean>;
}) {
  const raw = options.raw ?? rawReader();
  const permissionProvider: PermissionProvider = {
    async getPermittedJobIds(): Promise<PermissionLookupResult> {
      return (options.scope ?? { kind: "all" }) as PermissionLookupResult;
    },
  };
  return {
    raw,
    scoped: createScopedGreenhouseReader<number>({
      actorResolver,
      permissionProvider,
      rawReader: raw,
      scopePolicyRegistry: SCOPE_POLICIES,
      ...(options.operatorActorIds ? { operatorActorIds: options.operatorActorIds } : {}),
      ...(options.attestation ? { privateCandidateAttestation: options.attestation } : {}),
    } as Parameters<typeof createScopedGreenhouseReader>[0]),
  };
}

function rowIds(data: unknown): number[] {
  return (data as Array<{ id: number }>).map((row) => row.id);
}

// ---------------------------------------------------------------------------
// The table: every tool whose rows are (or can be) candidate substance.
// ---------------------------------------------------------------------------

interface GateCase {
  toolName: string;
  kept: number[];
  withheld: number;
  /**
   * The EXCLUSIONS axis: the rows an unattested actor keeps in a tenant that has a legacy
   * confidential job (9) the actor is not on the hiring team of. The unattested branch runs its own
   * exclusion pass instead of the job-scope engine, and it resolved a row's job through the
   * CANDIDATE's whole application set — so a row sitting on job 9 was admitted because the same
   * person also had an application on job 7, and a job-level interview on job 9 was admitted
   * outright because it belongs to no candidate at all.
   */
  excludedKept: number[];
  /**
   * The one-capable/one-non-capable axis: ONE private candidate with two applications — job 7,
   * where the actor holds Greenhouse's built-in "Private" Job Admin role, and job 8, where they do
   * not. Only the job-7 rows may be returned. The per-job check ran on the candidate's whole
   * application set, so holding the role on ONE req admitted every req that candidate touched.
   */
  capableKept: number[];
}

const GATE_CASES: readonly GateCase[] = [
  { toolName: "list_candidates", kept: [501], withheld: 1, excludedKept: [501], capableKept: [504] },
  { toolName: "list_applications", kept: [1001], withheld: 1, excludedKept: [1001], capableKept: [1047] },
  { toolName: "list_application_stages", kept: [7001], withheld: 1, excludedKept: [7001], capableKept: [7047] },
  { toolName: "list_scorecards", kept: [4001], withheld: 1, excludedKept: [4001], capableKept: [4047] },
  { toolName: "list_rejection_details", kept: [7101], withheld: 1, excludedKept: [7101], capableKept: [7147] },
  { toolName: "list_prospect_details", kept: [7201], withheld: 1, excludedKept: [7201], capableKept: [7247] },
  { toolName: "list_offers", kept: [7301], withheld: 1, excludedKept: [7301], capableKept: [7347] },
  { toolName: "list_notes", kept: [7401], withheld: 1, excludedKept: [7401], capableKept: [7447] },
  { toolName: "list_attachments", kept: [7501], withheld: 1, excludedKept: [7501], capableKept: [7547] },
  { toolName: "list_candidate_educations", kept: [7601], withheld: 1, excludedKept: [7601], capableKept: [7647] },
  { toolName: "list_candidate_employments", kept: [7701], withheld: 1, excludedKept: [7701], capableKept: [7747] },
  // Multi-hop: no candidate_id and no application_id on the row at all.
  { toolName: "list_interviews", kept: [2001, 2003], withheld: 1, excludedKept: [2001, 2003], capableKept: [2047] },
  { toolName: "list_interviewers", kept: [3001, 3003], withheld: 1, excludedKept: [3001, 3003], capableKept: [3047] },
  { toolName: "list_scorecard_question_answers", kept: [5001], withheld: 1, excludedKept: [5001], capableKept: [5047] },
  {
    toolName: "list_scorecard_question_answer_options",
    kept: [6001],
    withheld: 1,
    excludedKept: [6001],
    capableKept: [6047],
  },
];

describe("the unattested branch gates every candidate-substance tool, however many hops away", () => {
  for (const testCase of GATE_CASES) {
    it(`withholds the private-candidate row from an unattested ALL-ACCESS actor: ${testCase.toolName}`, async () => {
      const { scoped } = readerFor({ scope: { kind: "all" } });
      const result = await scoped.scopedRead(100, testCase.toolName, {});
      assert.equal(result.ok, true, `${testCase.toolName} denied`);
      if (!result.ok) return;
      assert.deepStrictEqual(rowIds(result.data), testCase.kept, testCase.toolName);
      assert.equal(result.rowCounts.privacyWithheld, testCase.withheld, testCase.toolName);
    });

    it(`withholds the private-candidate row from an unattested DIRECT OPERATOR: ${testCase.toolName}`, async () => {
      const { scoped } = readerFor({
        scope: { kind: "all" },
        operatorActorIds: new Set([900]),
        attestation: async () => false,
      });
      const result = await scoped.scopedRead(900, testCase.toolName, {});
      assert.equal(result.ok, true, `${testCase.toolName} denied`);
      if (!result.ok) return;
      assert.deepStrictEqual(rowIds(result.data), testCase.kept, testCase.toolName);
      assert.equal(result.rowCounts.privacyWithheld, testCase.withheld, testCase.toolName);
    });
  }
});

describe("an ATTESTED actor still reads every row on all of them", () => {
  for (const testCase of GATE_CASES) {
    it(`returns the private-candidate row too: ${testCase.toolName}`, async () => {
      const { scoped } = readerFor({ scope: { kind: "all", privateCandidatesAttested: true } });
      const result = await scoped.scopedRead(100, testCase.toolName, {});
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(
        rowIds(result.data).length,
        testCase.kept.length + testCase.withheld,
        testCase.toolName
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Fail-closed on a row that must resolve to a candidate but does not
// ---------------------------------------------------------------------------

const MALFORMED: ReadonlyArray<{ toolName: string; path: string; row: Record<string, unknown> }> = [
  { toolName: "list_notes", path: "/notes", row: { id: 9001, visibility: "public" } },
  { toolName: "list_attachments", path: "/attachments", row: { id: 9002 } },
  { toolName: "list_candidate_educations", path: "/candidate_educations", row: { id: 9003 } },
  { toolName: "list_candidate_employments", path: "/candidate_employments", row: { id: 9004 } },
  { toolName: "list_scorecard_question_answers", path: "/scorecard_question_answers", row: { id: 9005 } },
  {
    toolName: "list_scorecard_question_answer_options",
    path: "/scorecard_question_answer_options",
    row: { id: 9006 },
  },
  { toolName: "list_scorecards", path: "/scorecards", row: { id: 9007 } },
];

describe("a row that must name a candidate and does not is withheld, never waved through", () => {
  for (const entry of MALFORMED) {
    it(`fails closed: ${entry.toolName}`, async () => {
      const raw = rawReader((path, params) => (path === entry.path ? [entry.row] : tenantHandler(path, params)));
      const { scoped } = readerFor({ scope: { kind: "all" }, raw });
      const result = await scoped.scopedRead(100, entry.toolName, {});
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.deepStrictEqual(rowIds(result.data), [], entry.toolName);
      assert.equal(result.rowCounts.privacyWithheld, 1, entry.toolName);
    });
  }
});

describe("a parent hop that cannot be read withholds its row rather than waving it through", () => {
  it("withholds an interviewer whose interview read fails", async () => {
    const raw = rawReader((path, params) => {
      if (path === "/interviews") throw new Error("upstream 500");
      return tenantHandler(path, params);
    });
    const { scoped } = readerFor({ scope: { kind: "all" }, raw });
    const result = await scoped.scopedRead(100, "list_interviewers", {});
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepStrictEqual(rowIds(result.data), []);
    assert.equal(result.rowCounts.privacyWithheld, 3);
  });
});

// ---------------------------------------------------------------------------
// Batching: the hops go through the shared caches, not one read per row
// ---------------------------------------------------------------------------

describe("the multi-hop resolution is batched", () => {
  it("reads each hop's parents in one batched call for a whole page", async () => {
    const answers = Array.from({ length: 40 }, (_, index) => ({ id: 8000 + index, scorecard_id: 4001 }));
    const raw = rawReader((path, params) => {
      if (path === "/scorecard_question_answers" && params?.ids === undefined) return answers;
      return tenantHandler(path, params);
    });
    const { scoped } = readerFor({ scope: { kind: "all" }, raw });
    const result = await scoped.scopedRead(100, "list_scorecard_question_answers", {});
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.rowCounts.returned, 40);
    // Exactly four, in chain order: the page, then one batched read per hop. Forty rows resolving
    // one at a time would be 121.
    assert.deepStrictEqual(raw.calls.map((call) => call.path), [
      "/scorecard_question_answers",
      "/scorecards",
      "/applications",
      "/candidates",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Registry drift guard (item 20)
// ---------------------------------------------------------------------------

describe("the hand-maintained privacy tool sets cannot drift from the registry", () => {
  it("classifies every registration whose row filter carries candidate substance", () => {
    // Row-filter name -> the set the tool has to appear in for the universal gate to reach it.
    const REQUIRED_MEMBERSHIP: Record<string, "candidate_row" | "candidate_substance"> = {
      filterCandidateRow: "candidate_row",
      filterApplicationRow: "candidate_substance",
      filterApplicationBackedRow: "candidate_substance",
      filterCandidateBackedRow: "candidate_substance",
      filterOfferRow: "candidate_substance",
      filterNoteOrActivityRow: "candidate_substance",
      filterAttachmentRow: "candidate_substance",
      filterScorecardBackedRow: "candidate_substance",
    };
    const unclassified: string[] = [];
    for (const [toolName, registration] of DEFAULT_FILTER_REGISTRY) {
      const filterName = registration.rowFilter?.name;
      if (!filterName) continue;
      const required = REQUIRED_MEMBERSHIP[filterName];
      if (required === undefined) continue;
      const set = required === "candidate_row" ? CANDIDATE_ROW_TOOLS : CANDIDATE_SUBSTANCE_TOOLS;
      if (!set.has(toolName)) unclassified.push(`${toolName} (${filterName})`);
    }
    assert.deepStrictEqual(
      unclassified,
      [],
      "a registration whose rows are candidate substance is missing from the privacy tool sets"
    );
  });

  it("names every row filter the registry actually uses, so a new one is a loud failure", () => {
    const KNOWN = new Set([
      "filterCandidateRow",
      "filterApplicationRow",
      "filterApplicationBackedRow",
      "filterApplicationBackedOrDirectJobRow",
      "filterCandidateBackedRow",
      "filterOfferRow",
      "filterNoteOrActivityRow",
      "filterAttachmentRow",
      "filterScorecardBackedRow",
      "filterInterviewerRow",
      "filterJobRow",
      "filterDirectJobScopedRow",
    ]);
    const unknown = new Set<string>();
    for (const [, registration] of DEFAULT_FILTER_REGISTRY) {
      const filterName = registration.rowFilter?.name;
      if (filterName && !KNOWN.has(filterName)) unknown.add(filterName);
    }
    assert.deepStrictEqual([...unknown], []);
  });
});

// ---------------------------------------------------------------------------
// Axis 2: a legacy confidential job the actor is NOT on the hiring team of
// ---------------------------------------------------------------------------

/**
 * Job 7 is ordinary; job 9 is the legacy confidential job Greenhouse restricts, and it arrives as
 * `excludedJobIds`. Candidate 501 is PUBLIC and sits on BOTH jobs, which is what makes the
 * candidate-union shortcut visible: every job-9 row below belongs to a person the actor may
 * otherwise read.
 */
const EXCLUSION_TABLES: Record<string, Array<Record<string, unknown>>> = {
  "/candidates": [
    { id: 501, first_name: "Ada", private: false },
    { id: 504, first_name: "Di", private: true },
  ],
  "/applications": [
    { id: 1001, job_id: 7, candidate_id: 501 },
    { id: 1004, job_id: 7, candidate_id: 504 },
    { id: 1009, job_id: 9, candidate_id: 501 },
  ],
  "/application_stages": [
    { id: 7001, application_id: 1001 },
    { id: 7002, application_id: 1004 },
    { id: 7009, application_id: 1009 },
  ],
  "/scorecards": [
    { id: 4001, application_id: 1001 },
    { id: 4002, application_id: 1004 },
    { id: 4009, application_id: 1009 },
  ],
  "/rejection_details": [
    { id: 7101, application_id: 1001 },
    { id: 7102, application_id: 1004 },
    { id: 7109, application_id: 1009 },
  ],
  "/prospect_details": [
    { id: 7201, application_id: 1001 },
    { id: 7202, application_id: 1004 },
    { id: 7209, application_id: 1009 },
  ],
  "/offers": [
    { id: 7301, job_id: 7, candidate_id: 501 },
    { id: 7302, job_id: 7, candidate_id: 504 },
    { id: 7309, job_id: 9, candidate_id: 501 },
  ],
  "/notes": [
    { id: 7401, visibility: "public", candidate_id: 501 },
    { id: 7402, visibility: "public", candidate_id: 504 },
    { id: 7409, visibility: "public", application_id: 1009 },
  ],
  "/attachments": [
    { id: 7501, candidate_id: 501 },
    { id: 7502, candidate_id: 504 },
    { id: 7509, application_id: 1009 },
  ],
  "/candidate_educations": [
    { id: 7601, candidate_id: 501 },
    { id: 7602, candidate_id: 504 },
  ],
  "/candidate_employments": [
    { id: 7701, candidate_id: 501 },
    { id: 7702, candidate_id: 504 },
  ],
  "/interviews": [
    { id: 2001, application_id: 1001 },
    { id: 2002, application_id: 1004 },
    { id: 2003, job_id: 7 },
    // A job-level interview on the CONFIDENTIAL job: it belongs to no candidate, so the
    // candidate-union route answered "no job" and let it straight through.
    { id: 2009, job_id: 9 },
    { id: 2019, application_id: 1009 },
  ],
  "/interviewers": [
    { id: 3001, interview_id: 2001 },
    { id: 3002, interview_id: 2002 },
    { id: 3003, interview_id: 2003 },
    { id: 3009, interview_id: 2009 },
    { id: 3019, interview_id: 2019 },
  ],
  // job_id is on the row because it is the terminal the answer-options scope policy declares; the
  // engine this axis is compared against resolves through it.
  "/scorecard_question_answers": [
    { id: 5001, job_id: 7, scorecard_id: 4001 },
    { id: 5002, job_id: 7, scorecard_id: 4002 },
    { id: 5009, job_id: 9, scorecard_id: 4009 },
  ],
  "/scorecard_question_answer_options": [
    { id: 6001, scorecard_question_answer_id: 5001 },
    { id: 6002, scorecard_question_answer_id: 5002 },
    { id: 6009, scorecard_question_answer_id: 5009 },
  ],
};

// ---------------------------------------------------------------------------
// Axis 3: ONE private candidate, one private-capable req and one that is not
// ---------------------------------------------------------------------------

/** Candidate 504 is private and sits on job 7 (Private Job Admin held) and job 8 (not held). */
const CAPABILITY_TABLES: Record<string, Array<Record<string, unknown>>> = {
  "/candidates": [{ id: 504, first_name: "Di", private: true }],
  "/applications": [
    { id: 1047, job_id: 7, candidate_id: 504 },
    { id: 1048, job_id: 8, candidate_id: 504 },
  ],
  "/application_stages": [
    { id: 7047, application_id: 1047 },
    { id: 7048, application_id: 1048 },
  ],
  "/scorecards": [
    { id: 4047, application_id: 1047 },
    { id: 4048, application_id: 1048 },
  ],
  "/rejection_details": [
    { id: 7147, application_id: 1047 },
    { id: 7148, application_id: 1048 },
  ],
  "/prospect_details": [
    { id: 7247, application_id: 1047 },
    { id: 7248, application_id: 1048 },
  ],
  "/offers": [
    { id: 7347, job_id: 7, candidate_id: 504 },
    { id: 7348, job_id: 8, candidate_id: 504 },
  ],
  "/notes": [
    { id: 7447, visibility: "public", application_id: 1047 },
    { id: 7448, visibility: "public", application_id: 1048 },
  ],
  "/attachments": [
    { id: 7547, application_id: 1047 },
    { id: 7548, application_id: 1048 },
  ],
  // Candidate-level substance genuinely spans every req the person is on, so the union IS the right
  // answer here and the row stays visible: Greenhouse grants this actor private access to the person
  // on job 7, and an education row belongs to no job at all.
  "/candidate_educations": [{ id: 7647, candidate_id: 504 }],
  "/candidate_employments": [{ id: 7747, candidate_id: 504 }],
  "/interviews": [
    { id: 2047, application_id: 1047 },
    { id: 2048, application_id: 1048 },
  ],
  "/interviewers": [
    { id: 3047, interview_id: 2047 },
    { id: 3048, interview_id: 2048 },
  ],
  // `/v3/scorecard_question_answers` carries job_id (it is the terminal the answer-options scope
  // policy declares), so the fixture carries it too — otherwise the policy engine this axis is
  // compared against cannot resolve a job at all and drops every row for a reason unrelated to
  // privacy.
  "/scorecard_question_answers": [
    { id: 5047, job_id: 7, scorecard_id: 4047 },
    { id: 5048, job_id: 8, scorecard_id: 4048 },
  ],
  "/scorecard_question_answer_options": [
    { id: 6047, scorecard_question_answer_id: 5047 },
    { id: 6048, scorecard_question_answer_id: 5048 },
  ],
};

function handlerFor(tables: Record<string, Array<Record<string, unknown>>>) {
  return (path: string, params?: Record<string, unknown>): unknown => {
    const table = tables[path];
    if (!table) return [];
    if (path === "/candidates" && params?.ids !== undefined) {
      const wanted = new Set(idsOf(params, "ids"));
      const rows = table.filter((row) => wanted.has(row.id as number));
      return params.fields === "id,private" ? rows.map((row) => ({ id: row.id, private: row.private })) : rows;
    }
    if (params?.ids !== undefined) {
      const wanted = new Set(idsOf(params, "ids"));
      return table.filter((row) => wanted.has(row.id as number));
    }
    if (path === "/applications" && params?.candidate_ids !== undefined) {
      const wanted = new Set(idsOf(params, "candidate_ids"));
      return table.filter((row) => wanted.has(row.candidate_id as number));
    }
    return table;
  };
}

describe("the exclusions branch resolves the row's OWN job, not the candidate's whole set", () => {
  for (const testCase of GATE_CASES) {
    it(`keeps only the non-confidential rows: ${testCase.toolName}`, async () => {
      const unattested = readerFor({
        scope: { kind: "all", excludedJobIds: new Set([9]) },
        raw: rawReader(handlerFor(EXCLUSION_TABLES)),
      });
      const result = await unattested.scoped.scopedRead(100, testCase.toolName, {});
      assert.equal(result.ok, true, `${testCase.toolName} denied`);
      if (!result.ok) return;
      assert.deepStrictEqual(rowIds(result.data), testCase.excludedKept, testCase.toolName);

      // …and never more than the ATTESTED read of the same tool, which runs the job-scope engine
      // over the same exclusion set. The unattested branch may withhold more; it may never keep a
      // row the engine excludes.
      const attested = readerFor({
        scope: { kind: "all", privateCandidatesAttested: true, excludedJobIds: new Set([9]) },
        raw: rawReader(handlerFor(EXCLUSION_TABLES)),
      });
      const engine = await attested.scoped.scopedRead(100, testCase.toolName, {});
      assert.equal(engine.ok, true, `${testCase.toolName} engine denied`);
      if (!engine.ok) return;
      const engineIds = new Set(rowIds(engine.data));
      const leaked = testCase.excludedKept.filter((id) => !engineIds.has(id));
      assert.deepStrictEqual(leaked, [], `${testCase.toolName}: unattested kept rows the engine excludes`);
    });
  }
});

describe("a private-capable role on ONE req does not admit the same candidate's OTHER reqs", () => {
  for (const testCase of GATE_CASES) {
    it(`keeps only the job-7 rows: ${testCase.toolName}`, async () => {
      const { scoped } = readerFor({
        scope: { kind: "all", privateCapableJobIds: new Set([7]) },
        raw: rawReader(handlerFor(CAPABILITY_TABLES)),
      });
      const result = await scoped.scopedRead(100, testCase.toolName, {});
      assert.equal(result.ok, true, `${testCase.toolName} denied`);
      if (!result.ok) return;
      assert.deepStrictEqual(rowIds(result.data), testCase.capableKept, testCase.toolName);
    });

    it(`agrees with the job-scope engine holding the same role: ${testCase.toolName}`, async () => {
      const { scoped } = readerFor({
        scope: { kind: "jobs", jobIds: new Set([7, 8]), privateCapableJobIds: new Set([7]) },
        raw: rawReader(handlerFor(CAPABILITY_TABLES)),
      });
      const result = await scoped.scopedRead(100, testCase.toolName, {});
      assert.equal(result.ok, true, `${testCase.toolName} denied`);
      if (!result.ok) return;
      assert.deepStrictEqual(rowIds(result.data), testCase.capableKept, testCase.toolName);
    });
  }
});

// ---------------------------------------------------------------------------
// Every candidate-bearing carrier on the row is resolved, not just the first
// ---------------------------------------------------------------------------

describe("a row carrying more than one candidate-bearing id is resolved through all of them", () => {
  // The real /v3/interviewers row carries interview_id AND scorecard_id. Here the interview is
  // job-level (application_id null, so the first carrier dead-ends at "no candidate") while the
  // scorecard belongs to a PRIVATE candidate's application.
  const DUAL_CARRIER: Record<string, Array<Record<string, unknown>>> = {
    "/candidates": [{ id: 504, private: true }],
    "/applications": [{ id: 1004, job_id: 7, candidate_id: 504 }],
    "/interviews": [{ id: 2002, application_id: null, job_id: 7 }],
    "/scorecards": [{ id: 4004, application_id: 1004 }],
    "/interviewers": [{ id: 3002, interview_id: 2002, scorecard_id: 4004, email: "panel@example.com" }],
  };

  it("withholds an interviewer whose SECOND carrier reaches a private candidate", async () => {
    const { scoped } = readerFor({ scope: { kind: "all" }, raw: rawReader(handlerFor(DUAL_CARRIER)) });
    const result = await scoped.scopedRead(100, "list_interviewers", {});
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepStrictEqual(rowIds(result.data), []);
    assert.equal(result.rowCounts.privacyWithheld, 1);
  });

  it("withholds when two carriers disagree about whose row this is", async () => {
    const CONFLICT: Record<string, Array<Record<string, unknown>>> = {
      "/candidates": [
        { id: 501, private: false },
        { id: 504, private: true },
      ],
      "/applications": [
        { id: 1001, job_id: 7, candidate_id: 501 },
        { id: 1004, job_id: 7, candidate_id: 504 },
      ],
      "/interviews": [{ id: 2001, application_id: 1001 }],
      "/scorecards": [{ id: 4004, application_id: 1004 }],
      "/interviewers": [{ id: 3002, interview_id: 2001, scorecard_id: 4004 }],
    };
    const { scoped } = readerFor({ scope: { kind: "all" }, raw: rawReader(handlerFor(CONFLICT)) });
    const result = await scoped.scopedRead(100, "list_interviewers", {});
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepStrictEqual(rowIds(result.data), []);
    assert.equal(result.rowCounts.privacyWithheld, 1);
  });
});

// ---------------------------------------------------------------------------
// Embedded applications on the exclusions branch
// ---------------------------------------------------------------------------

describe("the exclusions branch prunes the applications embedded on a candidate row", () => {
  const EMBEDDED: Record<string, Array<Record<string, unknown>>> = {
    "/candidates": [
      {
        id: 501,
        private: false,
        applications: [
          { id: 1001, job_id: 7 },
          { id: 1009, job_id: 9 },
        ],
      },
      // Genuinely applicationless: no job can be a confidential job, so the row survives.
      { id: 502, private: false, applications: [] },
    ],
  };

  it("returns the candidate without the confidential job's application", async () => {
    const { scoped } = readerFor({
      scope: { kind: "all", excludedJobIds: new Set([9]) },
      raw: rawReader(handlerFor(EMBEDDED)),
    });
    const result = await scoped.scopedRead(100, "list_candidates", {});
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const rows = result.data as Array<Record<string, unknown>>;
    assert.deepStrictEqual(rowIds(result.data), [501, 502]);
    assert.deepStrictEqual(rows[0]!.applications, [{ id: 1001, job_id: 7 }]);
  });

  it("withholds a candidate whose non-empty applications array cannot be read", async () => {
    const MALFORMED_EMBEDDED: Record<string, Array<Record<string, unknown>>> = {
      "/candidates": [{ id: 503, private: false, applications: [null] }],
    };
    const { scoped } = readerFor({
      scope: { kind: "all", excludedJobIds: new Set([9]) },
      raw: rawReader(handlerFor(MALFORMED_EMBEDDED)),
    });
    const result = await scoped.scopedRead(100, "list_candidates", {});
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepStrictEqual(rowIds(result.data), []);
    assert.equal(result.rowCounts.unresolved, 1);
  });
});

// ---------------------------------------------------------------------------
// A failing batch must not degrade into one read per row
// ---------------------------------------------------------------------------

describe("a failed batched privacy read withholds the page instead of retrying per row", () => {
  it("keeps the call count at the batch ceiling when /candidates fails", async () => {
    const applications = Array.from({ length: 100 }, (_, index) => ({
      id: 20000 + index,
      job_id: 7,
      candidate_id: 30000 + index,
    }));
    const raw = rawReader((path, params) => {
      if (path === "/applications" && params?.ids === undefined && params?.candidate_ids === undefined) {
        return applications;
      }
      if (path === "/candidates") throw new Error("upstream 500");
      return [];
    });
    const { scoped } = readerFor({ scope: { kind: "all" }, raw });
    const result = await scoped.scopedRead(100, "list_applications", {});
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepStrictEqual(rowIds(result.data), []);
    // The page, plus one /candidates batch per 50 ids. A per-row retry would be 103.
    assert.equal(raw.calls.length, 3, JSON.stringify(raw.calls.map((call) => call.path)));
  });

  it("keeps the call count at the batch ceiling when a parent hop fails", async () => {
    const answers = Array.from({ length: 100 }, (_, index) => ({ id: 40000 + index, scorecard_id: 50000 + index }));
    const raw = rawReader((path, params) => {
      if (path === "/scorecard_question_answers" && params?.ids === undefined) return answers;
      if (path === "/scorecards") throw new Error("upstream 500");
      return [];
    });
    const { scoped } = readerFor({ scope: { kind: "all" }, raw });
    const result = await scoped.scopedRead(100, "list_scorecard_question_answers", {});
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepStrictEqual(rowIds(result.data), []);
    // The page, plus one /scorecards batch per 50 ids.
    assert.equal(raw.calls.length, 3, JSON.stringify(raw.calls.map((call) => call.path)));
  });
});

// ---------------------------------------------------------------------------
// Registry drift by ENDPOINT, so a policy-driven tool cannot slip past
// ---------------------------------------------------------------------------

describe("the privacy tool sets are checked against the registry's endpoints, not its row filters", () => {
  it("classifies every registered endpoint that can carry candidate substance", () => {
    // Endpoint path -> the classification the tool must carry. A policy-driven registration has NO
    // row filter, so a check that walks rowFilter names skips it entirely — which is how
    // list_scorecard_question_answer_options reached the gate unclassified.
    const CANDIDATE_ROW_ENDPOINTS = new Set(["/candidates"]);
    const CANDIDATE_SUBSTANCE_ENDPOINTS = new Set([
      "/applications",
      "/application_stages",
      "/scorecards",
      "/rejection_details",
      "/prospect_details",
      "/offers",
      "/notes",
      "/attachments",
      "/candidate_educations",
      "/candidate_employments",
      // R2b: a tag row is (candidate_id, candidate_tag_id) — it names a candidate, so it is
      // candidate substance and the private gate must cover it.
      "/applied_candidate_tags",
      // R2d: the row carries an interviewer's free-text `note` about one candidate, reached through
      // its scorecard.
      "/scorecard_candidate_attributes",
      "/scorecard_question_answers",
      "/scorecard_question_answer_options",
    ]);
    // Endpoints that legitimately return rows belonging to no candidate, or no person at all.
    const NON_CANDIDATE_ENDPOINTS = new Set([
      "/interviews",
      "/interviewers",
      "/jobs",
      "/job_owners",
      "/openings",
      "/job_interview_stages",
      "/job_interviews",
      "/job_hiring_managers",
      "/job_notes",
      "/job_posts",
      "/tracking_links",
      "/users",
      "/rejection_reasons",
      "/sources",
      "/referrers",
      "/departments",
      "/offices",
      "/close_reasons",
      "/custom_field_options",
      "/custom_fields",
      "/pay_inputs",
      "/approval_flows",
      "/interview_kits",
      "/approvers",
      "/approver_groups",
      "/scorecard_questions",
      "/scorecard_question_options",
      "/default_interviewers",
      "/job_post_locations",
      "/pay_input_ranges",
      "/interviewer_tags",
      "/candidate_tags",
      "/prospect_pools",
      "/prospect_pool_stages",
      "/job_boards",
      "/custom_field_departments",
      "/custom_field_offices",
      // R2b. Post-level location (city/region/lat-long) reached through job_post_id; the permission
      // role dictionary (id, name, role_type), which names no user; and the org's email templates.
      // None can carry a candidate row.
      "/job_post_searchable_locations",
      "/user_roles",
      "/email_templates",
      // R2d. Rubric CONFIGURATION and org diagnostics. The attribute family below describes what a
      // scorecard rates and which question maps to which trait — the ratings themselves live on
      // /scorecard_candidate_attributes, which is classified as candidate substance above. The
      // permission, staff-directory, bulk-request, spam and board-location rows describe people who
      // work here or the org's own configuration, never an applicant.
      "/job_candidate_attributes",
      "/candidate_attribute_types",
      "/focus_candidate_attributes",
      "/scorecard_question_candidate_attributes",
      "/user_job_permissions",
      "/future_job_permissions",
      "/user_emails",
      "/bulk_requests",
      // R2e fold. The single bulk request, read by uuid: the same org-diagnostic row as the list,
      // plus signed result-file URLs the projection drops. No applicant appears on it.
      "/bulk_requests/{bulk_action_uuid}",
      "/blocked_spam_sources",
      "/job_board_custom_locations",
    ]);

    const problems: string[] = [];
    for (const [toolName, registration] of DEFAULT_FILTER_REGISTRY) {
      const endpoint = registration.endpoint;
      if (endpoint === undefined) {
        problems.push(`${toolName}: registration carries no endpoint`);
        continue;
      }
      if (CANDIDATE_ROW_ENDPOINTS.has(endpoint)) {
        if (!CANDIDATE_ROW_TOOLS.has(toolName)) problems.push(`${toolName} (${endpoint}) missing from CANDIDATE_ROW_TOOLS`);
        continue;
      }
      if (CANDIDATE_SUBSTANCE_ENDPOINTS.has(endpoint)) {
        if (!CANDIDATE_SUBSTANCE_TOOLS.has(toolName)) {
          problems.push(`${toolName} (${endpoint}) missing from CANDIDATE_SUBSTANCE_TOOLS`);
        }
        continue;
      }
      if (!NON_CANDIDATE_ENDPOINTS.has(endpoint)) {
        problems.push(`${toolName} (${endpoint}) is unclassified — decide whether its rows are candidate substance`);
      }
    }
    assert.deepStrictEqual(problems, []);
  });
});

// ---------------------------------------------------------------------------
// Third fold, item 1: a DIRECT candidate id is one carrier, not a short circuit
// ---------------------------------------------------------------------------

/**
 * A note that names a public candidate directly AND an application belonging to a private one.
 *
 * The resolver used to return on the direct association and never look at the sibling, so the row
 * was handed to an unattested actor on the strength of the public name printed on it while the
 * application it hangs off pointed at someone they may not see.
 */
const DIRECT_PLUS_PARENT: Record<string, Array<Record<string, unknown>>> = {
  "/candidates": [
    { id: 501, private: false },
    { id: 504, private: true },
  ],
  "/applications": [{ id: 1004, job_id: 7, candidate_id: 504 }],
  "/notes": [{ id: 7401, visibility: "public", candidate_id: 501, application_id: 1004 }],
};

describe("a direct candidate_id is one carrier among the row's carriers, not a short circuit", () => {
  it("withholds from an unattested ALL-ACCESS actor when a sibling carrier names someone else", async () => {
    const { scoped } = readerFor({
      scope: { kind: "all" },
      raw: rawReader(handlerFor(DIRECT_PLUS_PARENT)),
    });
    const result = await scoped.scopedRead(100, "list_notes", {});
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepStrictEqual(rowIds(result.data), []);
    assert.equal(result.rowCounts.privacyWithheld, 1);
  });

  it("withholds from an unattested DIRECT OPERATOR too", async () => {
    const { scoped } = readerFor({
      scope: { kind: "all" },
      raw: rawReader(handlerFor(DIRECT_PLUS_PARENT)),
      operatorActorIds: new Set([900]),
      attestation: async () => false,
    });
    const result = await scoped.scopedRead(900, "list_notes", {});
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepStrictEqual(rowIds(result.data), []);
    assert.equal(result.rowCounts.privacyWithheld, 1);
  });

  it("withholds when a sibling carrier cannot be read at all", async () => {
    const DANGLING: Record<string, Array<Record<string, unknown>>> = {
      "/candidates": [{ id: 501, private: false }],
      "/applications": [],
      "/notes": [{ id: 7401, visibility: "public", candidate_id: 501, application_id: 99999 }],
    };
    const { scoped } = readerFor({ scope: { kind: "all" }, raw: rawReader(handlerFor(DANGLING)) });
    const result = await scoped.scopedRead(100, "list_notes", {});
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepStrictEqual(rowIds(result.data), []);
  });
});

/**
 * The same strictness must NOT reach the job-scope engine. `resolveRowCandidate` is shared: the
 * privacy gate is a backstop after BOTH engines, so a rule written into the walk unconditionally
 * would change what a job-scoped recruiter sees when a sibling id dangles — and, through
 * `PermissionJoinError`, what `action-visibility.ts` lets them write.
 */
describe("the job-scope engine's dangling-sibling behaviour is untouched", () => {
  const ENGINE_DANGLING: Record<string, Array<Record<string, unknown>>> = {
    "/candidates": [{ id: 501, private: false }],
    "/applications": [{ id: 1001, job_id: 7, candidate_id: 501 }],
    "/scorecards": [],
    // The row filter for an education row reads candidate_id only; the dangling scorecard_id is a
    // sibling the engine has never consulted.
    "/candidate_educations": [{ id: 7601, candidate_id: 501, scorecard_id: 99999 }],
  };

  it("returns the row, and spends no read on the sibling", async () => {
    const raw = rawReader(handlerFor(ENGINE_DANGLING));
    const { scoped } = readerFor({ scope: { kind: "jobs", jobIds: new Set([7]) }, raw });
    const result = await scoped.scopedRead(100, "list_candidate_educations", {});
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepStrictEqual(rowIds(result.data), [7601]);
    assert.equal(
      raw.calls.some((call) => call.path === "/scorecards"),
      false,
      JSON.stringify(raw.calls.map((call) => call.path))
    );
  });
});

// ---------------------------------------------------------------------------
// Third fold, item 2: the walked jobs must AGREE, not merely overlap
// ---------------------------------------------------------------------------

describe("carriers that walk to different jobs resolve unresolved, not to their union", () => {
  it("withholds an interviewer whose interview and scorecard sit on different reqs", async () => {
    const SPLIT_JOB: Record<string, Array<Record<string, unknown>>> = {
      "/candidates": [{ id: 504, private: true }],
      "/applications": [
        { id: 1047, job_id: 7, candidate_id: 504 },
        { id: 1048, job_id: 8, candidate_id: 504 },
      ],
      "/interviews": [{ id: 2048, application_id: 1048 }],
      "/scorecards": [{ id: 4047, application_id: 1047 }],
      "/interviewers": [{ id: 3050, interview_id: 2048, scorecard_id: 4047 }],
    };
    const { scoped } = readerFor({
      scope: { kind: "all", privateCapableJobIds: new Set([7]) },
      raw: rawReader(handlerFor(SPLIT_JOB)),
    });
    const result = await scoped.scopedRead(100, "list_interviewers", {});
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepStrictEqual(rowIds(result.data), []);
  });

  it("withholds one whose second carrier sits on an EXCLUDED confidential job", async () => {
    const SPLIT_EXCLUDED: Record<string, Array<Record<string, unknown>>> = {
      // Public candidate: the withholding here is the job disagreement, not privacy.
      "/candidates": [{ id: 501, private: false }],
      "/applications": [
        { id: 1047, job_id: 7, candidate_id: 501 },
        { id: 1049, job_id: 9, candidate_id: 501 },
      ],
      "/interviews": [{ id: 2049, application_id: 1049 }],
      "/scorecards": [{ id: 4047, application_id: 1047 }],
      "/interviewers": [{ id: 3051, interview_id: 2049, scorecard_id: 4047 }],
    };
    const { scoped } = readerFor({
      scope: { kind: "all", excludedJobIds: new Set([9]) },
      raw: rawReader(handlerFor(SPLIT_EXCLUDED)),
    });
    const result = await scoped.scopedRead(100, "list_interviewers", {});
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepStrictEqual(rowIds(result.data), []);
  });
});

// ---------------------------------------------------------------------------
// Third fold, item 3: a SUCCESSFUL batch that answers for nobody
// ---------------------------------------------------------------------------

describe("a successful parent batch that returns no rows still seeds every id it asked for", () => {
  it("keeps the call count at the batch ceiling when /scorecards answers 200 with []", async () => {
    const answers = Array.from({ length: 100 }, (_, index) => ({ id: 40000 + index, scorecard_id: 50000 + index }));
    const raw = rawReader((path, params) => {
      if (path === "/scorecard_question_answers" && params?.ids === undefined) return answers;
      return [];
    });
    const { scoped } = readerFor({ scope: { kind: "all" }, raw });
    const result = await scoped.scopedRead(100, "list_scorecard_question_answers", {});
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepStrictEqual(rowIds(result.data), []);
    // The page, plus one /scorecards batch per 50 ids. Retrying the absentees one at a time is 103.
    assert.equal(raw.calls.length, 3, JSON.stringify(raw.calls.map((call) => call.path)));
  });
});

// ---------------------------------------------------------------------------
// Third fold, item 4: the 100-row call ceiling, dual-carrier included
// ---------------------------------------------------------------------------

function pageOf(count: number, build: (index: number) => Record<string, unknown>): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, index) => build(index));
}

/** 100 rows, 100 distinct candidates, half of them private. */
function hundredRowTenant(options: { dualCarrier: boolean }): Record<string, Array<Record<string, unknown>>> {
  return {
    "/candidates": pageOf(100, (i) => ({ id: 500 + i, private: i % 2 === 1 })),
    "/applications": pageOf(100, (i) => ({ id: 1000 + i, job_id: 7, candidate_id: 500 + i })),
    "/interviews": pageOf(100, (i) => ({ id: 2000 + i, application_id: 1000 + i })),
    "/scorecards": pageOf(100, (i) => ({ id: 4000 + i, application_id: 1000 + i })),
    "/scorecard_question_answers": pageOf(100, (i) => ({ id: 5000 + i, scorecard_id: 4000 + i })),
    "/interviewers": pageOf(100, (i) => ({
      id: 3000 + i,
      interview_id: 2000 + i,
      ...(options.dualCarrier ? { scorecard_id: 4000 + i } : {}),
    })),
  };
}

interface CallCeiling {
  label: string;
  toolName: string;
  dualCarrier: boolean;
  calls: number;
  /** The endpoint made to answer 200 with `[]` for every batched `ids=` request. */
  emptyBatch: string;
  /** The ceiling when that batch names nobody. Every row is withheld; nothing is retried per id. */
  emptyBatchCalls: number;
}

const CALL_CEILINGS: readonly CallCeiling[] = [
  // The page, plus one /candidates privacy batch per 50 rows.
  {
    label: "applications",
    toolName: "list_applications",
    dualCarrier: false,
    calls: 3,
    emptyBatch: "/candidates",
    emptyBatchCalls: 3,
  },
  // The page, plus /scorecards, /applications and /candidates at two batches each.
  {
    label: "answers",
    toolName: "list_scorecard_question_answers",
    dualCarrier: false,
    calls: 7,
    emptyBatch: "/scorecards",
    emptyBatchCalls: 3,
  },
  {
    label: "interviewers (interview_id only)",
    toolName: "list_interviewers",
    dualCarrier: false,
    calls: 7,
    emptyBatch: "/interviews",
    emptyBatchCalls: 3,
  },
  // Two carriers means two endpoints primed at the first hop: nine, not seven. And when the FIRST
  // carrier's batch names nobody, the row is withheld on that alone — resolving it through the
  // surviving carrier is the leak item 1 closed, and the 109 calls it took to leak are gone with it.
  {
    label: "interviewers (interview_id + scorecard_id)",
    toolName: "list_interviewers",
    dualCarrier: true,
    calls: 9,
    emptyBatch: "/interviews",
    emptyBatchCalls: 7,
  },
];

describe("a hundred-row page stays at its batch ceiling", () => {
  for (const ceiling of CALL_CEILINGS) {
    it(`${ceiling.label}: ${ceiling.calls} calls`, async () => {
      const raw = rawReader(handlerFor(hundredRowTenant({ dualCarrier: ceiling.dualCarrier })));
      const { scoped } = readerFor({ scope: { kind: "all" }, raw });
      const result = await scoped.scopedRead(100, ceiling.toolName, {});
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.rowCounts.returned, 50, ceiling.label);
      assert.equal(raw.calls.length, ceiling.calls, JSON.stringify(raw.calls.map((call) => call.path)));
    });

    it(`${ceiling.label}: ${ceiling.calls} calls with a private-capable role held`, async () => {
      const raw = rawReader(handlerFor(hundredRowTenant({ dualCarrier: ceiling.dualCarrier })));
      const { scoped } = readerFor({
        scope: { kind: "all", privateCapableJobIds: new Set([7]) },
        raw,
      });
      const result = await scoped.scopedRead(100, ceiling.toolName, {});
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.rowCounts.returned, 100, ceiling.label);
      assert.equal(raw.calls.length, ceiling.calls, JSON.stringify(raw.calls.map((call) => call.path)));
    });

    it(`${ceiling.label}: ${ceiling.emptyBatchCalls} calls when ${ceiling.emptyBatch} answers 200 with []`, async () => {
      const tables = hundredRowTenant({ dualCarrier: ceiling.dualCarrier });
      const inner = handlerFor(tables);
      const raw = rawReader((path, params) =>
        path === ceiling.emptyBatch && params?.ids !== undefined ? [] : inner(path, params)
      );
      const { scoped } = readerFor({ scope: { kind: "all" }, raw });
      const result = await scoped.scopedRead(100, ceiling.toolName, {});
      assert.equal(result.ok, true);
      if (!result.ok) return;
      // Nobody resolves, so nobody is returned — including the dual-carrier rows, whose surviving
      // carrier must not answer for a sibling nobody could read.
      assert.equal(result.rowCounts.returned, 0, ceiling.label);
      assert.equal(
        raw.calls.length,
        ceiling.emptyBatchCalls,
        JSON.stringify(raw.calls.map((call) => call.path))
      );
    });
  }
});
