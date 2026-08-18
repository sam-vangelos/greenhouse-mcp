import { randomUUID } from "node:crypto";
import { detectAliasTokens, expandAliases, type AliasEntry, type AliasExpansion } from "./aliases.js";
import { normalizeText, type JobInventory, type JobInventoryRecord } from "./inventory.js";
import { isAnalysisIntent } from "./analysis-intent.js";
import { buildJobSearchIndex, type JobSearchDocument } from "./search-index.js";
import { scopeHashOf, type ScopeArtifactSource, type ScopeSigner } from "./scope-handle.js";

/**
 * Server-authoritative resolver. The LLM may interpret wording, but this module
 * deterministically owns: permission-scoped candidate generation, matching and
 * scoring, ambiguity detection, inventory completeness, confirmation policy,
 * scope freezing, and the two user-type guardrails. No model-supplied identity
 * or model-trusted job ids ever shortcut these checks.
 */

export const JOB_SCOPE_RESOLVER_VERSION = "job_scope.resolver.v1";

export type ResolveDefaultStatus = "open_only" | "open_and_draft" | "all";
export type ResolveStatusFilter = "open" | "closed" | "draft" | "all";

export type ResolvePurpose =
  | "scorecard_accountability"
  | "interview_feedback_drag"
  | "stage_latency"
  | "pipeline_quality"
  | "source_quality"
  | "general_question"
  | "comparison"
  | "inventory";

export interface ResolveJobScopeFilters {
  status?: ResolveStatusFilter[];
  departments?: string[];
  offices?: string[];
  locations?: string[];
  recruiter_user_ids?: number[];
  hiring_manager_user_ids?: number[];
  opened_after?: string;
  opened_before?: string;
  include_confidential?: boolean;
  my_jobs_only?: boolean;
}

export interface ResolveJobScopeInput {
  query?: string;
  greenhouse_job_ids?: number[];
  requisition_ids?: string[];
  filters?: ResolveJobScopeFilters;
  aliases?: string[];
  role_families?: string[];
  default_status?: ResolveDefaultStatus;
  max_candidates?: number;
  allow_auto_confirm?: boolean;
  purpose?: ResolvePurpose;
}

export type ResolutionStatus =
  | "resolved"
  | "needs_confirmation"
  | "ambiguous"
  | "incomplete"
  | "no_match"
  | "forbidden"
  | "error";

export type ScopeStatus = "confirmed" | "proposed" | "rejected" | "expired";

export type ConfirmationReasonCode =
  | "multiple_matches"
  | "broad_scope"
  | "admin_scope"
  | "low_confidence"
  | "medium_confidence"
  | "partial_inventory"
  | "stale_index"
  | "contains_closed_jobs"
  | "contains_confidential_jobs"
  | "alias_expansion"
  | "role_family_expansion"
  | "duplicate_req_id"
  | "unmatched_material_terms";

export interface JobScopeMatch {
  greenhouse_job_id: number;
  requisition_id: string | null;
  title: string;
  status: string;
  department: string | null;
  office: string | null;
  location: string | null;
  opened_at: string | null;
  closed_at: string | null;
  recruiters: string[];
  hiring_managers: string[];
  confidential: boolean;
  match_score: number;
  match_band: "exact" | "high" | "medium" | "low";
  match_reasons: string[];
  matched_terms: string[];
  unmatched_terms: string[];
}

export interface JobScopeAmbiguousCandidate {
  greenhouse_job_id: number;
  requisition_id: string | null;
  title: string;
  status: string;
  location: string | null;
  match_score: number;
  why_ambiguous: string;
}

export interface ResolveJobScopeOutput {
  resolution_id: string;
  resolution_status: ResolutionStatus;
  scope: {
    scope_handle: string | null;
    scope_status: ScopeStatus;
    job_ids: number[];
    job_count: number;
    scope_label: string;
    scope_hash: string;
    expires_at: string | null;
  };
  matches: JobScopeMatch[];
  ambiguous_candidates: JobScopeAmbiguousCandidate[];
  confidence: {
    overall: number;
    band: "high" | "medium" | "low" | "none";
    top_margin: number | null;
    score_type: "deterministic_lexical_alias_ranker_v1";
  };
  completeness: {
    inventory_complete: boolean;
    truncated: boolean;
    accessible_jobs_seen: number;
    accessible_jobs_estimated: number | null;
    source: "live_greenhouse" | "cached_index" | "hybrid";
    index_as_of: string | null;
    pagination_error: string | null;
    freshness_seconds: number | null;
    unnormalizable_jobs_dropped: number;
  };
  confirmation: {
    required: boolean;
    reason_codes: ConfirmationReasonCode[];
    confirmation_token: string | null;
    confirmation_prompt: string | null;
  };
  warnings: string[];
  // Owner sources dropped by graceful degradation (a forbidden /v3/job_owners or /v3/job_hiring_managers
  // read — the deployed token lacks that scope). Populated by the tool layer, not the pure resolver.
  // Present only when the owned set is partial; the resolved scope stays owned ∩ permitted.
  owner_sources_omitted?: Array<{ source: string; reason: string }>;
  analysis_allowed: boolean;
  next_actions: ResolveJobScopeNextAction[];
}

export type ResolveJobScopeNextAction =
  | "confirm_exact_id"
  | "narrow_query"
  | "increase_inventory_or_use_index"
  | "select_candidate"
  | "retry_with_requisition_id";

export interface ResolverContext {
  inventory: JobInventory;
  subject: string;
  signer: ScopeSigner;
  nowMs: number;
  maxCandidates?: number;
  scopeTtlMs?: number;
  confirmationTtlMs?: number;
  signerEphemeral?: boolean;
  staleIndexThresholdSeconds?: number;
  // Owner resolution: a permitted-bounded set of job ids the owner handle(s) (my_jobs_only /
  // recruiter_user_ids / hiring_manager_user_ids) resolved to, pre-computed by the async tool layer
  // from /v3/job_owners (or /v3/job_hiring_managers for an explicit HM filter). Present (possibly empty) when an owner handle was
  // requested; undefined otherwise. The resolver applies it as a pure narrowing of the candidate
  // universe — never a broadening — and fails closed if an owner handle was requested but this is
  // absent (so an unresolvable owner filter never silently falls back to all-permitted).
  ownerScopedJobIds?: ReadonlySet<number> | null;
}

const DEFAULT_MAX_CANDIDATES = 20;
const HARD_MAX_CANDIDATES = 100;

