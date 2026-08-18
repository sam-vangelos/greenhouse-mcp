/**
 * Temporal-now view (Axis 1, the no-fork slice). Recruiters keep asking week-over-week pipeline
 * questions ("is inflow up or down this week?") that a point-in-time snapshot cannot answer. Application
 * `created_at` IS a real, spread timestamp, so weekly inflow, a genuine two-window WoW diff, a weekly
 * status-mix trend, and inflow velocity are all computable — in memory, over the application set the
 * recipe already read (the analysis window spans many weeks; no second read).
 *
 * HONESTY FLOOR: this view is built ONLY from `created_at`. True stage-flow-over-time (how candidates
 * moved stage-to-stage each week) needs application_stages `entered_at`, which is null/backfilled on
 * this Greenhouse instance (live-pilot finding L3) — so it is NOT reconstructable and is disclosed as
 * unavailable, never manufactured as zero (mirroring stage_conversion_rate's notImplemented metric).
 *
 * WoW correctness: the diff compares the two most recent COMPLETE CALENDAR weeks (last full week vs the
 * week before it), reading 0 for a week with no inflow. It never folds in the in-progress (partial)
 * week — comparing a partial week against a full one would understate the current week — so the partial
 * week is reported separately. Calendar-adjacent (not "two most recent weeks that happened to have
 * data") so a quiet week reads as a real 0, never as a skipped comparison against a non-adjacent week.
 */

import { weekKey } from "../metrics.js";
import { detectDataProvenance } from "./provenance.js";

export interface TemporalRecord {
  /** Application creation timestamp (created_at / applied_at) — the real, spread temporal signal. */
  timestamp: string | null;
  /** Normalized application status, for the weekly status-mix trend. Omit to skip the mix. */
  status?: string | null;
}

export interface WeeklyBucket {
  week: string; // Monday (UTC) of the ISO week, YYYY-MM-DD — aligned with weekly_application_volume
  count: number;
  status_mix: Record<string, number>;
}

export interface WeekOverWeek {
  current_week: string;
  current_count: number;
  prior_week: string;
  prior_count: number;
  delta: number;
  /** Fractional change vs the prior week; null when the prior week was 0 (growth is undefined). */
  pct_change: number | null;
}

export interface TemporalVelocity {
  complete_weeks_observed: number;
  mean_weekly_inflow: number;
  recent_4w_mean_weekly_inflow: number;
  trend: "rising" | "falling" | "flat" | "insufficient_data";
}

export interface TemporalInflowProvenance {
  /** True when the created_at timestamps seeding the weekly inflow look like real, spread activity. */
  reliable: boolean;
  /** Present only when unreliable: why the inflow itself may be a load artifact, not real timing. */
  reason?: string;
}

export interface TemporalView {
  basis: string;
  horizon_weeks: number;
  weekly_inflow: WeeklyBucket[];
  /** The current, still-accumulating week — reported separately so it never distorts the WoW diff. */
  in_progress_week: WeeklyBucket | null;
  /** The genuine two-window diff over the two most recent COMPLETE calendar weeks; null only when now
   *  is unresolvable or there are zero dated records. */
  week_over_week: WeekOverWeek | null;
  velocity: TemporalVelocity;
  stage_flow_over_time: { available: false; reason: string };
  /**
   * Whether the created_at timestamps that seed the weekly inflow are THEMSELVES trustworthy. The whole
   * temporal view leans on created_at being a real, spread signal (the L3 fallback: stage-flow timing is
   * gone, so inflow-by-week is what's left). But on a migration-backfilled instance created_at can be
   * import-clustered — every application stamped at load time — which makes the inflow / WoW / velocity
   * ALSO artifacts of the load, not real timing. This runs the same cluster detector as the L4 provenance
   * pass (R1) over the view's own timestamps and, when it fires, discloses the inflow as unreliable
   * rather than presenting the fallback as solid.
   */
  inflow_provenance: TemporalInflowProvenance;
}

export interface BuildTemporalOptions {
  nowMs: number;
  /** Recent horizon for the weekly series + velocity. Defaults to 12 (weekly_application_volume's). */
  maxWeeks?: number;
  /**
   * Honest description of which timestamp seeded the weekly buckets. Recipes resolve their inflow
   * timestamp with different field priorities (pipeline_quality: created_at-first; source_quality:
   * applied_at-first), so each passes its actual anchor here rather than letting the view claim a
   * single field it may not have used.
   */
  basis?: string;
}

