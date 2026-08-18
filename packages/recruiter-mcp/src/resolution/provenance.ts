/**
 * Data-provenance / freshness detector (live-pilot finding L4).
 *
 * Real recruiter use surfaced recipes computing confident conclusions over data that was almost
 * certainly migration/backfill, not recruiting activity: a 4-day-old req carrying 276 applications
 * and 5 hires; 449 applications all in a non-terminal status with zero dispositions; application_stage
 * rows whose created_at all landed in a ~30-minute window today. Presenting artifacts of a data load as
 * if they were recruiting findings is the dishonest failure mode the honesty spine is supposed to
 * prevent — so this module gives every analysis recipe ONE uniform detector that flags the migration
 * shapes and WARNS, rather than letting each recipe decide ad hoc (or not at all).
 *
 * It is pure: a recipe maps the records it already read into {@link ProvenanceRecord}s (a creation
 * timestamp, an optional terminal flag, an optional job id) plus the job-open anchors threaded from the
 * already-loaded scope inventory, and gets back a {@link ProvenanceAssessment}. The recipe surfaces the
 * assessment in its completeness envelope — it never silently drops or "corrects" the data. Honesty
 * degrades (a warning + a partial status), it does not fabricate (no number is changed).
 *
 * Calibration follows the project's risk posture: this is an internal tool for trusted teammates, and
 * the cost of presenting a migration artifact as a finding is HIGH while the cost of a hedged
 * "may reflect a recent data migration" on a genuinely-new req is LOW. The thresholds are nonetheless
 * conservative — they only fire on shapes real recruiting inflow does not produce — so the warning
 * stays meaningful rather than crying wolf.
 */

export type ProvenanceRecordKind = "application" | "application_stage" | "scorecard" | "record";

export interface ProvenanceRecord {
  /** Creation timestamp of the record (application/stage/scorecard created_at, or applied_at). */
  timestamp: string | null;
  /**
   * Whether this record reached a terminal disposition. Only meaningful for cohorts that HAVE a
   * disposition concept (applications: hired/rejected/converted). Leave undefined for record kinds
   * with no disposition (stages, scorecards) — the all-default-status signal is then not evaluated.
   */
  isTerminal?: boolean | null;
  /** The requisition this record belongs to, for the predate-the-req signal. */
  jobId?: number | null;
}

/** The "req record" anchor for the predate signal: when the requisition opened for applications. */
export interface ProvenanceJobAnchor {
  jobId: number;
  openedAt: string | null;
}

export type ProvenanceSignalCode =
  | "recent_creation_cluster"
  | "records_predate_requisition"
  | "all_default_status";

export interface ProvenanceSignal {
  code: ProvenanceSignalCode;
  detail: string;
  /** Records this signal evaluated (the timestamped / anchored / disposition-bearing subset). */
  records_evaluated: number;
  /** Records this signal implicates (clustered / predating / non-terminal). */
  records_flagged: number;
}

export interface ProvenanceAssessment {
  /**
   * True only when a LOAD SHAPE fired — a recent creation cluster or records predating the requisition.
   * all_default_status alone never sets this: a large zero-disposition cohort is equally a genuine
   * un-triaged backlog, surfaced via {@link advisory} instead. `migration_suspected: true` degrades a
   * recipe's status to at least `partial`; an advisory degrades nothing.
   */
  migration_suspected: boolean;
  record_kind: ProvenanceRecordKind;
  records_evaluated: number;
  signals: ProvenanceSignal[];
  /**
   * The operator-facing warning when migration is suspected (a load shape fired); null otherwise. It names
   * BOTH explanations — a recent data migration AND genuinely un-worked recruiting activity — so a real
   * backlog is never flatly asserted to be an import. A recipe surfaces this so the numbers read as
   * provisional, not as findings.
   */
  warning: string | null;
  /**
   * A NON-migration advisory for the ambiguous standalone shape: a large zero-disposition cohort with NO
   * corroborating load shape. That is equally an un-triaged backlog or migrated data, so it is surfaced as
   * a neutral "verify directly" note — never a migration assertion — and it does NOT degrade the recipe
   * status. null unless that exact shape is present.
   */
  advisory: string | null;
}

export interface DetectProvenanceOptions {
  nowMs: number;
  jobAnchors?: ProvenanceJobAnchor[] | null;
  recordKind?: ProvenanceRecordKind;
}

// --- Thresholds (exported for tests; tuned to fire only on shapes real inflow does not produce). ---

/** A tight creation cluster needs at least this many timestamped records to mean anything. */
export const CLUSTER_MIN_RECORDS = 30;
/** The window width within which a migration's timestamps bunch. Real inflow spans days/weeks. */
export const CLUSTER_WINDOW_HOURS = 6;
/** Fraction of timestamped records that must fall inside the densest window to call it a cluster. */
export const CLUSTER_FRACTION = 0.9;

