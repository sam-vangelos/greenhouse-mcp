import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildTemporalView, type TemporalRecord } from "../src/resolution/temporal.js";

// Wednesday 2026-06-24; weekKey snaps to Monday 2026-06-22 (the current, in-progress week).
const NOW = Date.parse("2026-06-24T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function rec(iso: string | null, status?: string): TemporalRecord {
  return { timestamp: iso, status };
}

describe("temporal-now view (Axis 1)", () => {
  it("computes a genuine two-window WoW diff over two distinct complete weeks (revert lock)", () => {
    const records: TemporalRecord[] = [
      // prior complete week (Mon 2026-06-08): 3 apps
      rec("2026-06-09T10:00:00.000Z"), rec("2026-06-10T10:00:00.000Z"), rec("2026-06-11T10:00:00.000Z"),
      // last complete week (Mon 2026-06-15): 5 apps
      rec("2026-06-16T10:00:00.000Z"), rec("2026-06-16T11:00:00.000Z"), rec("2026-06-17T10:00:00.000Z"),
      rec("2026-06-18T10:00:00.000Z"), rec("2026-06-19T10:00:00.000Z"),
      // current in-progress week (Mon 2026-06-22): 2 apps — must NOT enter the WoW
      rec("2026-06-23T10:00:00.000Z"), rec("2026-06-23T11:00:00.000Z"),
    ];
    const view = buildTemporalView(records, { nowMs: NOW });
    assert.ok(view.week_over_week, "WoW must be present with >=1 dated record");
    const wow = view.week_over_week!;
    // Two DISTINCT weekly cohorts — the heart of week-over-week.
    assert.notEqual(wow.current_week, wow.prior_week);
    assert.equal(wow.current_count, 5);
    assert.equal(wow.prior_count, 3);
    assert.equal(wow.delta, 2);
    assert.equal(wow.pct_change, 0.6667);
    // The partial current week is reported separately and excluded from the WoW.
    assert.ok(view.in_progress_week);
    assert.equal(view.in_progress_week!.count, 2);
    assert.notEqual(view.in_progress_week!.week, wow.current_week);
  });

  it("reads a quiet week as a real 0, not a skipped comparison (pct_change null when prior is 0)", () => {
    const records: TemporalRecord[] = [
      // last complete week (2026-06-15): 4 apps; the prior week (2026-06-08) had NONE.
      rec("2026-06-16T10:00:00.000Z"), rec("2026-06-16T12:00:00.000Z"),
      rec("2026-06-17T10:00:00.000Z"), rec("2026-06-18T10:00:00.000Z"),
    ];
    const wow = buildTemporalView(records, { nowMs: NOW }).week_over_week!;
    assert.equal(wow.current_count, 4);
    assert.equal(wow.prior_count, 0);
    assert.equal(wow.delta, 4);
    assert.equal(wow.pct_change, null); // growth from 0 is undefined, not Infinity
  });

  it("carries a weekly status-mix trend from real status data", () => {
    const records: TemporalRecord[] = [
      rec("2026-06-16T10:00:00.000Z", "active"), rec("2026-06-16T11:00:00.000Z", "active"),
      rec("2026-06-17T10:00:00.000Z", "rejected"), rec("2026-06-18T10:00:00.000Z", "hired"),
    ];
    const view = buildTemporalView(records, { nowMs: NOW });
    const week = view.weekly_inflow.find((b) => b.count === 4);
    assert.ok(week);
    assert.equal(week!.status_mix.active, 2);
    assert.equal(week!.status_mix.rejected, 1);
    assert.equal(week!.status_mix.hired, 1);
  });

  it("anchors WoW on the last COMPLETE calendar week even when it is empty (adjacency, not last-week-with-data)", () => {
    // Last complete week (Mon 2026-06-15) had ZERO inflow; the week before (2026-06-08) had 3. A naive
    // "most recent week that has data" impl would wrongly report 3 as the current week. Calendar-
    // adjacency correctly reports the last complete week as a real 0 — inflow stopped.
    const records: TemporalRecord[] = [
      rec("2026-06-09T10:00:00.000Z"), rec("2026-06-10T10:00:00.000Z"), rec("2026-06-11T10:00:00.000Z"),
    ];
    const wow = buildTemporalView(records, { nowMs: NOW }).week_over_week!;
    assert.equal(wow.current_count, 0, "the last complete week was genuinely empty");
    assert.equal(wow.prior_count, 3);
    assert.equal(wow.delta, -3);
    assert.notEqual(wow.current_week, wow.prior_week);
  });

  it("reports inflow velocity and a trend over the active span", () => {
    // 6 consecutive complete weeks, rising: 1,2,3,4,5,6 apps ending the week before current.
    const records: TemporalRecord[] = [];
    for (let w = 6; w >= 1; w -= 1) {
      const weekMondayMs = Date.parse("2026-06-15T00:00:00.000Z") - (w - 1) * 7 * DAY;
      for (let i = 0; i < 7 - w; i += 1) records.push(rec(new Date(weekMondayMs + DAY).toISOString()));
    }
    const view = buildTemporalView(records, { nowMs: NOW });
    assert.ok(view.velocity.complete_weeks_observed >= 4);
    assert.equal(view.velocity.trend, "rising");
    assert.ok(view.velocity.recent_4w_mean_weekly_inflow > view.velocity.mean_weekly_inflow);
  });

  it("reports the caller's actual inflow anchor in basis (not a hardcoded created_at claim)", () => {
    // Recipes resolve different inflow timestamps (pipeline created_at-first, source applied_at-first),
    // so the view must echo the anchor the caller declares rather than always claiming created_at.
    const view = buildTemporalView([rec("2026-06-16T10:00:00.000Z")], {
      nowMs: NOW,
      basis: "application applied_at (inflow anchor; falls back to created_at)",
    });
    assert.match(view.basis, /applied_at/);
  });

  it("discloses stage-flow-over-time as unavailable (L3), never fabricated", () => {
    const view = buildTemporalView([rec("2026-06-16T10:00:00.000Z")], { nowMs: NOW });
    assert.equal(view.stage_flow_over_time.available, false);
    assert.match(view.stage_flow_over_time.reason, /entered_at|not reconstructable|L3/);
  });

  it("bounds the weekly series to the recent horizon", () => {
    // One app 30 weeks ago + one last week; horizon default 12 → only the recent one shows.
    const oldMs = Date.parse("2026-06-15T00:00:00.000Z") - 30 * 7 * DAY;
    const records: TemporalRecord[] = [rec(new Date(oldMs + DAY).toISOString()), rec("2026-06-16T10:00:00.000Z")];
    const view = buildTemporalView(records, { nowMs: NOW, maxWeeks: 12 });
    assert.equal(view.weekly_inflow.length, 1, "the 30-week-old week falls outside the 12-week horizon");
    assert.equal(view.weekly_inflow[0].count, 1);
  });

  it("returns no WoW when there are no dated records", () => {
    const view = buildTemporalView([rec(null), { timestamp: "not-a-date" }], { nowMs: NOW });
    assert.equal(view.week_over_week, null);
    assert.equal(view.weekly_inflow.length, 0);
  });

  // R5: the weekly inflow is the L3 fallback (stage-flow timing is gone), built entirely from
  // application created_at. On a migration-backfilled instance created_at can be import-clustered, which
  // makes the inflow ITSELF a load artifact — so the view discloses whether its own basis is trustworthy
  // (reusing the L4/R1 cluster detector) rather than presenting the fallback as solid.
  it("discloses the inflow as UNRELIABLE when application created_at is itself import-clustered (R5)", () => {
    // 40 applications all created within a ~20-minute window — the migration-backfill shape. REVERT the
    // assessInflowProvenance call (hardcode reliable:true) and this flips to reliable, so it fails.
    const base = Date.parse("2026-06-16T09:00:00.000Z"); // inside a complete past week
    const records: TemporalRecord[] = Array.from({ length: 40 }, (_unused, i) => rec(new Date(base + i * 30 * 1000).toISOString()));
    const view = buildTemporalView(records, { nowMs: NOW });
    assert.equal(view.inflow_provenance.reliable, false, "load-clustered created_at makes the weekly inflow a load artifact, not real timing");
    assert.ok(view.inflow_provenance.reason, "an unreliable inflow basis must carry a reason");
    assert.match(view.inflow_provenance.reason ?? "", /clustered into a load window/);
    assert.match(view.inflow_provenance.reason ?? "", /verify directly in Greenhouse/);
  });

  it("keeps the inflow RELIABLE when created_at is spread across weeks (R5)", () => {
    // 40 applications, one per day over ~6 weeks — real inflow, no load cluster.
    const records: TemporalRecord[] = Array.from({ length: 40 }, (_unused, i) => rec(new Date(NOW - (i + 1) * DAY).toISOString()));
    const view = buildTemporalView(records, { nowMs: NOW });
    assert.equal(view.inflow_provenance.reliable, true);
    assert.equal(view.inflow_provenance.reason, undefined, "a trustworthy inflow basis carries no reason");
  });

  it("does not cry wolf on a small same-day cohort (below the cluster floor) — a genuinely new req reads reliable (R5)", () => {
    // Only 8 apps, even bunched same-day: below the cluster detector's 30-record floor, so a small/new
    // req is NOT falsely flagged as a migration artifact (mirrors R1's conservative calibration).
    const base = Date.parse("2026-06-16T09:00:00.000Z");
    const records: TemporalRecord[] = Array.from({ length: 8 }, (_unused, i) => rec(new Date(base + i * 60 * 1000).toISOString()));
    const view = buildTemporalView(records, { nowMs: NOW });
    assert.equal(view.inflow_provenance.reliable, true, "a small cohort is not enough to call the inflow a load artifact");
  });
});
