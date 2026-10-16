import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  attestPrivateCandidates,
  parseAttestPrivateCandidatesArgs,
} from "../src/attest-private-candidates-cli.js";

const ENV = {
  GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_URL: "https://exampleprojectref000.supabase.co",
  GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_KEY: "test-service-role-key",
} as NodeJS.ProcessEnv;

interface RecordedCall {
  method: string;
  url: URL;
  body?: Record<string, unknown>;
  prefer?: string;
}

function fakeDirectory(responder: (call: RecordedCall) => unknown): {
  fetchImpl: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: URL | string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers ?? {});
    const call: RecordedCall = {
      method: init.method ?? "GET",
      url: new URL(String(input)),
      ...(init.body ? { body: JSON.parse(String(init.body)) as Record<string, unknown> } : {}),
      ...(headers.get("prefer") ? { prefer: headers.get("prefer") as string } : {}),
    };
    calls.push(call);
    const value = responder(call);
    if (value instanceof Response) return value;
    return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const RESOLVED_ROW = {
  greenhouse_user_id: 7100000001,
  primary_email: "avery.morgan@example.com",
  status: "resolved",
  private_candidates_attested: false,
  private_candidates_attested_at: null,
  private_candidates_attested_by: null,
};

describe("B7: greenhouse-recruiter-attest-private-candidates", () => {
  it("parses the documented invocation and refuses an ambiguous or under-specified one", () => {
    assert.deepEqual(
      parseAttestPrivateCandidatesArgs(["--greenhouse-user-id", "7100000001", "--by", "Avery Morgan (attested 2026-09-02)"]),
      { greenhouseUserId: 7100000001, by: "Avery Morgan (attested 2026-09-02)", clear: false }
    );
    assert.deepEqual(
      parseAttestPrivateCandidatesArgs(["--greenhouse-user-id", "7100000001", "--clear"]),
      { greenhouseUserId: 7100000001, clear: true }
    );
    assert.throws(() => parseAttestPrivateCandidatesArgs(["--by", "Avery"]), /greenhouse-user-id/);
    assert.throws(
      () => parseAttestPrivateCandidatesArgs(["--greenhouse-user-id", "1", "--email", "a@example.com", "--by", "Avery"]),
      /exactly one/i
    );
    assert.throws(() => parseAttestPrivateCandidatesArgs(["--greenhouse-user-id", "7100000001"]), /--by/);
    assert.throws(() => parseAttestPrivateCandidatesArgs(["--greenhouse-user-id", "0", "--by", "Avery"]), /positive/i);
  });

  it("records attested / at / by on exactly the one resolved row it names", async () => {
    const { fetchImpl, calls } = fakeDirectory((call) =>
      call.method === "PATCH"
        ? [{ ...RESOLVED_ROW, private_candidates_attested: true, private_candidates_attested_at: "2026-09-03T00:00:00.000Z", private_candidates_attested_by: "Avery Morgan" }]
        : [RESOLVED_ROW]
    );
    const report = await attestPrivateCandidates(
      ENV,
      ["--greenhouse-user-id", "7100000001", "--by", "Avery Morgan"],
      fetchImpl,
      () => new Date("2026-09-03T00:00:00.000Z")
    );

    assert.equal(report.status, "attested");
    assert.equal(report.before?.private_candidates_attested, false);
    assert.equal(report.after.private_candidates_attested, true);

    const patch = calls.find((call) => call.method === "PATCH");
    assert.ok(patch, "the CLI must PATCH the directory row");
    assert.equal(patch.url.searchParams.get("greenhouse_user_id"), "eq.7100000001");
    assert.equal(patch.url.searchParams.get("status"), "eq.resolved",
      "an unresolved or deactivated row must never gain an attestation");
    assert.match(patch.prefer ?? "", /return=representation/,
      "the CLI must see the rows it changed rather than trusting a 204");
    assert.deepEqual(patch.body, {
      private_candidates_attested: true,
      private_candidates_attested_at: "2026-09-03T00:00:00.000Z",
      private_candidates_attested_by: "Avery Morgan",
    });
  });

  it("--clear resets the three columns to false / null / null", async () => {
    const { fetchImpl, calls } = fakeDirectory((call) => (call.method === "PATCH" ? [RESOLVED_ROW] : [RESOLVED_ROW]));
    const report = await attestPrivateCandidates(ENV, ["--greenhouse-user-id", "7100000001", "--clear"], fetchImpl);
    assert.equal(report.status, "cleared");
    assert.deepEqual(calls.find((call) => call.method === "PATCH")?.body, {
      private_candidates_attested: false,
      private_candidates_attested_at: null,
      private_candidates_attested_by: null,
    });
  });

  it("exits non-zero unless exactly one row came back", async () => {
    for (const [label, rows] of [["zero rows", []], ["two rows", [RESOLVED_ROW, RESOLVED_ROW]]] as const) {
      const { fetchImpl } = fakeDirectory((call) => (call.method === "PATCH" ? rows : [RESOLVED_ROW]));
      await assert.rejects(
        attestPrivateCandidates(ENV, ["--greenhouse-user-id", "7100000001", "--by", "Avery"], fetchImpl),
        /exactly one/i,
        label
      );
    }
  });

  it("resolves --email to exactly one resolved row, and refuses two", async () => {
    const { fetchImpl, calls } = fakeDirectory((call) =>
      call.method === "PATCH" ? [{ ...RESOLVED_ROW, private_candidates_attested: true }] : [RESOLVED_ROW]
    );
    const report = await attestPrivateCandidates(
      ENV,
      ["--email", "Avery.Morgan@Example.com", "--by", "Avery"],
      fetchImpl
    );
    assert.equal(report.greenhouseUserId, 7100000001);
    assert.equal(
      calls[0]!.url.searchParams.get("primary_email"),
      "eq.avery.morgan@example.com",
      "the email is lowercased to match the resolved-row unique index"
    );
    assert.equal(
      calls[0]!.url.searchParams.get("status"),
      "eq.resolved",
      "primary_email is unique only among resolved rows (0001:24-26), so the lookup has to say so " +
        "or a deactivated duplicate makes a live address ambiguous"
    );

    const ambiguous = fakeDirectory(() => [RESOLVED_ROW, { ...RESOLVED_ROW, greenhouse_user_id: 7100000002 }]);
    await assert.rejects(
      attestPrivateCandidates(ENV, ["--email", "shared@example.com", "--by", "Avery"], ambiguous.fetchImpl),
      /2 resolved rows/i
    );
    assert.ok(
      !ambiguous.calls.some((call) => call.method === "PATCH"),
      "an ambiguous email must never reach a write"
    );
  });

  it("refuses a Supabase project that is not the canonical Greenhouse MCP project", async () => {
    const { fetchImpl } = fakeDirectory(() => [RESOLVED_ROW]);
    await assert.rejects(
      attestPrivateCandidates(
        { ...ENV, GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_URL: "https://otherprojectref00000.supabase.co" },
        ["--greenhouse-user-id", "7100000001", "--by", "Avery"],
        fetchImpl
      ),
      /canonical/i
    );
  });

  it("never prints the service-role key or the project it reached", async () => {
    const { fetchImpl } = fakeDirectory((call) =>
      call.method === "PATCH" ? [{ ...RESOLVED_ROW, private_candidates_attested: true }] : [RESOLVED_ROW]
    );
    const report = await attestPrivateCandidates(ENV, ["--greenhouse-user-id", "7100000001", "--by", "Avery"], fetchImpl);
    const serialized = JSON.stringify(report);
    assert.ok(!serialized.includes("test-service-role-key"), "the key must never reach the printed report");
    assert.ok(!serialized.includes("supabase.co"), "nor the project URL");
  });

  // ---------------------------------------------------------------------------
  // The directory's column overrides
  // ---------------------------------------------------------------------------

  it("honours the identity directory's table, column and status overrides", async () => {
    const { fetchImpl, calls } = fakeDirectory((call) =>
      call.method === "PATCH" ? [{ ...RESOLVED_ROW, private_candidates_attested: true }] : [RESOLVED_ROW]
    );
    await attestPrivateCandidates(
      {
        ...ENV,
        GREENHOUSE_RECRUITER_IDENTITY_TABLE: "directory_v2",
        GREENHOUSE_RECRUITER_IDENTITY_GREENHOUSE_USER_ID_COLUMN: "gh_user_id",
        GREENHOUSE_RECRUITER_IDENTITY_STATUS_COLUMN: "row_status",
        GREENHOUSE_RECRUITER_IDENTITY_RESOLVED_STATUS: "active",
      } as NodeJS.ProcessEnv,
      ["--greenhouse-user-id", "7100000001", "--by", "Avery"],
      fetchImpl
    );

    const patch = calls.find((call) => call.method === "PATCH");
    assert.ok(patch);
    assert.match(patch.url.pathname, /directory_v2$/,
      "the writer must reach the same table the reader resolves the attestation from");
    assert.equal(patch.url.searchParams.get("gh_user_id"), "eq.7100000001");
    assert.equal(patch.url.searchParams.get("row_status"), "eq.active",
      "hard-coded `status=eq.resolved` writes nothing on a directory configured with an override, " +
        "and the CLI would report success for a row it never touched");
  });
});