const DEFAULT_MAX_WEEKS = 12;
const TREND_THRESHOLD = 0.1;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const STAGE_FLOW_UNAVAILABLE_REASON =
  "Stage-flow over time (week-by-week stage-to-stage movement) requires application_stages entered_at, " +
  "which is null/backfilled on this Greenhouse instance (live-pilot finding L3), so it is not " +
  "reconstructable from history and is not reported. The weekly inflow, status mix, and WoW diff above " +
  "are computed from real application created_at timestamps.";

export function buildTemporalView(records: TemporalRecord[], options: BuildTemporalOptions): TemporalView {
  const maxWeeks = options.maxWeeks && options.maxWeeks > 0 ? Math.floor(options.maxWeeks) : DEFAULT_MAX_WEEKS;
  const buckets = new Map<string, WeeklyBucket>();
  let datedRecords = 0;
  for (const record of records) {
    const week = weekKey(record.timestamp);
    if (!week) continue;
    datedRecords += 1;
    const bucket = buckets.get(week) ?? { week, count: 0, status_mix: {} };
    bucket.count += 1;
    const status = typeof record.status === "string" && record.status.length > 0 ? record.status : null;
    if (status) bucket.status_mix[status] = (bucket.status_mix[status] ?? 0) + 1;
    buckets.set(week, bucket);
  }

  const currentWeek = weekKey(safeIso(options.nowMs));
  const horizonStartWeek = currentWeek ? shiftWeek(currentWeek, -(maxWeeks - 1)) : null;

  const weeklyInflow = [...buckets.values()]
    .filter((bucket) => (horizonStartWeek ? bucket.week >= horizonStartWeek : true) && (currentWeek ? bucket.week <= currentWeek : true))
    .sort((a, b) => a.week.localeCompare(b.week));

  const inProgressWeek = currentWeek ? buckets.get(currentWeek) ?? null : null;

  return {
    basis: options.basis ?? "application created_at (real, spread timestamp)",
    horizon_weeks: maxWeeks,
    weekly_inflow: weeklyInflow,
    in_progress_week: inProgressWeek,
    week_over_week: computeWeekOverWeek(buckets, currentWeek, datedRecords),
    velocity: computeVelocity(buckets, currentWeek, maxWeeks),
    stage_flow_over_time: { available: false, reason: STAGE_FLOW_UNAVAILABLE_REASON },
    inflow_provenance: assessInflowProvenance(records, options.nowMs),
  };
}

// The weekly inflow / WoW / velocity all lean on application created_at being a real, spread signal
// (the L3 fallback, since stage-flow timing is gone). But a migration-backfilled instance stamps every
// application's created_at at load time, so the inflow itself becomes a load artifact. Reuse the L4
// cluster detector (R1) over ALL the created_at timestamps fed to the view — the recipe's full read set,
// deliberately NOT horizon-trimmed to the displayed weeks: a backfill is an instance-level property, so a
// load cluster anywhere in the read makes the fallback suspect. Only recent_creation_cluster can fire here
// (no job anchors -> predate can't fire; no isTerminal -> all_default can't fire). Disclose when the inflow
// basis is unreliable rather than presenting the fallback as solid (R5). The disclosure is a hedge (treat
// as provisional / verify directly), never a changed number, so the honesty floor holds either way.
function assessInflowProvenance(records: TemporalRecord[], nowMs: number): TemporalInflowProvenance {
  const assessment = detectDataProvenance(
    records.map((record) => ({ timestamp: record.timestamp })),
    { nowMs, recordKind: "application" }
  );
  const cluster = assessment.signals.find((signal) => signal.code === "recent_creation_cluster");
  if (!cluster) {
    return { reliable: true };
  }
  return {
    reliable: false,
    reason:
      `The application created_at timestamps that seed this weekly inflow are themselves clustered into a ` +
      `load window (${cluster.detail}) — on a migration-backfilled instance created_at is stamped at import ` +
      `time, so the weekly inflow, WoW diff, and velocity here may reflect the data load rather than real ` +
      `application timing. Treat them as provisional and verify directly in Greenhouse.`,
  };
}

