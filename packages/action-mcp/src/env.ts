import { ACTION_DEFINITIONS } from "./actions/index.js";
import { validateActionSession } from "./crypto.js";
import { createGreenhouseGatewayFromEnv } from "./greenhouse.js";
import { GreenhouseActionService } from "./service.js";
import { createActionStoreFromEnv } from "./store.js";
import type { ActionKind, ActionSession, ActionStore, GreenhouseGateway, TargetVisibilityProbe } from "./types.js";

export const ACTION_SIGNING_SECRET_ENV = "GREENHOUSE_ACTION_SIGNING_SECRET";

export interface ActionRuntimeFlags {
  serviceEnabled: boolean;
  writesEnabled: boolean;
  production: boolean;
  catalogCapabilities: ReadonlySet<ActionKind>;
  writeCapabilities: ReadonlySet<ActionKind>;
}

export interface ActionRuntime {
  store: ActionStore;
  greenhouse: GreenhouseGateway;
}

export function createActionRuntimeFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch
): ActionRuntime {
  return {
    store: createActionStoreFromEnv(env, fetchImpl),
    greenhouse: createGreenhouseGatewayFromEnv(env, fetchImpl),
  };
}

export function createActionRuntimeProvider(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch
): () => ActionRuntime {
  let runtime: ActionRuntime | undefined;
  return () => runtime ??= createActionRuntimeFromEnv(env, fetchImpl);
}

export function readActionRuntimeFlags(env: NodeJS.ProcessEnv = process.env): ActionRuntimeFlags {
  const catalogCapabilities = readCapabilities(env.GREENHOUSE_ACTION_CAPABILITIES);
  const writeCapabilities = env.GREENHOUSE_ACTION_WRITE_CAPABILITIES === undefined
    ? new Set(catalogCapabilities)
    : readCapabilities(env.GREENHOUSE_ACTION_WRITE_CAPABILITIES);
  for (const kind of writeCapabilities) {
    if (!catalogCapabilities.has(kind)) throw new Error("GREENHOUSE_ACTION_WRITE_CAPABILITIES must be a subset of GREENHOUSE_ACTION_CAPABILITIES.");
  }
  return {
    serviceEnabled: readExactBoolean(env, "GREENHOUSE_ACTION_SERVICE_ENABLED", false),
    writesEnabled: readExactBoolean(env, "GREENHOUSE_ACTION_WRITES_ENABLED", false),
    production: env.NODE_ENV === "production",
    catalogCapabilities,
    writeCapabilities,
  };
}

export function readActionSigningSecret(env: NodeJS.ProcessEnv = process.env): string {
  const value = env[ACTION_SIGNING_SECRET_ENV];
  if (!value || value.trim() !== value || Buffer.byteLength(value, "utf8") < 32) {
    throw new Error(`${ACTION_SIGNING_SECRET_ENV} must be a trimmed secret of at least 32 bytes.`);
  }
  return value;
}

export function validateActionEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  runtime?: ActionRuntime
): ActionRuntimeFlags {
  const flags = readActionRuntimeFlags(env);
  const secret = readActionSigningSecret(env);
  validateActionSession(undefined, secret);
  if (!runtime) createActionRuntimeFromEnv(env);
  return flags;
}

export async function validateActionReadiness(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
  runtime?: ActionRuntime
): Promise<ActionRuntimeFlags> {
  const dependencies = runtime ?? createActionRuntimeFromEnv(env, fetchImpl);
  const flags = validateActionEnvironment(env, dependencies);
  if (!flags.serviceEnabled) return flags;
  const readinessActionId = "00000000-0000-4000-8000-000000000000";
  await Promise.all([
    dependencies.store.isSessionRevoked("action:readiness-probe"),
    dependencies.store.getEntitlement({
      identityId: "00000000-0000-4000-8000-000000000000",
      greenhouseUserId: 1,
    }, "codex"),
    dependencies.store.getAction(readinessActionId),
    dependencies.store.prepareReconciliation(readinessActionId),
    dependencies.greenhouse.probe(),
  ]);
  return flags;
}

/**
 * The probe for construction paths that have NO scoped read plane in-process (CLI bins, standalone
 * tests of env wiring). `unavailable` DENIES — with its own code, so the operator sees "this
 * deployment shape cannot answer visibility" rather than a revoked grant. The recruiter host never
 * uses this: it supplies createRecruiterVisibilityProbe, which runs the real pipeline.
 */
export const unavailableVisibilityProbe: TargetVisibilityProbe = {
  async probe() {
    return { state: "unavailable", reason: "This construction path has no scoped read plane to consult." };
  },
};

export function createGreenhouseActionServiceFromEnv(
  session: ActionSession,
  env: NodeJS.ProcessEnv = process.env,
  runtime?: ActionRuntime
): GreenhouseActionService {
  const flags = readActionRuntimeFlags(env);
  const dependencies = runtime ?? createActionRuntimeFromEnv(env);
  return new GreenhouseActionService({
    session,
    store: dependencies.store,
    greenhouse: dependencies.greenhouse,
    signingSecret: readActionSigningSecret(env),
    visibility: unavailableVisibilityProbe,
    writesEnabled: flags.writesEnabled,
    writeCapabilities: flags.writeCapabilities,
    production: flags.production,
  });
}

export function readExactBoolean(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const value = env[name];
  if (value === undefined || value.length === 0) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be exactly true or false.`);
}

function readCapabilities(raw: string | undefined): Set<ActionKind> {
  const all = new Set(ACTION_DEFINITIONS.map((definition) => definition.kind));
  if (raw === undefined) return all;
  if (raw === "") return new Set();
  if (raw.trim() !== raw || raw.includes(" ") || raw.includes(",,")) throw new Error("Greenhouse action capability lists must be comma-separated action kinds without spaces.");
  const values = raw.split(",");
  if (new Set(values).size !== values.length) throw new Error("Greenhouse action capability lists cannot contain duplicates.");
  for (const value of values) {
    if (!all.has(value as ActionKind)) throw new Error(`Unknown Greenhouse action capability: ${value}`);
  }
  return new Set(values as ActionKind[]);
}