/** Zero dispositions is only migration-shaped once the cohort is large enough to expect some. */
export const ALL_DEFAULT_MIN_RECORDS = 50;

/** A record created more than this far before its req opened predates it (small same-day tolerance). */
export const PREDATE_TOLERANCE_HOURS = 24;
/** Absolute floor of predating records before the signal fires. */
export const PREDATE_MIN_RECORDS = 5;
/** Fraction of anchored records that must predate before the signal fires (legit pre-open sourcing
 * exists, so a few predating records is not enough — a migration backfills ~all of them). */
export const PREDATE_FRACTION = 0.25;

const HOUR_MS = 60 * 60 * 1000;

export function detectDataProvenance(
  records: ProvenanceRecord[],
  options: DetectProvenanceOptions
): ProvenanceAssessment {
  const recordKind = options.recordKind ?? "record";

  const cluster = detectRecentCreationCluster(records);
  const predate = detectRecordsPredateRequisition(records, options.jobAnchors ?? null);
  const allDefault = detectAllDefaultStatus(records);

  const signals: ProvenanceSignal[] = [cluster, predate, allDefault].filter(
    (signal): signal is ProvenanceSignal => signal !== null
  );

  // A LOAD SHAPE — a tight recent creation cluster, or records created before their requisition opened —
  // is what makes a migration suspected; both are shapes real recruiting inflow does not produce.
  // all_default_status is CORROBORATING, not sufficient: zero dispositions is evidence FOR a migration
  // only once a load shape is already present. Standalone, a large zero-disposition cohort is equally a
  // genuine un-triaged backlog — a just-posted high-volume req nobody has screened yet — so asserting a
  // migration on it alone tells a recruiter their real neglected pipeline is "probably an import." That
  // cry-wolf is exactly what this guards against (R1), so standalone all_default_status degrades nothing
  // and surfaces a neutral advisory instead.
  const migrationSuspected = cluster !== null || predate !== null;

  return {
    migration_suspected: migrationSuspected,
    record_kind: recordKind,
    records_evaluated: records.length,
    signals,
    warning: migrationSuspected ? buildWarning(signals, recordKind) : null,
    advisory:
      !migrationSuspected && allDefault !== null
        ? buildZeroDispositionAdvisory(allDefault, recordKind)
        : null,
  };
}

function detectRecentCreationCluster(records: ProvenanceRecord[]): ProvenanceSignal | null {
  const times = records
    .map((record) => parseMs(record.timestamp))
    .filter((ms): ms is number => ms !== null)
    .sort((a, b) => a - b);
  if (times.length < CLUSTER_MIN_RECORDS) return null;

  // Densest CLUSTER_WINDOW_HOURS window via a two-pointer sweep over the sorted timestamps.
  const windowMs = CLUSTER_WINDOW_HOURS * HOUR_MS;
  let start = 0;
  let bestCount = 0;
  let bestStartMs = times[0];
  let bestEndMs = times[0];
  for (let end = 0; end < times.length; end += 1) {
    while (times[end] - times[start] > windowMs) start += 1;
    const count = end - start + 1;
    if (count > bestCount) {
      bestCount = count;
      bestStartMs = times[start];
      bestEndMs = times[end];
    }
  }

  const fraction = bestCount / times.length;
  if (fraction < CLUSTER_FRACTION) return null;

  const spanHours = round((bestEndMs - bestStartMs) / HOUR_MS, 1);
  return {
    code: "recent_creation_cluster",
    detail:
      `${bestCount} of ${times.length} record timestamps (${pct(fraction)}) fall within a ${spanHours}-hour ` +
      `window (${iso(bestStartMs)} to ${iso(bestEndMs)}). Recruiting activity arrives spread over days and ` +
      `weeks, not in a single burst — a tight cluster of this size is the signature of a bulk data load.`,
    records_evaluated: times.length,
    records_flagged: bestCount,
  };
}

