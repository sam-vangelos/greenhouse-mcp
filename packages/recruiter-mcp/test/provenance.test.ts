import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  detectDataProvenance,
  type ProvenanceRecord,
  type ProvenanceJobAnchor,
} from "../src/resolution/provenance.js";

const NOW = Date.parse("2026-06-30T18:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function isoAt(ms: number): string {
  return new Date(ms).toISOString();
}

// A spread of `count` records, one per day going back from `startDaysAgo`, optionally terminal.
function spreadRecords(count: number, startDaysAgo: number, isTerminal: boolean | undefined, jobId?: number): ProvenanceRecord[] {
  const records: ProvenanceRecord[] = [];
  for (let i = 0; i < count; i += 1) {
    records.push({ timestamp: isoAt(NOW - (startDaysAgo + i) * DAY_MS), isTerminal, jobId });
  }
  return records;
}

// A tight cluster: `count` records bunched within `spanMinutes`, ending `endDaysAgo` before now.
function clusteredRecords(count: number, spanMinutes: number, endDaysAgo: number, isTerminal: (i: number) => boolean | undefined, jobId?: number): ProvenanceRecord[] {
  const end = NOW - endDaysAgo * DAY_MS;
  const step = count > 1 ? (spanMinutes * 60 * 1000) / (count - 1) : 0;
  const records: ProvenanceRecord[] = [];
  for (let i = 0; i < count; i += 1) {
    records.push({ timestamp: isoAt(end - (count - 1 - i) * step), isTerminal: isTerminal(i), jobId });
  }
  return records;
}

