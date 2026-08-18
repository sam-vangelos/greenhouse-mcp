/**
 * The package entry point — what a HOST server imports to mount the write plane.
 *
 * This package used to run only as its own HTTP service, so it had no entry at all: `main.ts`
 * started a server and nothing else was importable. Phase 2c registers these tools on the
 * scoped-recruiter server instead of standing up a second front door, which needs a real public
 * surface, so this file is it.
 *
 * Deliberately an enumerated list rather than a star re-export. Everything named here is something the host
 * genuinely needs; everything omitted — the eleven action modules, the Greenhouse gateway, the
 * custom-field machinery, the diagnostics sink — is internal, and keeping it internal is what stops
 * a host reaching around `GreenhouseActionService` to a mutation primitive directly. `service.ts`
 * holds the only `gateway.mutate()` call site in the package, and the visibility fence is specified
 * against that fact (phase-2c spec §2); an entry that re-exported the gateway would quietly make
 * that untrue.
 */

// The catalog. A host builds its tool grant from this rather than respelling 22 names —
// `scoped-recruiter-mcp/src/action-tools.ts` explains at length why a copied list rots.
export { ACTION_DEFINITIONS, actionDefinition } from "./actions/index.js";
export type { ActionContext, ActionDefinition } from "./actions/index.js";

// The service. One instance per session; `preview` and `apply` are the whole runtime surface.
export { GreenhouseActionService } from "./service.js";
export type { GreenhouseActionServiceConfig } from "./service.js";

// Construction from environment, plus the capability flags a host needs to decide what to register.
export {
  createActionRuntimeFromEnv,
  createActionRuntimeProvider,
  createGreenhouseActionServiceFromEnv,
  readActionRuntimeFlags,
  readActionSigningSecret,
  validateActionEnvironment,
  ACTION_SIGNING_SECRET_ENV,
} from "./env.js";
export type { ActionRuntime, ActionRuntimeFlags } from "./env.js";

// Session identity. The host derives an action session from its own authenticated session
// (phase-2c Slice 0b), so it needs to mint and validate one — but NOT to reach the intent
// signing/verification helpers, which belong to the service and stay unexported.
export {
  issueActionSession,
  validateActionSession,
  DEFAULT_SESSION_TTL_MS,
  MAX_SESSION_TTL_MS,
  INTENT_TTL_MS,
} from "./crypto.js";
export type { SessionIssueInput, SessionValidationResult } from "./crypto.js";

// Durable state. A host that already owns a Supabase connection supplies its own store.
export {
  createActionStoreFromEnv,
  createSupabaseActionStore,
  readActionSupabaseConfig,
  ActionStoreError,
} from "./store.js";
export type { ActionSupabaseConfig, SupabaseActionStoreConfig } from "./store.js";

// Denials arrive as this, and a host must be able to distinguish them from a crash.
export { ActionDeniedError } from "./errors.js";

// The standalone MCP server, kept for the CLI bins that still stand one up in-process.
export { createGreenhouseActionMcpServer } from "./server.js";

export { unavailableVisibilityProbe } from "./env.js";
export type {
  ActionBinding,
  FenceTarget,
  TargetKind,
  TargetVisibilityProbe,
  VisibilityVerdict,
  ClaimResult,
  GreenhouseGateway,
  MutationPlan,
  ActionClient,
  ActionEntitlement,
  ActionIntent,
  ActionKind,
  ActionPhase,
  ActionRecord,
  ActionSession,
  ActionStatus,
  ActionStore,
  Clock,
  Observation,
  ReconciliationObservation,
  ResolvedIdentity,
} from "./types.js";
export { ACTION_KINDS } from "./types.js";
