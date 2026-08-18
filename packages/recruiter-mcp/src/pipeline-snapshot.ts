import { readBooleanEnvFlag } from "./env.js";
import { assertCanonicalSupabaseProjectRef, normalizeSupabaseApiKey } from "./supabase-config.js";
import { isActiveAnalysisStatus, normalizeAnalysisStatus } from "./tools/analysis-scalars.js";

/**
 * Temporal logbook (Option B — docs/greenhouse-mcp-temporal-logbook-design.md, greenlit).
 *
 * True stage-flow week-over-week needs application_stages.entered_at, which the live tenant does
 * not populate (L3). So the MCP keeps its OWN append-only logbook of DERIVED stage occupancy
 * (one small row per req-stage-week — never a shadow copy of source rows) and diffs weeks.
 *
 * This module is the pure core + the dormant writer:
 * - computePipelineStateSnapshot: scoped application rows -> occupancy rows. Pure, no I/O.
 * - computeStageFlowWoW: two weeks of snapshot rows -> per-req-stage deltas. Pure, no I/O.
 * - writePipelineStateSnapshot: upserts via Supabase PostgREST, HARD-GATED on
 *   GREENHOUSE_RECRUITER_SNAPSHOT_ENABLED (default OFF — ships dark; Sam applies the migration
 *   and wires the weekly cron per the deploy-gated activation in the design doc).
 *
 * Live temporal wiring (surfacing stage_flow_over_time from the logbook) intentionally lands with
 * activation: the diff is meaningless until >=2 weekly snapshots exist post-migration, so wiring it
 * before data can exist would be decorative. The differ is built and tested; activation flips it on.
 */

export interface PipelineStateSnapshotRow {
  period_key: string; // the Monday (UTC) of the ISO week, YYYY-MM-DD
  snapshot_at: string;
  greenhouse_job_id: number;
  // The stage NAME is the grain: v3's stage_id on an application row is a per-application
  // stage-instance id (keying on it shadow-copies applications — 167k buckets of size 1 on the
  // live org), while names are the shared stage vocabulary. "" = the job-level rollup row.
  stage_name: string;
  active_count: number;
  status_mix: Record<string, number> | null;
  scope_hash: string | null;
  actor_id: number | null;
}

const STARTUP_SWEEP_FRESHNESS_MS = 6 * 60 * 60 * 1000;

/** Startup-only gate: sweep at boot only when the newest snapshot is stale (or unknown — fail open). */
export function shouldRunStartupSweep(latestSnapshotAt: string | null, nowMs: number): boolean {
  if (!latestSnapshotAt) return true;
  const parsed = Date.parse(latestSnapshotAt);
  if (!Number.isFinite(parsed)) return true;
  return nowMs - parsed >= STARTUP_SWEEP_FRESHNESS_MS;
}

export function mondayOfUtcWeek(nowMs: number): string {
  const date = new Date(nowMs);
  const day = date.getUTCDay(); // 0=Sun..6=Sat
  const diff = day === 0 ? 6 : day - 1;
  const monday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - diff));
  return monday.toISOString().slice(0, 10);
}

/**
 * Derive stage-occupancy rows from scoped application rows (the same projected rows the recipes
 * read: id, job_id, stage_name, status). Occupancy counts ACTIVE applications per req-stage-NAME,
 * plus one job-level rollup row (stage_name "") carrying the full status mix.
 */
/**
 * Incremental accumulator: fold application pages into small per-req-stage counters as they
 * stream in. Memory is O(reqs × stages), never O(applications) — accumulating the full org
 * application set crashed the 512MB instance (earlyExit restart loop, 2026-07-02).
 */
