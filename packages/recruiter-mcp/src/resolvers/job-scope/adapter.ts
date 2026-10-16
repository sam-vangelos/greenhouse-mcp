import type {
  ConfidenceLevel,
  ConfidenceMethod,
  ResolutionCompleteness,
  ResolutionContext,
  ResolutionResult,
  ResolutionStatus,
  Resolver,
  UnresolvedEvidence,
} from "../../resolution/types.js";
import {
  JOB_SCOPE_RESOLVER_VERSION,
  resolveJobScope,
  type JobScopeMatch,
  type ResolveJobScopeInput,
  type ResolveJobScopeOutput,
  type ResolutionStatus as JobScopeResolutionStatus,
} from "./resolver.js";
import type { JobInventory } from "./inventory.js";
import type { ScopeSigner } from "./scope-handle.js";

// Foundation adapter for the first resolver only. Until a second resolver exists,
// this keeps job_scope mappable to shared contracts but is not load-bearing
// orchestration for cross-domain resolution.
export interface JobScopeResolved {
  greenhouse_job_id: number;
  requisition_id: string | null;
  title: string;
  status: string;
  scope_hash: string;
  match_score: number;
  match_reasons: string[];
}

export interface JobScopeFrameworkInput extends ResolveJobScopeInput {
  inventory: JobInventory;
  signer: ScopeSigner;
  maxCandidates?: number;
  scopeTtlMs?: number;
  confirmationTtlMs?: number;
  signerEphemeral?: boolean;
  staleIndexThresholdSeconds?: number;
}

export function createJobScopeFrameworkResolver(): Resolver<JobScopeFrameworkInput, JobScopeResolved> {
  return {
    domain: "job_scope",
    version: JOB_SCOPE_RESOLVER_VERSION,
    async resolve(input, context) {
      const output = resolveJobScope(input, {
        inventory: input.inventory,
        subject: context.subject,
        signer: input.signer,
        nowMs: context.nowMs,
        maxCandidates: input.maxCandidates,
        scopeTtlMs: input.scopeTtlMs,
        confirmationTtlMs: input.confirmationTtlMs,
        signerEphemeral: input.signerEphemeral,
        staleIndexThresholdSeconds: input.staleIndexThresholdSeconds,
      });
      return adaptJobScopeResolution(output, context);
    },
  };
}

export function adaptJobScopeResolution(
  output: ResolveJobScopeOutput,
  context: Pick<ResolutionContext, "nowMs" | "requestId">
): ResolutionResult<JobScopeResolved> {
  return {
    domain: "job_scope",
    status: mapStatus(output.resolution_status),
    resolved: output.matches.map((match) => mapMatch(match, output.scope.scope_hash)),
    confidence: {
      level: mapConfidenceLevel(output.confidence.band, output.resolution_status),
      method: inferConfidenceMethod(output.matches),
      reason: confidenceReason(output),
      score: output.confidence.overall,
    },
    completeness: mapCompleteness(output),
    unresolved_evidence: buildUnresolvedEvidence(output),
    metadata: {
      resolver_domain: "job_scope",
      resolver_version: JOB_SCOPE_RESOLVER_VERSION,
      resolved_at: new Date(context.nowMs).toISOString(),
      warnings: [...output.warnings],
      scope_hash: output.scope.scope_hash,
      ...(context.requestId ? { correlation_id: context.requestId } : {}),
    },
  };
}

function mapMatch(match: JobScopeMatch, scopeHash: string): JobScopeResolved {
  return {
    greenhouse_job_id: match.greenhouse_job_id,
    requisition_id: match.requisition_id,
    title: match.title,
    status: match.status,
    scope_hash: scopeHash,
    match_score: match.match_score,
    match_reasons: [...match.match_reasons],
  };
}

function mapStatus(status: JobScopeResolutionStatus): ResolutionStatus {
  switch (status) {
    case "resolved":
      return "resolved";
    case "needs_confirmation":
      return "needs_confirmation";
    case "ambiguous":
      return "ambiguous";
    case "incomplete":
      return "incomplete";
    case "no_match":
      return "unresolved";
    case "forbidden":
      return "forbidden";
    case "error":
      return "error";
  }
}

