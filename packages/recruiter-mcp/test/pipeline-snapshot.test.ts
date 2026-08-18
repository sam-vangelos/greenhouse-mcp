import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computePipelineStateSnapshot,
  computeStageFlowWoW,
  createSnapshotAccumulator,
  maybeStartPipelineSnapshotTimer,
  mondayOfUtcWeek,
  shouldRunStartupSweep,
  writePipelineStateSnapshot,
  type PipelineStateSnapshotRow,
  type SnapshotStoreClient,
} from "../src/pipeline-snapshot.js";

const WED = Date.parse("2026-07-01T15:00:00.000Z"); // a Wednesday

// v3 reality: stage_id on an application row is a PER-APPLICATION stage-instance id (never
// shared), while stage_name is the shared vocabulary. Every fixture app carries a distinct
// stage_id on purpose — folding must happen by name.
const APPS = [
  { id: 1, job_id: 10, stage_id: 9001, stage_name: "Phone Screen", status: "in_process" },
  { id: 2, job_id: 10, stage_id: 9002, stage_name: "Phone Screen", status: "in_process" },
  { id: 3, job_id: 10, stage_id: 9003, stage_name: "Onsite", status: "in_process" },
  { id: 4, job_id: 10, stage_id: 9004, stage_name: "Onsite", status: "rejected" }, // not occupancy
  { id: 5, job_id: 20, stage_id: 9005, stage_name: "Phone Screen", status: "hired" },
];

