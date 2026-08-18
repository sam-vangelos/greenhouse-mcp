#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptDir, "..");
const repoRoot = resolve(packageRoot, "..", "..", "..");
const dockerfilePath = "packages/recruiter-mcp/deploy/Dockerfile";
const imageTag = process.env.GREENHOUSE_RECRUITER_DOCKER_SMOKE_IMAGE ?? "greenhouse-recruiter-mcp:smoke";
const shouldRunContainer = process.env.GREENHOUSE_RECRUITER_DOCKER_SMOKE_RUN === "true";
const hostPort = normalizePort(process.env.GREENHOUSE_RECRUITER_DOCKER_SMOKE_PORT);
const containerName = safeDockerName(
  process.env.GREENHOUSE_RECRUITER_DOCKER_SMOKE_CONTAINER ?? `greenhouse-recruiter-mcp-smoke-${process.pid}`
);
const ownsAuditVolume = !process.env.GREENHOUSE_RECRUITER_DOCKER_SMOKE_AUDIT_VOLUME;
const auditVolumeName = safeDockerName(
  process.env.GREENHOUSE_RECRUITER_DOCKER_SMOKE_AUDIT_VOLUME ?? `${containerName}-audit`
);
const readinessToken = "smoke-readiness-token-32-characters-minimum";
const npmCaFile = process.env.GREENHOUSE_RECRUITER_DOCKER_SMOKE_NPM_CA_FILE ?? process.env.NODE_EXTRA_CA_CERTS;

async function main() {
  const caArgs = npmCaFile ? ["--secret", `id=npm_ca,src=${npmCaFile}`] : [];
  runDocker(["build", ...caArgs, "-f", dockerfilePath, "-t", imageTag, "."], { cwd: repoRoot });
  const containerSelfCheck = runDockerJson([
    "run", "--rm", "--entrypoint", "node", imageTag,
    "packages/recruiter-mcp/bin/greenhouse-recruiter-container-self-check.mjs",
  ]);

  if (!shouldRunContainer) {
    writeReport({
      ok: true,
      imageTag,
      built: true,
      ran: false,
      containerSelfCheck,
      authenticatedMcpHttpValidated: false,
      nextStep: "Set GREENHOUSE_RECRUITER_DOCKER_SMOKE_RUN=true to start the image and probe /healthz plus /readyz.",
    });
    return;
  }

  const envArgs = Object.entries(smokeEnv()).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
  const port = `${hostPort}:3333`;
  let containerStarted = false;
  try {
    runDocker([
      "run",
      "--rm",
      "-d",
      "--name",
      containerName,
      "-p",
      `127.0.0.1:${port}`,
      "--mount",
      `type=volume,source=${auditVolumeName},target=/app/audit`,
      ...envArgs,
      imageTag,
    ]);
    containerStarted = true;

    const healthUrl = `http://127.0.0.1:${hostPort}/healthz`;
    const readyUrl = `http://127.0.0.1:${hostPort}/readyz`;
    const healthz = await pollJson(healthUrl, (status, body) => status === 200 && body?.ok === true);
    const readyz = await pollJson(
      readyUrl,
      (status, body) => status === 200 && body?.ok === true && body?.status === "ready",
      { authorization: `Bearer ${readinessToken}` }
    );
    writeReport({
      ok: true,
      imageTag,
      built: true,
      ran: true,
      containerName,
      auditVolumeName,
      containerSelfCheck,
      authenticatedMcpHttpValidated: false,
      healthz,
      readyz,
      nextStep: "Validate authenticated MCP initialize/tools/list with a real issued recruiter session against the isolated candidate deployment.",
    });
  } finally {
    if (containerStarted) {
      runDocker(["rm", "-f", containerName], { optional: true });
    }
    if (ownsAuditVolume) {
      runDocker(["volume", "rm", auditVolumeName], { optional: true });
    }
  }
}

