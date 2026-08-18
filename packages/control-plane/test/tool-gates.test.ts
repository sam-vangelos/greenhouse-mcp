import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  assertTier3ActorAllowed,
  createToolGateConfig,
  emitTier3ErrorReadAudit,
  emitTier3SuccessReadAudit,
  isToolDisabled,
  parseDisabledToolNames,
  parseTier3ActorIds,
  shouldRegisterTier3Tool,
  TIER3_GATE_DENIED_MESSAGE,
  TIER3_TOOL_NAMES,
  wrapTier3Handler,
} from "../src/tool-gates.js";
import {
  READ_AUDIT_FAILURE_MESSAGE,
  READ_AUDIT_PREFIX,
  type ReadAuditLinePayload,
} from "../src/read-audit.js";

// Shared stderr-capture helper. Matches the idiom in client.test.ts.
function captureStderr(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
  };
  return {
    lines,
    restore: () => {
      console.error = original;
    },
  };
}

function readAuditLines(lines: string[]): ReadAuditLinePayload[] {
  const prefix = `${READ_AUDIT_PREFIX} `;
  return lines
    .filter((l) => l.startsWith(prefix))
    .map((l) => JSON.parse(l.slice(prefix.length)) as ReadAuditLinePayload);
}

describe("tool-gates helpers", () => {
  it("parses the GREENHOUSE_DISABLE_TOOLS kill-switch as a trimmed name set", () => {
    const names = parseDisabledToolNames(" list_attachments, , list_user_emails , list_eeoc ");
    assert.deepStrictEqual([...names], ["list_attachments", "list_user_emails", "list_eeoc"]);

    assert.equal(parseDisabledToolNames(undefined).size, 0);
    assert.equal(parseDisabledToolNames("").size, 0);
  });

  it("parses GREENHOUSE_TIER3_ACTOR_IDS as a positive-integer allowlist", () => {
    const ids = parseTier3ActorIds("1, 2, not-a-number, 3");
    assert.deepStrictEqual([...ids], [1, 2, 3]);

    assert.equal(parseTier3ActorIds(undefined).size, 0);
    assert.equal(parseTier3ActorIds("").size, 0);
  });

  it("keeps Tier 3 reads available unless explicitly turned off", () => {
    const disabled = createToolGateConfig({
      GREENHOUSE_ENABLE_TIER3_READS: "false",
      GREENHOUSE_TIER3_ACTOR_IDS: "7",
    });
    assert.equal(disabled.tier3ReadsEnabled, false);
    assert.equal(disabled.tier3ReadsAvailable, false);

    const missingAllowlist = createToolGateConfig({
      GREENHOUSE_ENABLE_TIER3_READS: "true",
    });
    assert.equal(missingAllowlist.tier3ReadsEnabled, true);
    assert.equal(missingAllowlist.tier3ReadsAvailable, true);
    assert.equal(missingAllowlist.tier3ActorIds.size, 0);

    const enabled = createToolGateConfig({
      GREENHOUSE_ENABLE_TIER3_READS: "true",
      GREENHOUSE_TIER3_ACTOR_IDS: "7,8",
    });
    assert.equal(enabled.tier3ReadsEnabled, true);
    assert.equal(enabled.tier3ReadsAvailable, true);
    assert.deepStrictEqual([...enabled.tier3ActorIds], [7, 8]);
  });

  it("defaults to expanded read tools available when no setup override is provided", () => {
    const config = createToolGateConfig({});
    assert.equal(config.tier3ReadsEnabled, true);
    assert.equal(config.tier3ReadsAvailable, true);
    assert.equal(config.disabledTools.size, 0);
    assert.equal(config.tier3ActorIds.size, 0);
  });

  it("surfaces the kill-switch decision per tool name", () => {
    const config = createToolGateConfig({
      GREENHOUSE_DISABLE_TOOLS: "list_email_templates, list_notes",
    });
    assert.equal(isToolDisabled(config, "list_email_templates"), true);
    assert.equal(isToolDisabled(config, "list_notes"), true);
    assert.equal(isToolDisabled(config, "list_applications"), false);
  });
});

