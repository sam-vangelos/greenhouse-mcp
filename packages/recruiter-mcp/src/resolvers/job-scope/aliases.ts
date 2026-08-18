import { normalizeText } from "./inventory.js";

export interface AliasEntry {
  alias: string;
  canonical: string;
  type: string;
  risk?: string;
  requires_confirmation?: boolean;
  collision_terms?: string[];
}

export interface AliasExpansion {
  alias: string;
  type: string;
  canonicalTerms: string[];
  requiresConfirmation: boolean;
  hasCollision: boolean;
  known: boolean;
}

/**
 * Expand model/user-supplied acronyms and role-family shorthand into canonical
 * match terms. Collision aliases (e.g. "FD" => Frontier Data | Finance Director)
 * carry every meaning so the resolver can flag genuine ambiguity rather than
 * silently choosing one interpretation.
 */
export function expandAliases(requested: readonly string[], table: readonly AliasEntry[]): AliasExpansion[] {
  const byAlias = new Map<string, AliasEntry>();
  for (const entry of table) {
    if (typeof entry?.alias === "string") {
      byAlias.set(normalizeText(entry.alias), entry);
    }
  }
  const expansions: AliasExpansion[] = [];
  const seen = new Set<string>();
  for (const raw of requested) {
    if (typeof raw !== "string") continue;
    const key = normalizeText(raw);
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    const entry = byAlias.get(key);
    if (entry) {
      const collisions = (entry.collision_terms ?? []).filter(
        (term): term is string => typeof term === "string" && term.trim().length > 0
      );
      expansions.push({
        alias: entry.alias,
        type: entry.type,
        canonicalTerms: [entry.canonical, ...collisions].filter((term) => typeof term === "string" && term.length > 0),
        requiresConfirmation: entry.requires_confirmation === true || collisions.length > 0,
        hasCollision: collisions.length > 0,
        known: true,
      });
    } else {
      const literal = raw.trim();
      expansions.push({
        alias: literal,
        type: "literal",
        canonicalTerms: [literal],
        requiresConfirmation: false,
        hasCollision: false,
        known: false,
      });
    }
  }
  return expansions;
}

/**
 * Detect known aliases that appear as whole tokens inside free-text query so the
 * resolver behaves the same whether the model passes `aliases: ["FD"]` or just
 * writes "FD roles".
 */
export function detectAliasTokens(query: string, table: readonly AliasEntry[]): string[] {
  const normalizedQuery = normalizeText(query);
  if (normalizedQuery.length === 0) return [];
  const queryTokens = new Set(normalizedQuery.split(" ").filter(Boolean));
  const found: string[] = [];
  const seen = new Set<string>();
  for (const entry of table) {
    if (typeof entry?.alias !== "string") continue;
    const aliasNorm = normalizeText(entry.alias);
    if (aliasNorm.length === 0 || seen.has(aliasNorm)) continue;
    const aliasTokens = aliasNorm.split(" ").filter(Boolean);
    const present = aliasTokens.length > 0 && aliasTokens.every((token) => queryTokens.has(token));
    if (present) {
      seen.add(aliasNorm);
      found.push(entry.alias);
    }
  }
  return found;
}
