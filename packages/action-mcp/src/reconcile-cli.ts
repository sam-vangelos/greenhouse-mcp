import { fingerprintOperator } from "./crypto.js";
import { readActionSigningSecret } from "./env.js";
import { createGreenhouseReconcilerGatewayFromEnv } from "./greenhouse.js";
import { reconcileRecoverableActions } from "./service.js";
import { createActionStoreFromEnv } from "./store.js";

export async function runReconciliation(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch
): Promise<unknown> {
  const store = createActionStoreFromEnv(env, fetchImpl);
  const signingSecret = readActionSigningSecret(env);
  const actionId = readOptionalFlag(args, "--resolve-action");
  if (!actionId) {
    rejectUnknownArgs(args, []);
    const greenhouse = createGreenhouseReconcilerGatewayFromEnv(env, fetchImpl);
    await greenhouse.probe();
    return { actions: await reconcileRecoverableActions({
      store,
      greenhouse,
      signingSecret,
    }) };
  }

  rejectUnknownArgs(args, ["--resolve-action", "--outcome", "--operator"]);
  const outcome = readFlag(args, "--outcome");
  const operator = readFlag(args, "--operator");
  if (outcome !== "applied" && outcome !== "not_applied") {
    throw new Error("--outcome must be applied or not_applied.");
  }
  const record = await store.getAction(actionId);
  if (!record || record.status !== "unknown") {
    throw new Error("Manual resolution requires an unknown action.");
  }
  const resolved = await store.resolveUnknown({
    actionId,
    status: "reconciled",
    observation: outcome === "applied" ? "desired_observed" : "not_observed",
    errorCode: outcome === "applied" ? "OPERATOR_RESOLVED_APPLIED" : "OPERATOR_RESOLVED_NOT_APPLIED",
    resolutionSource: "operator",
    resolvedByFingerprint: fingerprintOperator(operator, signingSecret),
  });
  if (!resolved) throw new Error("Action was not eligible for manual resolution.");
  return {
    action_id: resolved.actionId,
    state: resolved.status,
    observation: resolved.observation,
    resolution_source: resolved.resolutionSource,
  };
}

function readFlag(args: string[], name: string): string {
  const value = readOptionalFlag(args, name);
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function readOptionalFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--") || value.trim() !== value) throw new Error(`${name} requires a trimmed value.`);
  if (args.indexOf(name, index + 1) >= 0) throw new Error(`${name} may be provided only once.`);
  return value;
}

function rejectUnknownArgs(args: string[], flags: string[]): void {
  const consumed = new Set<number>();
  for (const flag of flags) {
    const index = args.indexOf(flag);
    if (index >= 0) {
      consumed.add(index);
      consumed.add(index + 1);
    }
  }
  if (args.some((_, index) => !consumed.has(index))) throw new Error("Unknown reconciliation argument.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runReconciliation(process.argv.slice(2))
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : "Reconciliation failed.");
      process.exitCode = 1;
    });
}