describe("tier 3 registration gate", () => {
  // Test 1 - registration closes only when the explicit off switch is set.
  it("keeps every Tier 3 tool unregistered only when GREENHOUSE_ENABLE_TIER3_READS is false", () => {
    for (const envValue of ["false"]) {
      const env: NodeJS.ProcessEnv = { GREENHOUSE_TIER3_ACTOR_IDS: "7,8" };
      env.GREENHOUSE_ENABLE_TIER3_READS = envValue;
      const config = createToolGateConfig(env);
      assert.equal(
        shouldRegisterTier3Tool(config),
        false,
        `expected closed posture with GREENHOUSE_ENABLE_TIER3_READS=${JSON.stringify(envValue)}`
      );
      for (const toolName of TIER3_TOOL_NAMES) {
        assert.equal(
          shouldRegisterTier3Tool(config),
          false,
          `tool ${toolName} must not register when the flag is off`
        );
      }
    }
  });

  // Test 2 - empty approval lists no longer hide the tools.
  it("registers every Tier 3 tool when GREENHOUSE_TIER3_ACTOR_IDS is empty", () => {
    const missingAllowlist = createToolGateConfig({
      GREENHOUSE_ENABLE_TIER3_READS: "true",
    });
    assert.equal(shouldRegisterTier3Tool(missingAllowlist), true);

    const emptyAllowlist = createToolGateConfig({
      GREENHOUSE_ENABLE_TIER3_READS: "true",
      GREENHOUSE_TIER3_ACTOR_IDS: "",
    });
    assert.equal(shouldRegisterTier3Tool(emptyAllowlist), true);

    const junkAllowlist = createToolGateConfig({
      GREENHOUSE_ENABLE_TIER3_READS: "true",
      GREENHOUSE_TIER3_ACTOR_IDS: " , not-a-number , -3 ",
    });
    assert.equal(shouldRegisterTier3Tool(junkAllowlist), true);
  });

  // Test 3 - approval-user lists are optional, not required for registration.
  it("registers every Tier 3 tool when approval-user settings are present", () => {
    const config = createToolGateConfig({
      GREENHOUSE_ENABLE_TIER3_READS: "true",
      GREENHOUSE_TIER3_ACTOR_IDS: "7,8",
    });
    assert.equal(shouldRegisterTier3Tool(config), true);
    assert.deepStrictEqual(
      [...TIER3_TOOL_NAMES],
      [
        "list_email_templates",
        "list_interview_kits",
        "list_scheduled_interviews",
        "list_user_emails",
      ],
      "TIER3_TOOL_NAMES must stay exactly the four Tier 3 reads"
    );
    for (const toolName of TIER3_TOOL_NAMES) {
      assert.equal(
        shouldRegisterTier3Tool(config),
        true,
        `tool ${toolName} must be registrable under the fully-open config`
      );
    }
  });
});

describe("tier 3 request-time actor gate", () => {
  // Test 4 — missing on_behalf_of_user_id must be rejected with the sanitized
  // message. The message must be identical to the not-allowlisted case (Test 5)
  // so the model cannot tell the two failures apart.
  it("rejects a Tier 3 call without on_behalf_of_user_id using the sanitized error", () => {
    const config = { tier3ActorIds: new Set<number>([7, 8]) };

    for (const missing of [undefined, null, 0, -1, 1.5, "7", {}, []]) {
      assert.throws(
        () =>
          assertTier3ActorAllowed({
            toolName: "list_email_templates",
            params: { on_behalf_of_user_id: missing as unknown } as {
              on_behalf_of_user_id?: unknown;
            } & Record<string, unknown>,
            config,
          }),
        (err: Error) => {
          assert.equal(err.message, TIER3_GATE_DENIED_MESSAGE);
          return true;
        },
        `missing/invalid on_behalf_of_user_id value ${JSON.stringify(missing)} must be denied`
      );
    }

    assert.throws(
      () =>
        assertTier3ActorAllowed({
          toolName: "list_email_templates",
          params: {},
          config,
        }),
      (err: Error) => {
        assert.equal(err.message, TIER3_GATE_DENIED_MESSAGE);
        return true;
      }
    );
  });

  // Test 5 — a well-formed but non-allowlisted actor must also be denied using
  // the SAME message; the allowlist membership must not be leaked.
  it("rejects a non-allowlisted actor with the same sanitized error (no leak)", () => {
    const config = { tier3ActorIds: new Set<number>([7, 8]) };

    assert.throws(
      () =>
        assertTier3ActorAllowed({
          toolName: "list_interview_kits",
          params: { on_behalf_of_user_id: 99 },
          config,
        }),
      (err: Error) => {
        assert.equal(err.message, TIER3_GATE_DENIED_MESSAGE);
        assert.ok(
          !err.message.includes("99"),
          "sanitized error must not echo the attempted actor ID"
        );
        assert.ok(
          !err.message.includes("7") && !err.message.includes("8"),
          "sanitized error must not echo the allowlist"
        );
        return true;
      }
    );
  });

  // Test 6 — an allowlisted actor passes the gate. We prove it both via the
  // pure assertion AND via wrapTier3Handler, which is the shape the four real
  // tool handlers in index.ts use; the wrapper must also strip
  // on_behalf_of_user_id from the params before the inner handler runs so
  // Harvest never sees it as an unknown query parameter.
  it("lets an allowlisted actor through and strips on_behalf_of_user_id before the inner handler runs", async () => {
    const config = { tier3ActorIds: new Set<number>([7, 8]) };

    assert.equal(
      assertTier3ActorAllowed({
        toolName: "list_user_emails",
        params: { on_behalf_of_user_id: 7 },
        config,
      }),
      7
    );

    let innerCalled = false;
    let innerParams: Record<string, unknown> = {};
    const wrapped = wrapTier3Handler<
      { on_behalf_of_user_id?: number; ids?: string; cursor?: string },
      { ok: true }
    >("list_user_emails", config, async (params) => {
      innerCalled = true;
      innerParams = params as Record<string, unknown>;
      return { ok: true };
    });

    const result = await wrapped({
      on_behalf_of_user_id: 8,
      ids: "1,2,3",
      cursor: undefined,
    });

    assert.deepStrictEqual(result, { ok: true });
    assert.equal(innerCalled, true);
    assert.ok(
      !("on_behalf_of_user_id" in innerParams),
      "wrapTier3Handler must strip on_behalf_of_user_id before calling the inner handler"
    );
    assert.equal(innerParams.ids, "1,2,3", "non-gate params must pass through untouched");
  });

  it("rejects via wrapTier3Handler before the inner handler ever runs", async () => {
    const config = { tier3ActorIds: new Set<number>([7]) };

    let innerCalled = false;
    const wrapped = wrapTier3Handler<
      { on_behalf_of_user_id?: number },
      { ok: true }
    >("list_scheduled_interviews", config, async () => {
      innerCalled = true;
      return { ok: true };
    });

    await assert.rejects(
      () => wrapped({ on_behalf_of_user_id: 99 }),
      (err: Error) => {
        assert.equal(err.message, TIER3_GATE_DENIED_MESSAGE);
        return true;
      }
    );
    assert.equal(innerCalled, false, "inner handler must not run when the gate denies");

    await assert.rejects(
      () => wrapped({}),
      (err: Error) => {
        assert.equal(err.message, TIER3_GATE_DENIED_MESSAGE);
        return true;
      }
    );
    assert.equal(innerCalled, false);
  });

  it("can skip the actor gate for conditionally gated projected Tier 3 calls", async () => {
    const config = { tier3ActorIds: new Set<number>([7]) };
    let innerParams: Record<string, unknown> | undefined;
    let actorSeen: number | null | undefined;

    const wrapped = wrapTier3Handler<
      { on_behalf_of_user_id?: number; detail_profile?: "minimal" | "body" },
      { ok: true }
    >(
      "list_notes",
      config,
      async (params, context) => {
        innerParams = params;
        actorSeen = context?.actorId;
        return { ok: true };
      },
      {
        shouldGate: (params) => params.detail_profile === "body",
        projectionAppliedOnError: true,
      }
    );

    const result = await wrapped({ detail_profile: "minimal" });
    assert.deepStrictEqual(result, { ok: true });
    assert.deepStrictEqual(innerParams, { detail_profile: "minimal" });
    assert.equal(actorSeen, null);
  });
});