function smokeEnv() {
  return {
    GREENHOUSE_CLIENT_ID: "smoke-client-id",
    GREENHOUSE_CLIENT_SECRET: "smoke-client-secret-placeholder",
    GREENHOUSE_RECRUITER_STATE_BACKEND: "supabase_postgrest",
    GREENHOUSE_RECRUITER_SESSION_SECRET: "smoke-session-signing-secret-32-characters-minimum",
    GREENHOUSE_RECRUITER_SCOPE_SIGNING_SECRET: "smoke-scope-signing-secret-32-characters-minimum",
    GREENHOUSE_RECRUITER_READYZ_TOKEN: readinessToken,
    GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_URL: "https://exampleprojectref000.supabase.co",
    GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_KEY: "smoke-supabase-key-placeholder",
    GREENHOUSE_RECRUITER_REVOCATION_SUPABASE_URL: "https://exampleprojectref000.supabase.co",
    GREENHOUSE_RECRUITER_REVOCATION_SUPABASE_KEY: "smoke-revocation-key-placeholder",
    GREENHOUSE_RECRUITER_AUDIT_JSONL_PATH: "/app/audit/audit.jsonl",
    GREENHOUSE_RECRUITER_AUDIT_DURABLE_MOUNT_PATH: "/app/audit",
    GREENHOUSE_RECRUITER_ALLOWED_TOOLS: "answer_my_recruiting_question,analyze_scorecard_accountability,analyze_interview_feedback_drag,analyze_stage_latency,analyze_pipeline_quality,analyze_source_quality,analyze_rejection_reason_drift,resolve_job_scope,confirm_job_scope,get_job_scope,get_recruiting_capabilities,read_my_resume,search_my_jobs,get_my_job,search_my_applications,get_my_application,search_my_interviews,search_my_offers,search_my_openings,search_my_users,search_my_job_owners,search_my_job_interview_stages,search_my_application_stages,search_my_job_hiring_managers,search_my_job_posts,search_my_candidates,get_my_candidate,search_my_scorecards,search_my_rejection_details,search_my_rejection_reasons,search_my_notes,search_my_attachments,search_my_interviewers,search_my_scorecard_question_answers,search_my_candidate_educations,search_my_candidate_employments,get_my_user,search_my_sources,search_my_referrers,search_my_custom_field_options,search_my_custom_fields,search_my_departments,search_my_offices,search_my_close_reasons",
    GREENHOUSE_RECRUITER_CORS_ORIGIN: "https://chatgpt.com,https://claude.ai",
    GREENHOUSE_RECRUITER_MCP_PORT: "3333",
  };
}

async function pollJson(url, predicate, headers = {}) {
  const startedAt = Date.now();
  const timeoutMs = normalizePositiveInt(
    process.env.GREENHOUSE_RECRUITER_DOCKER_SMOKE_TIMEOUT_MS,
    15000,
    "GREENHOUSE_RECRUITER_DOCKER_SMOKE_TIMEOUT_MS"
  );
  let lastError = "not attempted";
  while (Date.now() - startedAt <= timeoutMs) {
    try {
      const response = await fetch(url, { headers: { accept: "application/json", ...headers } });
      const text = await response.text();
      const body = text ? JSON.parse(text) : null;
      if (predicate(response.status, body)) {
        return { url, status: response.status, ok: true, body };
      }
      lastError = `${url} returned ${response.status}: ${text.slice(0, 500)}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError}`);
}

function runDocker(args, options = {}) {
  const result = spawnSync("docker", args, {
    cwd: options.cwd,
    stdio: options.optional ? "ignore" : "inherit",
  });
  if (result.status === 0) return;
  if (options.optional) return;
  const cause = result.error instanceof Error ? `: ${result.error.message}` : "";
  throw new Error(`docker ${args.join(" ")} failed${cause}`);
}

function runDockerJson(args) {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`docker ${args.join(" ")} failed: ${(result.stderr || result.error?.message || "unknown error").trim()}`);
  }
  try {
    const parsed = JSON.parse(result.stdout);
    if (
      parsed?.ok !== true ||
      parsed?.authenticatedHttpSimulated !== false ||
      parsed?.catalogToolCount !== 44 ||
      parsed?.hiddenToolCount !== 22 ||
      parsed?.catalogOrder !== true ||
      parsed?.readOnlyAnnotations !== true ||
      parsed?.pdfParser !== true ||
      parsed?.docxParser !== true
    ) throw new Error("unexpected self-check report");
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Container self-check returned invalid JSON: ${message}`);
  }
}

function normalizePort(raw) {
  const port = normalizePositiveInt(raw, 3333, "GREENHOUSE_RECRUITER_DOCKER_SMOKE_PORT");
  if (port > 65535) {
    throw new Error(`Invalid GREENHOUSE_RECRUITER_DOCKER_SMOKE_PORT: ${raw}`);
  }
  return port;
}

function normalizePositiveInt(raw, fallback, label) {
  if (raw === undefined || raw === null || String(raw).trim().length === 0) return fallback;
  const value = String(raw);
  if (value.trim() !== value || !/^[1-9]\d*$/.test(value)) {
    throw new Error(`Invalid ${label}: ${raw}`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Invalid ${label}: ${raw}`);
  }
  return parsed;
}

function safeDockerName(value) {
  const safe = value.replace(/[^a-zA-Z0-9_.-]/g, "-").replace(/^-+|-+$/g, "");
  if (!safe) {
    throw new Error("Docker smoke container/volume name resolved to an empty value.");
  }
  return safe;
}

function writeReport(report) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[greenhouse-recruiter-docker-smoke] ${message}`);
  process.exit(1);
});
