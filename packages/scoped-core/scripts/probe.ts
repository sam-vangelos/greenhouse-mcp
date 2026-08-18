#!/usr/bin/env tsx

import { apiGet, configure, type ApiResponse } from "../../src/client.js";

const clientId = process.env.GREENHOUSE_CLIENT_ID;
const clientSecret = process.env.GREENHOUSE_CLIENT_SECRET;
const perJobUserId = readPositiveEnv("SCOPED_GREENHOUSE_PER_JOB_USER_ID");
const allJobsUserId = readPositiveEnv("SCOPED_GREENHOUSE_ALL_JOBS_USER_ID");

if (!clientId || !clientSecret) {
  console.error(
    "Missing GREENHOUSE_CLIENT_ID/GREENHOUSE_CLIENT_SECRET. Set them to run the scoped Greenhouse probe."
  );
  process.exit(1);
}

configure(clientId, clientSecret);

const probes: Record<string, unknown> = {};

if (perJobUserId) {
  probes.per_job_user_job_permissions = await readShape("/user_job_permissions", {
    user_ids: String(perJobUserId),
    per_page: 10,
  });
} else {
  probes.per_job_user_job_permissions =
    "skipped: set SCOPED_GREENHOUSE_PER_JOB_USER_ID";
}

if (allJobsUserId) {
  probes.all_jobs_user_job_permissions = await readShape("/user_job_permissions", {
    user_ids: String(allJobsUserId),
    per_page: 10,
  });
} else {
  probes.all_jobs_user_job_permissions =
    "skipped: set SCOPED_GREENHOUSE_ALL_JOBS_USER_ID";
}

probes.notes = await readShape("/notes", { per_page: 10 });

console.log(JSON.stringify({ generated_at: new Date().toISOString(), probes }, null, 2));

async function readShape(
  path: string,
  params: Record<string, string | number | boolean | undefined>
): Promise<Record<string, unknown>> {
  const response: ApiResponse<unknown> = await apiGet(path, params);
  return {
    path,
    params: redactParams(params),
    next_cursor_present: Boolean(response.nextCursor),
    data_shape: shapeOf(response.data),
  };
}

function readPositiveEnv(name: string): number | null {
  const raw = process.env[name];
  if (!raw || !/^\d+$/.test(raw)) {
    return null;
  }
  const parsed = Number.parseInt(raw, 10);
  return parsed > 0 ? parsed : null;
}

function redactParams(
  params: Record<string, string | number | boolean | undefined>
): Record<string, string | number | boolean | undefined> {
  const redacted: Record<string, string | number | boolean | undefined> = {};
  for (const [key, value] of Object.entries(params)) {
    redacted[key] = key.endsWith("_ids") || key.endsWith("_id") ? "[redacted-id]" : value;
  }
  return redacted;
}

function shapeOf(value: unknown, depth = 0): unknown {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return value.slice(0, 3).map((item) => shapeOf(item, depth + 1));
  }
  if (typeof value !== "object") {
    return typeof value;
  }
  if (depth >= 4) {
    return "object";
  }

  const shaped: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    shaped[key] = shapeOf(entry, depth + 1);
  }
  return shaped;
}
