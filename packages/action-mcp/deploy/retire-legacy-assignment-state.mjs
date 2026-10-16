#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { assertCanonicalActionDatabaseUrl } from "../src/access-cli.ts";
import { ARCHIVE_TABLE, legacyRetirementSql, LEGACY_TABLE } from "./legacy-retirement-sql.mjs";

export { legacyRetirementSql } from "./legacy-retirement-sql.mjs";

export function retireLegacyAssignmentState(env = process.env) {
  if (env.GREENHOUSE_ACTION_RETIRE_LEGACY_ASSIGNMENT_STATE !== "archive") {
    throw new Error("Set GREENHOUSE_ACTION_RETIRE_LEGACY_ASSIGNMENT_STATE=archive after freezing the legacy service and stopping its reconciler.");
  }
  const databaseUrl = env.GREENHOUSE_ACTION_DATABASE_URL;
  const database = assertCanonicalActionDatabaseUrl(databaseUrl);
  const present = query(databaseUrl, `select coalesce(to_regclass('${LEGACY_TABLE}')::text, '')`);
  if (present.length === 0) {
    return { ok: true, status: "already_absent", project_ref: database.project_ref };
  }
  const totalRows = readCount(query(databaseUrl, `select count(*) from ${LEGACY_TABLE}`), "legacy row count");
  const unresolvedRows = readCount(query(
    databaseUrl,
    `select count(*) from ${LEGACY_TABLE} where status in ('executing', 'unknown')`
  ), "legacy unresolved count");
  if (unresolvedRows !== 0) {
    throw new Error(`Legacy assignment state has ${unresolvedRows} executing/unknown row(s); reconcile them before retirement.`);
  }
  execute(databaseUrl, legacyRetirementSql());
  return {
    ok: true,
    status: "archived",
    project_ref: database.project_ref,
    archived_table: ARCHIVE_TABLE,
    archived_rows: totalRows,
    dropped_legacy_functions: 7,
  };
}

function query(databaseUrl, sql) {
  const result = spawnSync("psql", [databaseUrl, "-X", "--no-psqlrc", "-v", "ON_ERROR_STOP=1", "-Atqc", sql], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? "");
    throw new Error("Legacy assignment-state preflight failed.");
  }
  return result.stdout.trim();
}

function execute(databaseUrl, sql) {
  const result = spawnSync("psql", [databaseUrl, "-X", "--no-psqlrc", "-v", "ON_ERROR_STOP=1", "-c", sql], {
    stdio: "inherit",
  });
  if (result.status !== 0) throw new Error("Legacy assignment-state retirement failed and was rolled back.");
}

function readCount(value, label) {
  if (!/^\d+$/.test(value)) throw new Error(`Could not read ${label}.`);
  const count = Number(value);
  if (!Number.isSafeInteger(count)) throw new Error(`Could not read ${label}.`);
  return count;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.stdout.write(`${JSON.stringify(retireLegacyAssignmentState())}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Legacy assignment-state retirement failed.");
    process.exitCode = 1;
  }
}
