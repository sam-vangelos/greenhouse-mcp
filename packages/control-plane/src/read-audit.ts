// Read-side audit emitter for the Greenhouse MCP (P2.1 / S5).
//
// Emits exactly one JSON line per
// audit-bearing Tier 3 event to structured stderr, prefixed
// `[greenhouse-mcp] READ_AUDIT `. Tier 1 and Tier 2 reads never reach this
// module.
//
// Policy anchors:
//   - docs/greenhouse-mcp-read-audit-spec.md (the canonical contract)
//   - docs/greenhouse-mcp-output-doctrine.md §7 "Audit Posture"
//   - docs/data-privacy-security-roadmap.md §8 S5
//
// The §4 exclusion rule from the spec is enforced by construction: the public
// API of this module accepts only the narrow field set that maps 1:1 onto
// the §3 schema. Callers cannot pass raw params, candidate IDs, payload
// fragments, projected-field names, or free-form error strings through this
// interface. Any widening requires changing the types below, which is the
// review signal for §4 enforcement.

/**
 * Stable prefix for every read-audit line. Matches doctrine §7 exactly so
 * operators can grep a single string across stderr for read audits.
 */
export const READ_AUDIT_PREFIX = "[greenhouse-mcp] READ_AUDIT";

/**
 * Current audit-schema version. Bumped only on a breaking schema change;
 * additive fields do not require a bump. See spec §3.
 */
export const READ_AUDIT_VERSION = "1.0.0";

/**
 * Fail-closed thrown-error message emitted when an audit-bearing Tier 3
 * event cannot be recorded. Intentionally does not echo the tool name,
 * actor, allowlist, or audit internals. Mirrors the sanitization discipline
 * of TIER3_GATE_DENIED_MESSAGE in tool-gates.ts.
 */
export const READ_AUDIT_FAILURE_MESSAGE =
  "Tier 3 read audit failed; request aborted.";

export type ReadAuditOutcome = "success" | "denied" | "error";

/**
 * Only tier that currently emits a read audit. The number type keeps the
 * door open for a future reintroduced Tier 4 value (`4`) per doctrine §9
 * without a schema bump; Tier 1 and Tier 2 never reach this module.
 */
export type ReadAuditTier = 3;

/**
 * Coarse size bucket from spec §3.2. Deliberately coarse: exact counts leak
 * behavioral signal. `undefined` is the only acceptable value on non-success
 * outcomes; see the CallerIdentity + emit signature below.
 */
export type ReadAuditResultSizeClass =
  | "empty"
  | "small"
  | "medium"
  | "large";

/**
 * Structured caller identity. No free-form payload. No display name, no
 * email, no session identifier, no request ID. Per spec §3.1:
 *   - success: on_behalf_of_user_id is the numeric actor that passed the
 *     Tier 3 gate.
 *   - denied: on_behalf_of_user_id is always null (no attempted-actor leak).
 *   - error:  on_behalf_of_user_id is the actor that passed the gate (the
 *             gate passed; the failure is downstream).
 */
export interface ReadAuditCallerIdentity {
  on_behalf_of_user_id: number | null;
}

/**
 * Narrow input surface. The public field set is the allowlist from spec §3;
 * anything not listed here cannot enter an audit line. `params`, `data`,
 * `err.message`, and projected-field-name sets are intentionally absent.
 */
export interface ReadAuditEvent {
  tool: string;
  tier: ReadAuditTier;
  callerIdentity: ReadAuditCallerIdentity;
  projectionApplied: boolean;
  resultSizeClass?: ReadAuditResultSizeClass;
  outcome: ReadAuditOutcome;
}

/**
 * Classify an array length into the §3.2 bucket. Exported so the wiring
 * sites in index.ts can classify their Harvest response array (or single
 * record count) without reinventing the thresholds.
 */
export function classifyResultSize(
  count: number
): ReadAuditResultSizeClass {
  if (!Number.isFinite(count) || count <= 0) {
    return "empty";
  }
  if (count <= 10) {
    return "small";
  }
  if (count <= 100) {
    return "medium";
  }
  return "large";
}

/**
 * Compute the §3.2 bucket from a Harvest response's `data` field when it
 * happens to be an array. Returns `"small"` for a single non-array record
 * (future get_* Tier 3 tools). Returns `"empty"` for null/undefined.
 *
 * The implementation never reads array contents, only the length.
 */
export function resultSizeClassFromData(
  data: unknown
): ReadAuditResultSizeClass {
  if (data === null || data === undefined) {
    return "empty";
  }
  if (Array.isArray(data)) {
    return classifyResultSize(data.length);
  }
  return "small";
}

/**
 * The JSON body written inside the audit line. Exposed as a type (not just
 * a helper's internal structure) so tests can assert the serialized shape
 * against a compile-time-checked expectation.
 */
export interface ReadAuditLinePayload {
  timestamp: string;
  audit_version: string;
  tool: string;
  tier: ReadAuditTier;
  caller_identity: ReadAuditCallerIdentity;
  projection_applied: boolean;
  result_size_class?: ReadAuditResultSizeClass;
  outcome: ReadAuditOutcome;
}

/**
 * Emit a single read-audit line. One call per audit-bearing Tier 3 event.
 *
 * Failure mode (spec §6): if `console.error` or `JSON.stringify` throws,
 * this function re-throws READ_AUDIT_FAILURE_MESSAGE so the caller can
 * enforce fail-closed discipline. The original underlying error is
 * intentionally not propagated to the caller; echoing it would leak
 * audit-emitter internals through the thrown-error path that the model
 * eventually sees.
 */
export function logReadAudit(event: ReadAuditEvent): void {
  let line: string;
  try {
    const payload: ReadAuditLinePayload = {
      timestamp: new Date().toISOString(),
      audit_version: READ_AUDIT_VERSION,
      tool: event.tool,
      tier: event.tier,
      caller_identity: {
        on_behalf_of_user_id: event.callerIdentity.on_behalf_of_user_id,
      },
      projection_applied: event.projectionApplied,
      outcome: event.outcome,
    };
    if (event.outcome === "success" && event.resultSizeClass !== undefined) {
      payload.result_size_class = event.resultSizeClass;
    }
    line = `${READ_AUDIT_PREFIX} ${JSON.stringify(payload)}`;
  } catch {
    throw new Error(READ_AUDIT_FAILURE_MESSAGE);
  }

  try {
    console.error(line);
  } catch {
    throw new Error(READ_AUDIT_FAILURE_MESSAGE);
  }
}
