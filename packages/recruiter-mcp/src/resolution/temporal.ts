/**
 * Temporal-now view (Axis 1, the no-fork slice). Recruiters keep asking week-over-week pipeline
 * questions ("is inflow up or down this week?") that a point-in-time snapshot cannot answer. Application
 * `created_at` IS a real, spread timestamp, so weekly inflow, a genuine two-window WoW diff, a weekly
 * status-mix trend, and inflow velocity are all computable — in memory, over the application set the
 * recipe already read (the analysis window spans many weeks; no second read).
 *
 * HONESTY FLOOR: this view is built ONLY from `created_at`. True stage-flow-over-time (how candidates
 * moved stage-to-stage each week) needs application_stages `entered_at`, which is often null or backfilled
 * in Harvest v3 — so it is NOT reconstructable and is disclosed as
 * unavailable, never manufactured as zero (mirroring stage_conversion_rate's notImplemented metric).
 *
 * WoW correctness: the diff compares the two most recent COMPLETE CALENDAR weeks (last full week vs the
 * week before it), reading 0 for a week with no inflow. It never folds in the in-progress (partial)
 * week — comparing a partial week against a full one would understate the current week — so the partial
 * week is reported separately. Calendar-adjacent (not "two most recent weeks that happened to have
 * data") so a quiet week reads as a real 0, never as a skipped comparison against a non-adjacent week.
 *
 * WINDOWED MODE: a caller that states an analysis window passes it here, and the view is then anchored
 * to `window_end` rather than to now, bounded to `window_start`, and horizoned by the window's own span
 * instead of a fixed 12 weeks. That is what makes a historical question answerable at all — anchored to
 * now, a six-month-old window produced an EMPTY weekly series, because every bucket fell outside the
 * 12-week horizon before now. The 0-for-a-missing-week reading survives only INSIDE the window: a
 * comparison week that is not wholly inside it is reported as null-with-a-reason, never as a real 0,
 * because "no rows read for that week" and "that week was never in scope" are different facts.
 *
 * IN OR OUT IS A RECORD'S QUESTION, NOT ITS WEEK'S. Every record is classified by its OWN timestamp
 * against window_start/window_end BEFORE anything is bucketed. Bucketing first and then comparing each
 * bucket's Monday to the raw bounds got both edges wrong on the ordinary midweek window: a Wednesday
 * window_start sits after its own week's Monday, so the whole first partial week — including records
 * created inside the window — was dropped and counted as `excluded_before_window`; and a record created
 * after window_end but inside the anchor week was displayed as inflow and counted nowhere. The two edge
 * buckets are therefore genuine PARTIAL weeks (the window covers only part of their calendar week) and
 * are marked `partial: true` so a reader never reads a part-week's count as a full week's inflow.
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
  /**
   * True when the stated window covers only PART of this calendar week (the first bucket of a window
   * that starts midweek, the last bucket of one that ends midweek). Present only in windowed mode. Its
   * count is a part-week's inflow and must not be compared like-for-like against a full week's.
   */
  partial?: true;
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

export interface TemporalWindowSummary {
  /** The caller's stated window, echoed so the buckets below can be read against it. */
  start: string;
  end: string;
  /** Calendar weeks the window spans: ceil((end - start) / 7d). */
  weeks_covered: number;
  /** The first/last week actually present in weekly_inflow; null when the window produced no bucket. */
  first_bucket_week: string | null;
  last_bucket_week: string | null;
  /** Dated records whose OWN timestamp fell before/after the window (not their week's Monday — a
   *  midweek bound splits a calendar week, and the records on the far side of it are out of scope even
   *  though their week is in scope). These rows are still analysed in the recipe's snapshot cohort —
   *  they are excluded from the INFLOW series only, which is why they are reported here rather than as
   *  completeness exclusions. */
  excluded_before_window: number;
  excluded_after_window: number;
  /** Records carrying no parseable inflow timestamp at all. */
  missing_timestamp: number;
}