const STOPWORDS = new Set([
  "compare", "comparison", "vs", "versus", "between", "in", "on", "at", "the", "a", "an", "of",
  "for", "and", "or", "to", "with", "my", "our", "your", "their", "all", "any", "every", "everything",
  "entire", "org", "orgwide", "companywide", "company", "organization", "organisation", "across",
  "right", "now", "show", "me", "us", "please", "how", "what", "are", "is", "am", "be", "doing",
  "trending", "trend", "status", "health", "pipeline", "req", "reqs", "requisition", "requisitions",
  "role", "roles", "job", "jobs", "position", "positions", "opening", "openings", "open", "closed",
  "close", "draft", "active", "current", "this", "that", "these", "those", "vs.", "about", "over",
  // generic question words and pronouns — never a scope signal
  "which", "why", "who", "whom", "whose", "where", "when", "we", "they", "them", "i",
]);

const BROAD_PHRASE_TOKENS = new Set([
  "all", "every", "everything", "entire", "orgwide", "companywide", "organization", "organisation", "everyone",
]);

export function resolveJobScope(input: ResolveJobScopeInput, ctx: ResolverContext): ResolveJobScopeOutput {
  const resolutionId = randomUUID();
  const warnings: string[] = [];
  if (ctx.signerEphemeral) {
    warnings.push("scope_signing_key_ephemeral: scope handles validate only within this server process; set GREENHOUSE_RECRUITER_SCOPE_SIGNING_SECRET for hosted multi-instance use.");
  }
  const maxCandidates = clampCandidates(input.max_candidates ?? ctx.maxCandidates ?? DEFAULT_MAX_CANDIDATES);
  const reasonCodes = new Set<ConfirmationReasonCode>();

  // Owner resolution (my_jobs_only / recruiter_user_ids / hiring_manager_user_ids). The async tool
  // layer resolves the owner handle(s) to a permitted-bounded set of job ids via /v3/job_owners and,
  // only for an explicit hiring-manager filter, /v3/job_hiring_managers. "My reqs" keeps recruiter or
  // sourcer rows and ignores `responsible` — the ownership source the host model previously had
  // to compose by hand — and passes it as ctx.ownerScopedJobIds. We apply it here as a pure NARROWING
  // of the candidate universe: it can only shrink the already-permission-filtered inventory, never
  // widen it. FLOOR PRESERVED — if an owner handle was requested but no resolved set reached us (the
  // owner read failed, or the pure resolver was invoked without pre-resolution), FAIL CLOSED rather
  // than silently fall back to all-permitted.
  const ownerRequested = ownerFilterRequested(input.filters);
  if (ownerRequested && !ctx.ownerScopedJobIds) {
    return buildOutput({
      resolutionId,
      status: "error",
      scopeStatus: "rejected",
      confirmationRequired: false,
      matched: [],
      ambiguous: [],
      reasonCodes,
      ctx,
      input,
      warnings: [
        ...warnings,
        "An owner filter (my_jobs_only / recruiter_user_ids / hiring_manager_user_ids) was requested but its permitted-bounded job set could not be resolved; the scope was not broadened to ignore it. Retry, or name jobs explicitly.",
      ],
      confirmationToken: null,
      mintHandle: false,
    });
  }
  const ownerScoped = ownerRequested && ctx.ownerScopedJobIds;
  const inventory = ownerScoped
    ? { ...ctx.inventory, records: ctx.inventory.records.filter((record) => ctx.ownerScopedJobIds!.has(record.greenhouse_job_id)) }
    : ctx.inventory;
  if (ownerScoped) {
    warnings.push(`Owner filter applied: scope narrowed to ${inventory.records.length} of your permitted requisition(s). "My reqs" means recruiter/sourcer assignment in job_owners; explicit hiring-manager filters remain separate. Scope never broadened past your permitted jobs.`);
  }
  if (inventory.unnormalizableRows > 0) {
    warnings.push(`${inventory.unnormalizableRows} job inventory row(s) could not be normalized and were omitted; inventory is treated as incomplete.`);
  }
  if ((input.filters?.locations?.length ?? 0) > 0) {
    // Tenant data-hygiene disclosure (live-pilot finding #4): geo tags are coarse — a job POSTED
    // to a city often carries only a country-level tag. Matching normally spans tags ∪ job-post
    // targeting (the inventory enrichment); when the job-post joins were incomplete, matching
    // degrades to tags only, and THAT is what gets disclosed so the client model cross-checks
    // instead of trusting an under-match.
    const postSignalsMissing =
      inventory.enrichmentIncomplete.includes("job_posts") || inventory.enrichmentIncomplete.includes("job_post_locations");
    warnings.push(
      postSignalsMissing
        ? `Location filter matched office/location TAGS only for this response — the internal job-post targeting join was unavailable (${inventory.enrichmentIncomplete.join(", ")}), so jobs POSTED to ${input.filters!.locations!.join("/")} with a broader tag may be missing. Retry before treating the result as complete.`
        : `Location filter matched office/location tags AND job-post targeting locations (this tenant's geo tags are coarse; posted-to locations count as being in that location).`
    );
  }
  const isAdmin = inventory.scopeKind !== "jobs";

  let requestedIds = sanitizeJobIds(input.greenhouse_job_ids);
  let requestedReqs = sanitizeStrings(input.requisition_ids);
  // A recruiter's most precise input is the bare req number ("907") or exact job
  // id — and the natural thing is to type it into the free-text `query`, not the
  // structured field. When the query IS exactly an accessible job's requisition_id
  // or greenhouse_job_id (and no structured id/req was supplied), resolve it through
  // the same exact, auto-confirming path those structured fields take rather than
  // fuzzy-ranking it down to medium/needs_confirmation. Deterministic, non-widening
  // (the single job the recruiter named), permission-bounded by `inventory`. This is
  // a consistency fix: query:"907" now resolves identically to requisition_ids:["907"].
  if (requestedIds.length === 0 && requestedReqs.length === 0) {
    const promoted = promoteExactIdentifierQuery(input.query, inventory);
    if (promoted?.kind === "req") {
      requestedReqs = [promoted.value];
    } else if (promoted?.kind === "job_id") {
      requestedIds = [promoted.value];
    }
  }
  const hasIdPath = requestedIds.length > 0;
  const hasReqPath = requestedReqs.length > 0;

  // Stale cached index signal.
  const staleThreshold = ctx.staleIndexThresholdSeconds ?? 86_400;
  const staleIndex =
    inventory.source !== "live_greenhouse" &&
    typeof inventory.freshnessSeconds === "number" &&
    inventory.freshnessSeconds > staleThreshold;

  let selection: SelectionResult;
  if (hasIdPath) {
    selection = selectByIds(requestedIds, inventory, warnings);
  } else if (hasReqPath) {
    selection = selectByRequisitionIds(requestedReqs, inventory, warnings, reasonCodes);
  } else {
    selection = selectBySearch(input, inventory, warnings, reasonCodes);
  }

  // maxCandidates is a fuzzy-search disambiguation-preview size, NOT a ceiling on scope. Three paths
  // freeze the FULL matched set rather than a truncated preview, because each is a set the caller is
  // entitled to in full and each still passes through the confirmation gate below:
  //   - an explicit greenhouse_job_id selection (hasIdPath): the caller named the exact jobs;
  //     truncating would silently drop reqs they asked for.
  //   - an explicit requisition_id selection (hasReqPath): same — explicitly named.
  //   - a deliberate broad "all jobs" request (selection.broad): the org-wide mode (settled #28) a
  //     site admin legitimately holds; the literal "run pipeline-quality across all 240 reqs" case.
  // Only a fuzzy keyword search that produced many SCORED candidates is preview-capped — and even
  // that path requires confirmation, so the operator sees the count and narrows rather than silently
  // losing reqs. The cap buys zero API cost (it slices already-read, permission-bounded rows) and
  // cited no external constraint, so applying it to an entitled set was timidity (ledger Rank 24).
  const capAppliesToPreview = !hasIdPath && !hasReqPath && !selection.broad;
  const matched = capAppliesToPreview
    ? selection.matched.slice(0, maxCandidates)
    : selection.matched;
  if (capAppliesToPreview && selection.matched.length > maxCandidates) {
    warnings.push(`Showing the top ${maxCandidates} of ${selection.matched.length} fuzzy matches; name jobs explicitly with an exact id or requisition id to scope all of them.`);
  }

  // Closed / confidential signals on the in-scope or preview set.
  const containsClosed = matched.some((m) => normalizeStatus(m.record.status) !== "open");
  const containsConfidential = matched.some((m) => m.record.confidential);
  if (containsClosed) reasonCodes.add("contains_closed_jobs");
  if (containsConfidential) reasonCodes.add("contains_confidential_jobs");
  if (staleIndex) reasonCodes.add("stale_index");

  const scores = matched.map((m) => m.score).sort((a, b) => b - a);
  const overall = scores[0] ?? 0;
  const topMargin = scores.length >= 2 ? round(scores[0] - scores[1], 4) : null;
  const band = confidenceBand(overall);

  if (selection.unmatchedMaterialTerms.length > 0) {
    reasonCodes.add("unmatched_material_terms");
    warnings.push(`Some query terms did not match any scoped job: ${selection.unmatchedMaterialTerms.join(", ")}.`);
  }

  if (selection.incomplete) {
    reasonCodes.add("partial_inventory");
    if (containsConfidential) {
      warnings.push("Partial preview includes confidential job metadata visible to this actor; exact-id confirmation is required before analysis.");
    }
    return buildOutput({
      resolutionId,
      status: "incomplete",
      scopeStatus: "rejected",
      confirmationRequired: true,
      matched,
      ambiguous: buildAmbiguousCandidates(selection),
      reasonCodes,
      ctx,
      input,
      warnings,
      confirmationToken: null,
      mintHandle: false,
      scopeJobIds: [],
      overall,
      topMargin,
      band,
      selection,
    });
  }

  if (matched.length === 0) {
    return buildOutput({
      resolutionId,
      status: "no_match",
      scopeStatus: "rejected",
      confirmationRequired: false,
      matched: [],
      ambiguous: [],
      reasonCodes,
      ctx,
      input,
      warnings,
      confirmationToken: null,
      mintHandle: false,
    });
  }

  const multiple = matched.length > 1;
  if (multiple) reasonCodes.add("multiple_matches");

  // Confidence.
  if (!hasIdPath && !hasReqPath) {
    if (band === "low" || band === "none") reasonCodes.add("low_confidence");
    else if (band === "medium") reasonCodes.add("medium_confidence");
  }

  const aliasRequiresConfirm = selection.aliasExpansions.some((e) => e.requiresConfirmation);
  // Genuine ambiguity = two distinct in-scope meanings of a collision alias actually
  // matched, not merely that the alias *definition* carries collision terms. A single
  // in-scope meaning still requires confirmation via aliasRequiresConfirm below.
  const hasGenuineCollision = selection.collisionRecords.length > 0;
  const allowAutoConfirm = input.allow_auto_confirm !== false;
  const exactPath = hasIdPath || hasReqPath;
  // Only globally-unique greenhouse_job_ids prove completeness for the named jobs
  // under a truncated inventory: a found id is authoritative on its own, and a
  // missing id already failed closed as "incomplete" in selectByIds. A
  // requisition_id can map to multiple jobs, so a same-req duplicate may sit on an
  // un-fetched page; the req path therefore fails closed under truncation in
  // selectByRequisitionIds and never reaches here while incomplete.
  const frozenComplete = inventory.complete || hasIdPath;
  const deterministicOwnerScope =
    ownerRequested &&
    !isAdmin &&
    !(input.query ?? "").trim() &&
    (input.aliases?.length ?? 0) === 0 &&
    (input.role_families?.length ?? 0) === 0 &&
    !hasIdPath &&
    !hasReqPath;

  let status: ResolutionStatus;
  let scopeStatus: ScopeStatus;
  let confirmationRequired: boolean;
  let mintHandle: boolean;

  if (hasGenuineCollision || selection.duplicateReqIds.length > 0) {
    status = "ambiguous";
    scopeStatus = "proposed";
    confirmationRequired = true;
    mintHandle = false;
    if (isAdmin) reasonCodes.add("admin_scope");
  } else {
    const needsConfirmation =
      !allowAutoConfirm ||
      (!deterministicOwnerScope && (multiple || selection.broad || aliasRequiresConfirm)) ||
      containsClosed ||
      containsConfidential ||
      (!deterministicOwnerScope && selection.unmatchedMaterialTerms.length > 0) ||
      staleIndex ||
      (!deterministicOwnerScope && (band === "low" || band === "none" || (band === "medium" && !exactPath))) ||
      (isAdmin && !exactPath);
    if (needsConfirmation) {
      status = "needs_confirmation";
      scopeStatus = "proposed";
      confirmationRequired = true;
      mintHandle = false;
      if (isAdmin) reasonCodes.add("admin_scope");
    } else {
      status = "resolved";
      scopeStatus = "confirmed";
      confirmationRequired = false;
      mintHandle = true;
    }
  }

  let confirmationToken: string | null = null;
  if (!mintHandle && (status === "needs_confirmation" || status === "ambiguous")) {
    confirmationToken = ctx.signer.signConfirmationToken({
      subject: ctx.subject,
      resolutionId,
      jobIds: matched.map((m) => m.record.greenhouse_job_id),
      label: buildScopeLabel(input, matched, selection),
      complete: frozenComplete,
      requiresAck: requiredAcknowledgements(reasonCodes),
      source: inventorySource(inventory.source),
      issuedAtMs: ctx.nowMs,
      ttlMs: ctx.confirmationTtlMs,
    });
  }

  return buildOutput({
    resolutionId,
    status,
    scopeStatus,
    confirmationRequired,
    matched,
    ambiguous: buildAmbiguousCandidates(selection),
    reasonCodes,
    ctx,
    input,
    warnings,
    confirmationToken,
    mintHandle,
    frozenComplete,
    overall,
    topMargin,
    band,
    selection,
  });
}