function computeWeekOverWeek(
  buckets: Map<string, WeeklyBucket>,
  currentWeek: string | null,
  datedRecords: number
): WeekOverWeek | null {
  if (!currentWeek || datedRecords === 0) return null;
  const lastComplete = shiftWeek(currentWeek, -1);
  const prior = shiftWeek(currentWeek, -2);
  const currentCount = buckets.get(lastComplete)?.count ?? 0;
  const priorCount = buckets.get(prior)?.count ?? 0;
  const delta = currentCount - priorCount;
  return {
    current_week: lastComplete,
    current_count: currentCount,
    prior_week: prior,
    prior_count: priorCount,
    delta,
    pct_change: priorCount === 0 ? null : round(delta / priorCount, 4),
  };
}

// Velocity over the COMPLETE calendar weeks (0-filled for quiet weeks) from the first week that carried
// inflow up to the last complete week, bounded to the horizon. Padding only within the active span — a
// req that started 3 weeks ago is not diluted by 9 leading zero-weeks.
function computeVelocity(
  buckets: Map<string, WeeklyBucket>,
  currentWeek: string | null,
  maxWeeks: number
): TemporalVelocity {
  if (!currentWeek) return emptyVelocity();
  const lastComplete = shiftWeek(currentWeek, -1);
  const horizonStart = shiftWeek(currentWeek, -maxWeeks);
  const completeWithData = [...buckets.keys()]
    .filter((week) => week >= horizonStart && week <= lastComplete)
    .sort();
  if (completeWithData.length === 0) return emptyVelocity();
  const firstDataWeek = completeWithData[0];

  // Build the dense calendar-week count series from firstDataWeek..lastComplete (0-filled gaps).
  const counts: number[] = [];
  for (let week = firstDataWeek; week <= lastComplete; week = shiftWeek(week, 1)) {
    counts.push(buckets.get(week)?.count ?? 0);
    if (counts.length > maxWeeks + 1) break; // guard against any pathological key
  }

  const mean = counts.reduce((sum, n) => sum + n, 0) / counts.length;
  const recent = counts.slice(-4);
  const recentMean = recent.reduce((sum, n) => sum + n, 0) / recent.length;
  return {
    complete_weeks_observed: counts.length,
    mean_weekly_inflow: round(mean, 2),
    recent_4w_mean_weekly_inflow: round(recentMean, 2),
    trend: computeTrend(counts),
  };
}

function computeTrend(counts: number[]): TemporalVelocity["trend"] {
  if (counts.length < 4) return "insufficient_data";
  const mid = Math.floor(counts.length / 2);
  const earlier = counts.slice(0, mid);
  const recent = counts.slice(mid);
  const earlierMean = earlier.reduce((sum, n) => sum + n, 0) / earlier.length;
  const recentMean = recent.reduce((sum, n) => sum + n, 0) / recent.length;
  if (earlierMean === 0) return recentMean > 0 ? "rising" : "flat";
  const change = (recentMean - earlierMean) / earlierMean;
  if (change > TREND_THRESHOLD) return "rising";
  if (change < -TREND_THRESHOLD) return "falling";
  return "flat";
}

function emptyVelocity(): TemporalVelocity {
  return { complete_weeks_observed: 0, mean_weekly_inflow: 0, recent_4w_mean_weekly_inflow: 0, trend: "insufficient_data" };
}

// Shift a Monday-anchored YYYY-MM-DD week key by `weeks` (negative = earlier). The key is UTC midnight
// Monday, so ±N*7 days stays on a Monday.
function shiftWeek(week: string, weeks: number): string {
  const ms = Date.parse(`${week}T00:00:00.000Z`);
  if (!Number.isFinite(ms)) return week;
  return new Date(ms + weeks * WEEK_MS).toISOString().slice(0, 10);
}

function safeIso(ms: number): string {
  try {
    return new Date(ms).toISOString();
  } catch {
    return "";
  }
}

function round(value: number, digits: number): number {
  const multiplier = 10 ** digits;
  return Math.round(value * multiplier) / multiplier;
}
