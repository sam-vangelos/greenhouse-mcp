import type { RecruiterToolRuntime } from "../../runtime.js";
import { getResolutionServices } from "../../resolution/services.js";
import { createScopeSignerFromEnv, type ScopeSigner } from "./scope-handle.js";
import { getJobScopeArtifactService } from "./services.js";

interface ScopeSignerCarrier {
  cachedJobScopeSigner?: ScopeSigner;
  cachedJobScopeSignerEphemeral?: boolean;
}

/**
 * Resolve the scope signer for a runtime. Tests and server wiring inject a
 * signer on the runtime. When absent, derive one from the environment once and
 * cache it on the runtime so every call in this process shares a single signing
 * key (an ephemeral per-call key would make handles unverifiable across calls).
 */
export function resolveScopeSigner(runtime: RecruiterToolRuntime): { signer: ScopeSigner; ephemeral: boolean } {
  const carrier = runtime as RecruiterToolRuntime & ScopeSignerCarrier;
  const services = getResolutionServices(carrier);
  const configured = getJobScopeArtifactService(services);
  if (configured) {
    return { signer: configured.signer, ephemeral: configured.ephemeral };
  }
  if (carrier.cachedJobScopeSigner) {
    return { signer: carrier.cachedJobScopeSigner, ephemeral: carrier.cachedJobScopeSignerEphemeral ?? false };
  }

  const created = createScopeSignerFromEnv(process.env);
  carrier.cachedJobScopeSigner = created.signer;
  carrier.cachedJobScopeSignerEphemeral = created.ephemeral;
  carrier.resolution = {
    ...services,
    artifacts: {
      ...(services.artifacts ?? {}),
      job_scope: { signer: created.signer, ephemeral: created.ephemeral },
    },
  };
  return { signer: created.signer, ephemeral: created.ephemeral };
}