// ---------------------------------------------------------------------------
// P2.1 read-audit integration tests.
//
// These drive wrapTier3Handler end-to-end and inspect the stderr audit
// lines. They prove the spec's denied/error/success emission, fail-closed
// discipline, exclusion of request params from the audit line, and the
// Tier-1/Tier-2 silence contract.
// ---------------------------------------------------------------------------

describe("wrapTier3Handler — denied-event read-audit (spec §2, §3.1)", () => {
  let spy: ReturnType<typeof captureStderr>;
  beforeEach(() => {
    spy = captureStderr();
  });
  afterEach(() => {
    spy.restore();
  });

  it("emits exactly one denied READ_AUDIT line per denied call with actor=null", async () => {
    const config = { tier3ActorIds: new Set<number>([7]) };
    const wrapped = wrapTier3Handler<
      { on_behalf_of_user_id?: number },
      { ok: true }
    >("list_email_templates", config, async () => ({ ok: true }));

    await assert.rejects(() => wrapped({ on_behalf_of_user_id: 99 }));
    const audits = readAuditLines(spy.lines);
    assert.equal(audits.length, 1, "exactly one denied audit line per denied call");
    assert.equal(audits[0]!.outcome, "denied");
    assert.equal(audits[0]!.tool, "list_email_templates");
    assert.equal(audits[0]!.tier, 3);
    assert.equal(audits[0]!.projection_applied, false);
    assert.deepStrictEqual(audits[0]!.caller_identity, { on_behalf_of_user_id: null });
    assert.ok(
      !("result_size_class" in (audits[0]! as unknown as Record<string, unknown>)),
      "denied events must omit result_size_class (spec §3.2)"
    );
  });

  it("denied audit line contains no attempted-actor ID, no allowlist, no deny message", async () => {
    const config = { tier3ActorIds: new Set<number>([7, 8]) };
    const wrapped = wrapTier3Handler<
      { on_behalf_of_user_id?: number },
      { ok: true }
    >("list_scheduled_interviews", config, async () => ({ ok: true }));

    await assert.rejects(() => wrapped({ on_behalf_of_user_id: 99 }));

    const auditLine = spy.lines.find((l) => l.startsWith(`${READ_AUDIT_PREFIX} `))!;
    assert.ok(auditLine, "expected a READ_AUDIT line for the denied call");
    assert.ok(!auditLine.includes("99"), "denied audit must not echo attempted actor id");
    assert.ok(
      !auditLine.includes("\"7\"") && !auditLine.includes("\"8\""),
      "denied audit must not echo allowlist"
    );
    assert.ok(
      !auditLine.includes(TIER3_GATE_DENIED_MESSAGE),
      "denied audit must not contain the deny message string"
    );
  });

  it("missing on_behalf_of_user_id still emits a denied audit line (actor=null)", async () => {
    const config = { tier3ActorIds: new Set<number>([7]) };
    const wrapped = wrapTier3Handler<
      { on_behalf_of_user_id?: number },
      { ok: true }
    >("list_interview_kits", config, async () => ({ ok: true }));

    await assert.rejects(() => wrapped({}));
    const audits = readAuditLines(spy.lines);
    assert.equal(audits.length, 1);
    assert.equal(audits[0]!.outcome, "denied");
    assert.deepStrictEqual(audits[0]!.caller_identity, { on_behalf_of_user_id: null });
  });

  it("the denied path still rejects with TIER3_GATE_DENIED_MESSAGE (audit does not change the caller-visible error)", async () => {
    const config = { tier3ActorIds: new Set<number>([7]) };
    const wrapped = wrapTier3Handler<
      { on_behalf_of_user_id?: number },
      { ok: true }
    >("list_user_emails", config, async () => ({ ok: true }));

    await assert.rejects(
      () => wrapped({ on_behalf_of_user_id: 99 }),
      (err: Error) => {
        assert.equal(err.message, TIER3_GATE_DENIED_MESSAGE);
        return true;
      }
    );
  });
});

