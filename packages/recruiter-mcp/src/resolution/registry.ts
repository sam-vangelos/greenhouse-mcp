import { createJobScopeFrameworkResolver } from "../resolvers/job-scope/adapter.js";
import type { Resolver, ResolverDomain } from "./types.js";

export interface ResolverRegistry {
  domains(): ResolverDomain[];
  get(domain: ResolverDomain): Resolver<unknown, unknown> | undefined;
}

export function createResolverRegistry(
  resolvers: Array<Resolver<unknown, unknown>>
): ResolverRegistry {
  const byDomain = new Map<ResolverDomain, Resolver<unknown, unknown>>();
  for (const resolver of resolvers) {
    byDomain.set(resolver.domain, resolver);
  }
  return {
    domains: () => [...byDomain.keys()],
    get: (domain) => byDomain.get(domain),
  };
}

export function createDefaultResolverRegistry(): ResolverRegistry {
  // Foundation-only registry: job_scope is the sole concrete resolver in this
  // pass. Future domains must be added only with implemented, tested resolvers.
  return createResolverRegistry([
    createJobScopeFrameworkResolver() as Resolver<unknown, unknown>,
  ]);
}
