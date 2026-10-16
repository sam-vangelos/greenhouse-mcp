export interface CorsOriginParseResult {
  configured: boolean;
  origins: string[];
  invalid: string[];
}

export function parseCorsOrigins(raw: string | undefined): CorsOriginParseResult {
  if (raw === undefined || raw.length === 0) {
    return { configured: false, origins: [], invalid: [] };
  }
  const origins: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const origin of raw.split(",")) {
    if (origin.length === 0 || origin.trim() !== origin || !isHttpsOrigin(origin) || seen.has(origin)) {
      invalid.push(origin);
      continue;
    }
    origins.push(origin);
    seen.add(origin);
  }
  return { configured: true, origins, invalid };
}

export function isHttpsOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value.replace(/\/$/, "") && url.pathname === "/" && !url.search && !url.hash;
  } catch {
    return false;
  }
}
