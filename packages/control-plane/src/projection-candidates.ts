// Projection for the Greenhouse MCP `list_candidates` tool (P2.2 / S4 slice 4).
//
// Returns only the minimal allowlist defined in
// docs/greenhouse-mcp-output-doctrine.md §3 (the `list_candidates` row):
// {id, last_activity_at, tag_names, stage_snapshot, private}. No other field —
// including the full nested candidate PII surface (first_name, last_name,
// email_addresses, phone_numbers, addresses, social_media_addresses,
// website_addresses), candidate free-text answers, employment/education history,
// attachments, nested recruiter/coordinator objects, or any future Harvest field —
// passes through to the MCP tool result. (`stage_snapshot` is per-application
// pipeline state; `tag_ids` became `tag_names` — see the v3 notes below.)
//
// Policy anchors:
//   - docs/greenhouse-mcp-projection-slice-4-spec.md §§4, 4.1, 4.2, 5.2
//   - docs/greenhouse-mcp-output-doctrine.md §3 (list_candidates row)
//     and §1 "needed Tier 2/3 → keep and project"
//   - docs/greenhouse-mcp-output-doctrine.md §7 Tier-2-silent rule:
//     list_candidates is Tier 2 and emits no READ_AUDIT line in any
//     outcome. The projection lives in this module and the call-site
//     wiring; there is no audit emitter involved. This module does
//     not import any audit helper.
//   - docs/greenhouse-mcp-projection-post-slice-5-decision-spec.md §4
//     (Path A) — this module migrated to the shared engine in
//     projection-shared.ts. Public API (ProjectedCandidate,
//     projectCandidate, projectCandidatesArray).
//
// Harvest v3 corrections (#H):
//   - `stage_snapshot` is candidate pipeline state — one entry per application,
//     carrying {application_id, job_id, stage_id, stage_name, status}. v3
//     `GET /v3/candidates` is strict-closed (additionalProperties:false) and does
//     NOT embed `applications[]`, so the list_candidates HANDLER fetches the
//     listed candidates' applications by candidate_id and injects them as
//     `raw.applications` before projection; `deriveStageSnapshot` reads that.
//     Rather than withhold the capability (the old field was always-null), the
//     data is supplied via the fetch — `null` only signals "applications could not
//     be fetched", `[]` means the candidate has no applications.
//   - `tag_ids: number[]` became `tag_names: string[]`. v3 returns `tags` as plain
//     strings (tag names; 0057), not `{id}` objects, so the ids-only design was
//     unrealizable — names are the only tag data v3 exposes.
//
// Design notes:
//   - The allowlist is enforced by construction: the projection
//     functions copy exactly the named fields into a freshly-shaped
//     object. Unknown source fields are silently dropped.
//   - `tag_names` extracts string tag names (v3), defensively also reading
//     `.name` from a legacy `{id, name}` object form.
//   - `stage_snapshot` entries read flat v3 stage_id/stage_name (defensive nested
//     `current_stage` fallback) and job_id via deriveApplicationJobId.
//   - `private` is conservative: any non-boolean input maps to
//     `false` (the common case: most candidates are not private),
//     avoiding accidentally exposing a candidate as private-when-not.

import {
  deriveApplicationJobId,
  isProjectableObject,
  normalizeBooleanDefaultFalse,
  normalizeNumberOrNull,
  normalizeStringOrNull,
  projectArray,
  readFlatOrNestedScalar,
} from "./projection-shared.js";

/**
 * One entry of a candidate's pipeline state: an application and its current stage,
 * plus the operational fields a recruiter triages on. All are flat v3 application
 * fields (0015-get_v3-applications.md); none is candidate contact PII. `applied_at`
 * is the application's `created_at`. job_id and stage are read flat-or-nested.
 */
export interface CandidatePipelineEntry {
  application_id: number | null;
  job_id: number | null;
  stage_id: number | null;
  stage_name: string | null;
  status: string | null;
  applied_at: string | null;
  last_activity_at: string | null;
  needs_decision: boolean | null;
  rejected_at: string | null;
  source_id: number | null;
  referrer_id: number | null;
}

/**
 * Allowlisted shape returned to the model turn for every
 * `list_candidates` record. Adding a field here requires a
 * corresponding doctrine §3 update and a fresh review of the
 * exclusion-rule tests.
 *
 * `tag_names` carries the candidate's tag names. Harvest v3 returns `tags` as
 * plain strings (0057), so the earlier `tag_ids: number[]` (which expected
 * `{id}` objects) was structurally always-empty; names are the only tag data v3
 * exposes (#H). `stage_snapshot` carries the candidate's pipeline state — one entry
 * per application. v3 `/v3/candidates` does not embed `applications[]`, so the
 * list_candidates handler fetches them separately by candidate_id and injects
 * `raw.applications` before projection; `deriveStageSnapshot` reads that. It is
 * `null` when the applications could not be supplied (fetch failed / not injected),
 * `[]` when the candidate has no applications, else the per-application stages.
 */