interface ScoredMatch {
  record: JobInventoryRecord;
  score: number;
  band: JobScopeMatch["match_band"];
  reasons: string[];
  matchedTerms: string[];
  unmatchedTerms: string[];
}

interface SelectionResult {
  matched: ScoredMatch[];
  incomplete: boolean;
  broad: boolean;
  aliasExpansions: AliasExpansion[];
  roleFamilyUsed: boolean;
  duplicateReqIds: string[];
  duplicateRecords: JobInventoryRecord[];
  collisionRecords: JobInventoryRecord[];
  unmatchedMaterialTerms: string[];
}

function emptySelection(partial: Partial<SelectionResult> = {}): SelectionResult {
  return {
    matched: [],
    incomplete: false,
    broad: false,
    aliasExpansions: [],
    roleFamilyUsed: false,
    duplicateReqIds: [],
    duplicateRecords: [],
    collisionRecords: [],
    unmatchedMaterialTerms: [],
    ...partial,
  };
}

function selectByIds(requestedIds: number[], inventory: JobInventory, warnings: string[]): SelectionResult {
  const byId = new Map(inventory.records.map((record) => [record.greenhouse_job_id, record]));
  const found: JobInventoryRecord[] = [];
  const missing: number[] = [];
  for (const id of requestedIds) {
    const record = byId.get(id);
    if (record) found.push(record);
    else missing.push(id);
  }
  // Under incomplete inventory we cannot distinguish forbidden/non-existent from
  // not-yet-paginated, so fail closed when a requested id was not seen.
  if (!inventory.complete && missing.length > 0) {
    return emptySelection({ incomplete: true });
  }
  if (missing.length > 0) {
    warnings.push(`Ignored ${missing.length} job id(s) that are not in your accessible inventory.`);
  }
  const matched = found.map((record) => ({
    record,
    score: 1,
    band: "exact" as const,
    reasons: ["exact_job_id"],
    matchedTerms: [String(record.greenhouse_job_id)],
    unmatchedTerms: [],
  }));
  return emptySelection({ matched });
}

