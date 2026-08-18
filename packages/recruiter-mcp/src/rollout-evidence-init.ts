import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DESKTOP_ROUTING_CASES, MIN_ROUTING_RUNS, ROUTING_TEST_VERSION } from "./desktop-user-test.js";

export interface RolloutEvidenceInitOptions {
  outputDir: string;
  force?: boolean;
}

export interface RolloutEvidenceInitReport {
  ok: boolean;
  outputDir: string;
  manifestPath: string;
  filesWritten: string[];
  nextSteps: string[];
}

const LIVE_PROBE_FILES = [
  ["small_req_set", "live-probe-small-req-set.json"],
  ["many_req_set", "live-probe-many-req-set.json"],
  ["all_jobs_or_operator", "live-probe-all-jobs-or-operator.json"],
  ["no_permissions", "live-probe-no-permissions.json"],
] as const;

const DISTRIBUTION_FILES = [
  ["claude_desktop", "claude_desktop_chat", "distribution-claude-desktop.json"],
  ["claude_desktop", "claude_code", "distribution-claude-code.json"],
  ["chatgpt_desktop", "chatgpt_codex_host", "distribution-chatgpt-desktop.json"],
] as const;

const DESKTOP_TEST_FILES = [
  ["claude_desktop", "claude_desktop_chat", "desktop-claude-desktop.json"],
  ["claude_desktop", "claude_code", "desktop-claude-code.json"],
  ["chatgpt_desktop", "chatgpt_codex_host", "desktop-chatgpt-desktop.json"],
] as const;

const REVOCATION_FILES = [
  ["claude_desktop", "claude_desktop_chat", "revocation-drill-claude-desktop.json", "session-revocation-claude-desktop.json"],
  ["claude_desktop", "claude_code", "revocation-drill-claude-code.json", "session-revocation-claude-code.json"],
  ["chatgpt_desktop", "chatgpt_codex_host", "revocation-drill-chatgpt-codex.json", "session-revocation-chatgpt-codex.json"],
] as const;

const EVIDENCE_DIR_MODE = 0o700;
const EVIDENCE_FILE_MODE = 0o600;

export async function runRolloutEvidenceInit(options: RolloutEvidenceInitOptions): Promise<RolloutEvidenceInitReport> {
  const outputDir = resolve(options.outputDir);
  await mkdir(outputDir, { recursive: true, mode: EVIDENCE_DIR_MODE });
  await chmod(outputDir, EVIDENCE_DIR_MODE);
  const filesWritten: string[] = [];

  await writeJson(outputDir, "manifest.json", manifestTemplate(), options.force, filesWritten);
  await writeJson(outputDir, "production-env-check.json", productionEnvCheckTemplate(), options.force, filesWritten);
  for (const [surface, client, drillPath, writePath] of REVOCATION_FILES) {
    await writeJson(outputDir, drillPath, revocationDrillTemplate(surface, client), options.force, filesWritten);
    await writeJson(outputDir, writePath, sessionRevocationTemplate(client), options.force, filesWritten);
  }
  await writeJson(outputDir, "desktop-delivery.json", desktopDeliveryTemplate(), options.force, filesWritten);
  for (const [surface, client, path] of DESKTOP_TEST_FILES) {
    await writeJson(outputDir, path, desktopTestTemplate(surface, client), options.force, filesWritten);
  }
  await writeText(outputDir, "README.md", readmeTemplate(), options.force, filesWritten);
  await writeText(outputDir, "RUNBOOK.md", runbookTemplate(), options.force, filesWritten);

  return {
    ok: true,
    outputDir,
    manifestPath: resolve(outputDir, "manifest.json"),
    filesWritten,
    nextSteps: [
      "Follow RUNBOOK.md in this scaffold for the ordered production rollout commands and evidence paths.",
      "Run greenhouse-recruiter-probe for each liveProbes manifest entry and write the JSON reports to the listed paths.",
      "Run greenhouse-recruiter-sample-leakage in strict mode and write the JSON report to leakage-sample.json.",
      "If the production identity directory is not already populated, run greenhouse-recruiter-bootstrap-identity and keep the token-free clean plan as identity-bootstrap-plan.json; include it as identityBootstrapEvidence in the final manifest if used.",
      "Run greenhouse-recruiter-preflight-roster --emails-file recruiters.txt --surface both --source <managed-roster-source> --verified-by ops-reviewer@example.com and write the token-free report to roster-preflight.json.",
      "After roster preflight passes, issue separate claude_desktop_chat, claude_code, and chatgpt_codex_host credentials. Package Claude Desktop with greenhouse-recruiter-claude-mcpb; generate Claude Code and ChatGPT/Codex configs with greenhouse-recruiter-desktop-config --client.",
      "Confirm issued session files and generated client artifacts carry matching email, subject, surface, client, token id, and issued-at metadata for each recruiter/client pair.",
      "After delivery, run greenhouse-recruiter-record-desktop-delivery --desktop-config-manifest ./desktop-configs/manifest.json --delivered-by ops-reviewer@example.com --delivery-channel managed_desktop_install --attest-delivered-to-matching-recruiters --out ./desktop-delivery.json.",
      "Run greenhouse-recruiter-validate-distribution once for each claude_desktop_chat, claude_code, and chatgpt_codex_host token from the issued-sessions manifest; write the JSON reports with matching sessionSurface, sessionClient, sessionTokenId, and sessionIssuedAt values to the listed paths.",
      "For each physical client, use greenhouse-recruiter-revoke-session --token-id with a separately issued drill token id, then run greenhouse-recruiter-revocation-drill with active and revoked credentials for that same client. Keep all six token-free reports at the client-specific manifest paths.",
      `Replace all three client attestation templates with real recruiter tests that name the actual attachmentMethod and client/model versions, pass every canonical routing case at least ${MIN_ROUTING_RUNS} times, keep resume instructions untrusted, include the issued sessionTokenId and sessionIssuedAt, repeat them after restart, and prove durable access across restart with no routine re-verification.`,
      "Generate audit-review.json with greenhouse-recruiter-review-audit after retained v2 audit terminals cover claude_desktop_chat, claude_code, and chatgpt_codex_host with coherent start/terminal attribution, success and denial events, and both evidence/analysis tool families.",
      "Set every permissionFreshnessEvidence field in manifest.json only after the corresponding live check has been performed.",
      "Run greenhouse-recruiter-check-production-env --env-file ./greenhouse-recruiter-production.env before starting the hosted server, and keep its secret-free JSON output as production-env-check.json for the final gate.",
      "Run greenhouse-recruiter-rollout-status --manifest manifest.json to summarize missing artifacts and failing gate checks before the final gate.",
      "Run the final gate with GREENHOUSE_RECRUITER_ROLLOUT_EVIDENCE_MANIFEST=manifest.json, the candidate's canonical GREENHOUSE_RECRUITER_ROLLOUT_LIVE_READYZ_URL, and GREENHOUSE_RECRUITER_READYZ_TOKEN; it re-observes both /readyz and the pinned /version commit.",
    ],
  };
}

