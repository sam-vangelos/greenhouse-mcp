import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LIMITS, createRecruiterToolConfig, createRecruiterToolLimits, isActionToolGranted, isToolEnabled, readNonNegativeFiniteNumber, resolveAnalysisWindow, sanitizeReadParams, validateRecruiterToolConfig } from "../src/limits.js";
import type { RecruiterToolConfig } from "../src/limits.js";
import { createActionToolGrant, isActionToolName, type ActionToolName } from "../src/action-tools.js";
import { PILOT_TOOL_NAMES, RECRUITER_TOOL_DEFINITIONS } from "../src/tools/register.js";

describe("recruiter tool parameter limits", () => {
  it("drops spoofable identity params across casing and separator variants", () => {
    const sanitized = sanitizeReadParams({
      status: "active",
      job_ids: "10,20",
      per_page: 500,
      actor_id: 1,
      actorId: 2,
      ACTOR_ID: 3,
      "actor-id": 4,
      actAsUser: 5,
      ActAsUser: 6,
      ACT_AS_USER: 7,
      "act-as-user-id": 8,
      on_behalf_of_user_id: 9,
      "on-behalf-of-user-id": 10,
      user_id: 11,
      userId: 12,
      USER_ID: 13,
      "user-id": 14,
      greenhouse_user_id: 15,
      greenhouseUserId: 16,
      GreenhouseUserID: 17,
      "greenhouse-user-id": 18,
      email: "spoof@example.com",
      WorkEmail: "spoof@example.com",
      "work-email": "spoof@example.com",
      USER_EMAIL: "spoof@example.com",
      recruiterEmail: "spoof@example.com",
      "authenticated-email": "spoof@example.com",
      subject: "email:spoof@example.com",
      SessionSubject: "email:spoof@example.com",
      "session-subject": "email:spoof@example.com",
      SUB: "email:spoof@example.com",
    }, DEFAULT_LIMITS);

    assert.deepStrictEqual(sanitized, {
      status: "active",
      job_ids: "10,20",
      per_page: 500,
    });
  });

  it("defaults to the v3-supported page size and a 365-day lookback (ledger #20/#40)", () => {
    assert.equal(DEFAULT_LIMITS.maxPerPage, 500);
    assert.equal(DEFAULT_LIMITS.defaultPerPage, 500);
    assert.equal(DEFAULT_LIMITS.maxLookbackDays, 365);
  });

  it("rejects malformed runtime limit env overrides instead of silently defaulting", () => {
    assert.throws(
      () => createRecruiterToolLimits({ GREENHOUSE_RECRUITER_MAX_TOOL_DURATION_MS: "0" } as NodeJS.ProcessEnv),
      /GREENHOUSE_RECRUITER_MAX_TOOL_DURATION_MS must be a positive integer/
    );
    assert.throws(
      () => createRecruiterToolLimits({ GREENHOUSE_RECRUITER_MAX_PER_PAGE: "100 " } as NodeJS.ProcessEnv),
      /GREENHOUSE_RECRUITER_MAX_PER_PAGE must be a positive integer/
    );
    assert.throws(
      () => createRecruiterToolLimits({ GREENHOUSE_RECRUITER_MAX_RANKINGS: "9007199254740993" } as NodeJS.ProcessEnv),
      /GREENHOUSE_RECRUITER_MAX_RANKINGS must be a positive integer/
    );
  });

  it("rejects malformed boolean tool-control flags instead of silently defaulting", () => {
    assert.throws(
      () => createRecruiterToolConfig({ GREENHOUSE_RECRUITER_DISABLE_ANALYTICS: " true " } as NodeJS.ProcessEnv),
      /GREENHOUSE_RECRUITER_DISABLE_ANALYTICS must be exactly "true" or "false"/
    );
    assert.throws(
      () => createRecruiterToolConfig({ GREENHOUSE_RECRUITER_DISABLE_EVIDENCE: "yes" } as NodeJS.ProcessEnv),
      /GREENHOUSE_RECRUITER_DISABLE_EVIDENCE must be exactly "true" or "false"/
    );
  });

  it("parses a fail-closed allowlist and applies it before the denylist/category switches", () => {
    const config = createRecruiterToolConfig({
      GREENHOUSE_RECRUITER_ALLOWED_TOOLS: "search_my_jobs,analyze_pipeline_quality",
      GREENHOUSE_RECRUITER_DISABLE_TOOLS: "search_my_jobs",
    } as NodeJS.ProcessEnv, ["search_my_jobs", "analyze_pipeline_quality"]);

    assert.equal(isToolEnabled(config, "test", "search_my_jobs", "evidence"), false, "denylist wins after allowlist admission");
    assert.equal(isToolEnabled(config, "test", "analyze_pipeline_quality", "analysis"), true);
    assert.equal(isToolEnabled(config, "test", "get_my_job", "evidence"), false, "not allowlisted");
  });

  it("rejects empty, duplicated, malformed, and unknown allowlist entries", () => {
    assert.throws(() => createRecruiterToolConfig({ GREENHOUSE_RECRUITER_ALLOWED_TOOLS: "" } as NodeJS.ProcessEnv), /non-empty/);
    assert.throws(() => createRecruiterToolConfig({ GREENHOUSE_RECRUITER_ALLOWED_TOOLS: "search_my_jobs,search_my_jobs" } as NodeJS.ProcessEnv), /duplicate/);
    assert.throws(() => createRecruiterToolConfig({ GREENHOUSE_RECRUITER_ALLOWED_TOOLS: "search_my_jobs," } as NodeJS.ProcessEnv), /non-empty/);
    assert.throws(
      () => createRecruiterToolConfig({ GREENHOUSE_RECRUITER_ALLOWED_TOOLS: "not_a_tool" } as NodeJS.ProcessEnv, ["search_my_jobs"]),
      /unknown tool name/
    );
  });

  it("does not honor unsafe model-supplied positive integers", () => {
    const sanitized = sanitizeReadParams({ per_page: "9007199254740993" }, DEFAULT_LIMITS);

    assert.equal(sanitized.per_page, DEFAULT_LIMITS.defaultPerPage);
  });

  it("parses only finite non-negative analysis numbers", () => {
    assert.equal(readNonNegativeFiniteNumber(2.5), 2.5);
    assert.equal(readNonNegativeFiniteNumber("2.5"), 2.5);
    assert.equal(readNonNegativeFiniteNumber(0), 0);
    assert.equal(readNonNegativeFiniteNumber("0"), 0);
    assert.equal(readNonNegativeFiniteNumber(Number.POSITIVE_INFINITY), null);
    assert.equal(readNonNegativeFiniteNumber(Number.NaN), null);
    assert.equal(readNonNegativeFiniteNumber(-1), null);
    assert.equal(readNonNegativeFiniteNumber("1 "), null);
    assert.equal(readNonNegativeFiniteNumber("9".repeat(65)), null);
  });

  it("resolves analysis windows from clean ISO-like dates only", () => {
    assert.deepStrictEqual(resolveAnalysisWindow({}, () => Date.parse("2026-06-23T12:00:00.000Z"), 30), {
      windowStart: "2026-05-24T12:00:00.000Z",
      windowEnd: "2026-06-23T12:00:00.000Z",
    });
    assert.deepStrictEqual(resolveAnalysisWindow({
      window_start: "2026-06-01T00:00:00.000Z",
      window_end: "2026-06-23T12:00:00.000Z",
    }, () => Date.parse("2026-06-24T00:00:00.000Z"), 30), {
      windowStart: "2026-06-01T00:00:00.000Z",
      windowEnd: "2026-06-23T12:00:00.000Z",
    });

    assert.throws(
      () => resolveAnalysisWindow({ window_end: "not-a-date" }, () => Date.parse("2026-06-23T12:00:00.000Z"), 30),
      /valid window_start and window_end/
    );
    assert.throws(
      () => resolveAnalysisWindow({ window_start: " 2026-06-01T00:00:00.000Z" }, () => Date.parse("2026-06-23T12:00:00.000Z"), 30),
      /valid window_start and window_end/
    );
    assert.throws(
      () => resolveAnalysisWindow({ window_start: "June 1, 2026" }, () => Date.parse("2026-06-23T12:00:00.000Z"), 30),
      /valid window_start and window_end/
    );
  });

  it("drops unsafe numeric read params before scoped Greenhouse reads", () => {
    const sanitized = sanitizeReadParams({
      id: 123,
      stage_ids: 7,
      source_ids: 0,
      candidate_ids: -1,
      application_ids: 1.5,
      job_ids: Number.POSITIVE_INFINITY,
      ids: Number.NaN,
      referrer_ids: Number.MAX_SAFE_INTEGER + 1,
      per_page: 25,
    }, DEFAULT_LIMITS, {
      allowedParamNames: new Set([
        "id",
        "stage_ids",
        "source_ids",
        "candidate_ids",
        "application_ids",
        "job_ids",
        "ids",
        "referrer_ids",
        "per_page",
      ]),
    });

    assert.deepStrictEqual(sanitized, {
      id: 123,
      stage_ids: 7,
      per_page: 25,
    });
  });

  it("normalizes only exact positive safe integer id-list read params", () => {
    const sanitized = sanitizeReadParams({
      id: "00123",
      job_ids: "10, 020",
      ids: "1,,2",
      application_ids: "101,0",
      candidate_ids: "501,not-a-number",
      stage_ids: "9007199254740993",
      source_ids: "3,4",
      referrer_ids: "7\t,8",
      per_page: 25,
    }, DEFAULT_LIMITS, {
      allowedParamNames: new Set([
        "id",
        "job_ids",
        "ids",
        "application_ids",
        "candidate_ids",
        "stage_ids",
        "source_ids",
        "referrer_ids",
        "per_page",
      ]),
    });

    assert.deepStrictEqual(sanitized, {
      id: "123",
      job_ids: "10,20",
      source_ids: "3,4",
      per_page: 25,
    });
  });

  it("drops scalar params that are not explicitly allowlisted", () => {
    const sanitized = sanitizeReadParams({
      status: "active",
      job_ids: "10,20",
      detail_profile: "contact",
      include_attachment_urls: true,
      reason: "debug export",
      foo: "bar",
      nested: { unsafe: true },
      per_page: 1000,
    }, DEFAULT_LIMITS, { allowedParamNames: new Set(["status", "job_ids", "per_page"]) });

    assert.deepStrictEqual(sanitized, {
      status: "active",
      job_ids: "10,20",
      per_page: 500,
    });
  });

  it("drops unsafe string params before forwarding read filters", () => {
    const sanitized = sanitizeReadParams({
      status: "active",
      stage_name: "Recruiter Screen",
      created_at: "gte|2026-06-01T00:00:00.000Z",
      job_ids: "10,20",
      ids: "123\n456",
      application_ids: " 101,102",
      candidate_ids: "501,502 ",
      source_ids: "x".repeat(2049),
      referrer_ids: "",
      per_page: "25",
    }, DEFAULT_LIMITS, {
      allowedParamNames: new Set([
        "cursor",
        "status",
        "stage_name",
        "created_at",
        "job_ids",
        "ids",
        "application_ids",
        "candidate_ids",
        "source_ids",
        "referrer_ids",
        "per_page",
      ]),
    });

    assert.deepStrictEqual(sanitized, {
      status: "active",
      stage_name: "Recruiter Screen",
      created_at: "gte|2026-06-01T00:00:00.000Z",
      job_ids: "10,20",
      per_page: 25,
    });
  });

  it("does not add pagination when per_page is not allowlisted", () => {
    const sanitized = sanitizeReadParams({ id: 123, per_page: 5 }, DEFAULT_LIMITS, {
      allowedParamNames: new Set(["id"]),
    });

    assert.deepStrictEqual(sanitized, { id: 123 });
  });
});

