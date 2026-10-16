import type {
  FenceTarget,
  TargetKind,
  TargetVisibilityProbe,
  VisibilityVerdict,
} from "../../action-mcp/dist/index.js";
import { newCorrelationId } from "./audit.js";
import { emitRequiredToolAudit, fromScopedRead, scopedReadWithTimeout, type RecruiterToolRuntime } from "./runtime.js";
import { resolvePrivateCustomFieldKeys } from "./private-custom-fields.js";
import { projectEvidenceResult } from "./tools/evidence-projection.js";
import { getEvidenceEndpointAdapter } from "./tools/scoped-endpoint-adapters.js";
import type { RecruiterToolResult } from "./types.js";

/**
 * The visibility probe — Phase 2c §4.2. The write plane asks "can the acting human read this
 * resource?", and this answers by RUNNING the read: the same scoped pipeline (identity → permitted
 * jobs → row filters → private-candidate gate) followed by the same projection (private custom-field
 * strip, note-body gating) an evidence tool applies. What the probe sees is exactly what the human
 * would see, because it is produced by the same code.
 *
 * Two gates from the model-facing tool path are deliberately NOT consulted, and the distinction is
 * authorization versus curation:
 *
 * - `isToolEnabled` (allowlist/denylist) decides which tools the MODEL may call. The probe is a
 *   server-internal integrity check, not a model call — and `search_my_job_notes` is not in the
 *   44-tool catalog at all, so consulting the catalog here would kill every job-note update over a
 *   curation choice that says nothing about what the human may READ.
 * - The rate budget throttles model behavior. A probe denied by a budget would surface as
 *   `unavailable`, turning a busy session into spurious write denials.
 *
 * Scope, privacy, redaction, and the audit trail all still apply. Every probe emits the same
 * required audit event a real read would, under the read's own tool name — because it IS that read,
 * performed on the human's behalf. If the audit sink is down the probe reports `unavailable`, which
 * DENIES the write: the one call type that must never proceed unlogged is a mutation's
 * authorization check.
 */

interface ProbeRoute {
  exposed: string;
  scoped: string;
  params: (id: number) => Record<string, unknown>;
  shape: "single" | "list";
}

const PROBE_ROUTES: Readonly<Record<TargetKind, ProbeRoute>> = {
  application: { exposed: "get_my_application", scoped: "get_application", params: (id) => ({ id }), shape: "single" },
  candidate: { exposed: "get_my_candidate", scoped: "get_candidate", params: (id) => ({ id }), shape: "single" },
  job: { exposed: "get_my_job", scoped: "get_job", params: (id) => ({ id }), shape: "single" },
  // `/offers` and `/job_notes` have no get_* tool, so they are probed through the exact-id list
  // filter the read plane already accepts; an id absent from the result is the list-shaped null.
  offer: { exposed: "search_my_offers", scoped: "list_offers", params: (id) => ({ ids: String(id), per_page: 10 }), shape: "list" },
  job_note: { exposed: "search_my_job_notes", scoped: "list_job_notes", params: (id) => ({ ids: String(id), per_page: 10 }), shape: "list" },
};

function rowsOf(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data.filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null);
  if (typeof data === "object" && data !== null) return [data as Record<string, unknown>];
  return [];
}

function rowWithId(result: RecruiterToolResult, id: number): Record<string, unknown> | null {
  if (!result.ok) return null;
  return rowsOf(result.data).find((row) => Number(row.id) === id) ?? null;
}

/**
 * Did projection remove anything the raw row carried? Checked one level deep into record-valued
 * fields, because the redactions in play live there: candidate/offer `custom_fields` lose KEYS while
 * the map itself survives, and a job note loses `body` at the top level. Never inferred from policy —
 * both halves come from the pipeline that just ran, so a new redaction class is caught by
 * construction rather than by someone remembering to update this file.
 */
function projectionRemovedSomething(raw: Record<string, unknown>, projected: Record<string, unknown> | null): boolean {
  if (projected === null) return true;
  for (const key of Object.keys(raw)) {
    if (!(key in projected)) return true;
    const rawValue = raw[key];
    const projectedValue = projected[key];
    if (
      typeof rawValue === "object" && rawValue !== null && !Array.isArray(rawValue) &&
      typeof projectedValue === "object" && projectedValue !== null && !Array.isArray(projectedValue)
    ) {
      for (const subKey of Object.keys(rawValue as Record<string, unknown>)) {
        if (!(subKey in (projectedValue as Record<string, unknown>))) return true;
      }
    }
  }
  return false;
}

const UNAVAILABLE_DENIALS = new Set([
  "PERMISSION_LOOKUP_FAILED",
  "PERMISSION_JOIN_FAILED",
  "TOOL_NOT_AVAILABLE",
  "TOOL_DISABLED",
  "TOOL_TIMEOUT",
  "CANCELLED",
  "RATE_LIMITED",
  "AUDIT_UNAVAILABLE",
  "UPSTREAM_ERROR",
  "IDENTITY_NOT_RESOLVED",
  "IDENTITY_AMBIGUOUS",
  "IDENTITY_INVALID",
  "ACTOR_DENIED",
  "INVALID_REQUEST",
  "LIMIT_EXCEEDED",
]);

export function createRecruiterVisibilityProbe(input: {
  runtime: RecruiterToolRuntime;
}): TargetVisibilityProbe {
  const { runtime } = input;
  return {
    async probe(target: FenceTarget): Promise<VisibilityVerdict> {
      const route = PROBE_ROUTES[target.kind];
      const startedAt = runtime.now();
      const correlationId = newCorrelationId(runtime.now);

      let result: RecruiterToolResult;
      try {
        const response = await scopedReadWithTimeout(runtime, route.scoped, route.params(target.id));
        result = fromScopedRead(route.exposed, response);
      } catch (error) {
        // The pipeline surfaces scope decisions as VALUES; a throw here is transport/timeout, which
        // is an outage, not a verdict. Denies — with the diagnosable code, per §4.1.
        const reason = error instanceof Error ? error.message : String(error);
        return { state: "unavailable", reason: reason.slice(0, 200) };
      }

      // The strip list decides which custom-field VALUES the human may see. Unreadable definitions
      // withhold all of them (`undefined`), the same fail-closed direction the evidence path takes.
      const privateKeys = await resolvePrivateCustomFieldKeys(runtime).catch(() => undefined);
      const projectedResult = projectEvidenceResult(result, getEvidenceEndpointAdapter(route.exposed), privateKeys);

      const auditDenied = await emitRequiredToolAudit(
        runtime, route.exposed, "evidence", startedAt, correlationId, projectedResult,
        result.ok ? rowsOf(result.data).length : null,
        projectedResult.ok ? rowsOf(projectedResult.data).length : 0,
        runtime.trustedActAsUser ?? null
      );
      if (auditDenied) return { state: "unavailable", reason: "audit sink unavailable" };

      if (!result.ok) {
        // Every denial code the read plane can emit is an inability to answer, not a "this row was
        // filtered" verdict — filtered rows come back as ok:true with null/absent data. So any
        // denial maps to unavailable, which denies the write with the diagnosable code attached.
        return { state: "unavailable", reason: result.denial.code };
      }

      const raw = rowWithId(result, target.id);
      if (raw === null) return { state: "hidden" };
      const projected = rowWithId(projectedResult, target.id);
      return { state: "visible", redacted: projectionRemovedSomething(raw, projected) };
    },
  };
}