export interface TemporalView {
  basis: string;
  horizon_weeks: number;
  /** Present only when the caller stated a window; null in unwindowed (now-anchored) mode. */
  inflow_window: TemporalWindowSummary | null;
  weekly_inflow: WeeklyBucket[];
  /**
   * The current, still-accumulating week — reported separately so it never distorts the WoW diff.
   * Null whenever the anchor week is not the LIVE week: a historical window's last week finished long
   * ago, and calling it "still accumulating" invited a reader to discount a complete number.
   */
  in_progress_week: WeeklyBucket | null;
  /** The genuine two-window diff over the two most recent COMPLETE calendar weeks; null only when now
   *  is unresolvable or there are zero dated records. */
  week_over_week: WeekOverWeek | null;
  /** Null when the comparison weeks are not wholly inside the stated window — see
   *  comparison_unavailable_reason. Never a 0-filled stand-in for an out-of-window week. */
  velocity: TemporalVelocity | null;
  /** Why week_over_week and velocity are null, when they are. Null when they were computed. */
  comparison_unavailable_reason: string | null;
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
  /**
   * The caller's analysis window. When BOTH bounds are given the view switches to windowed mode:
   * anchored at windowEnd, bounded below by windowStart, horizoned by the window's own span.
   */
  windowStart?: string;
  windowEnd?: string;
}

const DEFAULT_MAX_WEEKS = 12;
const TREND_THRESHOLD = 0.1;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const STAGE_FLOW_UNAVAILABLE_REASON =
  "Stage-flow over time (week-by-week stage-to-stage movement) requires application_stages entered_at, " +
  "which is often null or backfilled in Harvest v3, so it is not " +
  "reconstructable from history and is not reported. The weekly inflow, status mix, and WoW diff above " +
  "are computed from real application created_at timestamps.";

export function buildTemporalView(records: TemporalRecord[], options: BuildTemporalOptions): TemporalView {
  const windowed = resolveWindowMode(options);
  const maxWeeks = windowed
    ? windowed.weeksCovered
    : options.maxWeeks && options.maxWeeks > 0
      ? Math.floor(options.maxWeeks)
      : DEFAULT_MAX_WEEKS;

  // Classify every record on ITS OWN timestamp first. In unwindowed mode there are no bounds to
  // classify against, so every dated record is "inside" and the horizon below does the trimming.
  const buckets = new Map<string, WeeklyBucket>();
  let datedRecords = 0;
  let missingTimestamp = 0;
  let excludedBeforeWindow = 0;
  let excludedAfterWindow = 0;
  for (const record of records) {
    const at = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : Number.NaN;
    const week = Number.isFinite(at) ? weekKey(record.timestamp) : null;
    if (!week) {
      missingTimestamp += 1;
      continue;
    }
    if (windowed) {
      if (at < windowed.startMs) {
        excludedBeforeWindow += 1;
        continue;
      }
      if (at > windowed.endMs) {
        excludedAfterWindow += 1;
        continue;
      }
    }
    datedRecords += 1;
    const bucket = buckets.get(week) ?? { week, count: 0, status_mix: {} };
    bucket.count += 1;
    const status = typeof record.status === "string" && record.status.length > 0 ? record.status : null;
    if (status) bucket.status_mix[status] = (bucket.status_mix[status] ?? 0) + 1;
    buckets.set(week, bucket);
  }

  // Windowed mode anchors on window_end; otherwise on now, as before.
  const currentWeek = windowed ? windowed.anchorWeek : weekKey(safeIso(options.nowMs));
  const horizonStartWeek = currentWeek ? shiftWeek(currentWeek, -(maxWeeks - 1)) : null;
  // In windowed mode the lower bound is the WEEK CONTAINING window_start, not window_start's calendar
  // date: the bucket keys are Mondays, so comparing them to a midweek date deleted the window's own
  // first partial week. The records inside that week were already bounded above, by their own
  // timestamps, which is where the question belongs.
  const lowerBoundWeek = windowed ? windowed.startWeek : horizonStartWeek;

  const weeklyInflow = [...buckets.values()]
    .filter((bucket) => (lowerBoundWeek ? bucket.week >= lowerBoundWeek : true) && (currentWeek ? bucket.week <= currentWeek : true))
    .sort((a, b) => a.week.localeCompare(b.week));
  if (windowed) markPartialEdgeWeeks(weeklyInflow, windowed);

  // The anchor week is "still accumulating" only when it IS this week. A historical window's last
  // week is finished; labelling it in-progress told the reader to discount a complete count.
  const liveWeek = weekKey(safeIso(options.nowMs));
  const inProgressWeek = currentWeek && currentWeek === liveWeek ? buckets.get(currentWeek) ?? null : null;

  // A comparison week that is not WHOLLY inside the stated window is not a quiet week — it was never
  // in scope. Substituting 0 for it manufactured a delta out of the window's own edge.
  const comparisonUnavailableReason = windowed ? windowComparisonGap(windowed, currentWeek) : null;

  return {
    basis: options.basis ?? "application created_at (real, spread timestamp)",
    horizon_weeks: maxWeeks,
    inflow_window: windowed
      ? {
          start: windowed.start,
          end: windowed.end,
          weeks_covered: windowed.weeksCovered,
          first_bucket_week: weeklyInflow[0]?.week ?? null,
          last_bucket_week: weeklyInflow[weeklyInflow.length - 1]?.week ?? null,
          excluded_before_window: excludedBeforeWindow,
          excluded_after_window: excludedAfterWindow,
          missing_timestamp: missingTimestamp,
        }
      : null,
    weekly_inflow: weeklyInflow,
    in_progress_week: inProgressWeek,
    week_over_week: comparisonUnavailableReason ? null : computeWeekOverWeek(buckets, currentWeek, datedRecords),
    velocity: comparisonUnavailableReason ? null : computeVelocity(buckets, currentWeek, maxWeeks),
    comparison_unavailable_reason: comparisonUnavailableReason,
    stage_flow_over_time: { available: false, reason: STAGE_FLOW_UNAVAILABLE_REASON },
    inflow_provenance: assessInflowProvenance(records, options.nowMs),
  };
}