function mapConfidenceLevel(
  band: ResolveJobScopeOutput["confidence"]["band"],
  status: ResolveJobScopeOutput["resolution_status"]
): ConfidenceLevel {
  if (status === "no_match") return "unresolved";
  return band;
}

function inferConfidenceMethod(matches: JobScopeMatch[]): ConfidenceMethod {
  const reasons = new Set(matches.flatMap((match) => match.match_reasons));
  if (reasons.has("exact_job_id")) return "exact_id";
  if (reasons.has("exact_requisition_id")) return "exact_fk";
  if ([...reasons].some((reason) => reason.includes("alias"))) return "alias_table";
  if ([...reasons].some((reason) => reason.includes("fuzzy"))) return "fuzzy_text_match";
  if (matches.length > 0) return "lexical_match";
  return "no_evidence";
}

function confidenceReason(output: ResolveJobScopeOutput): string {
  if (output.matches.length === 0) {
    return output.resolution_status === "incomplete"
      ? "Job inventory was incomplete before a safe scope could be resolved."
      : "No accessible job evidence matched the requested scope.";
  }
  const top = output.matches[0];
  const reason = top.match_reasons.length > 0 ? top.match_reasons.join(", ") : "job_scope_match";
  return `${output.confidence.band} confidence via ${reason}`;
}

function mapCompleteness(output: ResolveJobScopeOutput): ResolutionCompleteness {
  const inventoryComplete = output.completeness.inventory_complete && !output.completeness.truncated;
  return {
    status: inventoryComplete ? "complete" : output.resolution_status === "incomplete" ? "incomplete" : "partial",
    inventory_complete: output.completeness.inventory_complete,
    truncated: output.completeness.truncated,
    records_seen: output.completeness.accessible_jobs_seen,
    records_estimated: output.completeness.accessible_jobs_estimated,
    source: output.completeness.source,
    freshness_seconds: output.completeness.freshness_seconds,
    pagination_error: output.completeness.pagination_error,
    unnormalizable_records: output.completeness.unnormalizable_jobs_dropped,
  };
}

function buildUnresolvedEvidence(output: ResolveJobScopeOutput): UnresolvedEvidence[] {
  const evidence: UnresolvedEvidence[] = [];
  if (output.resolution_status === "incomplete") {
    evidence.push({
      domain: "job_scope",
      entity_type: "job_inventory",
      entity_id: null,
      reason: "incomplete_inventory",
      description: "Job inventory was incomplete, so the requested scope was not resolved.",
      resolution_attempts: [{ method: inferConfidenceMethod(output.matches), outcome: "failure" }],
      surfaced_to_user: true,
    });
  }
  if (output.resolution_status === "no_match") {
    evidence.push({
      domain: "job_scope",
      entity_type: "job",
      entity_id: null,
      reason: "unknown",
      description: "No accessible job matched the requested scope.",
      resolution_attempts: [{ method: "lexical_match", outcome: "failure" }],
      surfaced_to_user: true,
    });
  }
  if (output.completeness.unnormalizable_jobs_dropped > 0) {
    const count = output.completeness.unnormalizable_jobs_dropped;
    evidence.push({
      domain: "job_scope",
      entity_type: "job_inventory_row",
      entity_id: null,
      reason: "process_exception",
      description: `${count} job inventory row(s) could not be normalized and were omitted before resolution.`,
      resolution_attempts: [{ method: inferConfidenceMethod(output.matches), outcome: "failure" }],
      surfaced_to_user: true,
    });
  }
  for (const candidate of output.ambiguous_candidates) {
    evidence.push({
      domain: "job_scope",
      entity_type: "job",
      entity_id: candidate.greenhouse_job_id,
      reason: "ambiguous_match",
      description: candidate.why_ambiguous,
      resolution_attempts: [{ method: inferConfidenceMethod(output.matches), outcome: "partial" }],
      surfaced_to_user: true,
    });
  }
  return evidence;
}
