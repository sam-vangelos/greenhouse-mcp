import type { ResolverDomain } from "./types.js";

export interface ResolutionArtifactService<TSigner = unknown> {
  signer: TSigner;
  ephemeral: boolean;
}

export interface ResolutionServices {
  artifacts?: Partial<Record<ResolverDomain, ResolutionArtifactService>>;
  providers?: Record<string, unknown>;
  registry?: unknown;
}

export interface ResolutionServiceCarrier {
  resolution?: ResolutionServices;
}

export function getResolutionServices(carrier: ResolutionServiceCarrier): ResolutionServices {
  if (!carrier.resolution) {
    carrier.resolution = {};
  }
  return carrier.resolution;
}

export function getResolutionArtifactService<TSigner>(
  services: ResolutionServices | undefined,
  domain: ResolverDomain
): ResolutionArtifactService<TSigner> | undefined {
  return services?.artifacts?.[domain] as ResolutionArtifactService<TSigner> | undefined;
}

export function getResolutionProvider<TProvider>(
  services: ResolutionServices | undefined,
  key: string
): TProvider | undefined {
  return services?.providers?.[key] as TProvider | undefined;
}
