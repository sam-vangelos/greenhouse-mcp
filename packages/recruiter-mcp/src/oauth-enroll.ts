import { readBooleanEnvFlag } from "./env.js";
import { fetchWithTimeout } from "./fetch-timeout.js";
import { buildIdentityBootstrapPlan, type IdentityBootstrapDeniedStatus } from "./identity-bootstrap.js";
import {
  assertCanonicalSupabaseProjectRef,
  normalizeOptionalSupabaseIdentifier,
  normalizeSupabaseApiKey,
  normalizeSupabaseRestOrigin,
} from "./supabase-config.js";

// First-sign-in enrollment (CLO-271). Before this, the recruiter identity directory was an
// allowlist: a handful of hand-bootstrapped rows against the whole active Greenhouse roster, and every
// other colleague who clicked Connect got "not enrolled" with nobody named to fix it — even though the
// server already held, at that moment, the exact evidence the bootstrap CLI uses to write the row
// (a Google-verified work email and the Greenhouse /v3/users roster).
//
// This module applies the bootstrap's OWN rules (buildIdentityBootstrapPlan: exactly one active
// Greenhouse user for the email, else denied) at sign-in time and writes the directory row with
// source "oauth_auto_enroll". The directory stays the authority for everything afterwards — this
// only decides whether a first resolution is attempted. Two lines it never crosses:
//   * it never overrides an existing row: a row for the email (any status — a deliberate
//     deactivation, an ambiguity someone parked) or for the Greenhouse user (unique constraint)
//     ends enrollment with a specific denial, never an upsert;
//   * it never enrolls on a partial answer: a Greenhouse or directory outage is an error the
//     caller reports as such, not a "no such user".
// Opt-out: GREENHOUSE_RECRUITER_OAUTH_DISABLE_AUTO_ENROLL=true restores the allowlist behaviour.

export const OAUTH_AUTO_ENROLL_SOURCE = "oauth_auto_enroll";
export const OAUTH_DISABLE_AUTO_ENROLL_ENV = "GREENHOUSE_RECRUITER_OAUTH_DISABLE_AUTO_ENROLL";

export type OauthEnrollmentDenialCode =
  | "enrollment_disabled"
  | "email_missing"
  | "ambiguous"
  | "deactivated"
  | "directory_row_exists"
  | "email_mismatch";

export type OauthEnrollmentResult =
  | { status: "enrolled"; greenhouseUserId: number; alreadyEnrolled: boolean }
  | { status: "denied"; code: OauthEnrollmentDenialCode; reason: string }
  | { status: "error"; reason: string };

export interface OauthEnrollment {
  enroll(email: string): Promise<OauthEnrollmentResult>;
}

export interface OauthEnrollmentDeps {
  /** Users whose PRIMARY email is the address (the cheap read). */
  readUsersByPrimaryEmail(email: string): Promise<unknown[]>;
  /** The complete roster, consulted only when the cheap read finds nothing (secondary emails). */
  readFullRoster(): Promise<{ users: unknown[]; complete: boolean }>;
  directory: {
    supabaseUrl: string;
    apiKey: string;
    table: string;
    timeoutMs: number;
    fetchImpl: typeof fetch;
  };
  allowedDomains: string[];
  disabled: boolean;
  now?: () => number;
}