export async function startRolloutEvidenceInitCli(args: string[] = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(args);
  const report = await runRolloutEvidenceInit(options);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

function manifestTemplate() {
  return {
    version: 2,
    candidate: { mcpUrl: "", commit: "" },
    liveProbes: LIVE_PROBE_FILES.map(([profile, path]) => ({
      profile,
      path,
      strict: profile !== "no_permissions",
      ...(profile === "no_permissions" ? { expectZeroVisibleJobs: true } : { expectVisibleData: true }),
    })),
    distributionValidations: DISTRIBUTION_FILES.map(([surface, client, path]) => ({ surface, client, path })),
    productionEnvEvidence: { path: "production-env-check.json" },
    revocationDrillEvidence: REVOCATION_FILES.map(([surface, client, path]) => ({ surface, client, path })),
    sessionRevocationEvidence: REVOCATION_FILES.map(([surface, client, , path]) => ({ surface, client, path })),
    rosterPreflightEvidence: { path: "roster-preflight.json" },
    sessionIssuanceEvidence: { path: "issued-sessions/manifest.json" },
    desktopConfigEvidence: { path: "desktop-configs/manifest.json" },
    desktopDeliveryEvidence: { path: "desktop-delivery.json" },
    desktopUserTests: DESKTOP_TEST_FILES.map(([surface, client, path]) => ({ surface, client, path })),
    permissionFreshnessEvidence: {
      removedReqDisappearedOnNextRead: false,
      addedReqAppearedWithoutDeploy: false,
      privateNotesDropped: false,
      scopedVsUnscopedLeakageSamplePassed: false,
      durableAccessTestedWithoutRoutineReverification: false,
      verifiedAt: "",
      verifiedBy: "",
      removedReqId: 0,
      removedReqRowsBeforeRemoval: 0,
      removedReqRowsAfterRemoval: -1,
      addedReqId: 0,
      addedReqRowsBeforeAddition: -1,
      addedReqRowsAfterAddition: 0,
      privateNoteId: 0,
      privateNoteRowsReturnedAfterScope: -1,
      durableSessionEmail: "",
      durableSessionSurface: "",
      durableSessionTokenId: "",
      durableSessionTokenIdAfterRestart: "",
      durableSessionIssuedAt: "",
      durableSessionIssuedAtAfterRestart: "",
      routineReverificationPrompted: true,
    },
    leakageSampleEvidence: { path: "leakage-sample.json" },
    auditReviewEvidence: { path: "audit-review.json" },
  };
}

function productionEnvCheckTemplate() {
  return {
    ok: false,
    status: "not_ready",
    generatedAt: "",
    source: "env_file",
    envFile: "",
    configuredSurfaces: [],
    checks: [],
    instructions: [
      "Replace this template with greenhouse-recruiter-check-production-env --env-file ./greenhouse-recruiter-production.env output before starting the hosted server.",
      "The report must be generated from an env file, be recent, pass every readiness check without warnings, and include both chatgpt_desktop and claude_desktop configured surfaces.",
      "Never paste Greenhouse credentials, Supabase keys, session secrets, scope-signing secrets, readiness tokens, recruiter durable tokens, or full env file contents into this report.",
    ],
  };
}

function desktopTestTemplate(surface: string, client: string) {
  return {
    status: "pending",
    surface,
    client,
    testedAt: "",
    tester: "",
    testerEmail: "",
    mcpUrl: "",
    sessionTokenId: "",
    sessionTokenIdAfterRestart: "",
    sessionIssuedAt: "",
    sessionIssuedAtAfterRestart: "",
    durableSessionAccess: false,
    sessionPersistedAcrossRestart: false,
    routineReverificationPrompted: true,
    attachmentMethod: client === "claude_desktop_chat"
      ? "claude_desktop_mcpb"
      : client === "claude_code"
        ? "claude_code_http_mcp"
        : "chatgpt_developer_mode_remote_mcp",
    exercisedTools: [],
    clientVersion: "",
    modelVersion: "",
    routingTestVersion: ROUTING_TEST_VERSION,
    routingChecks: DESKTOP_ROUTING_CASES.map(({ caseId }) => ({
      caseId,
      runs: Array.from({ length: MIN_ROUTING_RUNS }, (_, index) => ({
        run: index + 1,
        observedTools: [],
        passed: false,
      })),
    })),
    resumeInstructionsTreatedAsUntrusted: false,
    writeOrAdminToolsVisible: true,
    containsTokens: false,
    taskOutcome: "",
    taskOutcomeReason: "",
    instructions: [
      "Replace this template with a real desktop test result after running the configured desktop client.",
      "Set testerEmail to the same normalized work email that was included in roster-preflight.json for this desktop surface.",
      "Set sessionTokenId and sessionIssuedAt to the non-secret token metadata from the issued session and generated desktop config used in this desktop client.",
      "Set attachmentMethod to the actual path tested: claude_desktop_mcpb for Claude Desktop, claude_code_http_mcp for Claude Code, chatgpt_developer_mode_remote_mcp or chatgpt_desktop_remote_mcp for direct ChatGPT attachment, or responses_api_broker for the broker fallback.",
      "After restarting the desktop client, set sessionTokenIdAfterRestart and sessionIssuedAtAfterRestart to the same token metadata; different values mean the flow is re-verifying or reissuing access.",
      "Set status to pass only after the durable session works through that attachment method, survives restart, and does not prompt routine re-verification.",
      "Include at least one evidence tool and at least one analytical tool in exercisedTools.",
      "Record the exact physical clientVersion and modelVersion shown by the tested client; blank or inferred versions are not evidence.",
      `Run every routingChecks case at least ${MIN_ROUTING_RUNS} times in the real client and record each actual ordered observedTools sequence. The matrix covers all critical analyses, all candidate-intelligence prompts, adversarial near-neighbors, scope confirm/get, and hostile instructions inside resume text.`,
      "Set resumeInstructionsTreatedAsUntrusted=true only after the client treated resume instructions as document content and did not follow them.",
      "Record taskOutcome as useful, not_useful, or could_not_use and taskOutcomeReason as wrong_scope, timeout_error, installation_blocked, answer_received, or not_yet_needed.",
    ],
  };
}

function desktopDeliveryTemplate() {
  return {
    ok: false,
    deliveredAt: "",
    deliveredBy: "",
    containsTokens: false,
    deliveries: [],
    instructions: [
      "Replace this template with greenhouse-recruiter-record-desktop-delivery output after distributing generated desktop configs.",
      "Include one delivery row for every file in desktop-configs/manifest.json.",
      "Each row must include email, recipientEmail, surface, client, tokenId, issuedAt, configPath, deliveryChannel, and deliveredToMatchingRecruiter=true.",
      "Never paste durable tokens, Authorization headers, full config JSON, Greenhouse credentials, or session-signing secrets into this report.",
    ],
  };
}

function sessionRevocationTemplate(client: (typeof REVOCATION_FILES)[number][1]) {
  return {
    ok: false,
    revokedAt: "",
    table: "recruiter_mcp_session_revocation",
    tokenId: "",
    status: "revoked",
    revokedBy: "",
    reason: "",
    containsTokens: false,
    client,
    instructions: [
      `Replace this template with greenhouse-recruiter-revoke-session output after writing the separately issued ${client} drill token id to the server-side revocation table.`,
      "The tokenId here must match revokedSessionTokenId in the same client's revocation drill report.",
      "Never paste durable token strings, Authorization headers, or config payloads into this report.",
    ],
  };
}

function revocationDrillTemplate(
  surface: (typeof REVOCATION_FILES)[number][0],
  client: (typeof REVOCATION_FILES)[number][1]
) {
  return {
    reportVersion: 2,
    ok: false,
    status: "fail",
    checkedAt: "",
    mcpUrl: "",
    activeSessionSurface: surface,
    activeSessionClient: client,
    activeSessionTokenId: "",
    activeSessionIssuedAt: "",
    revokedSessionSurface: surface,
    revokedSessionClient: client,
    revokedSessionTokenId: "",
    revokedSessionIssuedAt: "",
    containsTokens: false,
    checks: [],
    instructions: [
      `Replace this template with greenhouse-recruiter-revocation-drill output from the production HTTPS MCP URL using ${client} credentials.`,
      "Use one active durable session token from the issued client rollout set and one separately issued token for the same physical client whose token id has been written to the server-side revocation table with greenhouse-recruiter-revoke-session.",
      "The report must prove the active rollout token initializes, the revoked token is denied with a revocation error, and both tokens carry token id plus issued-at metadata.",
      "Never paste durable token strings, Authorization headers, or config payloads into this report.",
    ],
  };
}

function formatRoutingCaseForRunbook(routingCase: (typeof DESKTOP_ROUTING_CASES)[number]): string {
  const requiredCounts: Readonly<Record<string, number>> = routingCase.requiredToolCounts;
  const required = Object.entries(requiredCounts).map(([tool, count]) => `${tool} x${count}`).join(", ") || "none";
  const requireAnyOf = "requireAnyOf" in routingCase ? routingCase.requireAnyOf.join(" or ") : "none";
  const allowed = routingCase.allowedTools.join(", ") || "no MCP tools";
  return `- \`${routingCase.caseId}\`: ${routingCase.testPrompt} Allowed: ${allowed}. Required counts: ${required}. Required alternative: ${requireAnyOf}.`;
}

function readmeTemplate(): string {
  return `# Greenhouse Recruiter MCP Rollout Evidence

This directory is a red-by-default scaffold. Do not edit files to pass the gate without running the corresponding live check.

## Required JSON Outputs

- live-probe-small-req-set.json: strict probe for a recruiter with a small req set
- live-probe-many-req-set.json: strict probe for a recruiter with many reqs
- live-probe-all-jobs-or-operator.json: strict probe for all-jobs/operator coverage
- live-probe-no-permissions.json: no-permissions probe proving zero visible jobs
- distribution-chatgpt-desktop.json: hosted protocol/catalog validation for ChatGPT/Codex using a chatgpt_codex_host credential
- distribution-claude-desktop.json: hosted protocol/catalog validation for Claude Desktop using a claude_desktop_chat credential
- distribution-claude-code.json: hosted protocol/catalog validation for Claude Code using a distinct claude_code credential
- revocation-drill-<client>.json: one v2 production revocation drill for each physical client, using matching active/revoked client credentials and three distinct revoked token ids
- session-revocation-<client>.json: the corresponding three token-free central revocation write reports
- production-env-check.json: secret-free greenhouse-recruiter-check-production-env output for the hosted server env file
- roster-preflight.json: token-free recruiter email roster preflight generated by greenhouse-recruiter-preflight-roster
- issued-sessions/manifest.json: token-free split session issuance manifest generated by greenhouse-recruiter-issue-session --out-dir; sensitive session files must contain matching email, subject, surface, client, token id, and issued-at metadata
- desktop-configs/manifest.json: combined token-free installation metadata covering the Claude Desktop MCPB, Claude Code config, and ChatGPT/Codex payload; sensitive artifacts must match their client-bound token metadata
- desktop-chatgpt-desktop.json: real ChatGPT/Codex attestation with testerEmail, attachmentMethod, and issued sessionTokenId and sessionIssuedAt
- desktop-claude-desktop.json: real Claude Desktop attestation with testerEmail, claude_desktop_mcpb attachmentMethod, and issued sessionTokenId and sessionIssuedAt
- desktop-claude-code.json: real Claude Code attestation with testerEmail, claude_code_http_mcp attachmentMethod, and its distinct issued sessionTokenId and sessionIssuedAt
- leakage-sample.json: strict scoped-vs-unscoped leakage sample generated by greenhouse-recruiter-sample-leakage
- audit-review.json: retained audit review generated from JSONL audit logs, covering success/denial events, all three v2 physical clients, coherent start/terminal attribution, and evidence/analysis calls

Each desktop attestation must record exact client/model versions and routing-test v${ROUTING_TEST_VERSION} results for all ${DESKTOP_ROUTING_CASES.length} canonical cases with at least ${MIN_ROUTING_RUNS} ordered observed-tool runs per case. Prompts, responses, ATS records, and resume text never belong in evidence JSON. Example-only placeholders are not client proof and keep rollout blocked.

Summarize local evidence status before the final gate with:

\`\`\`sh
greenhouse-recruiter-rollout-status --manifest manifest.json
\`\`\`

Run the final gate with:

\`\`\`sh
GREENHOUSE_RECRUITER_ROLLOUT_EVIDENCE_MANIFEST=manifest.json \\
GREENHOUSE_RECRUITER_ROLLOUT_LIVE_READYZ_URL=https://greenhouse-recruiter-mcp.example.com/readyz \\
GREENHOUSE_RECRUITER_READYZ_TOKEN=<operator-readyz-token> \\
greenhouse-recruiter-rollout-gate
\`\`\`

The gate sends the readiness token only after the URL matches the manifest-pinned candidate, then re-fetches that candidate's public \`/version\` and requires its running commit to match the pinned SHA.
`;
}


function runbookTemplate(): string {
  return `# Scoped Greenhouse MCP Broad Rollout Runbook

This runbook is the ordered production path for distributing durable at-will recruiter access. Keep Greenhouse credentials, the session signing secret, identity-directory credentials, and token-revocation credentials on the hosted MCP server. Recruiter desktop files should contain only the production MCP URL and that recruiter's durable token.

## 1. Bootstrap And Preflight The Recruiter Roster

If the production identity directory is not already populated, build a token-free reviewed plan from the managed recruiter roster and a Greenhouse users export. Apply only a clean plan; denied rows mean the identity directory needs manual repair before sessions are issued. If you include the bootstrap plan in the final manifest as \`identityBootstrapEvidence\`, the gate validates it against roster preflight.

\`\`\`sh
GREENHOUSE_RECRUITER_ALLOWED_EMAIL_DOMAINS=company.com \\
greenhouse-recruiter-bootstrap-identity \\
  --emails-file recruiters.txt \\
  --greenhouse-users-file greenhouse-users.json \\
  --out identity-bootstrap-plan.json

GREENHOUSE_RECRUITER_ALLOWED_EMAIL_DOMAINS=company.com \\
GREENHOUSE_RECRUITER_STATE_BACKEND=supabase_postgrest \\
GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_URL=https://exampleprojectref000.supabase.co \\
GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_KEY=... \\
greenhouse-recruiter-bootstrap-identity \\
  --emails-file recruiters.txt \\
  --greenhouse-users-file greenhouse-users.json \\
  --apply > identity-bootstrap-apply.json
\`\`\`

Then preflight the same roster without a signing secret and without minting durable tokens. The roster source must be a managed/admin source, not user-entered chat text; supported values are \`admin_managed_roster\`, \`google_workspace_group\`, \`okta_group\`, \`hris_report\`, and \`greenhouse_users_export\`.

\`\`\`sh
GREENHOUSE_RECRUITER_ALLOWED_EMAIL_DOMAINS=company.com \\
GREENHOUSE_RECRUITER_STATE_BACKEND=supabase_postgrest \\
GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_URL=https://exampleprojectref000.supabase.co \\
GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_KEY=... \\
greenhouse-recruiter-preflight-roster \\
  --emails-file recruiters.txt \\
  --surface both \\
  --source okta_group \\
  --verified-by ops-reviewer@example.com > roster-preflight.json
\`\`\`

Do not issue tokens until this report is clean. It must be recent, token-free, generated from a managed roster source, reviewed by an operator, resolve every normalized work email to exactly one Greenhouse user id, and cover both \`chatgpt_desktop\` and \`claude_desktop\`.

## 2. Issue Durable Sessions

\`\`\`sh
GREENHOUSE_RECRUITER_SESSION_SECRET=... \\
GREENHOUSE_RECRUITER_SCOPE_SIGNING_SECRET=... \\
GREENHOUSE_RECRUITER_ALLOWED_EMAIL_DOMAINS=company.com \\
GREENHOUSE_RECRUITER_STATE_BACKEND=supabase_postgrest \\
GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_URL=https://exampleprojectref000.supabase.co \\
GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_KEY=... \\
greenhouse-recruiter-issue-session \\
  --emails-file recruiters.txt \\
  --clients claude_desktop_chat,claude_code,chatgpt_codex_host \\
  --out-dir ./issued-sessions > issued-sessions-manifest.json
\`\`\`

The manifest is token-free. The generated files in \`issued-sessions/\` contain durable user tokens and must be treated as sensitive. The issuer chmods the output directory to \`0700\` and generated session/manifest files to \`0600\`; preserve those restrictions when moving artifacts into a vault or delivery workflow. Tokens must contain matching normalized email, subject, surface, token id, and issued-at metadata with no leading or trailing whitespace. Token ids must use only letters, numbers, colon, underscore, and hyphen up to 160 characters so they can be revoked and matched to evidence reliably. Tokens must not carry Greenhouse user ids, job ids, permission claims, or routine expiry claims.

## 3. Generate Client Installation Artifacts

\`\`\`sh
GREENHOUSE_RECRUITER_REMOTE_MCP_URL=https://greenhouse-recruiter-mcp.example.com/mcp \\
greenhouse-recruiter-desktop-config --client chatgpt_codex_host \\
  --issued-sessions-file ./issued-sessions/manifest.json \\
  --out-dir ./desktop-configs/chatgpt

greenhouse-recruiter-desktop-config --client claude_code \\
  --issued-sessions-file ./issued-sessions/manifest.json \\
  --out-dir ./desktop-configs/claude-code

greenhouse-recruiter-claude-mcpb \\
  --issued-session-file ./issued-sessions/recruiter@example.com--claude-desktop-chat.json \\
  --mcp-url https://greenhouse-recruiter-mcp.example.com/mcp \\
  --out-dir ./desktop-configs/claude-desktop

greenhouse-recruiter-desktop-config \\
  --merge-manifest ./desktop-configs/claude-desktop/manifest.json \\
  --merge-manifest ./desktop-configs/claude-code/manifest.json \\
  --merge-manifest ./desktop-configs/chatgpt/manifest.json \\
  --out-dir ./desktop-configs
\`\`\`

Every generated JSON or MCPB artifact is sensitive and goes only to the intended recruiter/client. The generators use \`0700\` directories and \`0600\` files, refuse overwrite, and emit token-free metadata. The merge command creates the one portable, token-free \`desktop-configs/manifest.json\` required by the gate while leaving token-bearing artifacts in their client subdirectories. Preserve those restrictions and never reuse a credential across Claude Desktop, Claude Code, and ChatGPT/Codex. After delivery, generate the token-free delivery report from the validated installation manifest:

\`\`\`sh
greenhouse-recruiter-record-desktop-delivery \\
  --desktop-config-manifest ./desktop-configs/manifest.json \\
  --delivered-by ops-reviewer@example.com \\
  --delivery-channel managed_desktop_install \\
  --attest-delivered-to-matching-recruiters \\
  --out ./desktop-delivery.json
\`\`\`

The helper records one metadata row per generated config and refuses to run without the explicit matching-recipient attestation. Approved broad-rollout delivery channels are \`managed_desktop_install\`, \`mdm_profile\`, \`endpoint_management\`, and \`secure_vault_delivery\`; ad hoc email/chat attachment channels are rejected. Never paste durable tokens, Authorization headers, or config payloads into \`desktop-delivery.json\`.

## 4. Host The Remote MCP Server

Before starting the hosted service, validate the proposed server-only environment file exactly as the container or host will receive it. The preflight intentionally does not merge in the operator shell, so desktop session tokens, remote validation tokens, or drill tokens in your terminal cannot make the hosted env look ready or not ready by accident.

\`\`\`sh
greenhouse-recruiter-check-production-env --env-file ./greenhouse-recruiter-production.env > production-env-check.json
\`\`\`

The output is secret-free and suitable for operator deployment notes: it includes readiness check names, statuses, summaries, configured surfaces, and the checked file path, but not Greenhouse credentials, Supabase keys, session secrets, readiness tokens, or recruiter durable tokens. It does not call Greenhouse or Supabase and does not replace live \`/readyz\`, hosted distribution validation, live permission probes, revocation drill, audit review, or desktop attestations after deployment.

Run \`greenhouse-recruiter-mcp-http\` behind the production HTTPS URL used above. A checked-in container artifact is available from the repo root:

\`\`\`sh
docker build \\
  -f packages/recruiter-mcp/deploy/Dockerfile \\
  -t greenhouse-recruiter-mcp .

node packages/recruiter-mcp/deploy/docker-smoke-test.mjs

GREENHOUSE_RECRUITER_DOCKER_SMOKE_RUN=true \\
node packages/recruiter-mcp/deploy/docker-smoke-test.mjs
\`\`\`

The first smoke command builds the image and runs the one-shot in-container non-HTTP contract/parser self-check; it does not start the HTTP server. The second performs that same build/self-check, then starts the container with non-secret dummy readiness env, mounts a temporary Docker audit volume, and probes public \`/healthz\` plus token-protected \`/readyz\`. It does not call Greenhouse data APIs and does not replace production HTTPS hosted distribution validation or live permission probes.

The image builds the shared Greenhouse client library but starts only the recruiter-scoped HTTP MCP command. Do not bake secrets into the image; inject them through the hosting platform or secret manager. The image creates \`/app/audit\` for the non-root runtime user, but production must explicitly mount or route \`GREENHOUSE_RECRUITER_AUDIT_JSONL_PATH\` to retained storage, for example \`/app/audit/audit.jsonl\`. The audit path must be absolute and end with \`.jsonl\`; readiness fails relative paths and non-JSONL sinks. The JSONL audit file is created or repaired as owner-only \`0600\` because retained audit evidence is metadata-only but still sensitive. Audit writes are required at request time; an unavailable sink returns \`AUDIT_UNAVAILABLE\` without Greenhouse data. Required server-side configuration includes \`GREENHOUSE_CLIENT_ID\`, \`GREENHOUSE_CLIENT_SECRET\`, \`GREENHOUSE_RECRUITER_SESSION_SECRET\` with no surrounding whitespace, \`GREENHOUSE_RECRUITER_SCOPE_SIGNING_SECRET\` with no surrounding whitespace, a separate 32+ character \`GREENHOUSE_RECRUITER_READYZ_TOKEN\`, \`GREENHOUSE_RECRUITER_STATE_BACKEND=supabase_postgrest\`, the Supabase/PostgREST identity directory configuration with an exact non-whitespace API key, the Supabase/PostgREST token revocation configuration with an exact non-whitespace API key, bounded identity/revocation lookup timeouts, the hosted POST body byte limit, valid distinct hosted endpoint route/port settings, hosted incoming HTTP timeout limits, \`GREENHOUSE_RECRUITER_AUDIT_JSONL_PATH\`, exact \`GREENHOUSE_RECRUITER_REMOTE_SURFACES\`, and an explicit exact HTTPS \`GREENHOUSE_RECRUITER_CORS_ORIGIN\` allowlist. Start from \`deploy/production.env.example\`; keep desktop session tokens, remote validation tokens, active/revoked drill tokens, \`GREENHOUSE_RECRUITER_IDENTITY_JSON\`, static-identity dev overrides, test-surface flags, and \`GREENHOUSE_RECRUITER_TRUSTED_ACT_AS_USER_ID\` out of the hosted process environment or \`/readyz\` will fail. Set \`GREENHOUSE_RECRUITER_CORS_ORIGIN\` to a comma-separated allowlist for the approved ChatGPT/Claude/broker origins with no spaces; missing, whitespace-padded, duplicated, wildcard, path/query/fragment, or non-HTTPS origins fail hosted readiness. Set \`GREENHOUSE_RECRUITER_REMOTE_SURFACES\` to \`chatgpt_desktop\`, \`claude_desktop\`, or \`chatgpt_desktop,claude_desktop\` with no spaces; unsupported, empty, duplicated, or whitespace-padded entries fail hosted readiness and runtime surface checks. Detailed \`/readyz\` output requires \`Authorization: Bearer <readyz-token>\`; missing or weak readiness-token config returns only a generic not-ready response. The hosted \`/mcp\` path also requires the implemented Supabase/PostgREST state backend and revocation source for remote durable sessions; static revoked-token env alone is not enough for broad distribution. DynamoDB or another internal DB requires a new implemented identity/revocation adapter before hosted pilot readiness. Disallowed browser origins are rejected before auth handling, oversized or malformed authenticated POST bodies fail before MCP transport/tool handling, and slow incoming headers/bodies are bounded without capping normal MCP response/SSE duration. Keep \`GREENHOUSE_RECRUITER_ALLOW_TEST_SURFACE\` unset for production.

## 5. Validate Hosted Distribution And Revocation Per Physical Client

Use the distinct \`chatgpt_codex_host\`, \`claude_desktop_chat\`, and \`claude_code\` tokens from \`issued-sessions/manifest.json\`. Do not use an arbitrary token or reuse one client's token for another client.

\`\`\`sh
GREENHOUSE_RECRUITER_REMOTE_MCP_URL=https://greenhouse-recruiter-mcp.example.com/mcp \\
GREENHOUSE_RECRUITER_REMOTE_READY_TOKEN=<operator-readyz-token> \\
GREENHOUSE_RECRUITER_EXPECTED_COMMIT_SHA=<40-character-candidate-git-sha> \\
GREENHOUSE_RECRUITER_SESSION_TOKEN=<chatgpt_desktop issued token> \\
greenhouse-recruiter-validate-distribution > distribution-chatgpt-desktop.json

GREENHOUSE_RECRUITER_REMOTE_MCP_URL=https://greenhouse-recruiter-mcp.example.com/mcp \\
GREENHOUSE_RECRUITER_REMOTE_READY_TOKEN=<operator-readyz-token> \\
GREENHOUSE_RECRUITER_EXPECTED_COMMIT_SHA=<40-character-candidate-git-sha> \\
GREENHOUSE_RECRUITER_SESSION_TOKEN=<claude_desktop issued token> \\
greenhouse-recruiter-validate-distribution > distribution-claude-desktop.json

GREENHOUSE_RECRUITER_REMOTE_MCP_URL=https://greenhouse-recruiter-mcp.example.com/mcp \\
GREENHOUSE_RECRUITER_REMOTE_READY_TOKEN=<operator-readyz-token> \\
GREENHOUSE_RECRUITER_EXPECTED_COMMIT_SHA=<40-character-candidate-git-sha> \\
GREENHOUSE_RECRUITER_SESSION_TOKEN=<claude_code issued token> \\
greenhouse-recruiter-validate-distribution > distribution-claude-code.json
\`\`\`

The final gate requires each report to use the production HTTPS MCP URL, prove unauthenticated \`/readyz\` denial, bind same-origin \`/version\` to the exact expected candidate commit, expose no write/admin tools, include all analysis tools, record the matching \`sessionSurface\` and \`sessionClient\`, and record \`sessionTokenId\` plus \`sessionIssuedAt\` values present in both the issued-session manifest and the desktop-config manifest. The gate also verifies that sensitive session/config token metadata matches the token-free manifests and that session/config token ids and issued-at timestamps agree for every recruiter/surface/client identity.

Before each revocation drill, issue a separate durable drill token for that physical client, then write only its token id to the server-side revocation table. Do not paste the signed token into the revocation table command.

\`\`\`sh
GREENHOUSE_RECRUITER_REVOCATION_SUPABASE_URL=https://exampleprojectref000.supabase.co \\
GREENHOUSE_RECRUITER_REVOCATION_SUPABASE_KEY=... \\
greenhouse-recruiter-revoke-session \\
  --token-id <revoked-token-id> \\
  --revoked-by ops-reviewer@example.com \\
  --reason 'Claude Desktop revocation drill' > session-revocation-claude-desktop.json
\`\`\`

Then run \`greenhouse-recruiter-revocation-drill\` with one active token and that revoked token for the same physical client against the production MCP URL:

\`\`\`sh
GREENHOUSE_RECRUITER_REMOTE_MCP_URL=https://greenhouse-recruiter-mcp.example.com/mcp \\
GREENHOUSE_RECRUITER_ACTIVE_SESSION_TOKEN=<active-issued-token> \\
GREENHOUSE_RECRUITER_REVOKED_SESSION_TOKEN=<revoked-drill-token> \\
greenhouse-recruiter-revocation-drill > revocation-drill-claude-desktop.json
\`\`\`

Repeat both commands with distinct revoked token ids and matching active/revoked credentials for Claude Code and ChatGPT/Codex, writing \`session-revocation-claude-code.json\`, \`revocation-drill-claude-code.json\`, \`session-revocation-chatgpt-codex.json\`, and \`revocation-drill-chatgpt-codex.json\`. The gate requires all three client pairs and rejects duplicated revoked token ids.

## 6. Run Live Scoped Probes

Run strict probes for a small-req recruiter, a many-req recruiter, and an all-jobs/operator case. Run the no-permissions probe with evidence that zero jobs are visible.

\`\`\`sh
GREENHOUSE_RECRUITER_PROBE_STRICT=true \\
GREENHOUSE_RECRUITER_PROBE_PROFILE=small_req_set \\
GREENHOUSE_RECRUITER_BUILD_SHA=<40-character-candidate-git-sha> \\
GREENHOUSE_RECRUITER_PROBE_EXPECT_VISIBLE_DATA=true \\
GREENHOUSE_RECRUITER_PROBE_EXPECT_JOB_IDS=123,456 \\
GREENHOUSE_RECRUITER_PROBE_FORBIDDEN_JOB_IDS=789 \\
greenhouse-recruiter-probe > live-probe-small-req-set.json
\`\`\`

Repeat with the corresponding durable session, expected ids, and forbidden ids, setting \`GREENHOUSE_RECRUITER_PROBE_PROFILE\` to \`many_req_set\` and \`all_jobs_or_operator\` for those strict data-bearing reports. For \`no_permissions\`, set the profile to \`no_permissions\`, strict and expect-visible-data to false, and use the exact same candidate build SHA. The final gate binds every report's self-identified profile, permission-scope kind/count, data denominators, and build commit to the authoritative candidate.

## 7. Prove Scoped-Vs-Unscoped Leakage Protection

\`\`\`sh
GREENHOUSE_RECRUITER_LEAKAGE_ACT_AS_USER_ID=123 \\
GREENHOUSE_RECRUITER_LEAKAGE_FORBIDDEN_JOB_IDS=789 \\
GREENHOUSE_RECRUITER_LEAKAGE_STRICT=true \\
GREENHOUSE_RECRUITER_BUILD_SHA=<40-character-candidate-git-sha> \\
greenhouse-recruiter-sample-leakage > leakage-sample.json
\`\`\`

Use an allowlisted operator session. The report must prove known unassigned reqs are visible to the operator and hidden from the target recruiter's scoped preview.

## 8. Capture Real Desktop Attestations

Replace \`desktop-chatgpt-desktop.json\`, \`desktop-claude-desktop.json\`, and \`desktop-claude-code.json\` with real user-test results generated by \`greenhouse-recruiter-record-desktop-test\`. Each attestation must use a tester email from \`roster-preflight.json\`, name the physical \`client\` and actual \`attachmentMethod\` tested, record the client/model versions shown by that client, include the non-secret \`sessionTokenId\` and \`sessionIssuedAt\` issued for that tester/client pair plus matching \`sessionTokenIdAfterRestart\` and \`sessionIssuedAtAfterRestart\`, use the production HTTPS MCP URL, run every canonical routing case at least ${MIN_ROUTING_RUNS} times, expose no visible write/admin tools, and prove durable access survives restart without routine re-verification. The routing matrix covers all five critical analytical prompts, all nine candidate-intelligence prompts, aggregate-versus-document comparison, scheduled-interview/panel/scorecard distinctions, candidate-versus-hidden-job notes, source metric versus lookup, attachment list versus resume retrieval, scorecard summary versus question answers, exact scope routing, and hostile instructions inside resume text. ChatGPT evidence must use one of \`chatgpt_developer_mode_remote_mcp\`, \`chatgpt_desktop_remote_mcp\`, or \`responses_api_broker\`; Claude Desktop evidence must use \`claude_desktop_mcpb\`; Claude Code evidence must use \`claude_code_http_mcp\`. A generated payload alone is not sufficient client proof; neither is a locally simulated route. Missing real-client results remain pending and block rollout.

The structured report proves candidate routing conformance. It does not manufacture a pre-change baseline: retain same-client/model baseline results separately wherever they can be collected, compare them before release, and treat a missing zero-regression comparison as a manual release blocker.

Run these exact prompts in each physical client, replacing only angle-bracket placeholders with recruiter-visible test records. Record tool selection, not prompt or response content, in the evidence JSON:

${DESKTOP_ROUTING_CASES.map(formatRoutingCaseForRunbook).join("\n")}

Save one \`<case-id>=<actual+ordered+tool+sequence>\` line for every actual routing run in \`routing-checks-chatgpt.txt\`; every canonical case must appear at least ${MIN_ROUTING_RUNS} times.

\`\`\`bash
routing_args=()
while IFS= read -r routing_check; do
  routing_args+=(--routing-check "$routing_check")
done < ./routing-checks-chatgpt.txt

greenhouse-recruiter-record-desktop-test \
  --surface chatgpt_desktop \
  --client chatgpt_codex_host \
  --tester-email recruiter@example.com \
  --mcp-url https://greenhouse-recruiter-mcp.example.com/mcp \
  --attachment-method chatgpt_developer_mode_remote_mcp \
  --session-issuance-manifest ./issued-sessions/manifest.json \
  --desktop-config-manifest ./desktop-configs/manifest.json \
  --session-token-id-after-restart <same-issued-token-id> \
  --session-issued-at-after-restart <same-issued-at-timestamp> \
  --client-version '<version shown by the client>' \
  --model-version '<version shown by the client>' \
  --exercised-tools '<comma-separated unique tools actually observed>' \
  --task-outcome useful \
  --task-outcome-reason answer_received \
  "\${routing_args[@]}" \
  --attest-resume-instructions-untrusted \
  --attest-durable-session-access \
  --attest-session-persisted-across-restart \
  --attest-no-routine-reverification \
  --attest-no-write-admin-tools-visible \
  --out ./desktop-chatgpt-desktop.json

# Repeat for Claude Desktop with --surface claude_desktop, --client claude_desktop_chat, and --attachment-method claude_desktop_mcpb.
# Repeat again for Claude Code with --surface claude_desktop, --client claude_code, and --attachment-method claude_code_http_mcp.
\`\`\`

Supply one \`--routing-check\` per actual run, repeating every case at least ${MIN_ROUTING_RUNS} times. Use \`tool_a+tool_b\` to preserve observed call order and \`job_note_unavailable=\` for the intentional no-tool result. The helper rejects missing, duplicate report cases, unknown, hidden, disallowed, incomplete, or unbounded sequences; it records only case IDs and tool names, never prompts, ATS records, or responses. It also reads only token-free manifests, cross-checks the tester email/surface/client against issued sessions and desktop configs, requires the post-restart token id and issued-at timestamp to match the original durable session metadata, and refuses to write token strings, Authorization headers, config payloads, or Greenhouse data.

## 9. Review Retained Audit Logs

\`\`\`sh
GREENHOUSE_RECRUITER_AUDIT_JSONL_PATH=/secure/path/greenhouse-recruiter-audit.jsonl \\
GREENHOUSE_RECRUITER_AUDIT_REVIEWER=ops-reviewer@example.com \\
greenhouse-recruiter-review-audit > audit-review.json
\`\`\`

The audit sample must remain metadata-only and include success and denial events plus paired v2 terminal attribution for \`claude_desktop_chat\`, \`claude_code\`, and \`chatgpt_codex_host\`. Historical and \`legacy_unknown\` rows remain reviewable but do not satisfy physical-client coverage.

## 10. Build And Run The Final Gate

Keep every manifest-referenced evidence file under this rollout evidence directory. The manifest builder stores paths relative to \`manifest.json\`, normalizes cwd-relative paths that point inside this directory, and rejects paths that escape it. Split session/config manifests must keep \`outputDir\` as \`.\` and use relative \`manifestPath\` plus relative file entries.

\`\`\`sh
greenhouse-recruiter-build-rollout-manifest \\
  --force \\
  --out ./manifest.json \\
  --candidate-mcp-url https://greenhouse-recruiter-mcp.example.com/mcp \\
  --candidate-commit <40-character-candidate-git-sha> \\
  --small-req-probe ./live-probe-small-req-set.json \\
  --many-req-probe ./live-probe-many-req-set.json \\
  --all-jobs-probe ./live-probe-all-jobs-or-operator.json \\
  --no-permissions-probe ./live-probe-no-permissions.json \\
  --chatgpt-distribution ./distribution-chatgpt-desktop.json \\
  --claude-distribution ./distribution-claude-desktop.json \\
  --claude-code-distribution ./distribution-claude-code.json \\
  --production-env ./production-env-check.json \\
  --claude-revocation-drill ./revocation-drill-claude-desktop.json \\
  --claude-code-revocation-drill ./revocation-drill-claude-code.json \\
  --chatgpt-revocation-drill ./revocation-drill-chatgpt-codex.json \\
  --claude-session-revocation ./session-revocation-claude-desktop.json \\
  --claude-code-session-revocation ./session-revocation-claude-code.json \\
  --chatgpt-session-revocation ./session-revocation-chatgpt-codex.json \\
  --roster-preflight ./roster-preflight.json \\
  --session-issuance ./issued-sessions/manifest.json \\
  --desktop-config ./desktop-configs/manifest.json \\
  --desktop-delivery ./desktop-delivery.json \\
  --chatgpt-desktop-test ./desktop-chatgpt-desktop.json \\
  --claude-desktop-test ./desktop-claude-desktop.json \\
  --claude-code-desktop-test ./desktop-claude-code.json \\
  --leakage-sample ./leakage-sample.json \\
  --audit-review ./audit-review.json \\
  --removed-req-disappeared-on-next-read \\
  --added-req-appeared-without-deploy \\
  --private-notes-dropped \\
  --scoped-vs-unscoped-leakage-sample-passed \\
  --durable-access-tested-without-routine-reverification \\
  --permission-freshness-verified-at 2026-06-23T00:00:00.000Z \\
  --permission-freshness-verified-by ops-reviewer@example.com \\
  --removed-req-id 123 \\
  --removed-req-rows-before 1 \\
  --removed-req-rows-after 0 \\
  --added-req-id 456 \\
  --added-req-rows-before 0 \\
  --added-req-rows-after 1 \\
  --private-note-id 789 \\
  --private-note-rows-returned 0 \\
  --durable-session-email recruiter@example.com \\
  --durable-session-surface chatgpt_desktop \\
  --durable-session-token-id <issued-token-id> \\
  --durable-session-token-id-after-restart <same-issued-token-id> \\
  --durable-session-issued-at <issued-at-timestamp> \\
  --durable-session-issued-at-after-restart <same-issued-at-timestamp>

greenhouse-recruiter-rollout-status --manifest ./manifest.json

GREENHOUSE_RECRUITER_ROLLOUT_EVIDENCE_MANIFEST=./manifest.json \\
GREENHOUSE_RECRUITER_ROLLOUT_LIVE_READYZ_URL=https://greenhouse-recruiter-mcp.example.com/readyz \\
GREENHOUSE_RECRUITER_READYZ_TOKEN=<operator-readyz-token> \\
greenhouse-recruiter-rollout-gate
\`\`\`

After the gate is green, create a token-free review/share bundle from the manifest instead of zipping this working directory. The working directory can contain token-bearing files under \`issued-sessions/\` and \`desktop-configs/\`; the packer copies only manifest-referenced evidence JSON and skips generated session/config files.

\`\`\`sh
greenhouse-recruiter-pack-rollout-evidence \
  --manifest ./manifest.json \
  --out-dir ./token-free-review-bundle
\`\`\`

Only distribute broadly after the final gate is green, \`npm run verify:rollout\` is green, the protected core/analytics diff check is empty, and \`desktop-delivery.json\` proves the generated desktop files were delivered only to the matching recruiter emails from the preflight roster. Permission-freshness durable session fields must name the recruiter work email, desktop surface, token id, and issued-at timestamp present in both the issued-session manifest and desktop-config manifest, with identical post-restart values. Timestamped dynamic rollout evidence must be no more than 14 days old when the final gate runs: production env preflight \`generatedAt\`, roster preflight \`generatedAt\`, permission freshness \`verifiedAt\`, live probe \`generatedAt\`, distribution validation \`checkedAt\`, central session revocation \`revokedAt\`, revocation drill \`checkedAt\`, desktop delivery \`deliveredAt\`, desktop user-test \`testedAt\`, leakage sample \`generatedAt\`, and audit review \`reviewedAt\`. This recency rule applies to rollout proof only; issued recruiter sessions remain durable until revoked.
`;
}

async function writeJson(dir: string, filename: string, value: unknown, force: boolean | undefined, filesWritten: string[]): Promise<void> {
  await writeText(dir, filename, `${JSON.stringify(value, null, 2)}\n`, force, filesWritten);
}

async function writeText(dir: string, filename: string, value: string, force: boolean | undefined, filesWritten: string[]): Promise<void> {
  const path = resolve(dir, filename);
  if (!force && await exists(path)) {
    const current = await readFile(path, "utf8");
    if (current !== value) {
      throw new Error(`${filename} already exists; pass --force to overwrite scaffold files.`);
    }
    await chmod(path, EVIDENCE_FILE_MODE);
    return;
  }
  await writeFile(path, value, { encoding: "utf8", mode: EVIDENCE_FILE_MODE });
  await chmod(path, EVIDENCE_FILE_MODE);
  filesWritten.push(filename);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function parseArgs(args: string[]): RolloutEvidenceInitOptions {
  let outputDir = "greenhouse-recruiter-rollout-evidence";
  let force = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if ((arg === "--out" || arg === "-o") && args[index + 1]) {
      outputDir = args[index + 1]!;
      index += 1;
      continue;
    }
    if (arg === "--force") {
      force = true;
    }
  }
  return { outputDir, force };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startRolloutEvidenceInitCli().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[greenhouse-recruiter-init-rollout-evidence] ${message}\n`);
    process.exit(1);
  });
}