export interface ProjectedCandidate {
  id: number | null;
  last_activity_at: string | null;
  tag_names: string[];
  stage_snapshot: CandidatePipelineEntry[] | null;
  private: boolean;
}

export interface ProjectedCandidateAttachment {
  filename: string | null;
  type: string | null;
  created_at: string | null;
  url: string | null;
}

export interface ProjectedCandidateContact extends ProjectedCandidate {
  first_name: string | null;
  last_name: string | null;
  full_name: string | null;
  primary_email: string | null;
  primary_phone: string | null;
  linkedin_url: string | null;
  location: string | null;
  attachments: ProjectedCandidateAttachment[];
}

export interface CandidateProjectionOptions {
  detailProfile?: "minimal" | "contact";
  includeAttachmentUrls?: boolean;
}

/**
 * Extract candidate tag NAMES from a raw `tags` array. Harvest v3 returns
 * `tags` as plain strings (tag names; 0057-get_v3-candidates.md). Numeric ids
 * are not available on v3, so the earlier ids-only design was unrealizable.
 * Defensively also reads `.name` from a legacy `{id, name}` object form. Returns
 * `[]` when `tags` is absent, not an array, or contains no valid names.
 */
function deriveTagNames(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const names: string[] = [];
  for (const entry of value) {
    const name =
      typeof entry === "string"
        ? normalizeStringOrNull(entry)
        : isProjectableObject(entry)
          ? normalizeStringOrNull(entry.name)
          : null;
    // Drop empty/whitespace-only names: they are not valid tag names, and surfacing them
    // would contradict this helper's contract. The real name is pushed unchanged (not trimmed).
    if (name !== null && name.trim().length > 0) {
      names.push(name);
    }
  }
  return names;
}

/**
 * Derive the candidate's pipeline state from the `applications` array the
 * list_candidates handler injects (v3 does not embed applications on the
 * candidate row, so the handler fetches them by candidate_id and attaches them).
 * Returns `null` when applications were not supplied (fetch failed / not injected
 * — an honest "unknown", distinct from `[]` = candidate has no applications). Each
 * entry is one application's current stage; v3 applications carry flat
 * stage_id/stage_name/status, with a defensive nested `current_stage` fallback.
 */
function deriveStageSnapshot(raw: Record<string, unknown>): CandidatePipelineEntry[] | null {
  const applications = raw.applications;
  if (!Array.isArray(applications)) {
    return null;
  }
  const entries: CandidatePipelineEntry[] = [];
  for (const application of applications) {
    if (!isProjectableObject(application)) {
      continue;
    }
    entries.push({
      application_id: normalizeNumberOrNull(application.id),
      job_id: deriveApplicationJobId(application),
      stage_id: readFlatOrNestedScalar(application, "stage_id", "current_stage", "id", "number") as number | null,
      stage_name: readFlatOrNestedScalar(application, "stage_name", "current_stage", "name", "string") as string | null,
      status: normalizeStringOrNull(application.status),
      applied_at: normalizeStringOrNull(application.created_at),
      last_activity_at: normalizeStringOrNull(application.last_activity_at),
      needs_decision: typeof application.needs_decision === "boolean" ? application.needs_decision : null,
      rejected_at: normalizeStringOrNull(application.rejected_at),
      source_id: normalizeNumberOrNull(application.source_id),
      referrer_id: normalizeNumberOrNull(application.referrer_id),
    });
  }
  return entries;
}

function sortByPrimaryFlag(entries: Record<string, unknown>[]): Record<string, unknown>[] {
  return [...entries].sort((a, b) => {
    const aPrimary = a.primary === true ? 1 : 0;
    const bPrimary = b.primary === true ? 1 : 0;
    return bPrimary - aPrimary;
  });
}

function firstStringField(value: unknown, valueKey = "value"): string | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const entries = sortByPrimaryFlag(value.filter(isProjectableObject));
  for (const entry of entries) {
    const candidateValue = normalizeStringOrNull(entry[valueKey]);
    if (candidateValue) {
      return candidateValue;
    }
  }
  return null;
}