export function createSnapshotAccumulator(): {
  addPage(rows: Array<Record<string, unknown>>): void;
  finalize(nowMs: number, provenance?: { scopeHash?: string | null; actorId?: number | null }): PipelineStateSnapshotRow[];
} {
  const byJobStage = new Map<string, { jobId: number; stageName: string; active: number }>();
  const byJob = new Map<number, Record<string, number>>();
  return {
    addPage(rows) {
      for (const row of rows) {
        // Prospects stay out of the logbook entirely — every analyzer surface (pipeline_quality,
        // source_quality, stage_latency) excludes them from pipeline math, so logbook occupancy
        // counting them would contradict the analyzers for the same reqs. The sweep also filters
        // upstream (prospect=false); this is the belt in case that param ever silently no-ops.
        if ((row as { prospect?: unknown }).prospect === true) continue;
        const jobId = readPositiveInt(row.job_id);
        if (jobId === null) continue;
        const status = typeof row.status === "string" && row.status.length > 0 ? row.status : "unknown";
        const mix = byJob.get(jobId) ?? {};
        mix[status] = (mix[status] ?? 0) + 1;
        byJob.set(jobId, mix);

        // v3 rows carry "in_process" where the list filter says "active" — test the vocabulary, not one literal.
        if (!isActiveAnalysisStatus(normalizeAnalysisStatus(status))) continue;
        const stageName = typeof row.stage_name === "string" ? row.stage_name.trim() : "";
        if (stageName === "") continue;
        const key = `${jobId}:${stageName}`;
        const bucket = byJobStage.get(key) ?? { jobId, stageName, active: 0 };
        bucket.active += 1;
        byJobStage.set(key, bucket);
      }
    },
    finalize(nowMs, provenance = {}) {
      return finalizeSnapshotRows(byJobStage, byJob, nowMs, provenance);
    },
  };
}

export function computePipelineStateSnapshot(
  applications: Array<Record<string, unknown>>,
  nowMs: number,
  provenance: { scopeHash?: string | null; actorId?: number | null } = {}
): PipelineStateSnapshotRow[] {
  const accumulator = createSnapshotAccumulator();
  accumulator.addPage(applications);
  return accumulator.finalize(nowMs, provenance);
}

function finalizeSnapshotRows(
  byJobStage: Map<string, { jobId: number; stageName: string; active: number }>,
  byJob: Map<number, Record<string, number>>,
  nowMs: number,
  provenance: { scopeHash?: string | null; actorId?: number | null }
): PipelineStateSnapshotRow[] {
  const periodKey = mondayOfUtcWeek(nowMs);
  const snapshotAt = new Date(nowMs).toISOString();
  const rows: PipelineStateSnapshotRow[] = [];
  for (const bucket of byJobStage.values()) {
    rows.push({
      period_key: periodKey,
      snapshot_at: snapshotAt,
      greenhouse_job_id: bucket.jobId,
      stage_name: bucket.stageName,
      active_count: bucket.active,
      status_mix: null,
      scope_hash: provenance.scopeHash ?? null,
      actor_id: provenance.actorId ?? null,
    });
  }
  for (const [jobId, mix] of byJob.entries()) {
    rows.push({
      period_key: periodKey,
      snapshot_at: snapshotAt,
      greenhouse_job_id: jobId,
      // "" = the job-level rollup row (sentinel; NULL broke both upsert conflict inference and dedupe).
      stage_name: "",
      active_count: Object.entries(mix).reduce(
        (sum, [status, count]) => (isActiveAnalysisStatus(normalizeAnalysisStatus(status)) ? sum + count : sum),
        0
      ),
      status_mix: mix,
      scope_hash: provenance.scopeHash ?? null,
      actor_id: provenance.actorId ?? null,
    });
  }
  return rows.sort(
    (a, b) => a.greenhouse_job_id - b.greenhouse_job_id || a.stage_name.localeCompare(b.stage_name)
  );
}

export interface StageFlowDelta {
  greenhouse_job_id: number;
  stage_name: string; // "" = the job-level rollup delta
  previous_period: string;
  current_period: string;
  previous_active: number;
  current_active: number;
  delta: number;
}

/**
 * Diff the two most recent periods present in the given snapshot rows. Stages present in only one
 * period diff against zero (a stage emptied or newly occupied IS the signal). Pure; ordering by
 * absolute delta so the biggest movements lead.
 */