function selectByRequisitionIds(
  requestedReqs: string[],
  inventory: JobInventory,
  warnings: string[],
  reasonCodes: Set<ConfirmationReasonCode>
): SelectionResult {
  const byReq = new Map<string, JobInventoryRecord[]>();
  for (const record of inventory.records) {
    if (record.requisition_id) {
      const key = normalizeText(record.requisition_id);
      const list = byReq.get(key) ?? [];
      list.push(record);
      byReq.set(key, list);
    }
  }
  const matched: ScoredMatch[] = [];
  const missing: string[] = [];
  const duplicateReqIds: string[] = [];
  const duplicateRecords: JobInventoryRecord[] = [];
  const seen = new Set<number>();
  for (const req of requestedReqs) {
    const records = byReq.get(normalizeText(req)) ?? [];
    if (records.length === 0) {
      missing.push(req);
      continue;
    }
    if (records.length > 1) {
      duplicateReqIds.push(req);
      for (const record of records) duplicateRecords.push(record);
    }
    for (const record of records) {
      if (seen.has(record.greenhouse_job_id)) continue;
      seen.add(record.greenhouse_job_id);
      matched.push({
        record,
        score: 1,
        band: "exact",
        reasons: ["exact_requisition_id"],
        matchedTerms: [req],
        unmatchedTerms: [],
      });
    }
  }
  // A requisition_id can map to multiple jobs; under a truncated inventory a
  // same-req duplicate may be on an un-fetched page, so "found exactly one" does
  // not prove uniqueness and a missing req cannot be distinguished from forbidden.
  // Fail the whole req path closed under an incomplete inventory rather than
  // auto-confirming a possibly-non-unique scope.
  if (!inventory.complete) {
    return emptySelection({ incomplete: true });
  }
  if (missing.length > 0 && matched.length > 0) {
    warnings.push(`No accessible job matched requisition id(s): ${missing.join(", ")}.`);
  }
  if (duplicateReqIds.length > 0) reasonCodes.add("duplicate_req_id");
  return emptySelection({ matched, duplicateReqIds, duplicateRecords });
}