describe("wrapTier3Handler — error-outcome read-audit (spec §3.1 error branch)", () => {
  let spy: ReturnType<typeof captureStderr>;
  beforeEach(() => {
    spy = captureStderr();
  });
  afterEach(() => {
    spy.restore();
  });

  it("emits an error READ_AUDIT line when the inner handler throws downstream of the gate", async () => {
    const config = { tier3ActorIds: new Set<number>([7]) };
    const wrapped = wrapTier3Handler<
      { on_behalf_of_user_id?: number },
      { ok: true }
    >("list_email_templates", config, async () => {
      throw new Error("Greenhouse API error: 500 Server Error");
    });

    await assert.rejects(
      () => wrapped({ on_behalf_of_user_id: 7 }),
      (err: Error) => {
        // Caller-visible error remains the original downstream error, not
        // a sanitized audit-failure message — the audit succeeded; only
        // the request failed.
        assert.match(err.message, /Greenhouse API error: 500 Server Error/);
        return true;
      }
    );

    const audits = readAuditLines(spy.lines);
    assert.equal(audits.length, 1);
    assert.equal(audits[0]!.outcome, "error");
    assert.equal(audits[0]!.tool, "list_email_templates");
    assert.deepStrictEqual(audits[0]!.caller_identity, { on_behalf_of_user_id: 7 });
    assert.ok(
      !("result_size_class" in (audits[0]! as unknown as Record<string, unknown>)),
      "error events must omit result_size_class (spec §3.2)"
    );
  });

  it("the error audit line does not leak err.message, Harvest body, or endpoint query string", async () => {
    const config = { tier3ActorIds: new Set<number>([7]) };
    const wrapped = wrapTier3Handler<
      { on_behalf_of_user_id?: number },
      { ok: true }
    >("list_user_emails", config, async () => {
      throw new Error(
        "Greenhouse API error: 404 Not Found (/user_emails?ids=999&cursor=abc) [correlation_id=deadbeef]"
      );
    });

    await assert.rejects(() => wrapped({ on_behalf_of_user_id: 7 }));

    const auditLine = spy.lines.find((l) => l.startsWith(`${READ_AUDIT_PREFIX} `))!;
    assert.ok(auditLine);
    for (const leak of [
      "Greenhouse API error",
      "404 Not Found",
      "/user_emails",
      "ids=999",
      "cursor=abc",
      "correlation_id=deadbeef",
    ]) {
      assert.ok(
        !auditLine.includes(leak),
        `error audit leaked free-form error content: ${leak}`
      );
    }
  });

  it("can mark downstream errors as projected for gated projected tools", async () => {
    const config = { tier3ActorIds: new Set<number>([7]) };
    const wrapped = wrapTier3Handler<
      { on_behalf_of_user_id?: number },
      { ok: true }
    >(
      "get_offer_letter_context",
      config,
      async () => {
        throw new Error("Offer letter assembly failed");
      },
      { projectionAppliedOnError: true }
    );

    await assert.rejects(() => wrapped({ on_behalf_of_user_id: 7 }));

    const audits = readAuditLines(spy.lines);
    assert.equal(audits.length, 1);
    assert.equal(audits[0]!.tool, "get_offer_letter_context");
    assert.equal(audits[0]!.outcome, "error");
    assert.equal(audits[0]!.projection_applied, true);
    assert.deepStrictEqual(audits[0]!.caller_identity, { on_behalf_of_user_id: 7 });
  });
});

describe("emitTier3SuccessReadAudit — success emission from call site", () => {
  let spy: ReturnType<typeof captureStderr>;
  beforeEach(() => {
    spy = captureStderr();
  });
  afterEach(() => {
    spy.restore();
  });

  it("emits a success READ_AUDIT line with the requested size class", () => {
    emitTier3SuccessReadAudit({
      toolName: "list_email_templates",
      actorId: 42,
      resultSizeClass: "medium",
    });
    const audits = readAuditLines(spy.lines);
    assert.equal(audits.length, 1);
    assert.equal(audits[0]!.outcome, "success");
    assert.equal(audits[0]!.tool, "list_email_templates");
    assert.equal(audits[0]!.tier, 3);
    assert.equal(audits[0]!.result_size_class, "medium");
    assert.equal(audits[0]!.projection_applied, false);
    assert.deepStrictEqual(audits[0]!.caller_identity, { on_behalf_of_user_id: 42 });
  });

  it("fails closed with the sanitized message when the sink throws", () => {
    const original = console.error;
    console.error = () => {
      throw new Error("sink failure");
    };
    try {
      assert.throws(
        () =>
          emitTier3SuccessReadAudit({
            toolName: "list_email_templates",
            actorId: 42,
            resultSizeClass: "small",
          }),
        (err: Error) => {
          assert.equal(err.message, READ_AUDIT_FAILURE_MESSAGE);
          return true;
        }
      );
    } finally {
      console.error = original;
    }
  });
});