describe("pipeline state snapshot (temporal logbook, Option B)", () => {
  it("anchors the period key to the Monday of the UTC ISO week", () => {
    assert.equal(mondayOfUtcWeek(WED), "2026-06-29");
    assert.equal(mondayOfUtcWeek(Date.parse("2026-06-29T00:00:00.000Z")), "2026-06-29", "Monday maps to itself");
    assert.equal(mondayOfUtcWeek(Date.parse("2026-07-05T23:59:59.000Z")), "2026-06-29", "Sunday maps back to Monday");
  });

  it("buckets occupancy by stage NAME, never by v3's per-application stage_id (anti-shadow-copy)", () => {
    // The first live sweep keyed on stage_id and produced 167,697 buckets of size exactly 1 —
    // a per-application shadow copy, the grain the design doc forbids. Two apps sharing a stage
    // name with different instance ids MUST fold into one bucket.
    const rows = computePipelineStateSnapshot(APPS, WED, { scopeHash: "h", actorId: 900 });

    const phone10 = rows.find((row) => row.greenhouse_job_id === 10 && row.stage_name === "Phone Screen");
    const onsite10 = rows.find((row) => row.greenhouse_job_id === 10 && row.stage_name === "Onsite");
    const rollup10 = rows.find((row) => row.greenhouse_job_id === 10 && row.stage_name === "");
    const rollup20 = rows.find((row) => row.greenhouse_job_id === 20 && row.stage_name === "");

    assert.equal(phone10?.active_count, 2, "same-name apps fold into one bucket despite distinct stage ids");
    assert.equal(onsite10?.active_count, 1, "the rejected onsite application is not stage occupancy");
    assert.equal(
      rows.filter((row) => row.greenhouse_job_id === 10 && row.stage_name !== "").length,
      2,
      "exactly one row per distinct stage name, not one per application"
    );
    assert.deepEqual(rollup10?.status_mix, { in_process: 3, rejected: 1 });
    assert.equal(rollup10?.active_count, 3);
    assert.deepEqual(rollup20?.status_mix, { hired: 1 });
    assert.equal(rollup20?.active_count, 0, "a req with no active applications rolls up to zero, honestly");
    assert.ok(rows.every((row) => row.period_key === "2026-06-29"));
    assert.ok(rows.every((row) => row.scope_hash === "h" && row.actor_id === 900));
  });

  it("counts v3 row vocabulary as occupancy: rows say in_process where the filter says active", () => {
    // GET /v3/applications?status=active returns rows whose own status field is
    // "in_process" (the filter vocab and the row vocab differ). The first live sweep
    // folded 314k such rows into rollups with active_count 0 and zero stage rows.
    const v3Rows = [
      { id: 1, job_id: 10, stage_id: 9001, stage_name: "Phone Screen", status: "in_process" },
      { id: 2, job_id: 10, stage_id: 9002, stage_name: "Phone Screen", status: "in_process" },
      { id: 3, job_id: 10, stage_id: 9003, stage_name: "Onsite", status: "rejected" },
    ];
    const rows = computePipelineStateSnapshot(v3Rows, WED);
    const phone = rows.find((row) => row.greenhouse_job_id === 10 && row.stage_name === "Phone Screen");
    const rollup = rows.find((row) => row.greenhouse_job_id === 10 && row.stage_name === "");
    assert.equal(phone?.active_count, 2, "in_process rows occupy their stage");
    assert.equal(rollup?.active_count, 2, "the rollup's active_count counts in_process rows");
    assert.deepEqual(rollup?.status_mix, { in_process: 2, rejected: 1 }, "the mix keeps the raw vocabulary");
  });

  it("re-running within the same week produces identical keys (idempotent upsert target)", () => {
    const monday = computePipelineStateSnapshot(APPS, Date.parse("2026-06-29T09:00:00.000Z"));
    const friday = computePipelineStateSnapshot(APPS, Date.parse("2026-07-03T09:00:00.000Z"));
    assert.deepEqual(
      monday.map((row) => [row.period_key, row.greenhouse_job_id, row.stage_name]),
      friday.map((row) => [row.period_key, row.greenhouse_job_id, row.stage_name])
    );
  });

  it("diffs the two most recent weeks per req-stage-name, including emptied and newly-occupied stages", () => {
    const week1 = computePipelineStateSnapshot(APPS, Date.parse("2026-06-22T09:00:00.000Z"));
    const week2Apps = [
      // stage ids differ from week 1 even for the SAME stage (per-application instances);
      // the diff must line up by name regardless.
      { id: 1, job_id: 10, stage_id: 9101, stage_name: "Phone Screen", status: "in_process" }, // 2 -> 1
      { id: 3, job_id: 10, stage_id: 9102, stage_name: "Offer", status: "in_process" }, // new stage
      { id: 4, job_id: 10, stage_id: 9103, stage_name: "Onsite", status: "rejected" },
      { id: 5, job_id: 20, stage_id: 9104, stage_name: "Phone Screen", status: "hired" },
    ];
    const week2 = computePipelineStateSnapshot(week2Apps, Date.parse("2026-06-29T09:00:00.000Z"));

    const wow = computeStageFlowWoW([...week1, ...week2]);
    assert.equal(wow.previousPeriod, "2026-06-22");
    assert.equal(wow.currentPeriod, "2026-06-29");
    const at = (jobId: number, stageName: string) =>
      wow.deltas.find((delta) => delta.greenhouse_job_id === jobId && delta.stage_name === stageName);
    assert.equal(at(10, "Phone Screen")?.delta, -1, "phone screen drained by one");
    assert.equal(at(10, "Onsite")?.delta, -1, "onsite emptied (present only last week) diffs against zero");
    assert.equal(at(10, "Offer")?.delta, 1, "offer newly occupied diffs from zero");
  });

  it("returns no deltas (never a fabricated trend) with fewer than two weeks of snapshots", () => {
    const week1 = computePipelineStateSnapshot(APPS, WED);
    assert.deepEqual(computeStageFlowWoW(week1).deltas, []);
    assert.deepEqual(computeStageFlowWoW([]).deltas, []);
  });

  it("writer is DORMANT by default: computes rows but refuses to write without the env gate", async () => {
    let upsertCalls = 0;
    const client: SnapshotStoreClient = {
      async upsertRows() {
        upsertCalls += 1;
        return { upserted: 99 };
      },
    };
    const dormant = await writePipelineStateSnapshot({} as NodeJS.ProcessEnv, APPS, WED, {}, client);
    assert.equal(dormant.enabled, false);
    assert.equal(dormant.upserted, 0);
    assert.equal(upsertCalls, 0, "the store must NEVER be touched while the gate is off");
    assert.ok(dormant.rows.length > 0, "the plan is still computed for dry-run visibility");

    const enabled = await writePipelineStateSnapshot(
      { GREENHOUSE_RECRUITER_SNAPSHOT_ENABLED: "true" } as NodeJS.ProcessEnv,
      APPS,
      WED,
      {},
      client
    );
    assert.equal(enabled.enabled, true);
    assert.equal(upsertCalls, 1);
  });

  it("page-streamed accumulation equals batch computation (O(page) memory refactor is lossless)", () => {
    // The sweep folds PAGES into counters instead of holding the org's rows (the 512MB
    // earlyExit crash fix); splitting the same rows across pages must change nothing.
    const accumulator = createSnapshotAccumulator();
    accumulator.addPage(APPS.slice(0, 2));
    accumulator.addPage(APPS.slice(2, 4));
    accumulator.addPage(APPS.slice(4));
    assert.deepStrictEqual(accumulator.finalize(WED), computePipelineStateSnapshot(APPS, WED));
  });

  it("in-service timer is DORMANT by default and starts only behind the env gate", () => {
    assert.equal(maybeStartPipelineSnapshotTimer({} as NodeJS.ProcessEnv), null, "no timer without the gate");
    const timer = maybeStartPipelineSnapshotTimer(
      { GREENHOUSE_RECRUITER_SNAPSHOT_ENABLED: "true" } as NodeJS.ProcessEnv,
      async () => {} // injected sweep: the timer test must never touch Greenhouse/Supabase
    );
    assert.notEqual(timer, null);
    if (timer) clearInterval(timer);
  });

  it("upsert keys stay unique per req-stage-name-week (the migration's conflict target holds)", () => {
    const rows: PipelineStateSnapshotRow[] = computePipelineStateSnapshot(APPS, WED);
    const keys = rows.map((row) => `${row.period_key}|${row.greenhouse_job_id}|${row.stage_name}`);
    assert.equal(new Set(keys).size, keys.length);
  });
});

