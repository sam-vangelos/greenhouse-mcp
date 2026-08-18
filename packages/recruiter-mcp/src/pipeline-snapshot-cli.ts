import { streamApplicationsForSnapshot } from "./scoped-reader.js";
import { createPostgrestSnapshotClient, createSnapshotAccumulator } from "./pipeline-snapshot.js";
import { readBooleanEnvFlag } from "./env.js";

/**
 * Snapshot CLI (bin/greenhouse-recruiter-snapshot). A service-actor sweep per the logbook design:
 * STREAMS the complete /v3/applications set page by page into small per-req-stage counters (never
 * holding the org's rows in memory — that crashed the 512MB instance), derives stage occupancy,
 * and upserts one row per req-stage-week. Dormant end to end: without
 * GREENHOUSE_RECRUITER_SNAPSHOT_ENABLED=true it prints the computed plan and writes nothing.
 * Refuses to WRITE from an incomplete read (a partial sweep understates occupancy and would
 * poison the week's diff) unless --allow-incomplete.
 */
export async function startPipelineSnapshotCli(
  env: NodeJS.ProcessEnv = process.env,
  args: string[] = process.argv.slice(2)
): Promise<void> {
  try {
    const allowIncomplete = args.includes("--allow-incomplete");
    const accumulator = createSnapshotAccumulator();
    const read = await streamApplicationsForSnapshot(env, (page) => accumulator.addPage(page), { status: "active", prospect: false });
    if (!read.complete && !allowIncomplete) {
      process.stderr.write(
        `[greenhouse-recruiter-snapshot] applications read INCOMPLETE after ${read.pagesRead} pages — refusing to write a partial snapshot (pass --allow-incomplete to override).\n`
      );
      process.exitCode = 1;
      return;
    }
    const rows = accumulator.finalize(Date.now());
    const enabled = readBooleanEnvFlag(env, "GREENHOUSE_RECRUITER_SNAPSHOT_ENABLED");
    let upserted = 0;
    if (enabled) {
      const store = createPostgrestSnapshotClient(env);
      upserted = (await store.upsertRows(rows)).upserted;
    }
    process.stdout.write(
      `${JSON.stringify(
        {
          enabled,
          read_complete: read.complete,
          pages_read: read.pagesRead,
          applications_read: read.rowsRead,
          snapshot_rows: rows.length,
          upserted,
          period_key: rows[0]?.period_key ?? null,
          ...(enabled ? {} : { note: "DORMANT: set GREENHOUSE_RECRUITER_SNAPSHOT_ENABLED=true after applying migration 0002 to write." }),
        },
        null,
        2
      )}\n`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[greenhouse-recruiter-snapshot] ${message}\n`);
    process.exitCode = 1;
  }
}
