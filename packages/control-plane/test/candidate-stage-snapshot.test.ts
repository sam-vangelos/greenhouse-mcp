import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_APPLICATION_PAGES_PER_BATCH,
  MAX_CANDIDATE_IDS_PER_QUERY,
  attachCandidateApplicationsForStageSnapshot,
  chunkCandidateIds,
  groupApplicationsByCandidate,
  injectApplications,
} from "../src/candidate-stage-snapshot.js";

// The fetch/join logic for list_candidates stage_snapshot. The two v3 limits that
// silently broke the naive version are exercised here: the candidate_ids maxItems:50
// cap (chunking) and the honest null-vs-[]-vs-entries injection contract.

describe("chunkCandidateIds — v3 candidate_ids maxItems:50 (#H)", () => {
  it("never emits a batch larger than the v3 cap", () => {
    assert.equal(MAX_CANDIDATE_IDS_PER_QUERY, 50);
    const ids = Array.from({ length: 137 }, (_, i) => i + 1);
    const chunks = chunkCandidateIds(ids);
    assert.deepStrictEqual(
      chunks.map((c) => c.length),
      [50, 50, 37],
      "a 137-candidate page must split into 50/50/37, never one 137-id query that v3 rejects"
    );
    for (const chunk of chunks) {
      assert.ok(chunk.length <= 50, "batch exceeds the v3 candidate_ids maxItems");
    }
    assert.deepStrictEqual(chunks.flat(), ids, "chunking must not drop or duplicate any candidate id");
  });

  it("returns a single batch when the ids fit, and [] for none", () => {
    assert.deepStrictEqual(chunkCandidateIds([1, 2, 3]), [[1, 2, 3]]);
    assert.deepStrictEqual(chunkCandidateIds([]), []);
  });
});

describe("groupApplicationsByCandidate", () => {
  it("groups by flat candidate_id and skips rows without a positive one", () => {
    const grouped = groupApplicationsByCandidate([
      { id: 1, candidate_id: 10 },
      { id: 2, candidate_id: 10 },
      { id: 3, candidate_id: 20 },
      { id: 4 },
      { id: 5, candidate_id: 0 },
      "not-an-object",
      null,
    ]);
    assert.deepStrictEqual((grouped.get(10) ?? []).map((a) => (a as { id: number }).id), [1, 2]);
    assert.deepStrictEqual((grouped.get(20) ?? []).map((a) => (a as { id: number }).id), [3]);
    assert.equal(grouped.size, 2);
  });
});

describe("injectApplications — honest null vs [] vs entries", () => {
  const byCandidate = new Map<number, unknown[]>([[10, [{ id: 1, candidate_id: 10 }]]]);

  it("injects fetched candidates' applications; [] when fetched but the candidate has none", () => {
    const out = injectApplications(
      [{ id: 10 }, { id: 11 }],
      byCandidate,
      new Set([10, 11])
    ) as Array<Record<string, unknown>>;
    assert.deepStrictEqual((out[0]!.applications as Array<{ id: number }>).map((a) => a.id), [1]);
    assert.deepStrictEqual(out[1]!.applications, []);
  });

  it("leaves a candidate whose batch was NOT fetched untouched, so stage_snapshot stays null (never a fabricated [])", () => {
    const out = injectApplications([{ id: 12 }], byCandidate, new Set([10])) as Array<Record<string, unknown>>;
    assert.ok(
      !("applications" in out[0]!),
      "a candidate whose batch failed must not receive a fabricated empty applications array"
    );
  });
});

describe("attachCandidateApplicationsForStageSnapshot — orchestration (injected fetch)", () => {
  type Resp = { data: unknown; nextCursor: string | null };
  const okEmpty = async (): Promise<Resp> => ({ data: [], nextCursor: null });

  it("never queries more than 50 candidate_ids per call — chunks a >50-candidate page (#H)", async () => {
    const queried: number[] = [];
    const deps = {
      get: async (_path: string, params: Record<string, unknown>) => {
        queried.push(String(params.candidate_ids).split(",").length);
        return { data: [], nextCursor: null } as Resp;
      },
      getWithCursor: okEmpty,
    };
    const candidates = Array.from({ length: 120 }, (_, i) => ({ id: i + 1 }));
    await attachCandidateApplicationsForStageSnapshot(candidates, deps);
    assert.deepStrictEqual(queried, [50, 50, 20], "a 120-candidate page must split into 50/50/20 queries");
    for (const count of queried) {
      assert.ok(count <= 50, `a batch queried ${count} ids, exceeding the v3 candidate_ids maxItems`);
    }
  });

  it("follows the cursor and merges a candidate's applications across pages", async () => {
    const deps = {
      get: async (): Promise<Resp> => ({ data: [{ id: 100, candidate_id: 10 }], nextCursor: "c1" }),
      getWithCursor: async (_path: string, cursor: string): Promise<Resp> => {
        assert.equal(cursor, "c1");
        return { data: [{ id: 101, candidate_id: 10 }], nextCursor: null };
      },
    };
    const out = (await attachCandidateApplicationsForStageSnapshot([{ id: 10 }], deps)) as Array<Record<string, unknown>>;
    assert.deepStrictEqual(
      (out[0]!.applications as Array<{ id: number }>).map((a) => a.id),
      [100, 101]
    );
  });

  it("leaves a candidate untouched when its batch throws (→ null stage_snapshot, not a fabricated [])", async () => {
    const deps = {
      get: async (): Promise<Resp> => {
        throw new Error("Greenhouse 500");
      },
      getWithCursor: okEmpty,
    };
    const out = (await attachCandidateApplicationsForStageSnapshot([{ id: 10 }], deps)) as Array<Record<string, unknown>>;
    assert.ok(!("applications" in out[0]!), "a thrown batch must not inject a fabricated empty applications array");
  });

  it("injects [] for a fetched candidate with no applications", async () => {
    const deps = {
      get: async (): Promise<Resp> => ({ data: [{ id: 100, candidate_id: 10 }], nextCursor: null }),
      getWithCursor: okEmpty,
    };
    const out = (await attachCandidateApplicationsForStageSnapshot([{ id: 10 }, { id: 11 }], deps)) as Array<Record<string, unknown>>;
    assert.deepStrictEqual((out[0]!.applications as Array<{ id: number }>).map((a) => a.id), [100]);
    assert.deepStrictEqual(out[1]!.applications, []);
  });

  it("caps cursor-following at MAX_APPLICATION_PAGES_PER_BATCH (terminates on a runaway cursor)", async () => {
    let getCalls = 0;
    let cursorCalls = 0;
    const deps = {
      get: async (): Promise<Resp> => {
        getCalls += 1;
        return { data: [], nextCursor: "loop" };
      },
      getWithCursor: async (): Promise<Resp> => {
        cursorCalls += 1;
        return { data: [], nextCursor: "loop" };
      },
    };
    await attachCandidateApplicationsForStageSnapshot([{ id: 10 }], deps);
    assert.equal(getCalls, 1);
    assert.equal(cursorCalls, MAX_APPLICATION_PAGES_PER_BATCH - 1, "must stop following after the page cap, not loop forever");
  });
});