/**
 * Flag the edge buckets whose calendar week the window only partly covers. Only the two edge weeks can
 * be partial: every week between them is wholly inside the window by construction.
 */
function markPartialEdgeWeeks(weeklyInflow: WeeklyBucket[], windowed: WindowMode): void {
  for (const bucket of weeklyInflow) {
    const weekStartMs = Date.parse(`${bucket.week}T00:00:00.000Z`);
    const weekEndMs = weekStartMs + WEEK_MS - 1;
    if (weekStartMs < windowed.startMs || weekEndMs > windowed.endMs) bucket.partial = true;
  }
}

interface WindowMode {
  start: string;
  end: string;
  /** The bounds every RECORD is classified against, to the millisecond. */
  startMs: number;
  endMs: number;
  /** Monday of the week CONTAINING window_start; the first bucket the series may display. */
  startWeek: string;
  anchorWeek: string;
  weeksCovered: number;
}

function resolveWindowMode(options: BuildTemporalOptions): WindowMode | null {
  if (!options.windowStart || !options.windowEnd) return null;
  const startMs = Date.parse(options.windowStart);
  const endMs = Date.parse(options.windowEnd);
  const anchorWeek = weekKey(options.windowEnd);
  const startWeek = weekKey(options.windowStart);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs || !anchorWeek || !startWeek) return null;
  return {
    start: options.windowStart,
    end: options.windowEnd,
    startMs,
    endMs,
    startWeek,
    anchorWeek,
    weeksCovered: Math.max(1, Math.ceil((endMs - startMs) / WEEK_MS)),
  };
}

function windowComparisonGap(windowed: WindowMode, currentWeek: string | null): string | null {
  if (!currentWeek) return null;
  const lastComplete = shiftWeek(currentWeek, -1);
  const prior = shiftWeek(currentWeek, -2);
  const outside = [lastComplete, prior].filter((week) => !isWeekInsideWindow(week, windowed));
  if (outside.length === 0) return null;
  return (
    `Week-over-week and velocity are not reported: the comparison week${outside.length > 1 ? "s" : ""} ` +
    `${outside.join(" and ")} ${outside.length > 1 ? "are" : "is"} not wholly inside the requested window ` +
    `(${windowed.start} to ${windowed.end}), so this analysis read no complete week of inflow for ` +
    `${outside.length > 1 ? "them" : "it"}. A count of 0 would report a quiet week where there was ` +
    `simply no window. Widen window_start to at least three complete calendar weeks for a diff.`
  );
}

// Wholly inside, to the millisecond and on the same bounds every record is classified against — so a
// week the series marks `partial` is exactly a week this refuses as a comparison week.
function isWeekInsideWindow(week: string, windowed: WindowMode): boolean {
  const weekStartMs = Date.parse(`${week}T00:00:00.000Z`);
  if (!Number.isFinite(weekStartMs)) return false;
  return weekStartMs >= windowed.startMs && weekStartMs + WEEK_MS - 1 <= windowed.endMs;
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
