import { createHmac, timingSafeEqual } from "node:crypto";

export const MIN_ARTIFACT_SIGNING_SECRET_LENGTH = 32;

export type SignedArtifactVerifyFailureReason = "invalid" | "expired" | "forbidden";

export type SignedArtifactVerifyResult<T> =
  | { ok: true; payload: T }
  | { ok: false; reason: SignedArtifactVerifyFailureReason };

export interface SignedArtifactPayload {
  kind: string;
  sub: string;
  exp: number;
}

export interface SignedArtifactVerificationContext {
  subject: string;
  nowMs: number;
}

export interface SignedArtifactSigner {
  signArtifact<T extends SignedArtifactPayload>(payload: T): string;
  verifyArtifact<T extends SignedArtifactPayload>(
    token: string,
    expectedKind: string,
    context: SignedArtifactVerificationContext
  ): SignedArtifactVerifyResult<T>;
}

export function createSignedArtifactSigner(secret: string | Buffer): SignedArtifactSigner {
  const key = typeof secret === "string" ? Buffer.from(secret, "utf8") : secret;
  if (key.length < MIN_ARTIFACT_SIGNING_SECRET_LENGTH) {
    throw new Error("Artifact signing secret must be at least 32 bytes.");
  }

  return {
    signArtifact(payload) {
      return signSerializedPayload(key, JSON.stringify(payload));
    },
    verifyArtifact<T extends SignedArtifactPayload>(token: string, expectedKind: string, context: SignedArtifactVerificationContext) {
      const result = verifySerializedPayload<T>(key, token, expectedKind);
      if (!result.ok) return result;
      return validateSignedArtifactClaims(result.payload, context);
    },
  };
}

export function signSerializedPayload(key: Buffer, serializedPayload: string): string {
  const body = base64UrlEncode(Buffer.from(serializedPayload, "utf8"));
  const signature = base64UrlEncode(createHmac("sha256", key).update(body).digest());
  return `${body}.${signature}`;
}

export function verifySerializedPayload<T extends SignedArtifactPayload>(
  key: Buffer,
  token: string,
  expectedKind: string
): SignedArtifactVerifyResult<T> {
  if (typeof token !== "string" || token.length === 0 || token.length > 8192) {
    return { ok: false, reason: "invalid" };
  }
  const dotIndex = token.indexOf(".");
  if (dotIndex <= 0 || dotIndex === token.length - 1 || token.indexOf(".", dotIndex + 1) !== -1) {
    return { ok: false, reason: "invalid" };
  }
  const body = token.slice(0, dotIndex);
  const provided = token.slice(dotIndex + 1);
  const expected = base64UrlEncode(createHmac("sha256", key).update(body).digest());
  if (!constantTimeEquals(provided, expected)) {
    return { ok: false, reason: "invalid" };
  }

  let payload: T;
  try {
    payload = JSON.parse(base64UrlDecode(body).toString("utf8")) as T;
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (!isRecord(payload) || payload.kind !== expectedKind) {
    return { ok: false, reason: "invalid" };
  }
  return { ok: true, payload };
}

export function validateSignedArtifactClaims<T extends SignedArtifactPayload>(
  payload: T,
  context: SignedArtifactVerificationContext
): SignedArtifactVerifyResult<T> {
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp) || payload.exp <= context.nowMs) {
    return { ok: false, reason: "expired" };
  }
  if (typeof payload.sub !== "string" || payload.sub !== context.subject) {
    return { ok: false, reason: "forbidden" };
  }
  return { ok: true, payload };
}

export function base64UrlEncode(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(value: string): Buffer {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(padded, "base64");
}

export function constantTimeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "utf8");
  const bufferB = Buffer.from(b, "utf8");
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