function selectBySearch(
  input: ResolveJobScopeInput,
  inventory: JobInventory,
  warnings: string[],
  reasonCodes: Set<ConfirmationReasonCode>
): SelectionResult {
  const queryText = typeof input.query === "string" ? input.query : "";
  const aliasInput = [...sanitizeStrings(input.aliases), ...detectAliasTokens(queryText, inventory.aliasTable)];
  const aliasExpansions = expandAliases(aliasInput, inventory.aliasTable);
  const roleFamilies = sanitizeStrings(input.role_families);
  const aliasTerms = aliasExpansions.flatMap((e) => e.canonicalTerms);

  const filterTokenSet = new Set<string>();
  for (const value of [
    ...(input.filters?.locations ?? []),
    ...(input.filters?.offices ?? []),
    ...(input.filters?.departments ?? []),
  ]) {
    for (const token of normalizeText(String(value)).split(" ")) {
      if (token) filterTokenSet.add(token);
    }
  }
  const aliasSurfaceTokens = new Set<string>();
  for (const surface of aliasInput) {
    for (const token of normalizeText(surface).split(" ")) {
      if (token) aliasSurfaceTokens.add(token);
    }
  }

  const queryPhrase = normalizeText(queryText);
  const materialTokens = computeMaterialTokens(queryPhrase, aliasSurfaceTokens, filterTokenSet);
  const broadPhrase = queryPhrase.split(" ").some((token) => BROAD_PHRASE_TOKENS.has(token));

  // Pre-filter by non-status filters (departments/offices/locations/dates/confidential).
  const filtered = inventory.records.filter((record) => passesNonStatusFilters(record, input.filters));

  const statusFilter = resolveStatusFilter(input.filters?.status, input.default_status);

  // Score each record against the query / alias / role-family signals. The
  // search index is safe job metadata only and works for both production and
  // fixture inventories.
  const index = buildJobSearchIndex(filtered, inventory.source);
  // A material token that appears in NO accessible job's searchable text cannot be a
  // scope signal — it describes the ANALYSIS ("rejection", "stalling", "candidates",
  // "converting"), not which job. Drop such tokens from the SCORING denominator so a
  // noisy natural question ("why are we losing candidates on the forward deployed
  // engineer roles") still triangulates on the real title tokens instead of the noise
  // dragging the overlap ratio below the match threshold and dead-ending at no_match.
  // A real title token is never dropped (it IS in the vocab), genuinely unmatched
  // terms are still surfaced below (unmatchedMaterialTerms), and a query with NO scope
  // signal at all still falls through to no_match / broad exactly as before (that
  // boundary keys off the original materialTokens, not this filtered set).
  const scopeVocab = new Set<string>();
  for (const document of index.documents) {
    for (const token of `${document.normalized_title} ${document.normalized_text}`.split(" ")) {
      if (token) scopeVocab.add(token);
    }
  }
  const scopeSignalTokens = materialTokens.filter((token) => scopeVocab.has(token));
  const scoredCandidates: ScoredMatch[] = [];
  const matchedTermUniverse = new Set<string>();
  for (const document of index.documents) {
    const scored = scoreRecord(document, { queryPhrase, materialTokens, scopeSignalTokens, aliasTerms, roleFamilies });
    if (scored) {
      scoredCandidates.push(scored);
      for (const term of scored.matchedTerms) matchedTermUniverse.add(term);
    }
  }

  let candidates = scoredCandidates;
  let broad = false;
  // A role-less analysis question ("which of my reqs are stalling") names no job, so
  // NO material token matches any accessible job's text (scopeSignalTokens is empty),
  // yet its residual is pure analysis-intent. Treat it as an all-scope request (offered
  // for confirmation), not a no_match dead end. Gated on the empty scope signal so a
  // query naming a real job is never broadened, and on isAnalysisIntent so a genuine
  // unknown-role miss ("blockchain wizard") still falls through to no_match below.
  const roleLessAnalysisIntent = scopeSignalTokens.length === 0 && isAnalysisIntent(materialTokens);
  if (candidates.length === 0) {
    // No specific match. If the query carried material terms, this is a genuine
    // miss (no_match). If it was empty or broad-phrased, treat as an all-scope
    // request that must be confirmed, never silently run.
    if (materialTokens.length === 0 || broadPhrase || roleLessAnalysisIntent) {
      broad = true;
      candidates = filtered.map((record) => ({
        record,
        score: 0.3,
        band: "low" as const,
        reasons: broadPhrase ? ["broad_phrase"] : ["all_accessible"],
        matchedTerms: [],
        unmatchedTerms: [],
      }));
    } else {
      return emptySelection({
        incomplete: !inventory.complete,
        aliasExpansions,
        roleFamilyUsed: roleFamilies.length > 0,
      });
    }
  } else if (broadPhrase) {
    broad = true;
  }
  if (broad) reasonCodes.add("broad_scope");

  // Status policy: split into in-scope (allowed status) and excluded.
  const inScope: ScoredMatch[] = [];
  const excludedByStatus: JobInventoryRecord[] = [];
  for (const candidate of candidates) {
    if (statusFilter.allowed.has(normalizeStatus(candidate.record.status))) {
      inScope.push(candidate);
    } else {
      excludedByStatus.push(candidate.record);
    }
  }
  if (excludedByStatus.length > 0 && !statusFilter.includesClosed) {
    warnings.push(`Excluded ${excludedByStatus.length} non-open job(s) by default; pass filters.status to include closed/draft jobs.`);
  }

  // Collision detection: a collision alias whose distinct canonical meanings each
  // matched in-scope is genuine ambiguity.
  const collisionRecords = detectCollisionRecords(aliasExpansions, inScope);

  const unmatchedMaterialTerms = materialTokens.filter((token) => !matchedTermUniverse.has(token));

  const sorted = inScope.slice().sort(
    (a, b) => b.score - a.score || a.record.greenhouse_job_id - b.record.greenhouse_job_id
  );

  if (roleFamilies.length > 0) reasonCodes.add("role_family_expansion");
  if (aliasExpansions.some((e) => e.known)) {
    if (aliasExpansions.length > 0) reasonCodes.add("alias_expansion");
  }

  return emptySelection({
    matched: sorted,
    incomplete: !inventory.complete,
    broad,
    aliasExpansions,
    roleFamilyUsed: roleFamilies.length > 0,
    collisionRecords,
    unmatchedMaterialTerms,
  });
}

interface ScoreSignals {
  queryPhrase: string;
  materialTokens: string[];
  // materialTokens that appear in at least one accessible job's searchable text; the
  // rest are analysis-intent noise ("rejection", "stalling") that must not dilute the
  // partial-overlap ratio. Falls back to materialTokens' length when every token is
  // noise so the div-by-zero guard is unnecessary at the call sites.
  scopeSignalTokens: string[];
  aliasTerms: string[];
  roleFamilies: string[];
}

function scoreRecord(document: JobSearchDocument, signals: ScoreSignals): ScoredMatch | null {
  const record = document.record;
  const titleNorm = document.normalized_title;
  const textNorm = document.normalized_text;
  const reasons: string[] = [];
  const matchedTerms = new Set<string>();
  let best = 0;

  // Exact identifiers handled elsewhere; here is text matching only.
  if (signals.queryPhrase.length > 0) {
    if (titleNorm === signals.queryPhrase) {
      best = Math.max(best, 0.97);
      reasons.push("title_exact");
    } else if (containsPhrase(titleNorm, signals.queryPhrase)) {
      best = Math.max(best, 0.92);
      reasons.push("title_phrase");
    } else if (containsPhrase(textNorm, signals.queryPhrase)) {
      best = Math.max(best, 0.84);
      reasons.push("text_phrase");
    }
    if (signals.materialTokens.length > 0) {
      const inTitle = signals.materialTokens.every((token) => containsToken(titleNorm, token));
      const inText = signals.materialTokens.every((token) => containsToken(textNorm, token));
      if (inTitle) {
        best = Math.max(best, 0.9);
        reasons.push("title_tokens");
        for (const token of signals.materialTokens) matchedTerms.add(token);
      } else if (inText) {
        best = Math.max(best, 0.8);
        reasons.push("text_tokens");
        for (const token of signals.materialTokens) matchedTerms.add(token);
      } else {
        const titleMatches = signals.materialTokens.filter((token) => containsToken(titleNorm, token));
        const textMatches = signals.materialTokens.filter((token) => containsToken(textNorm, token));
        const strongestMatches = titleMatches.length >= textMatches.length ? titleMatches : textMatches;
        // Divide by the scope-SIGNAL token count, not the full material-token count:
        // analysis-intent noise ("rejection", "stalling", "candidates") that matches no
        // job must not drag this ratio below threshold and dead-end a real title match.
        const overlapDenominator = signals.scopeSignalTokens.length > 0 ? signals.scopeSignalTokens.length : signals.materialTokens.length;
        const overlapRatio = strongestMatches.length / overlapDenominator;
        if (strongestMatches.length >= Math.min(3, signals.materialTokens.length) && overlapRatio >= 0.6) {
          best = Math.max(best, overlapRatio >= 0.8 ? 0.9 : 0.72);
          reasons.push(titleMatches.length >= textMatches.length ? "title_token_overlap" : "text_token_overlap");
          for (const token of strongestMatches) matchedTerms.add(token);
        }
      }
    }
  }

  for (const term of signals.aliasTerms) {
    const norm = normalizeText(term);
    if (norm.length === 0) continue;
    if (titleNorm === norm || containsPhrase(titleNorm, norm)) {
      best = Math.max(best, 0.9);
      reasons.push(`alias_title:${term}`);
      matchedTerms.add(term);
    } else if (containsPhrase(textNorm, norm)) {
      best = Math.max(best, 0.82);
      reasons.push(`alias_text:${term}`);
      matchedTerms.add(term);
    }
  }

  for (const family of signals.roleFamilies) {
    const norm = normalizeText(family);
    if (norm.length === 0) continue;
    if (titleNorm === norm || containsPhrase(titleNorm, norm)) {
      best = Math.max(best, 0.88);
      reasons.push(`role_family_title:${family}`);
      matchedTerms.add(family);
    } else if (containsPhrase(textNorm, norm)) {
      best = Math.max(best, 0.8);
      reasons.push(`role_family_text:${family}`);
      matchedTerms.add(family);
    }
  }

  if (best <= 0) return null;
  const unmatchedTerms = signals.materialTokens.filter((token) => !matchedTerms.has(token));
  return {
    record,
    score: round(best, 4),
    band: matchBand(best),
    reasons,
    matchedTerms: [...matchedTerms],
    unmatchedTerms,
  };
}