describe("data-provenance detector (L4)", () => {
  it("stays quiet on healthy data: spread timestamps, mixed dispositions, no predate", () => {
    const records = spreadRecords(60, 1, false).map((record, i) => ({
      ...record,
      // ~30% terminal — a real pipeline carries dispositions.
      isTerminal: i % 3 === 0,
    }));
    const assessment = detectDataProvenance(records, { nowMs: NOW, recordKind: "application" });
    assert.equal(assessment.migration_suspected, false);
    assert.equal(assessment.warning, null);
    assert.equal(assessment.advisory, null, "dispositioned, spread data raises neither a warning nor an advisory");
    assert.equal(assessment.signals.length, 0);
  });

  it("flags a recent creation cluster: hundreds of records bunched into a tiny window", () => {
    // 40 records within 20 minutes, half terminal (so all-default-status does NOT also fire — isolates
    // the cluster signal). Real recruiting inflow never arrives 90%+ inside a 6-hour window.
    const records = clusteredRecords(40, 20, 0, (i) => i % 2 === 0);
    const assessment = detectDataProvenance(records, { nowMs: NOW, recordKind: "application" });
    const cluster = assessment.signals.find((signal) => signal.code === "recent_creation_cluster");
    assert.ok(cluster, "recent_creation_cluster must fire on a 40-record / 20-minute bunch");
    assert.equal(cluster?.records_flagged, 40);
    assert.equal(assessment.migration_suspected, true);
    assert.match(assessment.warning ?? "", /data migration/);
  });

  it("does NOT flag a cluster when timestamps are spread across weeks", () => {
    const records = clusteredRecords(40, 20, 0, () => undefined); // tight…
    const spread = spreadRecords(40, 1, undefined); // …vs spread
    assert.ok(detectDataProvenance(records, { nowMs: NOW }).signals.some((s) => s.code === "recent_creation_cluster"));
    assert.equal(detectDataProvenance(spread, { nowMs: NOW }).signals.some((s) => s.code === "recent_creation_cluster"), false);
  });

  it("flags all-default-status: a large cohort with zero dispositions", () => {
    // 60 records spread over 60 days (so the cluster signal does NOT fire), all non-terminal.
    const records = spreadRecords(60, 1, false);
    const assessment = detectDataProvenance(records, { nowMs: NOW, recordKind: "application" });
    const allDefault = assessment.signals.find((signal) => signal.code === "all_default_status");
    assert.ok(allDefault, "all_default_status must fire on 60 zero-disposition records");
    assert.equal(allDefault?.records_flagged, 60);
    assert.equal(assessment.signals.some((s) => s.code === "recent_creation_cluster"), false, "spread timestamps must not trip the cluster signal");
  });

  it("does NOT flag all-default-status when any disposition is present", () => {
    const records = spreadRecords(60, 1, false);
    records[0].isTerminal = true; // a single hire/reject is enough to look like real activity
    const assessment = detectDataProvenance(records, { nowMs: NOW });
    assert.equal(assessment.signals.some((s) => s.code === "all_default_status"), false);
  });

  it("does NOT flag all-default-status below the cohort-size floor", () => {
    const records = spreadRecords(49, 1, false); // 49 < ALL_DEFAULT_MIN_RECORDS (50)
    const assessment = detectDataProvenance(records, { nowMs: NOW });
    assert.equal(assessment.signals.some((s) => s.code === "all_default_status"), false);
  });

  it("flags records that predate the requisition opening, given anchors", () => {
    const anchors: ProvenanceJobAnchor[] = [{ jobId: 100, openedAt: isoAt(NOW - 4 * DAY_MS) }];
    // 20 records on job 100, all created ~30 days ago — long before the req opened 4 days ago.
    const records = spreadRecords(20, 30, undefined, 100);
    const assessment = detectDataProvenance(records, { nowMs: NOW, jobAnchors: anchors, recordKind: "application" });
    const predate = assessment.signals.find((signal) => signal.code === "records_predate_requisition");
    assert.ok(predate, "records_predate_requisition must fire when records precede opened_at");
    assert.equal(predate?.records_flagged, 20);
    assert.match(assessment.warning ?? "", /predate the requisition/);
  });

  it("does NOT flag predate without anchors (the planner/unscoped path)", () => {
    const records = spreadRecords(20, 30, undefined, 100);
    const assessment = detectDataProvenance(records, { nowMs: NOW });
    assert.equal(assessment.signals.some((s) => s.code === "records_predate_requisition"), false);
  });

  it("does NOT flag predate when only a small fraction precede the req (legit pre-open sourcing)", () => {
    // Req opened 200 days ago, so the 100 recent records (1–100 days ago) all post-date the open.
    const anchors: ProvenanceJobAnchor[] = [{ jobId: 100, openedAt: isoAt(NOW - 200 * DAY_MS) }];
    const after = spreadRecords(100, 1, undefined, 100);
    // Only 4 records precede the open — below both the 5-record floor and the 25% fraction.
    const before = [0, 1, 2, 3].map((i) => ({ timestamp: isoAt(NOW - (290 + i) * DAY_MS), jobId: 100 }));
    const assessment = detectDataProvenance([...after, ...before], { nowMs: NOW, jobAnchors: anchors });
    assert.equal(assessment.signals.some((s) => s.code === "records_predate_requisition"), false);
  });

  it("composes multiple signals into one warning when several migration shapes coincide", () => {
    // The live shape: a large cohort, all zero-disposition, all created in one recent burst.
    const records = clusteredRecords(80, 25, 0, () => false);
    const assessment = detectDataProvenance(records, { nowMs: NOW, recordKind: "application" });
    const codes = assessment.signals.map((s) => s.code).sort();
    assert.deepEqual(codes, ["all_default_status", "recent_creation_cluster"]);
    assert.equal(assessment.migration_suspected, true);
    assert.match(assessment.warning ?? "", /may reflect a recent data migration/);
    assert.match(assessment.warning ?? "", /provisional until verified/);
    // Corroborated migration asserts via `warning`, not the standalone advisory.
    assert.equal(assessment.advisory, null, "no separate backlog advisory when a load shape corroborates");
  });

  // R1: a STANDALONE all_default_status (no creation cluster, no predate) is the cry-wolf case — a
  // just-posted high-volume req nobody has triaged looks identical to a fresh migration. It must NOT be
  // asserted as a migration; it surfaces a neutral backlog advisory and degrades nothing.
  // REVERT TEST: restore `migration_suspected = signals.length > 0` (provenance.ts) and this fails —
  // migration_suspected flips true and the migration warning fires on a genuine backlog.
  it("does NOT assert migration on a standalone all-default cohort — surfaces a neutral backlog advisory (R1)", () => {
    // 60 zero-disposition records spread one-per-day over ~2 months: all_default_status fires ALONE — the
    // spread defeats the cluster signal and no anchors are supplied, so neither load shape is present.
    const records = spreadRecords(60, 1, false);
    const assessment = detectDataProvenance(records, { nowMs: NOW, recordKind: "application" });

    // all_default fired, and it fired alone.
    assert.deepEqual(assessment.signals.map((s) => s.code), ["all_default_status"], "only all_default_status should fire on a spread, anchorless, zero-disposition cohort");

    // The fix: standalone all_default is never a migration assertion.
    assert.equal(assessment.migration_suspected, false, "a zero-disposition backlog with no load shape must not read as a migration");
    assert.equal(assessment.warning, null, "no migration warning without a corroborating load shape (cluster or predate)");

    // It still surfaces — as a neutral advisory that names BOTH explanations, never an import assertion.
    assert.ok(assessment.advisory, "a standalone zero-disposition cohort must still surface a (non-migration) advisory");
    assert.match(assessment.advisory ?? "", /un-triaged backlog/);
    assert.match(assessment.advisory ?? "", /migrated data/);
    assert.doesNotMatch(assessment.advisory ?? "", /may reflect a recent data migration/, "the advisory must not assert a migration");
  });

  it("a corroborated all-default (all_default + predate) still asserts migration — corroboration, not suppression (R1)", () => {
    // Records predating the req opening (a load shape) AND zero dispositions: the corroborated case must
    // still assert a migration; the R1 change only neutralises the STANDALONE all_default.
    const anchors: ProvenanceJobAnchor[] = [{ jobId: 100, openedAt: isoAt(NOW - 4 * DAY_MS) }];
    const records = spreadRecords(60, 30, false, 100); // 60 zero-disposition records, all ~a month before open
    const assessment = detectDataProvenance(records, { nowMs: NOW, jobAnchors: anchors, recordKind: "application" });
    const codes = assessment.signals.map((s) => s.code).sort();
    assert.deepEqual(codes, ["all_default_status", "records_predate_requisition"], "both the load shape and zero-disposition signals should fire");
    assert.equal(assessment.migration_suspected, true, "all_default corroborating a predate load shape still asserts migration");
    assert.match(assessment.warning ?? "", /may reflect a recent data migration/);
    assert.equal(assessment.advisory, null, "no standalone advisory once a load shape corroborates");
  });
});