describe("cursor pagination parameter handling", () => {
  it("passes a cursor read through with the cursor as the only param (no per_page injected)", () => {
    const sanitized = sanitizeReadParams({ cursor: "abc123" }, DEFAULT_LIMITS, {
      allowedParamNames: new Set(["cursor", "per_page", "status"]),
    });
    // Regression lock for the UPSTREAM_ERROR pagination bug: Greenhouse v3 rejects
    // a cursor request that carries any other query param, so per_page must NOT ride along.
    assert.deepStrictEqual(sanitized, { cursor: "abc123" });
  });

  it("drops per_page and filters when a cursor is present", () => {
    const sanitized = sanitizeReadParams(
      { cursor: "abc123", per_page: 50, status: "open", job_ids: "10,20" },
      DEFAULT_LIMITS,
      { allowedParamNames: new Set(["cursor", "per_page", "status", "job_ids"]) }
    );
    assert.deepStrictEqual(sanitized, { cursor: "abc123" });
  });

  it("still applies the per_page cap on the first (cursor-less) page", () => {
    const sanitized = sanitizeReadParams({ per_page: 5000 }, DEFAULT_LIMITS, {
      allowedParamNames: new Set(["cursor", "per_page"]),
    });
    assert.deepStrictEqual(sanitized, { per_page: DEFAULT_LIMITS.maxPerPage });
  });
});

