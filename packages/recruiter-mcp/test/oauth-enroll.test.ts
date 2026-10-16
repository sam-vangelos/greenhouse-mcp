import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createOauthEnrollment, createOauthEnrollmentFromEnv, OAUTH_AUTO_ENROLL_SOURCE, type OauthEnrollmentDeps } from "../src/oauth-enroll.js";

const CANONICAL = "https://exampleprojectref000.supabase.co";
const EMAIL = "newhire@example.com";

interface Captured { method: string; url: URL; body: Record<string, unknown> | null }

function directoryFake(options: {
  rowsByEmail?: Array<Record<string, unknown>>;
  rowsByUser?: Array<Record<string, unknown>>;
  insertStatus?: number;
  lookupStatus?: number;
} = {}): { fetchImpl: typeof fetch; requests: Captured[] } {
  const requests: Captured[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const method = init?.method ?? "GET";
    requests.push({ method, url, body: typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null });
    if (method === "GET") {
      if (options.lookupStatus !== undefined) return new Response("", { status: options.lookupStatus });
      if (url.searchParams.has("primary_email")) return new Response(JSON.stringify(options.rowsByEmail ?? []), { status: 200 });
      if (url.searchParams.has("greenhouse_user_id")) return new Response(JSON.stringify(options.rowsByUser ?? []), { status: 200 });
    }
    if (method === "POST") return new Response(null, { status: options.insertStatus ?? 201 });
    throw new Error(`unexpected ${method} ${url}`);
  }) as typeof fetch;
  return { fetchImpl, requests };
}

const ACTIVE_USER = { id: 7100000002, primary_email: EMAIL, emails: [EMAIL], deactivated: false };

function deps(overrides: Partial<OauthEnrollmentDeps> & { fetchImpl?: typeof fetch } = {}): OauthEnrollmentDeps {
  const { fetchImpl, ...rest } = overrides;
  return {
    readUsersByPrimaryEmail: async () => [ACTIVE_USER],
    readFullRoster: async () => ({ users: [], complete: true }),
    directory: { supabaseUrl: CANONICAL, apiKey: "sb_secret_service_role_key", table: "recruiter_identity_directory", timeoutMs: 1000, fetchImpl: fetchImpl ?? directoryFake().fetchImpl },
    allowedDomains: ["example.com"],
    disabled: false,
    now: () => Date.parse("2026-09-02T21:00:00.000Z"),
    ...rest,
  };
}