function detectCollisionRecords(expansions: AliasExpansion[], inScope: ScoredMatch[]): JobInventoryRecord[] {
  const collisionRecords: JobInventoryRecord[] = [];
  for (const expansion of expansions) {
    if (!expansion.hasCollision) continue;
    const matchedMeanings = expansion.canonicalTerms.filter((term) => {
      const norm = normalizeText(term);
      return inScope.some((m) => containsPhrase(m.record.normalized_text, norm));
    });
    if (matchedMeanings.length >= 2) {
      for (const m of inScope) {
        if (expansion.canonicalTerms.some((term) => containsPhrase(m.record.normalized_text, normalizeText(term)))) {
          collisionRecords.push(m.record);
        }
      }
    }
  }
  return collisionRecords;
}

interface BuildOutputArgs {
  resolutionId: string;
  status: ResolutionStatus;
  scopeStatus: ScopeStatus;
  confirmationRequired: boolean;
  matched: ScoredMatch[];
  ambiguous: JobScopeAmbiguousCandidate[];
  reasonCodes: Set<ConfirmationReasonCode>;
  ctx: ResolverContext;
  input: ResolveJobScopeInput;
  warnings: string[];
  confirmationToken: string | null;
  mintHandle: boolean;
  frozenComplete?: boolean;
  overall?: number;
  topMargin?: number | null;
  band?: "high" | "medium" | "low" | "none";
  selection?: SelectionResult;
  scopeJobIds?: number[];
}

function buildOutput(args: BuildOutputArgs): ResolveJobScopeOutput {
  const { ctx, input, matched } = args;
  const inventory = ctx.inventory;
  const jobIds = uniqueSorted(args.scopeJobIds ?? matched.map((m) => m.record.greenhouse_job_id));
  const scopeHash = scopeHashOf(jobIds);
  const label = buildScopeLabel(input, matched, args.selection);

  let scopeHandle: string | null = null;
  let expiresAt: string | null = null;
  if (args.mintHandle && jobIds.length > 0) {
    scopeHandle = ctx.signer.signScopeHandle({
      subject: ctx.subject,
      jobIds,
      complete: args.frozenComplete ?? inventory.complete,
      label,
      source: inventorySource(inventory.source),
      issuedAtMs: ctx.nowMs,
      ttlMs: ctx.scopeTtlMs,
    });
    expiresAt = new Date(ctx.nowMs + (ctx.scopeTtlMs ?? defaultScopeTtl())).toISOString();
  }

  const confirmationPrompt = args.confirmationRequired
    ? buildConfirmationPrompt(args.status, label, jobIds.length, [...args.reasonCodes])
    : null;

  return {
    resolution_id: args.resolutionId,
    resolution_status: args.status,
    scope: {
      scope_handle: scopeHandle,
      scope_status: args.scopeStatus,
      job_ids: jobIds,
      job_count: jobIds.length,
      scope_label: label,
      scope_hash: scopeHash,
      expires_at: expiresAt,
    },
    matches: matched.map(toJobScopeMatch),
    ambiguous_candidates: args.ambiguous,
    confidence: {
      overall: round(args.overall ?? 0, 4),
      band: args.band ?? "none",
      top_margin: args.topMargin ?? null,
      score_type: "deterministic_lexical_alias_ranker_v1",
    },
    completeness: {
      inventory_complete: inventory.complete,
      truncated: inventory.truncated,
      accessible_jobs_seen: inventory.accessibleSeen,
      accessible_jobs_estimated: inventory.estimated,
      source: inventory.source,
      index_as_of: inventory.indexAsOf,
      pagination_error: inventory.paginationError,
      freshness_seconds: inventory.freshnessSeconds,
      unnormalizable_jobs_dropped: inventory.unnormalizableRows,
    },
    confirmation: {
      required: args.confirmationRequired,
      reason_codes: [...args.reasonCodes],
      confirmation_token: args.confirmationToken,
      confirmation_prompt: confirmationPrompt,
    },
    warnings: args.warnings,
    analysis_allowed: scopeHandle !== null,
    next_actions: buildNextActions(args.status, args.confirmationRequired, args.reasonCodes, matched.length),
  };
}

function buildAmbiguousCandidates(selection: SelectionResult): JobScopeAmbiguousCandidate[] {
  const out: JobScopeAmbiguousCandidate[] = [];
  const seen = new Set<number>();
  for (const record of selection.duplicateRecords) {
    if (seen.has(record.greenhouse_job_id)) continue;
    seen.add(record.greenhouse_job_id);
    out.push(ambiguousCandidate(record, `Shares requisition id ${record.requisition_id ?? "(none)"} with another job.`));
  }
  for (const record of selection.collisionRecords) {
    if (seen.has(record.greenhouse_job_id)) continue;
    seen.add(record.greenhouse_job_id);
    out.push(ambiguousCandidate(record, "Matched a collision alias with more than one meaning; confirm the intended interpretation."));
  }
  return out;
}