function deriveLinkedInUrl(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return null;
  }

  let fallback: string | null = null;
  const entries = sortByPrimaryFlag(value.filter(isProjectableObject));
  for (const entry of entries) {
    const candidateValue = normalizeStringOrNull(entry.value);
    if (!candidateValue) {
      continue;
    }
    if (fallback === null) {
      fallback = candidateValue;
    }
    if (candidateValue.toLowerCase().includes("linkedin.com")) {
      return candidateValue;
    }
  }
  return fallback;
}

function deriveLocation(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const entries = sortByPrimaryFlag(value.filter(isProjectableObject));
  for (const entry of entries) {
    const inlineValue = normalizeStringOrNull(entry.value);
    if (inlineValue) {
      return inlineValue;
    }

    const parts = [
      normalizeStringOrNull(entry.address_1),
      normalizeStringOrNull(entry.address_2),
      normalizeStringOrNull(entry.city),
      normalizeStringOrNull(entry.state),
      normalizeStringOrNull(entry.postal_code),
      normalizeStringOrNull(entry.country),
    ].filter((part): part is string => typeof part === "string" && part.length > 0);

    if (parts.length > 0) {
      return parts.join(", ");
    }
  }
  return null;
}

function deriveAttachments(
  value: unknown,
  includeAttachmentUrls: boolean
): ProjectedCandidateAttachment[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const attachments: ProjectedCandidateAttachment[] = [];
  for (const entry of value) {
    if (!isProjectableObject(entry)) {
      continue;
    }
    attachments.push({
      filename: normalizeStringOrNull(entry.filename),
      type: normalizeStringOrNull(entry.type),
      created_at: normalizeStringOrNull(entry.created_at),
      url: includeAttachmentUrls ? normalizeStringOrNull(entry.url) : null,
    });
  }
  return attachments;
}

/**
 * Project a single raw Greenhouse candidate into the allowlist.
 * Non-object inputs return a fully-null / empty-default shape rather
 * than throwing.
 */
export function projectCandidate(raw: unknown): ProjectedCandidate;
export function projectCandidate(
  raw: unknown,
  options: CandidateProjectionOptions & { detailProfile: "contact" }
): ProjectedCandidateContact;
export function projectCandidate(
  raw: unknown,
  options?: CandidateProjectionOptions
): ProjectedCandidate | ProjectedCandidateContact {
  const detailProfile = options?.detailProfile ?? "minimal";
  const includeAttachmentUrls = options?.includeAttachmentUrls === true;

  if (!isProjectableObject(raw)) {
    const base: ProjectedCandidate = {
      id: null,
      last_activity_at: null,
      tag_names: [],
      stage_snapshot: null,
      private: false,
    };
    if (detailProfile === "contact") {
      return {
        ...base,
        first_name: null,
        last_name: null,
        full_name: null,
        primary_email: null,
        primary_phone: null,
        linkedin_url: null,
        location: null,
        attachments: [],
      };
    };
    return base;
  }

  const base: ProjectedCandidate = {
    id: normalizeNumberOrNull(raw.id),
    last_activity_at: normalizeStringOrNull(raw.last_activity_at),
    tag_names: deriveTagNames(raw.tags),
    stage_snapshot: deriveStageSnapshot(raw),
    private: normalizeBooleanDefaultFalse(raw.private),
  };

  if (detailProfile !== "contact") {
    return base;
  }

  const firstName = normalizeStringOrNull(raw.first_name);
  const lastName = normalizeStringOrNull(raw.last_name);
  const fullName =
    [firstName, lastName]
      .filter((part): part is string => typeof part === "string" && part.length > 0)
      .join(" ")
      .trim() || null;

  return {
    ...base,
    first_name: firstName,
    last_name: lastName,
    full_name: fullName,
    primary_email:
      firstStringField(raw.email_addresses) ?? normalizeStringOrNull(raw.email),
    primary_phone: firstStringField(raw.phone_numbers),
    linkedin_url: deriveLinkedInUrl(raw.social_media_addresses),
    location: deriveLocation(raw.addresses),
    attachments: deriveAttachments(raw.attachments, includeAttachmentUrls),
  };
}

/**
 * Project an array of raw candidates into an array of
 * ProjectedCandidate. When the input is not an array (null, undefined,
 * object, scalar), returns an empty array.
 */
export function projectCandidatesArray(raw: unknown): ProjectedCandidate[];
export function projectCandidatesArray(
  raw: unknown,
  options: CandidateProjectionOptions & { detailProfile: "contact" }
): ProjectedCandidateContact[];
export function projectCandidatesArray(
  raw: unknown,
  options?: CandidateProjectionOptions
): ProjectedCandidate[] | ProjectedCandidateContact[] {
  return projectArray(raw, (entry) => projectCandidate(entry, options as any));
}
