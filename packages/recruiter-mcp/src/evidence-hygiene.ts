export function containsTokenOrConfigPayload(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsTokenOrConfigPayload);
  if (typeof value === "string") return looksLikeSensitiveEvidenceString(value);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, nested]) => {
    if (isForbiddenEvidencePayloadKey(key)) return true;
    return containsTokenOrConfigPayload(nested);
  });
}

export function isForbiddenEvidencePayloadKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[-_\s]/g, "");
  if (normalized === "artifactcontainstoken" || normalized === "metadatacontainstoken") return false;
  if (normalized === "authorization" || normalized.endsWith("authorization")) return true;
  if (normalized === "token" || normalized === "tokens") return true;
  if (normalized.endsWith("token") && !normalized.endsWith("tokenid")) return true;
  if (normalized === "config" || normalized === "rawconfig" || normalized.endsWith("configpayload")) return true;
  return false;
}

export function looksLikeSensitiveEvidenceString(value: string): boolean {
  return /Authorization\s*:\s*Bearer\s+\S+/i.test(value)
    || /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/.test(value)
    || /\bGREENHOUSE_(?:CLIENT_SECRET|RECRUITER_SESSION_SECRET|RECRUITER_SESSION_TOKEN|RECRUITER_REMOTE_AUTH_TOKEN|RECRUITER_REMOTE_READY_TOKEN|RECRUITER_ACTIVE_SESSION_TOKEN|RECRUITER_REVOKED_SESSION_TOKEN)\s*[:=]\s*\S+/i.test(value)
    || /\b(?:sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9_]{12,})\b/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