// One endpoint has to serve both planes, so a write-entitled session must see names the env allowlist
// does not carry — and a session without an entitlement must see the base catalog byte for byte, because
// readiness.ts:530-563 and container-self-check.ts:71-80 both fail the service if it drifts. Grants are
// the seam, and "additive only" is the property that lets both be true at once. These lock it.
describe("per-session tool grants", () => {
  const KNOWN_READ_TOOLS = RECRUITER_TOOL_DEFINITIONS.map((tool) => tool.name);
  // A real action-plane name, not a placeholder: action-mcp/src/actions/application-stage-move.ts:74 on
  // branch codex/greenhouse-action-mcp. It is deliberately absent from RECRUITER_TOOL_DEFINITIONS — that
  // absence is the whole point, since it is what the allowlist and the validator would each reject.
  const ACTION_TOOL = "preview_application_stage_move";
  // One of the 22 source readers the curated catalog withholds (register.ts:42). Computed, not spelled,
  // so the test follows the catalog if a reader is promoted into PILOT_TOOL_NAMES — and fails loudly with
  // a reason if the catalog ever stops withholding one, since that would silently gut these assertions.
  const PILOT_NAME_SET = new Set<string>(PILOT_TOOL_NAMES);
  const WITHHELD_READ = ((): string => {
    const name = KNOWN_READ_TOOLS.find((toolName) => !PILOT_NAME_SET.has(toolName));
    if (!name) throw new Error("catalog no longer withholds a source reader; pick another name the allowlist excludes");
    return name;
  })();

  function pilotConfig(overrides: Record<string, string> = {}): RecruiterToolConfig {
    return createRecruiterToolConfig(
      { GREENHOUSE_RECRUITER_ALLOWED_TOOLS: PILOT_TOOL_NAMES.join(","), ...overrides } as NodeJS.ProcessEnv,
      KNOWN_READ_TOOLS
    );
  }

  /**
   * A FORGED grant, carrying names the type forbids. `grantedTools` is `ReadonlySet<ActionToolName>`,
   * so `WITHHELD_READ` cannot be put in one without this cast — which is exactly why the cast belongs
   * here. The type stops an honest mistake at compile time; these tests prove the RUNTIME guard also
   * holds for the paths a type cannot reach: a Phase-2 `as`, a JS caller, a grant rehydrated from JSON.
   */
  function forgedGrant(...names: string[]): ReadonlySet<ActionToolName> {
    return new Set(names) as unknown as ReadonlySet<ActionToolName>;
  }

  it("keeps every read tool out of reach of the action-name shape a grant is bound to", () => {
    // The property that makes "grants admit only action names" equivalent to "grants cannot expose a
    // withheld read". If a read tool were ever named preview_*/apply_*, the shape constraint would stop
    // being a boundary and this would fail rather than silently weaken every assertion below.
    const shapedLikeAnAction = KNOWN_READ_TOOLS.filter((name) => isActionToolName(name));
    assert.deepStrictEqual(shapedLikeAnAction, [], "a read tool now collides with the write plane's naming shape");
    assert.equal(isActionToolName(ACTION_TOOL), true);
    assert.equal(isActionToolName(WITHHELD_READ), false);
  });

  it("refuses to build a grant out of anything but action tools", () => {
    assert.deepStrictEqual(
      [...createActionToolGrant([ACTION_TOOL, "apply_offer_create"])],
      [ACTION_TOOL, "apply_offer_create"]
    );
    assert.throws(() => createActionToolGrant([ACTION_TOOL, WITHHELD_READ]), /admit write-plane action tools only/);
    // Neither a bare verb nor a shouted name is something the action package can emit.
    assert.throws(() => createActionToolGrant(["preview_"]), /action tools only/);
    assert.throws(() => createActionToolGrant(["apply_Offer_Create"]), /action tools only/);
  });

  it("admits an action name the allowlist rejects, and never a withheld read", () => {
    const base = pilotConfig();

    assert.equal(isToolEnabled(base, "claude_desktop", ACTION_TOOL, "analysis"), false, "an unentitled session must not see an action tool");
    assert.equal(isToolEnabled(base, "claude_desktop", WITHHELD_READ, "evidence"), false, "a withheld source reader stays withheld without a grant");

    const granted: RecruiterToolConfig = { ...base, grantedTools: createActionToolGrant([ACTION_TOOL]) };
    assert.equal(isToolEnabled(granted, "claude_desktop", ACTION_TOOL, "analysis"), true, "a grant must admit its action tool");
    assert.equal(isActionToolGranted(granted, "claude_desktop", ACTION_TOOL), true);

    // The property the previous version of this test had backwards. A grant is not a key to the 22
    // withheld readers, and forging one to name a read must change nothing.
    const forged: RecruiterToolConfig = { ...base, grantedTools: forgedGrant(ACTION_TOOL, WITHHELD_READ) };
    assert.equal(isToolEnabled(forged, "claude_desktop", WITHHELD_READ, "evidence"), false, "a grant must NOT expose a withheld read");
    assert.equal(isActionToolGranted(forged, "claude_desktop", WITHHELD_READ), false, "the direct gate must NOT admit a withheld read either");
  });

  it("never withdraws a name the allowlist already admitted, and adds none to the read catalog", () => {
    const base = pilotConfig();
    const granted: RecruiterToolConfig = { ...base, grantedTools: forgedGrant(ACTION_TOOL, WITHHELD_READ) };

    for (const surface of ["claude_desktop", "chatgpt_desktop", "test"] as const) {
      const before = RECRUITER_TOOL_DEFINITIONS.filter((tool) => isToolEnabled(base, surface, tool.name, tool.kind)).map((tool) => tool.name);
      const after = RECRUITER_TOOL_DEFINITIONS.filter((tool) => isToolEnabled(granted, surface, tool.name, tool.kind)).map((tool) => tool.name);
      const afterSet = new Set(after);
      const beforeSet = new Set(before);

      assert.deepStrictEqual(before.filter((name) => !afterSet.has(name)), [], `grants removed tools on ${surface}`);
      assert.deepStrictEqual(after.filter((name) => !beforeSet.has(name)), [], `grants added a read tool on ${surface}`);
    }
  });

  it("loses to the disable list, the category switches, and the server kill switch", () => {
    const denied = pilotConfig({ GREENHOUSE_RECRUITER_DISABLE_TOOLS: `${ACTION_TOOL},search_my_jobs` });
    const deniedGrant: RecruiterToolConfig = { ...denied, grantedTools: forgedGrant(ACTION_TOOL, "search_my_jobs") };
    assert.equal(isToolEnabled(deniedGrant, "claude_desktop", ACTION_TOOL, "analysis"), false, "a grant must not admit a denied name");
    assert.equal(isToolEnabled(deniedGrant, "claude_desktop", "search_my_jobs", "evidence"), false, "a grant must not resurrect a denied read");

    const analyticsOff = pilotConfig({ GREENHOUSE_RECRUITER_DISABLE_ANALYTICS: "true" });
    assert.equal(
      isToolEnabled({ ...analyticsOff, grantedTools: createActionToolGrant([ACTION_TOOL]) }, "claude_desktop", ACTION_TOOL, "analysis"),
      false,
      "a grant must not bypass a category switch"
    );

    const off = pilotConfig({ GREENHOUSE_RECRUITER_MCP_DISABLED: "true" });
    assert.equal(
      isToolEnabled({ ...off, grantedTools: createActionToolGrant([ACTION_TOOL]) }, "claude_desktop", ACTION_TOOL, "analysis"),
      false,
      "a grant must not survive the whole-server kill switch"
    );
  });

  it("does not throw when an allowlist carries a granted name outside the read catalog", () => {
    const base = pilotConfig();
    // What Phase 2 does when it merges a session's entitlement into the visible set. Unhandled, this
    // throws on the request path (register.ts:197) and the caller gets an opaque 500 (http-server.ts:90-99).
    const composed: RecruiterToolConfig = {
      ...base,
      allowedTools: new Set([...base.allowedTools!, ACTION_TOOL]),
      grantedTools: createActionToolGrant([ACTION_TOOL]),
    };
    assert.doesNotThrow(() => validateRecruiterToolConfig(composed, KNOWN_READ_TOOLS));

    // Still loud for a name that is neither known nor granted — this tolerance is for entitlement, not
    // for typos in GREENHOUSE_RECRUITER_ALLOWED_TOOLS.
    assert.throws(
      () => validateRecruiterToolConfig(
        { ...composed, allowedTools: new Set([...composed.allowedTools!, "apply_offer_create"]) },
        KNOWN_READ_TOOLS
      ),
      /unknown tool name\(s\): apply_offer_create/
    );
  });

  // Characterization, NOT an endorsement: this is the trap documented on isToolEnabled. With no allowlist
  // configured the membership test short-circuits and every name enables, entitlement or none — so Phase 2
  // must gate action-tool registration on grantedTools itself rather than trusting this predicate. If
  // someone later makes it fail closed, this test fails and points at that decision.
  it("enables any name at all when no allowlist is configured, granted or not", () => {
    const noAllowlist = createRecruiterToolConfig({} as NodeJS.ProcessEnv, KNOWN_READ_TOOLS);

    assert.equal(noAllowlist.allowedTools, undefined);
    assert.equal(isToolEnabled(noAllowlist, "claude_desktop", ACTION_TOOL, "analysis"), true, "fail-open: an unentitled session already passes this gate");
    assert.equal(isToolEnabled(noAllowlist, "claude_desktop", "not_a_tool_anywhere", "evidence"), true);
  });

  // The counterpart to the characterization above, and the reason it is safe to leave that fail-open
  // in place: action registration does NOT go through isToolEnabled. runtime.ts:93 (`createRecruiterToolConfig({})`)
  // and probe.ts:115 (`allowedTools: undefined`) both produce exactly the config the previous test
  // describes, and this gate denies in it.
  it("gives action registration a direct-membership gate that does not fail open", () => {
    const noAllowlist = createRecruiterToolConfig({} as NodeJS.ProcessEnv, KNOWN_READ_TOOLS);

    assert.equal(noAllowlist.allowedTools, undefined);
    assert.equal(isActionToolGranted(noAllowlist, "claude_desktop", ACTION_TOOL), false, "no grant, no write plane — allowlist or not");
    assert.equal(isActionToolGranted(noAllowlist, "claude_desktop", WITHHELD_READ), false);
    assert.equal(isActionToolGranted(noAllowlist, "claude_desktop", "not_a_tool_anywhere"), false);

    const granted: RecruiterToolConfig = { ...noAllowlist, grantedTools: createActionToolGrant([ACTION_TOOL]) };
    assert.equal(isActionToolGranted(granted, "claude_desktop", ACTION_TOOL), true, "a grant is the only thing that admits an action tool");
    assert.equal(isActionToolGranted(granted, "claude_desktop", "apply_offer_create"), false, "a grant admits ONLY the names it carries");
  });

  it("holds the denylist, the surface switches, and the kill switch over a granted action tool", () => {
    const grant = createActionToolGrant([ACTION_TOOL]);
    const config = (overrides: Record<string, string> = {}): RecruiterToolConfig => ({
      ...pilotConfig(overrides),
      grantedTools: grant,
    });

    assert.equal(isActionToolGranted(config(), "claude_desktop", ACTION_TOOL), true);
    assert.equal(
      isActionToolGranted(config({ GREENHOUSE_RECRUITER_DISABLE_TOOLS: ACTION_TOOL }), "claude_desktop", ACTION_TOOL),
      false,
      "the denylist must win over a grant here too"
    );
    assert.equal(
      isActionToolGranted(config({ GREENHOUSE_RECRUITER_DISABLE_CLAUDE_DESKTOP: "true" }), "claude_desktop", ACTION_TOOL),
      false,
      "a disabled surface must not receive the write plane"
    );
    assert.equal(
      isActionToolGranted(config({ GREENHOUSE_RECRUITER_DISABLE_CHATGPT_DESKTOP: "true" }), "chatgpt_desktop", ACTION_TOOL),
      false
    );
    assert.equal(
      isActionToolGranted(config({ GREENHOUSE_RECRUITER_MCP_DISABLED: "true" }), "claude_desktop", ACTION_TOOL),
      false,
      "the whole-server kill switch must reach the write plane"
    );
    // The read-plane category switches are deliberately NOT consulted: an action tool is neither
    // `evidence` nor `analysis`, and turning off the analyzers is not a statement about writes.
    assert.equal(
      isActionToolGranted(config({ GREENHOUSE_RECRUITER_DISABLE_ANALYTICS: "true", GREENHOUSE_RECRUITER_DISABLE_EVIDENCE: "true" }), "claude_desktop", ACTION_TOOL),
      true
    );
  });
});

// Head-of-TA deep-dive finding (2026-07-02): the whole-tool deadline defaulted to 300s — ABOVE the
// MCP client's ~240s transport budget — so a heavy bridged read (scope over 2,982 applications =
// ~120 batched upstream reads) died as client-side dead air 60 seconds BEFORE the server would
// have truncated honestly. The honesty machinery only works if it fires while a client is still
// listening: the default must sit comfortably under the client budget.
describe("analysis deadline sits under the MCP client transport budget", () => {
  it("default maxAnalysisDurationMs leaves the client margin to receive the honest-incomplete result", () => {
    const CLIENT_TRANSPORT_BUDGET_MS = 240_000;
    assert.ok(
      DEFAULT_LIMITS.maxAnalysisDurationMs! <= CLIENT_TRANSPORT_BUDGET_MS - 60_000,
      `deadline ${DEFAULT_LIMITS.maxAnalysisDurationMs} must be at least 60s under the ~240s client budget`
    );
  });
});
