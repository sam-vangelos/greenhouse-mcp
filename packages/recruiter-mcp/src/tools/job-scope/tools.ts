import { newCorrelationId } from "../../audit.js";
import { isToolEnabled, readPositiveInt } from "../../limits.js";
import {
  createToolDeadline,
  deny,
  emitRequiredToolAudit,
  enforceUsageBudget,
  type RecruiterToolRuntime,
  type ToolDeadline,
} from "../../runtime.js";
import type {
  RecruiterDenialCode,
  RecruiterPermissionScope,
  RecruiterToolDefinition,
  RecruiterToolResult,
} from "../../types.js";
import { getRecruitingCapabilities } from "../../resolvers/job-scope/capabilities.js";
import { loadJobInventory, type JobInventory } from "../../resolvers/job-scope/inventory.js";
import {
  ownerFilterRequested,
  resolveJobScope,
  type ResolveJobScopeFilters,
  type ResolveJobScopeInput,
  type ResolveDefaultStatus,
  type ResolvePurpose,
  type ResolveStatusFilter,
} from "../../resolvers/job-scope/resolver.js";
import { httpErrorStatus, readAllScopedRows } from "../../read-all.js";
import { scopeHashOf } from "../../resolvers/job-scope/scope-handle.js";
import { resolveScopeSigner } from "../../resolvers/job-scope/signer.js";

export const RESOLVE_JOB_SCOPE_TOOL: RecruiterToolDefinition = {
  name: "resolve_job_scope",
  kind: "analysis",
  description:
    "Resolve natural-language, requisition, alias, or exact-id job references into a proposed or auto-confirmed, permission-scoped scope_handle. Read-only; returns job metadata only.",
};

export const CONFIRM_JOB_SCOPE_TOOL: RecruiterToolDefinition = {
  name: "confirm_job_scope",
  kind: "analysis",
  description:
    "Confirm, narrow, or reject a proposed job scope and mint a signed, session-bound scope_handle. Read-only; revalidates permissions.",
};

export const GET_JOB_SCOPE_TOOL: RecruiterToolDefinition = {
  name: "get_job_scope",
  kind: "analysis",
  description:
    "Inspect a scope_handle (validity, frozen jobs, expiry, current accessibility) without running analysis. Read-only.",
};

export const GET_RECRUITING_CAPABILITIES_TOOL: RecruiterToolDefinition = {
  name: "get_recruiting_capabilities",
  kind: "analysis",
  description:
    "List supported read-only scoped analysis recipes, user modes, and the job-scope-resolution contract. Read-only; no write/admin tools.",
};

interface ConfirmJobScopeOutput {
  scope_handle: string | null;
  scope_status: "confirmed" | "rejected" | "needs_revision";
  job_ids: number[];
  job_count: number;
  scope_label: string;
  scope_hash: string;
  expires_at: string | null;
  permission_revalidated: boolean;
  warnings: string[];
}