describe("fold 2: the CLI honours the directory's own column overrides, and counts before it filters", () => {
  it("resolves --email through the configured email column, not a hard-coded primary_email", async () => {
    const env = {
      ...ENV,
      GREENHOUSE_RECRUITER_IDENTITY_EMAIL_COLUMN: "work_email",
      GREENHOUSE_RECRUITER_IDENTITY_GREENHOUSE_USER_ID_COLUMN: "gh_user_id",
      GREENHOUSE_RECRUITER_IDENTITY_STATUS_COLUMN: "lifecycle_state",
      GREENHOUSE_RECRUITER_IDENTITY_RESOLVED_STATUS: "active",
    } as NodeJS.ProcessEnv;
    const row = {
      gh_user_id: 7100000001,
      work_email: "avery.morgan@example.com",
      lifecycle_state: "active",
      private_candidates_attested: false,
      private_candidates_attested_at: null,
      private_candidates_attested_by: null,
    };
    const { fetchImpl, calls } = fakeDirectory((call) =>
      call.method === "PATCH" ? [{ ...row, private_candidates_attested: true }] : [row]
    );
    const report = await attestPrivateCandidates(env, ["--email", "avery.morgan@example.com", "--by", "Avery"], fetchImpl);

    assert.equal(report.greenhouseUserId, 7100000001);
    assert.equal(calls[0]!.url.searchParams.get("work_email"), "eq.avery.morgan@example.com");
    assert.equal(calls[0]!.url.searchParams.get("lifecycle_state"), "eq.active");
    assert.equal(calls[0]!.url.searchParams.get("primary_email"), null,
      "a directory configured with an email override has no primary_email column to filter on");
    assert.match(calls[0]!.url.searchParams.get("select") ?? "", /work_email/);
  });

  it("refuses a PATCH response of [row, null] instead of reading it as one row", async () => {
    // The malformed element used to be FILTERED OUT before the count, so a two-element body with
    // one usable row reported success — and "how many rows did that change" is the one answer this
    // command must never guess at.
    const { fetchImpl } = fakeDirectory((call) =>
      call.method === "PATCH" ? [{ ...RESOLVED_ROW, private_candidates_attested: true }, null] : [RESOLVED_ROW]
    );
    await assert.rejects(
      attestPrivateCandidates(ENV, ["--greenhouse-user-id", "7100000001", "--by", "Avery"], fetchImpl),
      /exactly one/i
    );
  });

  it("refuses a PATCH response that is a single unusable element", async () => {
    const { fetchImpl } = fakeDirectory((call) => (call.method === "PATCH" ? [null] : [RESOLVED_ROW]));
    await assert.rejects(
      attestPrivateCandidates(ENV, ["--greenhouse-user-id", "7100000001", "--by", "Avery"], fetchImpl),
      /exactly one/i
    );
  });
});