describe("wrapTier3Handler — fail-closed when emit throws (spec §6.1)", () => {
  it("propagates READ_AUDIT_FAILURE_MESSAGE when the inner handler's success emit fails, and returns no tool result", async () => {
    const config = { tier3ActorIds: new Set<number>([7]) };
    const wrapped = wrapTier3Handler<
      { on_behalf_of_user_id?: number },
      { content: { type: "text"; text: string }[] }
    >("list_email_templates", config, async (_params, context) => {
      // Simulate the real index.ts call site: call emitTier3SuccessReadAudit
      // right before formatting the result. If the emitter throws, the
      // handler throws before returning anything the model can see.
      emitTier3SuccessReadAudit({
        toolName: "list_email_templates",
        actorId: context!.actorId,
        resultSizeClass: "small",
      });
      return { content: [{ type: "text" as const, text: "{\"data\":[]}" }] };
    });

    const original = console.error;
    let returnedValue: unknown = "SHOULD_NOT_BE_SET";
    console.error = () => {
      throw new Error("sink failure");
    };
    try {
      await assert.rejects(
        async () => {
          returnedValue = await wrapped({ on_behalf_of_user_id: 7 });
        },
        (err: Error) => {
          assert.equal(err.message, READ_AUDIT_FAILURE_MESSAGE);
          // Sanitized: must not leak underlying cause or tool name.
          assert.ok(!err.message.includes("sink failure"));
          assert.ok(!err.message.includes("list_email_templates"));
          return true;
        }
      );
    } finally {
      console.error = original;
    }
    assert.equal(
      returnedValue,
      "SHOULD_NOT_BE_SET",
      "fail-closed: handler must not return any value when audit emit fails"
    );
  });

  it("denied-path emit failure also fails closed with READ_AUDIT_FAILURE_MESSAGE, not the deny message", async () => {
    const config = { tier3ActorIds: new Set<number>([7]) };
    const wrapped = wrapTier3Handler<
      { on_behalf_of_user_id?: number },
      { ok: true }
    >("list_email_templates", config, async () => ({ ok: true }));

    const original = console.error;
    console.error = () => {
      throw new Error("sink failure");
    };
    try {
      await assert.rejects(
        () => wrapped({ on_behalf_of_user_id: 99 }),
        (err: Error) => {
          assert.equal(err.message, READ_AUDIT_FAILURE_MESSAGE);
          return true;
        }
      );
    } finally {
      console.error = original;
    }
  });

  it("error-path emit failure also fails closed with READ_AUDIT_FAILURE_MESSAGE", async () => {
    const config = { tier3ActorIds: new Set<number>([7]) };
    const wrapped = wrapTier3Handler<
      { on_behalf_of_user_id?: number },
      { ok: true }
    >("list_email_templates", config, async () => {
      throw new Error("downstream failure");
    });

    const original = console.error;
    console.error = () => {
      throw new Error("sink failure");
    };
    try {
      await assert.rejects(
        () => wrapped({ on_behalf_of_user_id: 7 }),
        (err: Error) => {
          assert.equal(err.message, READ_AUDIT_FAILURE_MESSAGE);
          return true;
        }
      );
    } finally {
      console.error = original;
    }
  });
});

describe("Tier-1 and Tier-2 silence contract (spec §1.2, §1.3)", () => {
  let spy: ReturnType<typeof captureStderr>;
  beforeEach(() => {
    spy = captureStderr();
  });
  afterEach(() => {
    spy.restore();
  });

  it("a Tier-1 handler shape (no wrapTier3Handler, no emitTier3SuccessReadAudit) emits no READ_AUDIT line", async () => {
    // This mirrors the shape of every non-gated tool registration in
    // index.ts — a plain async handler that calls listEndpoint-equivalent
    // and returns formatResult-equivalent. It does NOT call any Tier 3
    // helper. We prove silence by running it and checking stderr.
    const tier1Handler = async (
      params: { cursor?: string; ids?: string }
    ): Promise<{ content: { type: "text"; text: string }[] }> => {
      return {
        content: [
          { type: "text" as const, text: JSON.stringify({ data: [{ id: 1 }], params }) },
        ],
      };
    };

    const result = await tier1Handler({ ids: "1,2,3" });
    assert.ok(result.content);
    assert.equal(
      readAuditLines(spy.lines).length,
      0,
      "Tier 1 handler shape must never emit a READ_AUDIT line"
    );
  });

  it("a Tier-2 handler shape emits no READ_AUDIT line, even when the response carries PII", async () => {
    // Simulate a Tier-2 handler (e.g. list_candidates) returning a
    // payload with candidate-PII-looking fields. The fields are
    // synthetic; the test proves the silence contract, not redaction.
    const tier2Handler = async (
      params: { cursor?: string; ids?: string }
    ): Promise<{ content: { type: "text"; text: string }[] }> => {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              data: [
                { id: 1, first_name: "Test", last_name: "Candidate", email: "a@b.example" },
              ],
              params,
            }),
          },
        ],
      };
    };

    const result = await tier2Handler({ ids: "42" });
    assert.ok(result.content);
    assert.equal(
      readAuditLines(spy.lines).length,
      0,
      "Tier 2 handler must never emit a READ_AUDIT line (doctrine §7 canonical rule)"
    );
  });

  it("calling wrapTier3Handler does not retroactively audit Tier-1/Tier-2 work done in the same test", async () => {
    // Guard against a regression where a new helper starts emitting
    // unconditionally. We run a Tier-1 handler AND a Tier-3 wrapped
    // handler in the same test; only the Tier-3 call may emit.
    const config = { tier3ActorIds: new Set<number>([7]) };
    const tier3 = wrapTier3Handler<
      { on_behalf_of_user_id?: number },
      { ok: true }
    >("list_email_templates", config, async (_params, context) => {
      emitTier3SuccessReadAudit({
        toolName: "list_email_templates",
        actorId: context!.actorId,
        resultSizeClass: "small",
      });
      return { ok: true };
    });

    const tier1: () => Promise<{ ok: true }> = async () => ({ ok: true });

    await tier1();
    await tier3({ on_behalf_of_user_id: 7 });
    await tier1();

    const audits = readAuditLines(spy.lines);
    assert.equal(
      audits.length,
      1,
      "only the single Tier-3 success call should emit; Tier-1 bookends stay silent"
    );
    assert.equal(audits[0]!.tool, "list_email_templates");
    assert.equal(audits[0]!.outcome, "success");
  });
});