function ambiguousCandidate(record: JobInventoryRecord, why: string): JobScopeAmbiguousCandidate {
  return {
    greenhouse_job_id: record.greenhouse_job_id,
    requisition_id: record.requisition_id,
    title: record.title,
    status: record.status,
    location: record.location,
    match_score: 1,
    why_ambiguous: why,
  };
}

function toJobScopeMatch(scored: ScoredMatch): JobScopeMatch {
  const r = scored.record;
  return {
    greenhouse_job_id: r.greenhouse_job_id,
    requisition_id: r.requisition_id,
    title: r.title,
    status: r.status,
    department: r.department,
    office: r.office,
    location: r.location,
    opened_at: r.opened_at,
    closed_at: r.closed_at,
    recruiters: r.recruiters,
    hiring_managers: r.hiring_managers,
    confidential: r.confidential,
    match_score: scored.score,
    match_band: scored.band,
    match_reasons: scored.reasons,
    matched_terms: scored.matchedTerms,
    unmatched_terms: scored.unmatchedTerms,
  };
}

function requiredAcknowledgements(reasonCodes: Set<ConfirmationReasonCode>): string[] {
  const acks: string[] = [];
  if (reasonCodes.has("broad_scope") && reasonCodes.has("admin_scope")) acks.push("acknowledge_broad_admin_scope");
  if (reasonCodes.has("contains_closed_jobs")) acks.push("acknowledge_closed_jobs");
  if (reasonCodes.has("contains_confidential_jobs")) acks.push("acknowledge_confidential_jobs");
  if (reasonCodes.has("stale_index")) acks.push("acknowledge_stale_index");
  return acks;
}

function buildScopeLabel(
  input: ResolveJobScopeInput,
  matched: ScoredMatch[],
  selection?: SelectionResult
): string {
  if (matched.length === 0) {
    if (input.greenhouse_job_ids?.length) return "No accessible jobs matched the requested ids";
    if (input.requisition_ids?.length) return "No accessible jobs matched the requested requisition ids";
    if (typeof input.query === "string" && input.query.trim().length > 0) return "No accessible jobs matched the requested query";
    return "No matching jobs";
  }
  if (matched.length === 1) {
    const r = matched[0].record;
    const reqSuffix = r.requisition_id ? ` (${r.requisition_id})` : "";
    return `${r.title}${reqSuffix}`;
  }
  const openCount = matched.filter((m) => normalizeStatus(m.record.status) === "open").length;
  const descriptor = buildMultiJobDescriptor(matched);
  const countLabel = openCount === matched.length ? `${matched.length} open jobs` : `${matched.length} jobs`;
  return `${descriptor} - ${countLabel}`;
}

function buildMultiJobDescriptor(matched: ScoredMatch[]): string {
  const titles = matched
    .slice(0, 2)
    .map((match) => match.record.title.trim())
    .filter((title) => title.length > 0);
  if (titles.length === 0) return "Selected jobs";
  if (matched.length <= 2) return titles.join(", ");
  return `${titles.join(", ")} and ${matched.length - titles.length} more`;
}

function buildConfirmationPrompt(
  status: ResolutionStatus,
  label: string,
  count: number,
  reasonCodes: ConfirmationReasonCode[]
): string {
  const reasonText = reasonCodes.length > 0 ? ` Reasons: ${reasonCodes.join(", ")}.` : "";
  if (status === "ambiguous") {
    return `This request is ambiguous and resolves to ${count} job(s) (${label}). Confirm which jobs you mean before analysis.${reasonText}`;
  }
  if (status === "incomplete") {
    return `The accessible job inventory could not be read completely, so analysis is blocked. Use an exact job id from the preview, narrow the request, or retry with a fresher index.${reasonText}`;
  }
  return `This resolves to ${count} job(s) (${label}). Confirm the scope before analysis.${reasonText}`;
}

function buildNextActions(
  status: ResolutionStatus,
  confirmationRequired: boolean,
  reasonCodes: Set<ConfirmationReasonCode>,
  matchCount: number
): ResolveJobScopeNextAction[] {
  const actions: ResolveJobScopeNextAction[] = [];
  const add = (action: ResolveJobScopeNextAction) => {
    if (!actions.includes(action)) actions.push(action);
  };
  if (reasonCodes.has("partial_inventory")) {
    if (matchCount > 0) add("select_candidate");
    add("confirm_exact_id");
    add("narrow_query");
    add("increase_inventory_or_use_index");
    add("retry_with_requisition_id");
  } else if (status === "no_match") {
    add("narrow_query");
    add("retry_with_requisition_id");
  } else if (confirmationRequired) {
    add("select_candidate");
    add("confirm_exact_id");
    if (reasonCodes.has("multiple_matches") || reasonCodes.has("broad_scope")) add("narrow_query");
  }
  return actions;
}

