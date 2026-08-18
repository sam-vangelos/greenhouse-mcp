import {
  ACTION_DEFINITIONS,
  GreenhouseActionService,
  createActionRuntimeFromEnv,
  readActionRuntimeFlags,
  readActionSigningSecret,
} from "../../action-mcp/dist/index.js";
import type { ActionStore } from "../../action-mcp/dist/index.js";
import { createRecruiterVisibilityProbe } from "./action-visibility.js";
import type { RecruiterToolRuntime } from "./runtime.js";
import { createActionToolGrant, type ActionToolName } from "./action-tools.js";
import { deriveActionSession, withParentRevocation, ActionSessionBridgeError } from "./action-session.js";
import type { AuthenticatedSession } from "./types.js";

/**
 * Mounting the write plane onto the recruiter server — Phase 2c Slice 0c.
 *
 * The catalog contract this has to respect is not negotiable, and two gates already enforce it:
 * `toolCatalogCheck` 503s the whole service unless the env catalog resolves to the exact ordered base
 * list (`readiness.ts`), and `assertExactCatalog` fails the container self-check unless a synthetic
 * session holding NO entitlement sees exactly that same list (`container-self-check.ts`). So the
 * write tools are not part of the catalog — they are a per-session ADDITION, admitted only by a grant,
 * and a session without one must be byte-identical to today. Returning `null` is how that holds.
 *
 * It returns null — silently, and correctly — in four cases:
 *
 *   - the action plane is not configured in this environment (no signing secret / no store);
 *   - the recruiter session cannot be bridged (legacy token with no id or no signed client);
 *   - the actor holds no entitlement row, which is the normal state for everyone;
 *   - the entitlement exists but does not carry preview.
 *
 * None of those is an error worth failing a READ over. A recruiter whose write entitlement is absent
 * still gets the full read catalog, which is the whole product for all but one person today.
 */

export interface ActionPlaneMount {
  /** Exactly the tools this session may see. Built from ACTION_DEFINITIONS, never a copied list. */
  grantedTools: ReadonlySet<ActionToolName>;
  /**
   * Constructed at REGISTRATION time rather than at mount time, because the visibility probe —
   * Phase 2c's fence — runs the session's own read pipeline, and the runtime that carries that
   * pipeline does not exist yet when the mount is resolved. Memoized: one service per session.
   */
  buildService(runtime: RecruiterToolRuntime): GreenhouseActionService;
}

export interface MountActionPlaneOptions {
  session: AuthenticatedSession;
  env?: NodeJS.ProcessEnv;
  /** Test seam. Production builds both from env. */
  store?: ActionStore;
  service?: GreenhouseActionService;
}

/** True when this deployment has the action plane configured at all. Cheap, and no network. */
export function actionPlaneConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    readActionSigningSecret(env);
    return true;
  } catch {
    return false;
  }
}

export async function mountActionPlane(
  options: MountActionPlaneOptions
): Promise<ActionPlaneMount | null> {
  // TOTAL fail-closed boundary, and the narrow per-step catches below are not a substitute for it.
  //
  // This was a real outage, not a hypothetical: with the service switch on and
  // GREENHOUSE_ACTION_CLIENT_ID unset, `createActionRuntimeFromEnv` throws — and that throw was
  // outside every catch, so it propagated into the request handler and took the READ session down
  // with it. A write plane that is merely misconfigured must never cost a recruiter their reads.
  //
  // So the rule is absolute rather than enumerated: any failure to mount means no write tools. The
  // alternative is a list of anticipated failures, and the one that took production down was the one
  // not on the list.
  try {
    return await mountActionPlaneOrThrow(options);
  } catch (error) {
    reportMountFailure(error);
    return null;
  }
}

/**
 * Mount failures are SILENT to the caller by design — but not to the operator. Without this an
 * entitled recruiter sees 44 tools instead of 66 and has no way to learn why, and neither does
 * anyone reading the logs. Written to stderr rather than the audit sink because it is a
 * configuration fault, not an access event.
 */
function reportMountFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[greenhouse-recruiter] action plane not mounted: ${message}`);
}

async function mountActionPlaneOrThrow(
  options: MountActionPlaneOptions
): Promise<ActionPlaneMount | null> {
  const env = options.env ?? process.env;

  // The master switch, and it defaults FALSE. Without this the plane would activate on the mere
  // presence of a signing secret — configuration as consent, which is how a capability arrives in
  // production because someone set a variable rather than because someone decided. The flag already
  // existed (`env.ts` readActionRuntimeFlags) and nothing on this path consulted it.
  //
  // This does not narrow what an entitled actor gets: with the switch on, they get all 22. It only
  // means turning the plane on is a decision somebody makes out loud.
  if (!readActionRuntimeFlags(env).serviceEnabled) return null;
  if (!options.service && !actionPlaneConfigured(env)) return null;

  let derived;
  try {
    derived = deriveActionSession({
      session: options.session,
      signingSecret: env.GREENHOUSE_RECRUITER_SCOPE_SIGNING_SECRET ?? readActionSigningSecret(env),
      actionSigningSecret: readActionSigningSecret(env),
    });
  } catch (error) {
    // A session that cannot be bridged gets no write tools. Never fails the read catalog with it:
    // the bridge's own refusals are about attribution, and a recruiter who cannot write should still
    // be able to read.
    if (error instanceof ActionSessionBridgeError) return null;
    throw error;
  }

  const flags = readActionRuntimeFlags(env);
  const runtime = options.service ? undefined : createActionRuntimeFromEnv(env);
  const store = options.store ?? runtime?.store;
  if (!store) return null;

  // Revocation consults the parent recruiter token as well as the derived id — Sam's call, and the
  // reason a revoked recruiter session cannot keep applying an already-approved intent.
  const bridgedStore = withParentRevocation(store, derived.parentTokenId);

  // The entitlement decides whether this session sees the tools at all. Its absence is the default
  // and the reason shipping the write plane is safe: an unprovisioned actor is denied by having
  // nothing to deny, not by a flag someone has to remember to set.
  let entitled = false;
  try {
    const identity = await bridgedStore.resolveIdentity(derived.session);
    const entitlement = await bridgedStore.getEntitlement(identity, derived.session.client);
    entitled = entitlement?.canPreview === true;
  } catch {
    // A store outage withholds the write tools and leaves reads untouched. Fail closed on the
    // narrow thing, not on the whole session.
    return null;
  }
  if (!entitled) return null;

  let built: GreenhouseActionService | undefined;
  const buildService = (toolRuntime: RecruiterToolRuntime): GreenhouseActionService =>
    built ??= options.service ?? new GreenhouseActionService({
      session: derived.session,
      store: bridgedStore,
      greenhouse: runtime!.greenhouse,
      signingSecret: readActionSigningSecret(env),
      // The fence. The probe runs the session's OWN read pipeline, so the write plane's answer to
      // "may this human touch this record" is the read plane's answer, not a second implementation.
      visibility: createRecruiterVisibilityProbe({ runtime: toolRuntime }),
      writesEnabled: flags.writesEnabled,
      production: env.NODE_ENV === "production",
      writeCapabilities: flags.writeCapabilities,
    });

  // Built from the action package's own catalog, filtered by the capabilities this deployment
  // exposes. Both capability env vars default to ALL eleven kinds; narrowing either is an explicit
  // decision that needs an external constraint to cite, and neither is set.
  const grantedTools = createActionToolGrant(
    ACTION_DEFINITIONS
      .filter((definition) => flags.catalogCapabilities.has(definition.kind))
      .flatMap((definition) => [definition.previewTool, definition.applyTool])
  );

  return { grantedTools, buildService };
}