// Analog fix program slice 4 (2026-07-02): the logbook was the ONE occupancy surface with zero
// prospect handling — every analyzer (pipeline_quality, source_quality, stage_latency) excludes
// prospect applications from pipeline math and discloses it, so logbook occupancy counting them
// silently would contradict the analyzers' numbers for the same reqs the moment WoW goes live.
describe("prospect exclusion (consistency with every analyzer surface)", () => {
  it("prospect rows never fold into occupancy or the status mix (belt for the upstream filter)", () => {
    const rows = computePipelineStateSnapshot(
      [
        { id: 1, job_id: 10, stage_id: 9001, stage_name: "Phone Screen", status: "in_process" },
        { id: 2, job_id: 10, stage_id: 9002, stage_name: "Reached Out", status: "in_process", prospect: true },
        { id: 3, job_id: 10, stage_id: 9003, stage_name: "Sourced Candidates", status: "in_process", prospect: true },
      ],
      WED
    );
    const phone = rows.find((row) => row.greenhouse_job_id === 10 && row.stage_name === "Phone Screen");
    const rollup = rows.find((row) => row.greenhouse_job_id === 10 && row.stage_name === "");
    assert.equal(phone?.active_count, 1);
    assert.equal(rows.some((row) => row.stage_name === "Reached Out" || row.stage_name === "Sourced Candidates"), false, "prospect stages never appear as occupancy");
    assert.deepEqual(rollup?.status_mix, { in_process: 1 }, "prospects stay out of the mix too — the logbook measures the applicant pipeline");
    assert.equal(rollup?.active_count, 1);
  });
});

// Head-of-TA demo finding #2 (2026-07-02): every deploy's boot fired a full org sweep, and the
// demo's heaviest question raced one — rate-budget contention read as "the tool choked". The
// STARTUP sweep now runs only when the logbook is stale; the daily interval always runs.
describe("startup sweep freshness gate", () => {
  it("skips the startup sweep when the newest snapshot is fresh, runs when stale/absent/garbled", () => {
    const now = Date.parse("2026-07-02T21:00:00.000Z");
    assert.equal(shouldRunStartupSweep("2026-07-02T20:14:12.307+00:00", now), false, "a snapshot from 46 minutes ago is fresh — skip");
    assert.equal(shouldRunStartupSweep("2026-07-02T14:00:00.000Z", now), true, "7 hours old is stale — sweep");
    assert.equal(shouldRunStartupSweep(null, now), true, "no snapshot yet — sweep");
    assert.equal(shouldRunStartupSweep("not-a-date", now), true, "unparseable timestamp fails OPEN toward sweeping");
  });
});