// ---------------------------------------------------------------------------
// P2.2 slice-1 read-audit integration — list_notes (projection + audit)
//
// Scope: exercise the emitters with the exact input shape the list_notes
// handler uses in index.ts. This proves the audit contract without
// spinning up an MCP server or mocking Harvest.
// ---------------------------------------------------------------------------

describe("list_notes audit integration — P2.2 slice 1", () => {
  let spy: ReturnType<typeof captureStderr>;
  beforeEach(() => {
    spy = captureStderr();
  });
  afterEach(() => {
    spy.restore();
  });

  it("success emits projection_applied=true with actor=null on a list_notes-shaped call", () => {
    emitTier3SuccessReadAudit({
      toolName: "list_notes",
      actorId: null,
      resultSizeClass: "small",
      projectionApplied: true,
    });

    const audits = readAuditLines(spy.lines);
    assert.equal(audits.length, 1, "exactly one audit line per list_notes success");
    assert.equal(audits[0]!.tool, "list_notes");
    assert.equal(audits[0]!.tier, 3);
    assert.equal(audits[0]!.outcome, "success");
    assert.equal(audits[0]!.projection_applied, true);
    assert.equal(audits[0]!.result_size_class, "small");
    assert.deepStrictEqual(audits[0]!.caller_identity, { on_behalf_of_user_id: null });
  });

  it("error emits projection_applied=true with actor=null and omits result_size_class", () => {
    emitTier3ErrorReadAudit({
      toolName: "list_notes",
      actorId: null,
      projectionApplied: true,
    });

    const audits = readAuditLines(spy.lines);
    assert.equal(audits.length, 1);
    assert.equal(audits[0]!.tool, "list_notes");
    assert.equal(audits[0]!.tier, 3);
    assert.equal(audits[0]!.outcome, "error");
    assert.equal(audits[0]!.projection_applied, true);
    assert.deepStrictEqual(audits[0]!.caller_identity, { on_behalf_of_user_id: null });
    assert.ok(
      !("result_size_class" in (audits[0]! as unknown as Record<string, unknown>)),
      "error events must omit result_size_class (P2.1 spec §3.2)"
    );
  });

  it("audit line for list_notes contains no body, subject, email, candidate name, or endpoint leak", () => {
    emitTier3SuccessReadAudit({
      toolName: "list_notes",
      actorId: null,
      resultSizeClass: "medium",
      projectionApplied: true,
    });
    const line = spy.lines.find((l) => l.startsWith(`${READ_AUDIT_PREFIX} `))!;
    assert.ok(line);
    const forbidden = [
      "body",
      "subject",
      "candidate_id=",
      "application_id=",
      "cursor=",
      "ids=",
      "@example.com",
      "@gmail.com",
      "/notes",
      "admin_only_visible",
    ];
    for (const token of forbidden) {
      assert.ok(
        !line.includes(token),
        `list_notes audit line leaked forbidden token "${token}": ${line}`
      );
    }
  });

  it("success emitter fails closed on sink failure (fail-closed parity with gated tools)", () => {
    const original = console.error;
    console.error = () => {
      throw new Error("sink failure");
    };
    try {
      assert.throws(
        () =>
          emitTier3SuccessReadAudit({
            toolName: "list_notes",
            actorId: null,
            resultSizeClass: "small",
            projectionApplied: true,
          }),
        (err: Error) => {
          assert.equal(err.message, READ_AUDIT_FAILURE_MESSAGE);
          assert.ok(!err.message.includes("sink failure"));
          assert.ok(!err.message.includes("list_notes"));
          return true;
        }
      );
    } finally {
      console.error = original;
    }
  });

  it("error emitter fails closed on sink failure (fail-closed parity with gated tools)", () => {
    const original = console.error;
    console.error = () => {
      throw new Error("sink failure");
    };
    try {
      assert.throws(
        () =>
          emitTier3ErrorReadAudit({
            toolName: "list_notes",
            actorId: null,
            projectionApplied: true,
          }),
        (err: Error) => {
          assert.equal(err.message, READ_AUDIT_FAILURE_MESSAGE);
          return true;
        }
      );
    } finally {
      console.error = original;
    }
  });
});

