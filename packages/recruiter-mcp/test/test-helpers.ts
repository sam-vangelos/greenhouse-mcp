import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ApiResponseMeta, AppliedPermissionScope, ScopedReadResult, ScopedReadRowCounts } from "../../scoped-core/src/index.js";
import { createMemoryAuditSink } from "../src/audit.js";
import { DEFAULT_LIMITS } from "../src/limits.js";
import { createFixtureInventoryProvider, type JobInventoryProvider, type JobScopeFixture } from "../src/resolvers/job-scope/inventory.js";
import { createJobScopeResolutionServices } from "../src/resolvers/job-scope/services.js";
import type { ScopeSigner } from "../src/resolvers/job-scope/scope-handle.js";
import { createRecruiterToolRuntime, type RecruiterToolRuntime } from "../src/runtime.js";
import type { AuthenticatedSession, ScopedReaderLike } from "../src/types.js";

export interface ScopedCall {
  toolName: string;
  params?: Record<string, unknown>;
  options?: Record<string, unknown>;
}

export function testSession(overrides: Partial<AuthenticatedSession> = {}): AuthenticatedSession {
  return {
    subject: "user-1",
    email: "recruiter@example.com",
    surface: "test",
    tokenId: "test-session-token-id",
    issuedAt: "2026-06-23T00:00:00.000Z",
    ...overrides,
  };
}

export function fakeScopedReader(
  handler: (toolName: string, params?: Record<string, unknown>, options?: Record<string, unknown>) => ScopedReadResult | Promise<ScopedReadResult>
): ScopedReaderLike<AuthenticatedSession> & { calls: ScopedCall[] } {
  const calls: ScopedCall[] = [];
  return {
    calls,
    async scopedRead(_session, toolName, params, options) {
      // Every evidence read resolves the org's custom-field DEFINITIONS so values restricted by
      // Greenhouse's "View Private" permission can be withheld. That is infrastructure, not the
      // tool's own scoped read, so it is answered here and kept out of `calls`. The default is the
      // normal tenant state — definitions readable, none private. A handler that wants to exercise
      // the gate should answer "list_custom_fields" itself before delegating, as the dedicated
      // private-custom-field tests do.
      if (toolName === "list_custom_fields" && !customFieldAware(handler)) {
        return scopedSuccess("list_custom_fields", []);
      }
      const optionRecord = options === undefined ? undefined : { ...options } as Record<string, unknown>;
      calls.push({ toolName, params, options: optionRecord });
      return handler(toolName, params, optionRecord);
    },
  };
}

/** A handler opts into driving the definitions read by mentioning it in its source. */
function customFieldAware(handler: (...args: never[]) => unknown): boolean {
  return handler.toString().includes("list_custom_fields");
}

export function scopedSuccess<T>(
  toolName: string,
  data: T,
  nextCursor: string | null = null,
  overrides: {
    actorId?: number;
    effectiveActorId?: number;
    scoped?: boolean;
    permissionScope?: AppliedPermissionScope;
    rowCounts?: ScopedReadRowCounts;
    meta?: ApiResponseMeta;
  } = {}
): ScopedReadResult<T> {
  return {
    ok: true,
    toolName,
    actorId: overrides.actorId ?? 100,
    effectiveActorId: overrides.effectiveActorId ?? 100,
    scoped: overrides.scoped ?? true,
    permissionScope: overrides.permissionScope ?? { kind: "jobs", permittedJobCount: 2 },
    rowCounts: overrides.rowCounts ?? { raw: countRows(data), returned: countReturnedRows(data) },
    data,
    nextCursor,
    meta: overrides.meta,
  };
}

function countRows(data: unknown): number | null {
  if (Array.isArray(data)) return data.length;
  if (data && typeof data === "object") return 1;
  if (data === null || data === undefined) return 0;
  return null;
}

function countReturnedRows(data: unknown): number {
  if (Array.isArray(data)) return data.length;
  return data && typeof data === "object" ? 1 : 0;
}

export function scopedDenial(toolName: string, code: "ACTOR_DENIED" | "TOOL_NOT_AVAILABLE" | "PERMISSION_LOOKUP_FAILED" | "PERMISSION_JOIN_FAILED"): ScopedReadResult {
  return {
    ok: false,
    toolName,
    actorId: 100,
    effectiveActorId: 100,
    denial: {
      code,
      message: `denied: ${code}`,
    },
  };
}

type TestRuntimeOverrides = Partial<RecruiterToolRuntime> & {
  scopeSigner?: ScopeSigner;
  scopeSignerEphemeral?: boolean;
  jobInventory?: JobInventoryProvider;
};

export function testRuntime(scopedReader: ScopedReaderLike<AuthenticatedSession>, overrides: TestRuntimeOverrides = {}) {
  const { scopeSigner, scopeSignerEphemeral, jobInventory, resolution, ...runtimeOverrides } = overrides;
  const resolutionServices = scopeSigner || jobInventory
    ? createJobScopeResolutionServices({
        scopeSigner,
        scopeSignerEphemeral,
        inventoryProvider: jobInventory,
        base: resolution,
      })
    : resolution;
  const auditSink = createMemoryAuditSink();
  const runtime = createRecruiterToolRuntime({
    session: testSession(),
    scopedReader,
    auditSink,
    limits: DEFAULT_LIMITS,
    toolConfig: {
      serverDisabled: false,
      disabledTools: new Set<string>(),
      evidenceToolsEnabled: true,
      analyticalToolsEnabled: true,
      claudeDesktopEnabled: true,
      chatgptDesktopEnabled: true,
      operatorUnscopedEnabled: true,
    },
    now: () => Date.parse("2026-06-23T12:00:00.000Z"),
    ...(resolutionServices ? { resolution: resolutionServices } : {}),
    ...runtimeOverrides,
  });
  return { runtime, auditSink };
}

const JOB_SCOPE_FIXTURE = JSON.parse(
  readFileSync(resolve("test/fixtures/job-scope-resolution.fixture.json"), "utf8")
) as JobScopeFixture;

export function narrowRecruiterInventory(): JobInventoryProvider {
  return createFixtureInventoryProvider(JOB_SCOPE_FIXTURE, "narrow_recruiter");
}

export function operatorInventory(): JobInventoryProvider {
  return createFixtureInventoryProvider(JOB_SCOPE_FIXTURE, "site_admin");
}

/**
 * Runtime for direct analysis-tool tests. The scope-resolution gate now loads the
 * permission-scoped inventory on the no-scope path to fail closed for broad-access
 * actors; injecting a narrow-recruiter inventory keeps the historic bounded
 * no-scope behavior (and leaves scoped-reader call sequences intact) without a
 * real list_jobs round-trip. Pass an explicit jobInventory to override.
 */
export function analysisRuntime(
  scopedReader: ScopedReaderLike<AuthenticatedSession>,
  overrides: TestRuntimeOverrides = {}
) {
  return testRuntime(scopedReader, { jobInventory: narrowRecruiterInventory(), ...overrides });
}