export function createOauthEnrollment(deps: OauthEnrollmentDeps): OauthEnrollment {
  const now = deps.now ?? (() => Date.now());
  const baseUrl = `${normalizeSupabaseRestOrigin(deps.directory.supabaseUrl, "Supabase identity directory")}/rest/v1/${encodeURIComponent(deps.directory.table)}`;
  const headers = {
    apikey: deps.directory.apiKey,
    authorization: `Bearer ${deps.directory.apiKey}`,
    accept: "application/json",
  };

  async function directoryRows(filter: Record<string, string>): Promise<Array<Record<string, unknown>>> {
    const url = new URL(baseUrl);
    for (const [key, value] of Object.entries(filter)) url.searchParams.set(key, value);
    url.searchParams.set("select", "id,greenhouse_user_id,primary_email,status");
    const response = await fetchWithTimeout(deps.directory.fetchImpl, url, { method: "GET", headers }, deps.directory.timeoutMs, "Identity directory lookup");
    if (!response.ok) throw new Error(`Identity directory lookup failed with status ${response.status}.`);
    const rows = await response.json() as unknown;
    return Array.isArray(rows) ? rows.filter((row): row is Record<string, unknown> => row !== null && typeof row === "object" && !Array.isArray(row)) : [];
  }

  return {
    async enroll(rawEmail) {
      if (deps.disabled) {
        return { status: "denied", code: "enrollment_disabled", reason: "First-sign-in enrollment is disabled; the directory is an allowlist." };
      }
      const email = rawEmail.trim().toLowerCase();
      try {
        // 1. Greenhouse decides who this is — by the bootstrap's own rules. The primary-email
        //    filter is the cheap read; the full roster is the fallback that matches secondary
        //    addresses too, so the denial copy is never "no such user" for someone the bootstrap
        //    CLI would have enrolled.
        let users = await deps.readUsersByPrimaryEmail(email);
        if (users.length === 0) {
          const roster = await deps.readFullRoster();
          if (!roster.complete) {
            return { status: "error", reason: "The Greenhouse user roster could not be read completely." };
          }
          users = roster.users;
        }
        const plan = buildIdentityBootstrapPlan({
          rosterEmails: [email],
          greenhouseUsers: users,
          allowedDomains: deps.allowedDomains,
          source: OAUTH_AUTO_ENROLL_SOURCE,
          generatedAt: new Date(now()).toISOString(),
        });
        const denied = plan.denied[0];
        if (denied !== undefined || plan.resolved.length !== 1) {
          return { status: "denied", code: mapBootstrapDenial(denied?.status), reason: denied?.reason ?? "No Greenhouse user resolved for this email." };
        }
        const entry = plan.resolved[0]!;

        // 2. A row for this email, in ANY status, is a decision someone already made. Sign-in
        //    never reverses it.
        const byEmail = await directoryRows({ primary_email: `eq.${email}` });
        if (byEmail.length > 0) {
          const existing = byEmail[0]!;
          // An operator's bootstrap that landed between the resolve and this read is the one row
          // that is not a decision against this person: same user, resolved — already enrolled.
          if (String(existing["status"]) === "resolved" && Number(existing["greenhouse_user_id"]) === entry.greenhouseUserId) {
            return { status: "enrolled", greenhouseUserId: entry.greenhouseUserId, alreadyEnrolled: true };
          }
          return { status: "denied", code: "directory_row_exists", reason: `A directory row already exists for this email (status ${String(existing["status"])}).` };
        }

        // 3. Insert WITHOUT on_conflict: the greenhouse_user_id unique constraint is the guard
        //    against enrolling one Greenhouse user under two addresses; a 409 is then diagnosed.
        const response = await fetchWithTimeout(deps.directory.fetchImpl, new URL(baseUrl), {
          method: "POST",
          headers: { ...headers, "content-type": "application/json", prefer: "return=minimal" },
          body: JSON.stringify(entry.row),
        }, deps.directory.timeoutMs, "Identity directory enrollment insert");
        if (response.status === 409) {
          const byUser = await directoryRows({ greenhouse_user_id: `eq.${entry.greenhouseUserId}` });
          const existing = byUser[0];
          if (existing === undefined) {
            return { status: "error", reason: "The identity directory refused the row but no conflicting row was found." };
          }
          const existingEmail = typeof existing["primary_email"] === "string" ? existing["primary_email"].toLowerCase() : "";
          const existingStatus = String(existing["status"]);
          if (existingStatus === "resolved" && existingEmail === email) {
            // A concurrent first sign-in (two tabs, a client retry) won the race: enrolled.
            return { status: "enrolled", greenhouseUserId: entry.greenhouseUserId, alreadyEnrolled: true };
          }
          if (existingStatus === "resolved") {
            return { status: "denied", code: "email_mismatch", reason: "The Greenhouse user is already mapped to a different email." };
          }
          return { status: "denied", code: "directory_row_exists", reason: `The Greenhouse user already has a directory row (status ${existingStatus}).` };
        }
        if (!response.ok) {
          return { status: "error", reason: `Identity directory enrollment insert failed with status ${response.status}.` };
        }
        return { status: "enrolled", greenhouseUserId: entry.greenhouseUserId, alreadyEnrolled: false };
      } catch (error) {
        return { status: "error", reason: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

function mapBootstrapDenial(status: IdentityBootstrapDeniedStatus | undefined): OauthEnrollmentDenialCode {
  switch (status) {
    case "ambiguous":
      return "ambiguous";
    case "deactivated":
      return "deactivated";
    default:
      // email_missing, greenhouse_missing (no safe id), unresolved (domain) — all "no active user".
      return "email_missing";
  }
}

export interface CreateOauthEnrollmentFromEnvOptions {
  allowedDomains: string[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}

/**
 * The production wiring: Greenhouse through the sanctioned scoped-reader chokepoint, the directory
 * through the identity Supabase pair (the same table the resolver reads), the opt-out flag from env.
 * Returns undefined when the identity directory is not Supabase-backed (static JSON for local dev),
 * where there is nothing durable to enroll into.
 */
export async function createOauthEnrollmentFromEnv(
  env: NodeJS.ProcessEnv,
  options: CreateOauthEnrollmentFromEnvOptions
): Promise<OauthEnrollment | undefined> {
  const supabaseUrl = env.GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_URL;
  const apiKey = env.GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_KEY;
  if (!supabaseUrl || !apiKey) return undefined;
  const { readGreenhouseUsersByPrimaryEmail, readFullGreenhouseUsersRoster } = await import("./scoped-reader.js");
  return createOauthEnrollment({
    readUsersByPrimaryEmail: (email) => readGreenhouseUsersByPrimaryEmail(email, env),
    readFullRoster: () => readFullGreenhouseUsersRoster(env),
    directory: {
      supabaseUrl: assertCanonicalSupabaseProjectRef(supabaseUrl, "Supabase identity directory"),
      apiKey: normalizeSupabaseApiKey(apiKey, "Supabase identity directory"),
      table: normalizeOptionalSupabaseIdentifier(env.GREENHOUSE_RECRUITER_IDENTITY_TABLE, "recruiter_identity_directory", "Supabase identity directory table"),
      timeoutMs: options.timeoutMs ?? 5_000,
      fetchImpl: options.fetchImpl ?? fetch,
    },
    allowedDomains: options.allowedDomains,
    disabled: readBooleanEnvFlag(env, OAUTH_DISABLE_AUTO_ENROLL_ENV),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
}