// Blind spot (documented, not silently assumed): this compares each record's creation timestamp against
// its requisition's opened_at, so it only catches a migration that preserved the original applied_at/
// created_at while the req's opened_at sits later. An import that resets BOTH the req opened_at AND the
// application created_at to the load timestamp leaves every record at/after open, so predate stays silent.
// That case is not lost — recent_creation_cluster is the backstop, because the reset timestamps bunch into
// one load window. predate and cluster are deliberately complementary: predate catches a preserved-history
// import, cluster catches a both-reset import.
function detectRecordsPredateRequisition(
  records: ProvenanceRecord[],
  jobAnchors: ProvenanceJobAnchor[] | null
): ProvenanceSignal | null {
  if (!jobAnchors || jobAnchors.length === 0) return null;
  const openedAtByJob = new Map<number, number>();
  for (const anchor of jobAnchors) {
    const openedMs = parseMs(anchor.openedAt);
    if (openedMs !== null) openedAtByJob.set(anchor.jobId, openedMs);
  }
  if (openedAtByJob.size === 0) return null;

  const toleranceMs = PREDATE_TOLERANCE_HOURS * HOUR_MS;
  let anchored = 0;
  let predating = 0;
  for (const record of records) {
    if (record.jobId === null || record.jobId === undefined) continue;
    const openedMs = openedAtByJob.get(record.jobId);
    if (openedMs === undefined) continue;
    const createdMs = parseMs(record.timestamp);
    if (createdMs === null) continue;
    anchored += 1;
    if (createdMs < openedMs - toleranceMs) predating += 1;
  }
  if (anchored === 0) return null;

  const fraction = predating / anchored;
  if (predating < PREDATE_MIN_RECORDS || fraction < PREDATE_FRACTION) return null;

  return {
    code: "records_predate_requisition",
    detail:
      `${predating} of ${anchored} records (${pct(fraction)}) were created before their requisition opened ` +
      `for applications. A candidate cannot apply to a req that does not yet exist, so records predating the ` +
      `req opening indicate backfilled/migrated history rather than activity on this requisition.`,
    records_evaluated: anchored,
    records_flagged: predating,
  };
}

function detectAllDefaultStatus(records: ProvenanceRecord[]): ProvenanceSignal | null {
  const dispositioned = records.filter(
    (record) => record.isTerminal === true || record.isTerminal === false
  );
  if (dispositioned.length < ALL_DEFAULT_MIN_RECORDS) return null;
  const terminal = dispositioned.filter((record) => record.isTerminal === true).length;
  if (terminal > 0) return null;

  return {
    code: "all_default_status",
    detail:
      `All ${dispositioned.length} records are in a non-terminal status with zero dispositions ` +
      `(no hired, rejected, or converted outcomes). A real pipeline of this size always carries some ` +
      `dispositions; a uniformly default cohort is the shape of freshly migrated data.`,
    records_evaluated: dispositioned.length,
    records_flagged: dispositioned.length,
  };
}

function buildWarning(signals: ProvenanceSignal[], recordKind: ProvenanceRecordKind): string {
  const noun = recordKind === "record" ? "these figures" : `these ${recordKind} figures`;
  const clauses = signals.map((signal) => SIGNAL_CLAUSE[signal.code]);
  // Name BOTH explanations rather than flatly asserting "not recruiting activity": the records may be load
  // artifacts, but a genuinely un-worked high-volume req can wear a similar shape, so the honest claim is
  // "verify which," not "this is an import."
  return (
    `Provenance warning: ${noun} may reflect a recent data migration rather than recruiting activity — ` +
    `though genuinely un-worked recruiting activity can look similar (${clauses.join("; ")}). Treat the ` +
    `counts as provisional until verified directly in Greenhouse.`
  );
}

// The standalone-all_default_status note: a large zero-disposition cohort with no corroborating load shape.
// This is the ambiguous case — an un-triaged backlog OR migrated data — so it is surfaced as a neutral
// advisory that names both, never a migration assertion, and (unlike a warning) it does not degrade status.
function buildZeroDispositionAdvisory(signal: ProvenanceSignal, recordKind: ProvenanceRecordKind): string {
  const noun = recordKind === "record" ? "this cohort" : `this ${recordKind} cohort`;
  return (
    `Note: ${noun} is a large zero-disposition cohort — all ${signal.records_flagged} records sit in a ` +
    `non-terminal status with no hired/rejected/converted outcomes. With no accompanying load shape (no ` +
    `recent creation-time cluster, no records predating the requisition), this is equally consistent with ` +
    `a genuine un-triaged backlog (a recently-posted high-volume req nobody has worked yet) or with migrated ` +
    `data. Verify directly in Greenhouse before reading the absence of dispositions as either.`
  );
}

const SIGNAL_CLAUSE: Record<ProvenanceSignalCode, string> = {
  recent_creation_cluster: "record timestamps are bunched into a single tight window",
  records_predate_requisition: "records predate the requisition opening",
  all_default_status: "every record is zero-disposition",
};

function parseMs(value: string | null | undefined): number | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function iso(ms: number): string {
  try {
    return new Date(ms).toISOString();
  } catch {
    return "unknown";
  }
}

function pct(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

function round(value: number, digits: number): number {
  const multiplier = 10 ** digits;
  return Math.round(value * multiplier) / multiplier;
}
