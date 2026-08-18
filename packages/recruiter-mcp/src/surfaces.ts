import type { RecruiterSurface } from "./types.js";

export const DEFAULT_REMOTE_SURFACES: RecruiterSurface[] = ["chatgpt_desktop", "claude_desktop"];

export interface RemoteSurfaceAllowlist {
  configured: boolean;
  surfaces: RecruiterSurface[];
  allowed: Set<RecruiterSurface>;
  invalid: string[];
}

export function parseRemoteSurfaceAllowlist(raw: string | undefined): RemoteSurfaceAllowlist {
  if (raw === undefined || raw.length === 0) {
    return { configured: false, surfaces: DEFAULT_REMOTE_SURFACES, allowed: new Set(DEFAULT_REMOTE_SURFACES), invalid: [] };
  }
  const surfaces: RecruiterSurface[] = [];
  const allowed = new Set<RecruiterSurface>();
  const invalid: string[] = [];
  for (const token of raw.split(",")) {
    if (token.length === 0 || token.trim() !== token || !isRemoteSurface(token) || allowed.has(token)) {
      invalid.push(token);
      continue;
    }
    surfaces.push(token);
    allowed.add(token);
  }
  return { configured: true, surfaces, allowed, invalid };
}

export function isRemoteSurface(value: string): value is RecruiterSurface {
  return value === "chatgpt_desktop" || value === "claude_desktop";
}