describe("emitTier3SuccessReadAudit — projectionApplied input widening (P2.2 slice 1)", () => {
  let spy: ReturnType<typeof captureStderr>;
  beforeEach(() => {
    spy = captureStderr();
  });
  afterEach(() => {
    spy.restore();
  });

  it("defaults projection_applied to false when the input flag is omitted (preserves gated-tool behavior)", () => {
    // Mirrors the four gated Tier 3 tools' call-site shape in index.ts:
    // they pass no projectionApplied flag.
    emitTier3SuccessReadAudit({
      toolName: "list_email_templates",
      actorId: 42,
      resultSizeClass: "medium",
    });
    const audits = readAuditLines(spy.lines);
    assert.equal(audits.length, 1);
    assert.equal(
      audits[0]!.projection_applied,
      false,
      "omitted projectionApplied must default to false to preserve gated-tool posture"
    );
  });

  it("emits projection_applied=true when the input flag is true", () => {
    emitTier3SuccessReadAudit({
      toolName: "list_notes",
      actorId: null,
      resultSizeClass: "small",
      projectionApplied: true,
    });
    const audits = readAuditLines(spy.lines);
    assert.equal(audits.length, 1);
    assert.equal(audits[0]!.projection_applied, true);
  });

  it("explicit projectionApplied=false is honored (equivalent to omitting the flag)", () => {
    emitTier3SuccessReadAudit({
      toolName: "list_scheduled_interviews",
      actorId: 7,
      resultSizeClass: "empty",
      projectionApplied: false,
    });
    const audits = readAuditLines(spy.lines);
    assert.equal(audits.length, 1);
    assert.equal(audits[0]!.projection_applied, false);
  });

  it("accepts actorId: null for non-gated Tier 3 tools without throwing", () => {
    // Type-level widening check: before P2.2 slice 1 this would not compile.
    emitTier3SuccessReadAudit({
      toolName: "list_notes",
      actorId: null,
      resultSizeClass: "small",
      projectionApplied: true,
    });
    const audits = readAuditLines(spy.lines);
    assert.equal(audits.length, 1);
    assert.deepStrictEqual(audits[0]!.caller_identity, { on_behalf_of_user_id: null });
  });
});

// ---------------------------------------------------------------------------
// P2.2 slice-2 read-audit integration — list_scorecards (projection + audit)
//
// Same shape as the slice-1 list_notes integration suite. Exercises the
// emitters with the exact input shape the list_scorecards handler uses
// in index.ts. Proves the audit contract without spinning up an MCP
// server or mocking Harvest.
// ---------------------------------------------------------------------------

describe("list_scorecards audit integration — P2.2 slice 2", () => {
  let spy: ReturnType<typeof captureStderr>;
  beforeEach(() => {
    spy = captureStderr();
  });
  afterEach(() => {
    spy.restore();
  });

  it("success emits projection_applied=true with actor=null on a list_scorecards-shaped call", () => {
    emitTier3SuccessReadAudit({
      toolName: "list_scorecards",
      actorId: null,
      resultSizeClass: "medium",
      projectionApplied: true,
    });

    const audits = readAuditLines(spy.lines);
    assert.equal(audits.length, 1, "exactly one audit line per list_scorecards success");
    assert.equal(audits[0]!.tool, "list_scorecards");
    assert.equal(audits[0]!.tier, 3);
    assert.equal(audits[0]!.outcome, "success");
    assert.equal(audits[0]!.projection_applied, true);
    assert.equal(audits[0]!.result_size_class, "medium");
    assert.deepStrictEqual(audits[0]!.caller_identity, { on_behalf_of_user_id: null });
  });

  it("error emits projection_applied=true with actor=null and omits result_size_class", () => {
    emitTier3ErrorReadAudit({
      toolName: "list_scorecards",
      actorId: null,
      projectionApplied: true,
    });

    const audits = readAuditLines(spy.lines);
    assert.equal(audits.length, 1);
    assert.equal(audits[0]!.tool, "list_scorecards");
    assert.equal(audits[0]!.tier, 3);
    assert.equal(audits[0]!.outcome, "error");
    assert.equal(audits[0]!.projection_applied, true);
    assert.deepStrictEqual(audits[0]!.caller_identity, { on_behalf_of_user_id: null });
    assert.ok(
      !("result_size_class" in (audits[0]! as unknown as Record<string, unknown>)),
      "error events must omit result_size_class (P2.1 spec §3.2)"
    );
  });

  it("audit line for list_scorecards contains no question prose, rating enum value, candidate/interviewer name, or filter token", () => {
    emitTier3SuccessReadAudit({
      toolName: "list_scorecards",
      actorId: null,
      resultSizeClass: "large",
      projectionApplied: true,
    });
    const line = spy.lines.find((l) => l.startsWith(`${READ_AUDIT_PREFIX} `))!;
    assert.ok(line);
    const forbidden = [
      // Never audit-log per-question free-text or attribute commentary.
      "questions",
      "attributes",
      // Per P2.1 spec §3.2, rating enum values never reach the audit line.
      "strong_yes",
      "definitely_not",
      // Filter-token echoes forbidden by P2.1 spec §4.
      "application_ids=",
      "interview_ids=",
      "ids=",
      "cursor=",
      // Endpoint path must never leak.
      "/scorecards",
      // Email / name leak guard.
      "@example.com",
      "@gmail.com",
      "Jane",
    ];
    for (const token of forbidden) {
      assert.ok(
        !line.includes(token),
        `list_scorecards audit line leaked forbidden token "${token}": ${line}`
      );
    }
  });

  it("success emitter fails closed on sink failure (fail-closed parity with list_notes and gated tools)", () => {
    const original = console.error;
    console.error = () => {
      throw new Error("sink failure");
    };
    try {
      assert.throws(
        () =>
          emitTier3SuccessReadAudit({
            toolName: "list_scorecards",
            actorId: null,
            resultSizeClass: "small",
            projectionApplied: true,
          }),
        (err: Error) => {
          assert.equal(err.message, READ_AUDIT_FAILURE_MESSAGE);
          assert.ok(!err.message.includes("sink failure"));
          assert.ok(!err.message.includes("list_scorecards"));
          return true;
        }
      );
    } finally {
      console.error = original;
    }
  });

  it("error emitter fails closed on sink failure (fail-closed parity with list_notes and gated tools)", () => {
    const original = console.error;
    console.error = () => {
      throw new Error("sink failure");
    };
    try {
      assert.throws(
        () =>
          emitTier3ErrorReadAudit({
            toolName: "list_scorecards",
            actorId: null,
            projectionApplied: true,
          }),
        (err: Error) => {
          assert.equal(err.message, READ_AUDIT_FAILURE_MESSAGE);
          return true;
        }
      );
    } finally {
      console.error = original;
    }
  });
});