describe("first-sign-in enrollment (CLO-271)", () => {
  it("enrolls a verified work email that matches exactly one active Greenhouse user, writing the bootstrap's row with source oauth_auto_enroll", async () => {
    const { fetchImpl, requests } = directoryFake();
    const result = await createOauthEnrollment(deps({ fetchImpl })).enroll("NewHire@Example.com");
    assert.deepEqual(result, { status: "enrolled", greenhouseUserId: 7100000002, alreadyEnrolled: false });
    const insert = requests.find((r) => r.method === "POST")!;
    assert.ok(insert, "one directory insert");
    assert.equal(insert.url.pathname, "/rest/v1/recruiter_identity_directory");
    assert.equal(insert.url.searchParams.has("on_conflict"), false, "never an upsert — the unique constraint is the guard");
    assert.equal(insert.body!["greenhouse_user_id"], 7100000002);
    assert.equal(insert.body!["primary_email"], EMAIL);
    assert.equal(insert.body!["status"], "resolved");
    assert.equal(insert.body!["source"], OAUTH_AUTO_ENROLL_SOURCE);
    assert.equal((insert.body!["evidence_detail"] as Record<string, unknown>)["matched_by"], "work_email");
    // The email pre-check ran before the insert.
    const emailLookup = requests.find((r) => r.method === "GET" && r.url.searchParams.get("primary_email") === `eq.${EMAIL}`);
    assert.ok(emailLookup, "the directory is asked about the email before any write");
    assert.ok(requests.indexOf(emailLookup!) < requests.indexOf(insert));
  });

  it("falls back to the full roster when the primary-email filter finds nothing, so a secondary-email colleague is still enrolled", async () => {
    const secondary = { id: 777, primary_email: "n.hire@example.com", emails: ["n.hire@example.com", EMAIL], deactivated: false };
    let rosterReads = 0;
    const result = await createOauthEnrollment(deps({
      readUsersByPrimaryEmail: async () => [],
      readFullRoster: async () => { rosterReads += 1; return { users: [secondary], complete: true }; },
    })).enroll(EMAIL);
    assert.equal(rosterReads, 1);
    assert.equal(result.status, "enrolled");
    assert.equal((result as { greenhouseUserId: number }).greenhouseUserId, 777);
  });

  it("denies with a specific code — no Greenhouse user, two users, or a deactivated one — and writes nothing", async () => {
    const { fetchImpl, requests } = directoryFake();
    const none = await createOauthEnrollment(deps({ fetchImpl, readUsersByPrimaryEmail: async () => [] })).enroll(EMAIL);
    assert.deepEqual(none, { status: "denied", code: "email_missing", reason: "No Greenhouse user record matched this work email." });
    const two = await createOauthEnrollment(deps({ fetchImpl, readUsersByPrimaryEmail: async () => [ACTIVE_USER, { ...ACTIVE_USER, id: 999 }] })).enroll(EMAIL);
    assert.equal(two.status, "denied");
    assert.equal((two as { code: string }).code, "ambiguous");
    const inactive = await createOauthEnrollment(deps({ fetchImpl, readUsersByPrimaryEmail: async () => [{ ...ACTIVE_USER, deactivated: true }] })).enroll(EMAIL);
    assert.equal((inactive as { code: string }).code, "deactivated");
    assert.equal(requests.filter((r) => r.method === "POST").length, 0, "no denial ever writes a row");
  });

  it("treats an operator bootstrap that landed a moment earlier (same user, resolved) as already enrolled, not as a denial", async () => {
    const { fetchImpl, requests } = directoryFake({ rowsByEmail: [{ id: "row-1", greenhouse_user_id: 7100000002, primary_email: EMAIL, status: "resolved" }] });
    const result = await createOauthEnrollment(deps({ fetchImpl })).enroll(EMAIL);
    assert.deepEqual(result, { status: "enrolled", greenhouseUserId: 7100000002, alreadyEnrolled: true });
    assert.equal(requests.filter((r) => r.method === "POST").length, 0);
  });

  it("never overrides an existing directory row for the email, whatever its status", async () => {
    const { fetchImpl, requests } = directoryFake({ rowsByEmail: [{ id: "row-1", greenhouse_user_id: 7100000002, primary_email: EMAIL, status: "deactivated" }] });
    const result = await createOauthEnrollment(deps({ fetchImpl })).enroll(EMAIL);
    assert.equal(result.status, "denied");
    assert.equal((result as { code: string }).code, "directory_row_exists");
    assert.equal(requests.filter((r) => r.method === "POST").length, 0);
  });

  it("diagnoses an insert conflict on the Greenhouse user: same email + resolved = concurrent enrollment; other email = email_mismatch; deactivated = row exists", async () => {
    const concurrent = directoryFake({ insertStatus: 409, rowsByUser: [{ greenhouse_user_id: 7100000002, primary_email: EMAIL, status: "resolved" }] });
    assert.deepEqual(await createOauthEnrollment(deps({ fetchImpl: concurrent.fetchImpl })).enroll(EMAIL), { status: "enrolled", greenhouseUserId: 7100000002, alreadyEnrolled: true });
    const mismatch = directoryFake({ insertStatus: 409, rowsByUser: [{ greenhouse_user_id: 7100000002, primary_email: "old.address@example.com", status: "resolved" }] });
    assert.equal(((await createOauthEnrollment(deps({ fetchImpl: mismatch.fetchImpl })).enroll(EMAIL)) as { code: string }).code, "email_mismatch");
    const parked = directoryFake({ insertStatus: 409, rowsByUser: [{ greenhouse_user_id: 7100000002, primary_email: "old.address@example.com", status: "deactivated" }] });
    assert.equal(((await createOauthEnrollment(deps({ fetchImpl: parked.fetchImpl })).enroll(EMAIL)) as { code: string }).code, "directory_row_exists");
  });

  it("reports an outage as an error, never as a denial: Greenhouse unreachable, an incomplete roster, or a directory lookup failure", async () => {
    const greenhouseDown = await createOauthEnrollment(deps({ readUsersByPrimaryEmail: async () => { throw new Error("Greenhouse API error: 503"); } })).enroll(EMAIL);
    assert.equal(greenhouseDown.status, "error");
    const partialRoster = await createOauthEnrollment(deps({ readUsersByPrimaryEmail: async () => [], readFullRoster: async () => ({ users: [], complete: false }) })).enroll(EMAIL);
    assert.equal(partialRoster.status, "error");
    const directoryDown = await createOauthEnrollment(deps({ fetchImpl: directoryFake({ lookupStatus: 503 }).fetchImpl })).enroll(EMAIL);
    assert.equal(directoryDown.status, "error");
  });

  it("honours the opt-out flag and refuses to enroll into a non-durable (static JSON) directory", async () => {
    const disabled = await createOauthEnrollment(deps({ disabled: true })).enroll(EMAIL);
    assert.equal((disabled as { code: string }).code, "enrollment_disabled");
    const none = await createOauthEnrollmentFromEnv({ GREENHOUSE_RECRUITER_IDENTITY_JSON: "[]" } as NodeJS.ProcessEnv, { allowedDomains: ["example.com"] });
    assert.equal(none, undefined);
    const wired = await createOauthEnrollmentFromEnv({
      GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_URL: CANONICAL,
      GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_KEY: "sb_secret_service_role_key",
      GREENHOUSE_RECRUITER_OAUTH_DISABLE_AUTO_ENROLL: "true",
    } as NodeJS.ProcessEnv, { allowedDomains: ["example.com"] });
    assert.ok(wired);
    assert.equal(((await wired!.enroll(EMAIL)) as { code: string }).code, "enrollment_disabled");
  });
});
