import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  createSignedArtifactSigner,
  MIN_ARTIFACT_SIGNING_SECRET_LENGTH,
  type SignedArtifactVerifyFailureReason,
  type SignedArtifactVerifyResult,
} from "../../resolution/artifacts.js";

/**
 * v1 scope artifacts are stateless, HMAC-signed, session-subject-bound, and
 * short lived. They are NOT persisted as DB-backed saved scopes. A scope_handle
 * freezes the resolved job ids; a confirmation_token authorizes turning a
 * proposed resolution into a confirmed scope_handle without server-side storage.
 */
export const SCOPE_SIGNING_SECRET_ENV = "GREENHOUSE_RECRUITER_SCOPE_SIGNING_SECRET";
export const DEFAULT_SCOPE_HANDLE_TTL_MS = 60 * 60 * 1000;
export const DEFAULT_CONFIRMATION_TOKEN_TTL_MS = 15 * 60 * 1000;
export const MIN_SCOPE_SIGNING_SECRET_LENGTH = MIN_ARTIFACT_SIGNING_SECRET_LENGTH;

const SCOPE_HANDLE_VERSION = "rsh1";
const CONFIRMATION_TOKEN_VERSION = "rct1";

export type ScopeArtifactSource = "live_greenhouse" | "cached_index" | "hybrid" | "exact_ids";

export interface ScopeHandlePayload {
  v: typeof SCOPE_HANDLE_VERSION;
  kind: "scope_handle";
  sub: string;
  jobs: number[];
  complete: boolean;
  hash: string;
  label: string;
  iat: number;
  exp: number;
  jti: string;
  src: ScopeArtifactSource;
}

export interface ConfirmationTokenPayload {
  v: typeof CONFIRMATION_TOKEN_VERSION;
  kind: "confirmation_token";
  sub: string;
  rid: string;
  jobs: number[];
  hash: string;
  label: string;
  complete: boolean;
  requires_ack: string[];
  iat: number;
  exp: number;
  jti: string;
  src: ScopeArtifactSource;
}

export interface SignScopeHandleInput {
  subject: string;
  jobIds: number[];
  complete: boolean;
  label: string;
  source: ScopeArtifactSource;
  issuedAtMs: number;
  ttlMs?: number;
}

export interface SignConfirmationTokenInput {
  subject: string;
  resolutionId: string;
  jobIds: number[];
  label: string;
  complete: boolean;
  requiresAck: string[];
  source: ScopeArtifactSource;
  issuedAtMs: number;
  ttlMs?: number;
}

export type VerifyFailureReason = SignedArtifactVerifyFailureReason;

export type VerifyResult<T> =
  | { ok: true; payload: T }
  | { ok: false; reason: VerifyFailureReason };

export interface ScopeSigner {
  signScopeHandle(input: SignScopeHandleInput): string;
  verifyScopeHandle(handle: string, context: { subject: string; nowMs: number }): VerifyResult<ScopeHandlePayload>;
  signConfirmationToken(input: SignConfirmationTokenInput): string;
  verifyConfirmationToken(token: string, context: { subject: string; nowMs: number }): VerifyResult<ConfirmationTokenPayload>;
  scopeHash(jobIds: number[]): string;
}

export function normalizeJobIdSet(jobIds: Iterable<number>): number[] {
  const unique = new Set<number>();
  for (const value of jobIds) {
    if (Number.isSafeInteger(value) && value > 0) {
      unique.add(value);
    }
  }
  return [...unique].sort((a, b) => a - b);
}

export function scopeHashOf(jobIds: number[]): string {
  const normalized = normalizeJobIdSet(jobIds);
  return createHash("sha256").update(normalized.join(",")).digest("hex").slice(0, 16);
}

export function createScopeSigner(secret: string | Buffer): ScopeSigner {
  const artifactSigner = createSignedArtifactSigner(secret);

  return {
    scopeHash: scopeHashOf,
    signScopeHandle(input) {
      const jobs = normalizeJobIdSet(input.jobIds);
      const payload: ScopeHandlePayload = {
        v: SCOPE_HANDLE_VERSION,
        kind: "scope_handle",
        sub: input.subject,
        jobs,
        complete: input.complete,
        hash: scopeHashOf(jobs),
        label: input.label,
        iat: input.issuedAtMs,
        exp: input.issuedAtMs + (input.ttlMs ?? DEFAULT_SCOPE_HANDLE_TTL_MS),
        jti: randomUUID(),
        src: input.source,
      };
      return artifactSigner.signArtifact(payload);
    },
    verifyScopeHandle(handle, context) {
      return artifactSigner.verifyArtifact<ScopeHandlePayload>(handle, "scope_handle", context) as SignedArtifactVerifyResult<ScopeHandlePayload>;
    },
    signConfirmationToken(input) {
      const jobs = normalizeJobIdSet(input.jobIds);
      const payload: ConfirmationTokenPayload = {
        v: CONFIRMATION_TOKEN_VERSION,
        kind: "confirmation_token",
        sub: input.subject,
        rid: input.resolutionId,
        jobs,
        hash: scopeHashOf(jobs),
        label: input.label,
        complete: input.complete,
        requires_ack: [...input.requiresAck],
        iat: input.issuedAtMs,
        exp: input.issuedAtMs + (input.ttlMs ?? DEFAULT_CONFIRMATION_TOKEN_TTL_MS),
        jti: randomUUID(),
        src: input.source,
      };
      return artifactSigner.signArtifact(payload);
    },
    verifyConfirmationToken(token, context) {
      return artifactSigner.verifyArtifact<ConfirmationTokenPayload>(token, "confirmation_token", context) as SignedArtifactVerifyResult<ConfirmationTokenPayload>;
    },
  };
}

export interface ScopeSignerFromEnv {
  signer: ScopeSigner;
  ephemeral: boolean;
}

export function createScopeSignerFromEnv(env: NodeJS.ProcessEnv = process.env): ScopeSignerFromEnv {
  const raw = env[SCOPE_SIGNING_SECRET_ENV];
  if (typeof raw === "string" && raw.trim().length >= MIN_SCOPE_SIGNING_SECRET_LENGTH) {
    if (raw.trim() !== raw) {
      throw new Error(`${SCOPE_SIGNING_SECRET_ENV} must not contain leading or trailing whitespace.`);
    }
    return { signer: createScopeSigner(raw), ephemeral: false };
  }
  if (typeof raw === "string" && raw.trim().length > 0) {
    throw new Error(`${SCOPE_SIGNING_SECRET_ENV} must be at least ${MIN_SCOPE_SIGNING_SECRET_LENGTH} characters when set.`);
  }
  return { signer: createScopeSigner(randomBytes(48)), ephemeral: true };
}
