import type { ResolutionServices } from "../../resolution/services.js";
import { getResolutionArtifactService, getResolutionProvider } from "../../resolution/services.js";
import type { JobInventoryProvider } from "./inventory.js";
import type { ScopeSigner } from "./scope-handle.js";

export const JOB_SCOPE_INVENTORY_PROVIDER_KEY = "job_scope.inventory";

export interface JobScopeResolutionServicesInput {
  scopeSigner?: ScopeSigner;
  scopeSignerEphemeral?: boolean;
  inventoryProvider?: JobInventoryProvider;
  base?: ResolutionServices;
}

export function createJobScopeResolutionServices(input: JobScopeResolutionServicesInput = {}): ResolutionServices {
  const services: ResolutionServices = {
    artifacts: { ...(input.base?.artifacts ?? {}) },
    providers: { ...(input.base?.providers ?? {}) },
    registry: input.base?.registry,
  };
  if (input.scopeSigner) {
    services.artifacts = {
      ...(services.artifacts ?? {}),
      job_scope: {
        signer: input.scopeSigner,
        ephemeral: input.scopeSignerEphemeral ?? false,
      },
    };
  }
  if (input.inventoryProvider) {
    services.providers = {
      ...(services.providers ?? {}),
      [JOB_SCOPE_INVENTORY_PROVIDER_KEY]: input.inventoryProvider,
    };
  }
  return services;
}

export function getJobScopeArtifactService(services: ResolutionServices | undefined) {
  return getResolutionArtifactService<ScopeSigner>(services, "job_scope");
}

export function getJobInventoryProvider(services: ResolutionServices | undefined): JobInventoryProvider | undefined {
  return getResolutionProvider<JobInventoryProvider>(services, JOB_SCOPE_INVENTORY_PROVIDER_KEY);
}