export function computeStageFlowWoW(rows: PipelineStateSnapshotRow[]): {
  previousPeriod: string | null;
  currentPeriod: string | null;
  deltas: StageFlowDelta[];
} {
  const periods = [...new Set(rows.map((row) => row.period_key))].sort();
  if (periods.length < 2) {
    return { previousPeriod: periods[0] ?? null, currentPeriod: periods[periods.length - 1] ?? null, deltas: [] };
  }
  const currentPeriod = periods[periods.length - 1];
  const previousPeriod = periods[periods.length - 2];
  const key = (row: PipelineStateSnapshotRow) => `${row.greenhouse_job_id}:${row.stage_name}`;
  const previous = new Map(rows.filter((row) => row.period_key === previousPeriod).map((row) => [key(row), row]));
  const current = new Map(rows.filter((row) => row.period_key === currentPeriod).map((row) => [key(row), row]));
  const allKeys = new Set([...previous.keys(), ...current.keys()]);
  const deltas: StageFlowDelta[] = [];
  for (const k of allKeys) {
    const prev = previous.get(k);
    const curr = current.get(k);
    const sample = (curr ?? prev) as PipelineStateSnapshotRow;
    deltas.push({
      greenhouse_job_id: sample.greenhouse_job_id,
      stage_name: sample.stage_name,
      previous_period: previousPeriod,
      current_period: currentPeriod,
      previous_active: prev?.active_count ?? 0,
      current_active: curr?.active_count ?? 0,
      delta: (curr?.active_count ?? 0) - (prev?.active_count ?? 0),
    });
  }
  deltas.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  return { previousPeriod, currentPeriod, deltas };
}

export interface SnapshotStoreClient {
  upsertRows(rows: PipelineStateSnapshotRow[]): Promise<{ upserted: number }>;
  /** Newest snapshot_at in the store, or null when empty. Optional: only the freshness gate uses it. */
  latestSnapshotAt?(): Promise<string | null>;
}

export function createPostgrestSnapshotClient(env: NodeJS.ProcessEnv): SnapshotStoreClient {
  const baseUrl = requireEnv(env, "GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_URL");
  assertCanonicalSupabaseProjectRef(baseUrl, "GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_URL");
  // Same project as the identity tables, so the identity key is the natural default writer
  // credential; a dedicated snapshot key can override it without touching identity config.
  const rawKey = env.GREENHOUSE_RECRUITER_SNAPSHOT_SUPABASE_KEY?.trim()
    ? env.GREENHOUSE_RECRUITER_SNAPSHOT_SUPABASE_KEY
    : requireEnv(env, "GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_KEY");
  const apiKey = normalizeSupabaseApiKey(rawKey as string, "GREENHOUSE_RECRUITER_SNAPSHOT_SUPABASE_KEY");
  return {
    async latestSnapshotAt(): Promise<string | null> {
      const url = new URL(`${baseUrl}/rest/v1/pipeline_state_snapshot`);
      url.searchParams.set("select", "snapshot_at");
      url.searchParams.set("order", "snapshot_at.desc");
      url.searchParams.set("limit", "1");
      const response = await fetch(url, { headers: { apikey: apiKey, authorization: `Bearer ${apiKey}` } });
      if (!response.ok) throw new Error(`pipeline_state_snapshot freshness read failed: ${response.status}`);
      const rows = (await response.json()) as Array<{ snapshot_at?: string }>;
      return typeof rows[0]?.snapshot_at === "string" ? rows[0].snapshot_at : null;
    },
    async upsertRows(rows: PipelineStateSnapshotRow[]): Promise<{ upserted: number }> {
      if (rows.length === 0) return { upserted: 0 };
      const url = new URL(`${baseUrl}/rest/v1/pipeline_state_snapshot`);
      url.searchParams.set("on_conflict", "period_key,greenhouse_job_id,stage_name");
      // Chunked bulk upserts: one multi-thousand-row POST 400'd on the live org while the
      // identical single-row call succeeded, so keep write units small. On failure, carry the
      // PostgREST error body (safe structured JSON) — a bare status cost multiple diagnosis cycles.
      const chunkSize = 500;
      let upserted = 0;
      for (let start = 0; start < rows.length; start += chunkSize) {
        const chunk = rows.slice(start, start + chunkSize);
        const response = await fetch(url, {
          method: "POST",
          headers: {
            apikey: apiKey,
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
            prefer: "resolution=merge-duplicates,return=minimal",
          },
          body: JSON.stringify(chunk),
        });
        if (!response.ok) {
          const body = await response.text().catch(() => "");
          throw new Error(
            `pipeline_state_snapshot upsert failed: ${response.status} at rows ${start}-${start + chunk.length} of ${rows.length}: ${body.slice(0, 220)}`
          );
        }
        upserted += chunk.length;
      }
      return { upserted };
    },
  };
}

/**
 * The dormant writer. Refuses to write unless GREENHOUSE_RECRUITER_SNAPSHOT_ENABLED=true — per
 * the migration-gated-writeback rule, a scheduled writer of an unapplied-migration table ships
 * dark and is activated by env only after Sam applies the migration.
 */
