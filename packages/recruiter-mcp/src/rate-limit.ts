import type { AuthenticatedSession, RecruiterToolKind } from "./types.js";
import { readBooleanEnvFlag } from "./env.js";

export interface RateLimitInput {
  session: AuthenticatedSession;
  toolName: string;
  toolKind: RecruiterToolKind;
  now: number;
}

export type RateLimitDecision =
  | { allowed: true; limit: number | null; remaining: number | null; resetAt: string | null }
  | { allowed: false; limit: number; remaining: 0; resetAt: string; reason: "total" | "analysis" };

export interface RecruiterRateLimiter {
  check(input: RateLimitInput): RateLimitDecision;
}

export interface RateLimiterConfig {
  windowMs: number;
  maxCallsPerWindow: number;
  maxAnalysisCallsPerWindow: number;
}

interface Bucket {
  windowStart: number;
  count: number;
}

const DEFAULT_RATE_LIMIT_CONFIG: RateLimiterConfig = {
  windowMs: 60_000,
  maxCallsPerWindow: 120,
  maxAnalysisCallsPerWindow: 30,
};

const RATE_LIMIT_ENV_NAMES = {
  windowMs: "GREENHOUSE_RECRUITER_RATE_LIMIT_WINDOW_MS",
  maxCallsPerWindow: "GREENHOUSE_RECRUITER_MAX_CALLS_PER_WINDOW",
  maxAnalysisCallsPerWindow: "GREENHOUSE_RECRUITER_MAX_ANALYSIS_CALLS_PER_WINDOW",
} as const satisfies Record<keyof RateLimiterConfig, string>;

const sharedLimiters = new Map<string, RecruiterRateLimiter>();

export function createNoopRateLimiter(): RecruiterRateLimiter {
  return {
    check() {
      return { allowed: true, limit: null, remaining: null, resetAt: null };
    },
  };
}

export function createInMemoryRateLimiter(config: RateLimiterConfig): RecruiterRateLimiter {
  const totalBuckets = new Map<string, Bucket>();
  const analysisBuckets = new Map<string, Bucket>();
  return {
    check(input) {
      const totalKey = rateLimitPrincipalKey(input.session);
      const total = checkBucket(totalBuckets, totalKey, input.now, config.windowMs, config.maxCallsPerWindow);
      if (!total.allowed) return { ...total, reason: "total" };
      if (input.toolKind === "analysis") {
        const analysis = checkBucket(analysisBuckets, `${totalKey}:analysis`, input.now, config.windowMs, config.maxAnalysisCallsPerWindow);
        if (!analysis.allowed) return { ...analysis, reason: "analysis" };
      }
      return total;
    },
  };
}

export function createRateLimiterFromEnv(env: NodeJS.ProcessEnv = process.env): RecruiterRateLimiter {
  if (readBooleanEnvFlag(env, "GREENHOUSE_RECRUITER_RATE_LIMIT_DISABLED")) {
    return createNoopRateLimiter();
  }
  const config = readRateLimiterConfigFromEnv(env);
  const key = `${config.windowMs}:${config.maxCallsPerWindow}:${config.maxAnalysisCallsPerWindow}`;
  let limiter = sharedLimiters.get(key);
  if (!limiter) {
    limiter = createInMemoryRateLimiter(config);
    sharedLimiters.set(key, limiter);
  }
  return limiter;
}

export function readRateLimiterConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RateLimiterConfig {
  validateRateLimiterEnv(env);
  return {
    windowMs: readPositiveInt(env.GREENHOUSE_RECRUITER_RATE_LIMIT_WINDOW_MS) ?? DEFAULT_RATE_LIMIT_CONFIG.windowMs,
    maxCallsPerWindow: readPositiveInt(env.GREENHOUSE_RECRUITER_MAX_CALLS_PER_WINDOW) ?? DEFAULT_RATE_LIMIT_CONFIG.maxCallsPerWindow,
    maxAnalysisCallsPerWindow: readPositiveInt(env.GREENHOUSE_RECRUITER_MAX_ANALYSIS_CALLS_PER_WINDOW) ?? DEFAULT_RATE_LIMIT_CONFIG.maxAnalysisCallsPerWindow,
  };
}

export function validateRateLimiterEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const name of Object.values(RATE_LIMIT_ENV_NAMES)) {
    const raw = env[name];
    if (raw === undefined || raw.trim().length === 0) continue;
    if (readPositiveInt(raw) === null) {
      throw new Error(`${name} must be a positive integer.`);
    }
  }
}

function checkBucket(
  buckets: Map<string, Bucket>,
  key: string,
  now: number,
  windowMs: number,
  limit: number
): { allowed: true; limit: number; remaining: number; resetAt: string } | { allowed: false; limit: number; remaining: 0; resetAt: string } {
  const current = buckets.get(key);
  const bucket = !current || now - current.windowStart >= windowMs
    ? { windowStart: now, count: 0 }
    : current;
  const resetAt = new Date(bucket.windowStart + windowMs).toISOString();
  if (bucket.count >= limit) {
    buckets.set(key, bucket);
    return { allowed: false, limit, remaining: 0, resetAt };
  }
  bucket.count += 1;
  buckets.set(key, bucket);
  return { allowed: true, limit, remaining: Math.max(0, limit - bucket.count), resetAt };
}

function rateLimitPrincipalKey(session: AuthenticatedSession): string {
  const principal = session.tokenId ?? session.subject;
  return `${session.surface}:${principal}`;
}

function readPositiveInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === "string" && value.trim() === value && /^[1-9]\d*$/.test(value)) {
    const parsed = Number.parseInt(value, 10);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}