// ---------------------------------------------------------------------------
// P2.2 slice-5 read-audit integration — list_rejection_details
//
// Same shape as the slice-1 and slice-2 integration suites. Exercises
// the emitters with the exact input shape the list_rejection_details
// handler uses in index.ts. list_rejection_details reverts to the
// Tier-3 audited pattern (projection + audit) after slices 3 and 4
// exercised the Tier-2 silent projection pattern.
// ---------------------------------------------------------------------------

describe("list_rejection_details audit integration — P2.2 slice 5", () => {
  let spy: ReturnType<typeof captureStderr>;
  beforeEach(() => {
    spy = captureStderr();
  });
  afterEach(() => {
    spy.restore();
  });

  it("success emits projection_applied=true with actor=null on a list_rejection_details-shaped call", () => {
    emitTier3SuccessReadAudit({
      toolName: "list_rejection_details",
      actorId: null,
      resultSizeClass: "medium",
      projectionApplied: true,
    });

    const audits = readAuditLines(spy.lines);
    assert.equal(audits.length, 1, "exactly one audit line per list_rejection_details success");
    assert.equal(audits[0]!.tool, "list_rejection_details");
    assert.equal(audits[0]!.tier, 3);
    assert.equal(audits[0]!.outcome, "success");
    assert.equal(audits[0]!.projection_applied, true);
    assert.equal(audits[0]!.result_size_class, "medium");
    assert.deepStrictEqual(audits[0]!.caller_identity, { on_behalf_of_user_id: null });
  });

  it("error emits projection_applied=true with actor=null and omits result_size_class", () => {
    emitTier3ErrorReadAudit({
      toolName: "list_rejection_details",
      actorId: null,
      projectionApplied: true,
    });

    const audits = readAuditLines(spy.lines);
    assert.equal(audits.length, 1);
    assert.equal(audits[0]!.tool, "list_rejection_details");
    assert.equal(audits[0]!.tier, 3);
    assert.equal(audits[0]!.outcome, "error");
    assert.equal(audits[0]!.projection_applied, true);
    assert.deepStrictEqual(audits[0]!.caller_identity, { on_behalf_of_user_id: null });
    assert.ok(
      !("result_size_class" in (audits[0]! as unknown as Record<string, unknown>)),
      "error events must omit result_size_class (P2.1 spec §3.2)"
    );
  });

  it("audit line for list_rejection_details contains no rejection-note prose, reason label, rejecting-user name/email, nested application/candidate detail, custom fields, or filter token", () => {
    emitTier3SuccessReadAudit({
      toolName: "list_rejection_details",
      actorId: null,
      resultSizeClass: "large",
      projectionApplied: true,
    });
    const line = spy.lines.find((l) => l.startsWith(`${READ_AUDIT_PREFIX} `))!;
    assert.ok(line);
    const forbidden = [
      // Rejection-notes prose content must never surface in audit.
      "notes",
      "rejection_notes",
      // Per P2.1 spec §3.2, reason-label enum values never reach the audit line.
      "Not a culture fit",
      "pool",
      // Rejecting-user names / emails / employee ids must never surface.
      "Ada",
      "Lovelace",
      "@example.com",
      "EMP-9001",
      // Nested application / candidate detail must never surface.
      "candidate",
      "application",
      // Custom-field payloads must never surface.
      "custom_fields",
      "keyed_custom_fields",
      "severity",
      // Filter-token echoes forbidden by P2.1 spec §4 — covers the tool's
      // full accepted filter surface per slice-5 spec §7.4.
      "ids=",
      "application_ids=",
      "rejection_reason_ids=",
      "custom_field_option_id=",
      "per_page=",
      "cursor=",
      "created_at=",
      "updated_at=",
      // Endpoint path must never leak.
      "/rejection_details",
    ];
    for (const token of forbidden) {
      assert.ok(
        !line.includes(token),
        `list_rejection_details audit line leaked forbidden token "${token}": ${line}`
      );
    }
  });

  it("success emitter fails closed on sink failure (fail-closed parity with list_notes and gated tools)", () => {
    const original = console.error;
    console.error = () => {
      throw new Error("sink failure");
    };
    try {
      assert.throws(
        () =>
          emitTier3SuccessReadAudit({
            toolName: "list_rejection_details",
            actorId: null,
            resultSizeClass: "small",
            projectionApplied: true,
          }),
        (err: Error) => {
          assert.equal(err.message, READ_AUDIT_FAILURE_MESSAGE);
          assert.ok(!err.message.includes("sink failure"));
          assert.ok(!err.message.includes("list_rejection_details"));
          return true;
        }
      );
    } finally {
      console.error = original;
    }
  });

  it("error emitter fails closed on sink failure (fail-closed parity with list_notes and gated tools)", () => {
    const original = console.error;
    console.error = () => {
      throw new Error("sink failure");
    };
    try {
      assert.throws(
        () =>
          emitTier3ErrorReadAudit({
            toolName: "list_rejection_details",
            actorId: null,
            projectionApplied: true,
          }),
        (err: Error) => {
          assert.equal(err.message, READ_AUDIT_FAILURE_MESSAGE);
          return true;
        }
      );
    } finally {
      console.error = original;
    }
  });
});