interface GetJobScopeOutput {
  valid: boolean;
  scope_status: "confirmed" | "expired" | "invalid" | "forbidden";
  job_ids: number[];
  job_count: number;
  scope_label: string | null;
  expires_at: string | null;
  permission_revalidated: boolean;
  inaccessible_job_ids: number[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// resolve_job_scope
// ---------------------------------------------------------------------------

export async function runResolveJobScope(
  runtime: RecruiterToolRuntime,
  params: Record<string, unknown>
): Promise<RecruiterToolResult> {
  const toolName = RESOLVE_JOB_SCOPE_TOOL.name;
  const startedAt = runtime.now();
  const correlationId = newCorrelationId(runtime.now);
  const actAsUser = runtime.trustedActAsUser ?? null;

  if (!isToolEnabled(runtime.toolConfig, runtime.session.surface, toolName, "analysis")) {
    const result = deny(toolName, "TOOL_DISABLED", "Job scope resolution is disabled for this runtime.");
    return (await emitRequiredToolAudit(runtime, toolName, "analysis", startedAt, correlationId, result, null, null, actAsUser, { scopeAction: "resolve" })) ?? result;
  }
  const rateDenied = await enforceUsageBudget(runtime, toolName, "analysis", runtime.session.surface, startedAt, correlationId, actAsUser);
  if (rateDenied) return rateDenied;

  const input = parseResolveInput(params);
  const deadline = createToolDeadline(runtime, startedAt);
  const load = await loadJobInventory(runtime, deadline);
  if (!load.ok) {
    const result = deny(toolName, load.code, load.message);
    return (await emitRequiredToolAudit(runtime, toolName, "analysis", startedAt, correlationId, result, null, null, actAsUser, { scopeAction: "resolve" })) ?? result;
  }

  // Owner pre-resolution: turn my_jobs_only / recruiter_user_ids / hiring_manager_user_ids into a
  // permitted-bounded owned-job set before the deterministic resolver runs. Fails closed (never
  // broadens) on a read error / incomplete read / unresolved identity.
  const ownerScope = await resolveOwnerScope(runtime, toolName, input.filters, load.inventory, deadline);
  if (!ownerScope.ok) {
    const result = deny(toolName, ownerScope.code, ownerScope.message);
    return (await emitRequiredToolAudit(runtime, toolName, "analysis", startedAt, correlationId, result, null, null, actAsUser, { scopeAction: "resolve" })) ?? result;
  }

  const { signer, ephemeral } = resolveScopeSigner(runtime);
  const output = resolveJobScope(input, {
    inventory: load.inventory,
    subject: runtime.session.subject,
    signer,
    nowMs: runtime.now(),
    maxCandidates: input.max_candidates,
    signerEphemeral: ephemeral,
    ownerScopedJobIds: ownerScope.ownerScopedJobIds,
  });

  // Disclose any explicitly requested owner source dropped by graceful degradation, so confirm + the recruiter know the owned set
  // is partial — never silently. The resolved set is still owned ∩ permitted; degrade only ever drops.
  if (ownerScope.ownerSourcesOmitted && ownerScope.ownerSourcesOmitted.length > 0) {
    output.owner_sources_omitted = ownerScope.ownerSourcesOmitted;
    for (const omission of ownerScope.ownerSourcesOmitted) {
      output.warnings.push(`Owner scope is partial — ${omission.reason}`);
    }
  }

  const result: RecruiterToolResult = {
    ok: true,
    toolName,
    actorId: load.inventory.actorId ?? undefined,
    effectiveActorId: load.inventory.actorId ?? undefined,
    scoped: load.inventory.scopeKind === "jobs",
    permissionScope: permissionScopeFor(load.inventory),
    data: output,
    nextCursor: null,
  };
  const audited = await emitRequiredToolAudit(
    runtime, toolName, "analysis", startedAt, correlationId, result, load.inventory.accessibleSeen, output.scope.job_count, actAsUser,
    {
      scopeAction: "resolve",
      scopeResolutionStatus: output.resolution_status,
      scopeStatus: output.scope.scope_status,
      scopeJobCount: output.scope.job_count,
      scopeConfirmationRequired: output.confirmation.required,
      scopeHash: output.scope.scope_hash,
      resolvedJobIds: output.scope.job_ids,
    }
  );
  return audited ?? result;
}

// ---------------------------------------------------------------------------
// confirm_job_scope
// ---------------------------------------------------------------------------

export async function runConfirmJobScope(
  runtime: RecruiterToolRuntime,
  params: Record<string, unknown>
): Promise<RecruiterToolResult> {
  const toolName = CONFIRM_JOB_SCOPE_TOOL.name;
  const startedAt = runtime.now();
  const correlationId = newCorrelationId(runtime.now);
  const actAsUser = runtime.trustedActAsUser ?? null;

  if (!isToolEnabled(runtime.toolConfig, runtime.session.surface, toolName, "analysis")) {
    const result = deny(toolName, "TOOL_DISABLED", "Job scope confirmation is disabled for this runtime.");
    return (await emitRequiredToolAudit(runtime, toolName, "analysis", startedAt, correlationId, result, null, null, actAsUser, { scopeAction: "confirm" })) ?? result;
  }
  const rateDenied = await enforceUsageBudget(runtime, toolName, "analysis", runtime.session.surface, startedAt, correlationId, actAsUser);
  if (rateDenied) return rateDenied;

  const confirmationToken = typeof params.confirmation_token === "string" ? params.confirmation_token.trim() : "";
  const decision = readDecision(params.decision);
  if (confirmationToken.length === 0 || decision === null) {
    const result = deny(toolName, "INVALID_REQUEST", "confirm_job_scope requires confirmation_token and a valid decision.");
    return (await emitRequiredToolAudit(runtime, toolName, "analysis", startedAt, correlationId, result, null, null, actAsUser, { scopeAction: "confirm" })) ?? result;
  }

  const { signer, ephemeral } = resolveScopeSigner(runtime);
  const verified = signer.verifyConfirmationToken(confirmationToken, { subject: runtime.session.subject, nowMs: runtime.now() });
  if (!verified.ok) {
    const message = verified.reason === "expired"
      ? "confirmation_token has expired. Re-run resolve_job_scope."
      : verified.reason === "forbidden"
        ? "confirmation_token was not issued to this session."
        : "confirmation_token is invalid.";
    const code = verified.reason === "forbidden" ? "ACTOR_DENIED" : "INVALID_REQUEST";
    const result = deny(toolName, code, message);
    return (await emitRequiredToolAudit(runtime, toolName, "analysis", startedAt, correlationId, result, null, null, actAsUser, { scopeAction: "confirm" })) ?? result;
  }

  const payload = verified.payload;

  const suppliedResolutionId = typeof params.resolution_id === "string" ? params.resolution_id.trim() : "";
  if (suppliedResolutionId.length > 0 && suppliedResolutionId !== payload.rid) {
    const result = deny(toolName, "INVALID_REQUEST", "resolution_id does not match the confirmation_token.");
    return (await emitRequiredToolAudit(runtime, toolName, "analysis", startedAt, correlationId, result, null, null, actAsUser, { scopeAction: "confirm" })) ?? result;
  }

  if (decision === "reject") {
    return finishConfirm(runtime, startedAt, correlationId, actAsUser, rejectedConfirm("Scope rejected by the user."));
  }
  if (decision === "revise") {
    return finishConfirm(runtime, startedAt, correlationId, actAsUser, {
      scope_handle: null,
      scope_status: "needs_revision",
      job_ids: [],
      job_count: 0,
      scope_label: payload.label,
      scope_hash: scopeHashOf([]),
      expires_at: null,
      permission_revalidated: false,
      warnings: ["Re-run resolve_job_scope with a revised query before confirming."],
    });
  }

  // confirm_all | confirm_selected
  const proposed = payload.jobs;
  const warnings: string[] = [];
  let chosen = proposed;
  if (decision === "confirm_selected") {
    const selected = sanitizeJobIdArray(params.selected_job_ids);
    const proposedSet = new Set(proposed);
    const escalated = selected.filter((id) => !proposedSet.has(id));
    chosen = selected.filter((id) => proposedSet.has(id));
    if (escalated.length > 0) {
      warnings.push(`Ignored ${escalated.length} selected id(s) outside the proposed scope; selection can only narrow.`);
    }
    if (chosen.length === 0) {
      return finishConfirm(runtime, startedAt, correlationId, actAsUser, {
        scope_handle: null,
        scope_status: "needs_revision",
        job_ids: [],
        job_count: 0,
        scope_label: payload.label,
        scope_hash: scopeHashOf([]),
        expires_at: null,
        permission_revalidated: false,
        warnings: [...warnings, "No valid jobs were selected from the proposed scope."],
      });
    }
  }

  const acknowledgements = isRecord(params.acknowledgements) ? params.acknowledgements : {};
  const missingAcks = (payload.requires_ack ?? []).filter((ack) => acknowledgements[ack] !== true);
  if (missingAcks.length > 0) {
    return finishConfirm(runtime, startedAt, correlationId, actAsUser, {
      scope_handle: null,
      scope_status: "needs_revision",
      job_ids: [],
      job_count: 0,
      scope_label: payload.label,
      scope_hash: scopeHashOf(chosen),
      expires_at: null,
      permission_revalidated: false,
      warnings: [...warnings, `Missing required acknowledgement(s): ${missingAcks.join(", ")}.`],
    });
  }

  // Permission revalidation at confirm time.
  const deadline = createToolDeadline(runtime, startedAt);
  const load = await loadJobInventory(runtime, deadline);
  if (!load.ok) {
    const result = deny(toolName, load.code, load.message);
    return (await emitRequiredToolAudit(runtime, toolName, "analysis", startedAt, correlationId, result, null, null, actAsUser, { scopeAction: "confirm" })) ?? result;
  }
  const accessibleIds = new Set(load.inventory.records.map((record) => record.greenhouse_job_id));
  const accessibleChosen = chosen.filter((id) => accessibleIds.has(id));
  const dropped = chosen.filter((id) => !accessibleIds.has(id));
  if (dropped.length > 0) {
    warnings.push(`${dropped.length} job(s) are no longer accessible and were dropped from the scope.`);
  }
  if (accessibleChosen.length === 0) {
    return finishConfirm(runtime, startedAt, correlationId, actAsUser, {
      ...rejectedConfirm("No jobs in the confirmed scope are currently accessible."),
      scope_label: payload.label,
      warnings: [...warnings, "No jobs in the confirmed scope are currently accessible."],
    });
  }

  const ttlMs = undefined;
  const scopeHandle = signer.signScopeHandle({
    subject: runtime.session.subject,
    jobIds: accessibleChosen,
    complete: payload.complete,
    label: payload.label,
    source: payload.src,
    issuedAtMs: runtime.now(),
    ttlMs,
  });
  if (ephemeral) warnings.push("scope_signing_key_ephemeral: this scope_handle validates only within this server process.");
  const sortedChosen = [...accessibleChosen].sort((a, b) => a - b);

  return finishConfirm(runtime, startedAt, correlationId, actAsUser, {
    scope_handle: scopeHandle,
    scope_status: "confirmed",
    job_ids: sortedChosen,
    job_count: sortedChosen.length,
    scope_label: payload.label,
    scope_hash: scopeHashOf(sortedChosen),
    expires_at: new Date(runtime.now() + 60 * 60 * 1000).toISOString(),
    permission_revalidated: true,
    warnings,
  }, load.inventory);
}

// ---------------------------------------------------------------------------
// get_job_scope
// ---------------------------------------------------------------------------

export async function runGetJobScope(
  runtime: RecruiterToolRuntime,
  params: Record<string, unknown>
): Promise<RecruiterToolResult> {
  const toolName = GET_JOB_SCOPE_TOOL.name;
  const startedAt = runtime.now();
  const correlationId = newCorrelationId(runtime.now);
  const actAsUser = runtime.trustedActAsUser ?? null;

  if (!isToolEnabled(runtime.toolConfig, runtime.session.surface, toolName, "analysis")) {
    const result = deny(toolName, "TOOL_DISABLED", "Job scope inspection is disabled for this runtime.");
    return (await emitRequiredToolAudit(runtime, toolName, "analysis", startedAt, correlationId, result, null, null, actAsUser, { scopeAction: "get" })) ?? result;
  }
  const rateDenied = await enforceUsageBudget(runtime, toolName, "analysis", runtime.session.surface, startedAt, correlationId, actAsUser);
  if (rateDenied) return rateDenied;

  const scopeHandle = typeof params.scope_handle === "string" ? params.scope_handle.trim() : "";
  if (scopeHandle.length === 0) {
    const result = deny(toolName, "INVALID_REQUEST", "get_job_scope requires a scope_handle.");
    return (await emitRequiredToolAudit(runtime, toolName, "analysis", startedAt, correlationId, result, null, null, actAsUser, { scopeAction: "get" })) ?? result;
  }

  const { signer } = resolveScopeSigner(runtime);
  const verified = signer.verifyScopeHandle(scopeHandle, { subject: runtime.session.subject, nowMs: runtime.now() });
  if (!verified.ok) {
    const scopeStatus = verified.reason === "expired" ? "expired" : verified.reason === "forbidden" ? "forbidden" : "invalid";
    const output: GetJobScopeOutput = {
      valid: false,
      scope_status: scopeStatus,
      job_ids: [],
      job_count: 0,
      scope_label: null,
      expires_at: null,
      permission_revalidated: false,
      inaccessible_job_ids: [],
      warnings: [`scope_handle is ${scopeStatus}.`],
    };
    return finishGet(runtime, startedAt, correlationId, actAsUser, output);
  }

  const payload = verified.payload;
  const deadline = createToolDeadline(runtime, startedAt);
  const load = await loadJobInventory(runtime, deadline);
  if (!load.ok) {
    const result = deny(toolName, load.code, load.message);
    return (await emitRequiredToolAudit(runtime, toolName, "analysis", startedAt, correlationId, result, null, null, actAsUser, { scopeAction: "get" })) ?? result;
  }
  const accessibleIds = new Set(load.inventory.records.map((record) => record.greenhouse_job_id));
  const inaccessible = payload.jobs.filter((id) => !accessibleIds.has(id));
  const warnings: string[] = [];
  if (inaccessible.length === payload.jobs.length && payload.jobs.length > 0) {
    warnings.push("No jobs in this scope are currently accessible; analysis would be denied.");
  } else if (inaccessible.length > 0) {
    warnings.push(`${inaccessible.length} job(s) in this scope are no longer accessible.`);
  }
  const output: GetJobScopeOutput = {
    valid: true,
    scope_status: "confirmed",
    job_ids: [...payload.jobs].sort((a, b) => a - b),
    job_count: payload.jobs.length,
    scope_label: payload.label,
    expires_at: new Date(payload.exp).toISOString(),
    permission_revalidated: true,
    inaccessible_job_ids: inaccessible,
    warnings,
  };
  return finishGet(runtime, startedAt, correlationId, actAsUser, output, load.inventory);
}

// ---------------------------------------------------------------------------
// get_recruiting_capabilities
// ---------------------------------------------------------------------------

export async function runGetRecruitingCapabilities(
  runtime: RecruiterToolRuntime,
  _params: Record<string, unknown>
): Promise<RecruiterToolResult> {
  const toolName = GET_RECRUITING_CAPABILITIES_TOOL.name;
  const startedAt = runtime.now();
  const correlationId = newCorrelationId(runtime.now);
  const actAsUser = runtime.trustedActAsUser ?? null;

  if (!isToolEnabled(runtime.toolConfig, runtime.session.surface, toolName, "analysis")) {
    const result = deny(toolName, "TOOL_DISABLED", "Recruiting capabilities are disabled for this runtime.");
    return (await emitRequiredToolAudit(runtime, toolName, "analysis", startedAt, correlationId, result, null, null, actAsUser, { scopeAction: "capabilities" })) ?? result;
  }
  const rateDenied = await enforceUsageBudget(runtime, toolName, "analysis", runtime.session.surface, startedAt, correlationId, actAsUser);
  if (rateDenied) return rateDenied;

  const result: RecruiterToolResult = {
    ok: true,
    toolName,
    scoped: true,
    data: getRecruitingCapabilities(activeAllowlistedTools(runtime)),
    nextCursor: null,
  };
  const audited = await emitRequiredToolAudit(runtime, toolName, "analysis", startedAt, correlationId, result, null, null, actAsUser, { scopeAction: "capabilities" });
  return audited ?? result;
}

function activeAllowlistedTools(runtime: RecruiterToolRuntime): Set<string> | undefined {
  if (!runtime.toolConfig.allowedTools) return undefined;
  return new Set([...runtime.toolConfig.allowedTools].filter((name) => !runtime.toolConfig.disabledTools.has(name)));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function finishConfirm(
  runtime: RecruiterToolRuntime,
  startedAt: number,
  correlationId: string,
  actAsUser: number | null,
  output: ConfirmJobScopeOutput,
  inventory?: JobInventory
): Promise<RecruiterToolResult> {
  const result: RecruiterToolResult = {
    ok: true,
    toolName: CONFIRM_JOB_SCOPE_TOOL.name,
    actorId: inventory?.actorId ?? undefined,
    effectiveActorId: inventory?.actorId ?? undefined,
    scoped: inventory ? inventory.scopeKind === "jobs" : true,
    permissionScope: inventory ? permissionScopeFor(inventory) : undefined,
    data: output,
    nextCursor: null,
  };
  const audited = await emitRequiredToolAudit(
    runtime, CONFIRM_JOB_SCOPE_TOOL.name, "analysis", startedAt, correlationId, result, inventory?.accessibleSeen ?? null, output.job_count, actAsUser,
    { scopeAction: "confirm", scopeStatus: output.scope_status, scopeJobCount: output.job_count, scopeHash: output.scope_hash, resolvedJobIds: output.job_ids }
  );
  return audited ?? result;
}

async function finishGet(
  runtime: RecruiterToolRuntime,
  startedAt: number,
  correlationId: string,
  actAsUser: number | null,
  output: GetJobScopeOutput,
  inventory?: JobInventory
): Promise<RecruiterToolResult> {
  const result: RecruiterToolResult = {
    ok: true,
    toolName: GET_JOB_SCOPE_TOOL.name,
    actorId: inventory?.actorId ?? undefined,
    effectiveActorId: inventory?.actorId ?? undefined,
    scoped: inventory ? inventory.scopeKind === "jobs" : true,
    permissionScope: inventory ? permissionScopeFor(inventory) : undefined,
    data: output,
    nextCursor: null,
  };
  const audited = await emitRequiredToolAudit(
    runtime, GET_JOB_SCOPE_TOOL.name, "analysis", startedAt, correlationId, result, inventory?.accessibleSeen ?? null, output.job_count, actAsUser,
    { scopeAction: "get", scopeStatus: output.scope_status, scopeJobCount: output.job_count, resolvedJobIds: output.job_ids }
  );
  return audited ?? result;
}

function rejectedConfirm(reason: string): ConfirmJobScopeOutput {
  return {
    scope_handle: null,
    scope_status: "rejected",
    job_ids: [],
    job_count: 0,
    scope_label: "Rejected scope",
    scope_hash: scopeHashOf([]),
    expires_at: null,
    permission_revalidated: false,
    warnings: [reason],
  };
}

function permissionScopeFor(inventory: JobInventory): RecruiterPermissionScope {
  if (inventory.scopeKind === "jobs") {
    return { kind: "jobs", permittedJobCount: inventory.accessibleSeen };
  }
  if (inventory.scopeKind === "all") {
    return { kind: "all", permittedJobCount: null };
  }
  return { kind: "operator", permittedJobCount: null };
}

interface OwnerSourceOmission {
  source: string;
  reason: string;
}

type OwnerScopeResolution =
  | { ok: true; ownerScopedJobIds: Set<number> | undefined; ownerSourcesOmitted?: OwnerSourceOmission[] }
  | { ok: false; code: RecruiterDenialCode; message: string };

/**
 * Resolve an owner handle (my_jobs_only / recruiter_user_ids / hiring_manager_user_ids) into the
 * permitted-bounded set of job ids the actor (or named users) own — the "my reqs" capability the host
 * model previously had to compose by hand. "My reqs" reads /v3/job_owners and keeps only recruiter
 * and sourcer assignments; explicit hiring-manager filters use /v3/job_hiring_managers. Both reads
 * pass through the scoped reader, which already bounds rows to PERMITTED jobs, so
 * the resulting set is `owned ∩ permitted` and can never widen scope. Returns `ownerScopedJobIds:
 * undefined` when no owner handle was requested. Any read failure, incomplete read, or unresolved
 * actor identity FAILS CLOSED (never falls back to all-permitted).
 */
export async function resolveOwnerScope(
  runtime: RecruiterToolRuntime,
  toolName: string,
  filters: ResolveJobScopeFilters | undefined,
  inventory: JobInventory,
  deadline: ToolDeadline | undefined
): Promise<OwnerScopeResolution> {
  if (!ownerFilterRequested(filters)) return { ok: true, ownerScopedJobIds: undefined };

  const ownerUserIds = new Set<number>(); // /v3/job_owners — recruiter / sourcer only
  const hmUserIds = new Set<number>(); // /v3/job_hiring_managers
  if (filters?.my_jobs_only === true) {
    if (typeof inventory.actorId !== "number") {
      return {
        ok: false,
        code: "IDENTITY_NOT_RESOLVED",
        message: "my_jobs_only requires a resolved actor identity, which was not available for this session.",
      };
    }
    // "My reqs" is the actor's recruiter/sourcer assignment set. `responsible` is intentionally
    // irrelevant; coordinator and hiring-manager assignments do not qualify.
    ownerUserIds.add(inventory.actorId);
  }
  for (const id of filters?.recruiter_user_ids ?? []) ownerUserIds.add(id);
  for (const id of filters?.hiring_manager_user_ids ?? []) hmUserIds.add(id);

  const sources: Array<{ key: string; label: string; scopedTool: "list_job_owners" | "list_job_hiring_managers"; userIds: number[] }> = [];
  if (ownerUserIds.size > 0) {
    sources.push({ key: "job_owners", label: "reqs assigned to you as recruiter or sourcer (job_owners)", scopedTool: "list_job_owners", userIds: [...ownerUserIds] });
  }
  if (hmUserIds.size > 0) {
    sources.push({ key: "hiring_managers", label: "reqs you hiring-manage (job_hiring_managers)", scopedTool: "list_job_hiring_managers", userIds: [...hmUserIds] });
  }

  // Degrade on a FORBIDDEN source, fail closed on a TRANSIENT one. A 403 means the deployed token
  // structurally lacks that endpoint's scope — it fails on every call, so DROP that source, keep the
  // sources that resolved, and disclose the omission. A transient failure (5xx / network / incomplete
  // read) means the source IS reachable but the read didn't finish; a retry could complete it, so KEEP
  // fail-closed rather than silently under-report a reachable source. Either way the set only ever
  // SHRINKS (owned ∩ permitted) — degrade never widens.
  const jobIds = new Set<number>();
  const omitted: OwnerSourceOmission[] = [];
  let anySourceResolved = false;
  for (const source of sources) {
    const read = await readOwnerScopedJobIds(runtime, toolName, source.scopedTool, source.userIds, deadline);
    if (read.ok) {
      anySourceResolved = true;
      for (const id of read.jobIds) jobIds.add(id);
      continue;
    }
    if (read.forbidden) {
      omitted.push({ source: source.key, reason: `${source.label} are not included — ${read.message}` });
      continue;
    }
    return { ok: false, code: read.code, message: read.message };
  }

  if (!anySourceResolved) {
    // Every requested owner source was forbidden — there is no owned set to return. Fail closed (never
    // fall back to all-permitted) and name the missing scope(s).
    return {
      ok: false,
      code: "ACTOR_DENIED",
      message: `No owner source is accessible (forbidden: ${omitted.map((entry) => entry.source).join(", ")}). "My reqs" could not be resolved; the deployed token may lack job_owners list access.`,
    };
  }

  return { ok: true, ownerScopedJobIds: jobIds, ...(omitted.length > 0 ? { ownerSourcesOmitted: omitted } : {}) };
}

async function readOwnerScopedJobIds(
  runtime: RecruiterToolRuntime,
  toolName: string,
  scopedToolName: "list_job_owners" | "list_job_hiring_managers",
  userIds: number[],
  deadline: ToolDeadline | undefined
): Promise<{ ok: true; jobIds: number[] } | { ok: false; forbidden: boolean; code: RecruiterDenialCode; message: string }> {
  const requested = new Set(userIds);
  let read: Awaited<ReturnType<typeof readAllScopedRows<Record<string, unknown>>>>;
  try {
    read = await readAllScopedRows<Record<string, unknown>>(
      runtime,
      toolName,
      scopedToolName,
      { user_ids: userIds.join(",") },
      deadline
    );
  } catch (error) {
    // readAllScopedRows propagates upstream/pagination throws (mirrors loadScopedReaderInventory's
    // wrapping). A 403 is FORBIDDEN — the deployed token structurally lacks this endpoint's scope, so
    // the caller may degrade (drop this source). Any other throw (5xx / network) is TRANSIENT: the
    // source is reachable but the read didn't finish, so fail closed. Neither ever broadens.
    const forbidden = httpErrorStatus(error) === 403;
    return {
      ok: false,
      forbidden,
      code: "UPSTREAM_ERROR",
      message: forbidden
        ? `Owner read (${scopedToolName}) is forbidden (HTTP 403); the deployed token lacks ${scopedToolName} list access.`
        : `Owner read (${scopedToolName}) failed before completing.`,
    };
  }
  if (read.kind === "denial") {
    // A structured denial (actor-level permission, audit, etc.) is NOT an endpoint-scope-forbidden
    // case — it would deny every source equally — so it is transient/fail-closed, never a degrade.
    if (read.result.ok) {
      return { ok: false, forbidden: false, code: "UPSTREAM_ERROR", message: `Owner read (${scopedToolName}) failed before completing.` };
    }
    return { ok: false, forbidden: false, code: read.result.denial.code, message: read.result.denial.message };
  }
  // An incomplete owner read cannot prove the owned set is complete; narrowing to a partial set would
  // silently drop reqs the actor owns. Fail closed (transient) rather than under-report the scope.
  if (!read.complete) {
    return {
      ok: false,
      forbidden: false,
      code: "UPSTREAM_ERROR",
      message: `Owner read (${scopedToolName}) was incomplete, so the owner-scoped requisition set could not be fully resolved.`,
    };
  }
  const jobIds: number[] = [];
  for (const row of read.rows) {
    const userId = readPositiveIntField(row.user_id);
    const jobId = readPositiveIntField(row.job_id);
    // The user_ids filter is applied server-side; re-checking here keeps the bridge correct even if a
    // projection or future change loosened it. job_id is already permitted-bounded by the scoped reader.
    const assignmentType = typeof row.type === "string" ? row.type.toLowerCase() : null;
    const allowedAssignment = scopedToolName !== "list_job_owners" || assignmentType === "recruiter" || assignmentType === "sourcer";
    if (jobId !== null && userId !== null && requested.has(userId) && allowedAssignment) jobIds.push(jobId);
  }
  return { ok: true, jobIds };
}

function readPositiveIntField(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number.parseInt(value, 10);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function parseResolveInput(params: Record<string, unknown>): ResolveJobScopeInput {
  return {
    query: typeof params.query === "string" ? params.query : undefined,
    greenhouse_job_ids: sanitizeJobIdArray(params.greenhouse_job_ids),
    requisition_ids: sanitizeStringArray(params.requisition_ids),
    filters: parseFilters(params.filters),
    aliases: sanitizeStringArray(params.aliases),
    role_families: sanitizeStringArray(params.role_families),
    default_status: readDefaultStatus(params.default_status),
    max_candidates: readPositiveInt(params.max_candidates) ?? undefined,
    allow_auto_confirm: typeof params.allow_auto_confirm === "boolean" ? params.allow_auto_confirm : undefined,
    purpose: readPurpose(params.purpose),
  };
}

function parseFilters(value: unknown): ResolveJobScopeFilters | undefined {
  if (!isRecord(value)) return undefined;
  const filters: ResolveJobScopeFilters = {};
  const status = sanitizeStringArray(value.status).filter((s): s is ResolveStatusFilter =>
    s === "open" || s === "closed" || s === "draft" || s === "all"
  );
  if (status.length > 0) filters.status = status;
  const departments = sanitizeStringArray(value.departments);
  if (departments.length > 0) filters.departments = departments;
  const offices = sanitizeStringArray(value.offices);
  if (offices.length > 0) filters.offices = offices;
  const locations = sanitizeStringArray(value.locations);
  if (locations.length > 0) filters.locations = locations;
  const recruiterIds = sanitizeJobIdArray(value.recruiter_user_ids);
  if (recruiterIds.length > 0) filters.recruiter_user_ids = recruiterIds;
  const hmIds = sanitizeJobIdArray(value.hiring_manager_user_ids);
  if (hmIds.length > 0) filters.hiring_manager_user_ids = hmIds;
  if (typeof value.opened_after === "string") filters.opened_after = value.opened_after;
  if (typeof value.opened_before === "string") filters.opened_before = value.opened_before;
  if (typeof value.include_confidential === "boolean") filters.include_confidential = value.include_confidential;
  if (typeof value.my_jobs_only === "boolean") filters.my_jobs_only = value.my_jobs_only;
  return filters;
}

function readDecision(value: unknown): "confirm_all" | "confirm_selected" | "reject" | "revise" | null {
  if (value === "confirm_all" || value === "confirm_selected" || value === "reject" || value === "revise") return value;
  return null;
}

function readDefaultStatus(value: unknown): ResolveDefaultStatus | undefined {
  return value === "open_only" || value === "open_and_draft" || value === "all" ? value : undefined;
}

function readPurpose(value: unknown): ResolvePurpose | undefined {
  const allowed: ResolvePurpose[] = [
    "scorecard_accountability", "interview_feedback_drag", "stage_latency", "pipeline_quality",
    "source_quality", "general_question", "comparison", "inventory",
  ];
  return allowed.includes(value as ResolvePurpose) ? (value as ResolvePurpose) : undefined;
}

function sanitizeJobIdArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<number>();
  for (const entry of value) {
    if (typeof entry === "number" && Number.isSafeInteger(entry) && entry > 0) ids.add(entry);
    else if (typeof entry === "string" && /^\d+$/.test(entry.trim())) {
      const parsed = Number.parseInt(entry.trim(), 10);
      if (Number.isSafeInteger(parsed) && parsed > 0) ids.add(parsed);
    }
  }
  return [...ids];
}

function sanitizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry.trim().length > 0 && entry.length <= 256) out.push(entry.trim());
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