function computeMaterialTokens(queryPhrase: string, aliasSurface: Set<string>, filterTokens: Set<string>): string[] {
  if (queryPhrase.length === 0) return [];
  const tokens: string[] = [];
  const seen = new Set<string>();
  for (const token of queryPhrase.split(" ")) {
    if (token.length === 0) continue;
    if (STOPWORDS.has(token)) continue;
    if (aliasSurface.has(token)) continue;
    if (filterTokens.has(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
  }
  return tokens;
}

interface ResolvedStatusFilter {
  allowed: Set<string>;
  includesClosed: boolean;
}

function resolveStatusFilter(
  statusFilter: ResolveStatusFilter[] | undefined,
  defaultStatus: ResolveDefaultStatus | undefined
): ResolvedStatusFilter {
  if (Array.isArray(statusFilter) && statusFilter.length > 0) {
    if (statusFilter.includes("all")) {
      return { allowed: new Set(["open", "closed", "draft"]), includesClosed: true };
    }
    const allowed = new Set<string>();
    for (const value of statusFilter) {
      if (value === "open" || value === "closed" || value === "draft") allowed.add(value);
    }
    if (allowed.size === 0) allowed.add("open");
    return { allowed, includesClosed: allowed.has("closed") || allowed.has("draft") };
  }
  switch (defaultStatus) {
    case "all":
      return { allowed: new Set(["open", "closed", "draft"]), includesClosed: true };
    case "open_and_draft":
      return { allowed: new Set(["open", "draft"]), includesClosed: false };
    case "open_only":
    default:
      return { allowed: new Set(["open"]), includesClosed: false };
  }
}

function passesNonStatusFilters(record: JobInventoryRecord, filters: ResolveJobScopeFilters | undefined): boolean {
  if (!filters) return true;
  if (filters.include_confidential === false && record.confidential) return false;
  // Multi-signal matching (2026-07-02): a recruiter concept spans several ATS fields — every
  // office/location/department name AND job-post targeting locations count, so a job posted to a
  // city whose only tag is country-level still matches (the live "FDE in NY" miss).
  if (Array.isArray(filters.departments) && filters.departments.length > 0) {
    if (!matchesAnyOf([record.department, ...record.departments], filters.departments)) return false;
  }
  if (Array.isArray(filters.offices) && filters.offices.length > 0) {
    if (!matchesAnyOf([record.office, ...record.offices], filters.offices)) return false;
  }
  if (Array.isArray(filters.locations) && filters.locations.length > 0) {
    if (!matchesAnyOf([record.location, record.office, ...record.locations, ...record.offices], filters.locations)) {
      return false;
    }
  }
  if (typeof filters.opened_after === "string" && record.opened_at) {
    if (Date.parse(record.opened_at) < Date.parse(filters.opened_after)) return false;
  }
  if (typeof filters.opened_before === "string" && record.opened_at) {
    if (Date.parse(record.opened_at) > Date.parse(filters.opened_before)) return false;
  }
  return true;
}

export function ownerFilterRequested(filters: ResolveJobScopeFilters | undefined): boolean {
  if (!filters) return false;
  return (
    filters.my_jobs_only === true ||
    (filters.recruiter_user_ids?.length ?? 0) > 0 ||
    (filters.hiring_manager_user_ids?.length ?? 0) > 0
  );
}

function matchesAnyOf(values: Array<string | null>, candidates: string[]): boolean {
  return values.some((value) => matchesAnyName(value, candidates));
}

function matchesAnyName(value: string | null, candidates: string[]): boolean {
  if (!value) return false;
  const norm = normalizeText(value);
  return candidates.some((candidate) => {
    const candidateNorm = normalizeText(String(candidate));
    return candidateNorm.length > 0 && (norm === candidateNorm || containsPhrase(norm, candidateNorm) || containsPhrase(candidateNorm, norm));
  });
}

function containsPhrase(haystack: string, needle: string): boolean {
  if (needle.length === 0) return false;
  // Token-boundary match only. The space-padded form already matches whole
  // multi-word phrases; an unanchored substring fallback would let short tokens
  // (e.g. "ai") match inside longer words ("training"), producing false matches.
  return ` ${haystack} `.includes(` ${needle} `);
}

function containsToken(haystack: string, token: string): boolean {
  if (token.length === 0) return false;
  return ` ${haystack} `.includes(` ${token} `);
}

function confidenceBand(score: number): "high" | "medium" | "low" | "none" {
  if (score >= 0.9) return "high";
  if (score >= 0.7) return "medium";
  if (score >= 0.45) return "low";
  return "none";
}

function matchBand(score: number): JobScopeMatch["match_band"] {
  if (score >= 1) return "exact";
  if (score >= 0.9) return "high";
  if (score >= 0.7) return "medium";
  return "low";
}

function inventorySource(source: JobInventory["source"]): ScopeArtifactSource {
  return source;
}

function defaultScopeTtl(): number {
  return 60 * 60 * 1000;
}

function clampCandidates(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_MAX_CANDIDATES;
  return Math.min(Math.floor(value), HARD_MAX_CANDIDATES);
}

/**
 * Triangulate an exact job identifier the caller expressed in free text — including
 * one embedded in a natural question — against the permission-scoped inventory, so
 * the dispatcher can route it through the same exact path the structured
 * requisition_ids / greenhouse_job_ids fields take. A recruiter should never have to
 * move a req number out of their sentence into a structured field:
 *   - "907", "SAIS-US-401"                      (a bare, deliberate id)
 *   - "rejection reasons for 907", "how's 907 doing", "req #1208 pipeline"
 *                                                (an id named inside a real question)
 * Every candidate is matched EXACTLY against an accessible requisition_id (checked
 * first — a bare number means a req to a recruiter) or greenhouse_job_id; nothing is
 * fuzzy-guessed here. Fires ONLY when EXACTLY ONE distinct accessible identifier is
 * present across the whole query. Zero (a pure keyword/role search) or two-plus (a
 * cross-req comparison like "907 vs 1027") fall through to the fuzzy search path, so
 * this never hijacks a genuine search or silently picks one of several named reqs.
 * Match keys use the same normalizeText the requisition path uses.
 */
function promoteExactIdentifierQuery(
  query: unknown,
  inventory: JobInventory
): { kind: "req"; value: string } | { kind: "job_id"; value: number } | null {
  if (typeof query !== "string") return null;
  const trimmed = query.trim();
  if (!trimmed) return null;

  const reqTokensByKey = new Map<string, string>(); // normalized req key -> original token
  const jobIds = new Set<number>();
  for (const raw of trimmed.split(/\s+/)) {
    // Peel an id marker ("#1208") and surrounding punctuation ("(1208)", "907,", "907.").
    const token = raw.replace(/^[#(]+/, "").replace(/[)\],.;:!?]+$/, "");
    if (!token) continue;
    const normalized = normalizeText(token);
    if (!normalized) continue;
    if (
      inventory.records.some(
        (record) => record.requisition_id != null && normalizeText(record.requisition_id) === normalized
      )
    ) {
      reqTokensByKey.set(normalized, token);
      continue;
    }
    if (/^\d+$/.test(token)) {
      const jobId = Number(token);
      if (Number.isSafeInteger(jobId) && inventory.records.some((record) => record.greenhouse_job_id === jobId)) {
        jobIds.add(jobId);
      }
    }
  }

  // Exactly one distinct identifier across the whole query => an unambiguous scope.
  // A requisition id wins over a job id when (rarely) both appear.
  if (reqTokensByKey.size === 1) {
    return { kind: "req", value: [...reqTokensByKey.values()][0]! };
  }
  if (reqTokensByKey.size === 0 && jobIds.size === 1) {
    return { kind: "job_id", value: [...jobIds][0]! };
  }
  return null;
}

function sanitizeJobIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<number>();
  for (const entry of value) {
    if (typeof entry === "number" && Number.isSafeInteger(entry) && entry > 0) ids.add(entry);
    else if (typeof entry === "string" && /^\d+$/.test(entry)) {
      const parsed = Number.parseInt(entry, 10);
      if (Number.isSafeInteger(parsed) && parsed > 0) ids.add(parsed);
    }
  }
  return [...ids];
}

function sanitizeStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (trimmed.length === 0 || trimmed.length > 256) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function normalizeStatus(status: string): string {
  const norm = status.trim().toLowerCase();
  if (norm === "open" || norm === "closed" || norm === "draft") return norm;
  if (norm.length === 0) return "unknown";
  return norm;
}

function uniqueSorted(ids: number[]): number[] {
  return [...new Set(ids)].sort((a, b) => a - b);
}

function round(value: number, digits: number): number {
  const m = 10 ** digits;
  return Math.round(value * m) / m;
}