export async function writePipelineStateSnapshot(
  env: NodeJS.ProcessEnv,
  applications: Array<Record<string, unknown>>,
  nowMs: number,
  provenance: { scopeHash?: string | null; actorId?: number | null } = {},
  client?: SnapshotStoreClient
): Promise<{ enabled: boolean; rows: PipelineStateSnapshotRow[]; upserted: number }> {
  const rows = computePipelineStateSnapshot(applications, nowMs, provenance);
  if (!readBooleanEnvFlag(env, "GREENHOUSE_RECRUITER_SNAPSHOT_ENABLED")) {
    return { enabled: false, rows, upserted: 0 };
  }
  const store = client ?? createPostgrestSnapshotClient(env);
  const { upserted } = await store.upsertRows(rows);
  return { enabled: true, rows, upserted };
}

/**
 * In-service snapshot timer: the schedule half of the logbook, hosted by the (single-instance)
 * service itself so activation needs no external cron. Runs shortly after startup and then daily;
 * the per-req-stage-WEEK upsert key makes daily refreshes idempotent (the in-progress week's row
 * is refreshed, history is never touched). DORMANT unless GREENHOUSE_RECRUITER_SNAPSHOT_ENABLED.
 * Failures log and never take the serving path down.
 */
export function maybeStartPipelineSnapshotTimer(
  env: NodeJS.ProcessEnv = process.env,
  runSweep?: () => Promise<void>
): NodeJS.Timeout | null {
  if (!readBooleanEnvFlag(env, "GREENHOUSE_RECRUITER_SNAPSHOT_ENABLED")) return null;
  const sweep = runSweep ?? (async () => {
    // STREAM pages into the accumulator — never hold the org's application set in memory
    // (doing so crashed the 512MB instance: earlyExit restart loop, 2026-07-02).
    const { streamApplicationsForSnapshot } = await import("./scoped-reader.js");
    const accumulator = createSnapshotAccumulator();
    const read = await streamApplicationsForSnapshot(env, (page) => accumulator.addPage(page), { status: "active", prospect: false });
    if (!read.complete) {
      console.error(`[greenhouse-recruiter-mcp] snapshot sweep skipped: applications read incomplete after ${read.pagesRead} pages`);
      return;
    }
    const rows = accumulator.finalize(Date.now());
    if (!readBooleanEnvFlag(env, "GREENHOUSE_RECRUITER_SNAPSHOT_ENABLED")) return;
    const store = createPostgrestSnapshotClient(env);
    const { upserted } = await store.upsertRows(rows);
    console.error(`[greenhouse-recruiter-mcp] pipeline snapshot ${rows[0]?.period_key ?? "?"}: ${upserted} rows upserted from ${read.rowsRead} applications`);
  });
  const guarded = () => {
    sweep().catch((error) => {
      const name = error instanceof Error ? error.name : "unknown";
      const detail = error instanceof Error ? error.message.slice(0, 160) : "";
      console.error(`[greenhouse-recruiter-mcp] pipeline snapshot sweep failed error_name=${name} detail=${detail}`);
    });
  };
  // Head-of-TA demo finding #2 (2026-07-02): every deploy's boot fired a full org sweep, and the
  // demo's heaviest question raced one — rate-budget contention read live as "the tool choked".
  // The STARTUP sweep runs only when the logbook is stale; the daily interval always runs.
  const startupGuarded = async () => {
    try {
      const store = createPostgrestSnapshotClient(env);
      const latest = await store.latestSnapshotAt!();
      if (!shouldRunStartupSweep(latest, Date.now())) {
        console.error("[greenhouse-recruiter-mcp] startup snapshot sweep skipped: logbook is fresh (<6h)");
        return;
      }
    } catch {
      // Freshness unknown -> fail OPEN toward sweeping; the sweep itself reports loudly on failure.
    }
    guarded();
  };
  const startupDelay = setTimeout(() => void startupGuarded(), 2 * 60 * 1000);
  startupDelay.unref?.();
  const timer = setInterval(guarded, 24 * 60 * 60 * 1000);
  timer.unref?.();
  console.error("[greenhouse-recruiter-mcp] pipeline snapshot timer enabled (daily refresh, weekly upsert key)");
  return timer;
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value || value.trim().length === 0) throw new Error(`${name} is required.`);
  return value;
}

function readPositiveInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) {
    const parsed = Number.parseInt(value, 10);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}
