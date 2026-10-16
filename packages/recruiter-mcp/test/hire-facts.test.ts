import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createScopedGreenhouseReader,
  type ApiResponse,
  type RawReadClient,
  type ReadParams,
} from "../../scoped-core/src/index.js";
import { buildHireFacts, classifyOfferStatus } from "../src/facts.js";
import { getHarvestEndpointByPath } from "../src/harvest-v3-registry.js";
import { HIRE_FACTS_OFFER_READ_PARAM_NAMES } from "../src/limits.js";
import { readHireSet } from "../src/tools/hire-facts.js";
import { bracketParamsForWindows, readAllWithDateFallback } from "../src/tools/read-with-date-fallback.js";
import { computeMetric } from "../src/metrics.js";
import { SCOPED_TOOL_SCOPE_POLICIES } from "../src/tools/scoped-endpoint-adapters.js";
import type { AuthenticatedSession } from "../src/types.js";
import { fakeScopedReader, scopedSuccess, testRuntime, testSession } from "./test-helpers.js";

const WINDOW = { start: "2026-04-01T00:00:00.000Z", end: "2026-06-30T23:59:59.999Z", label: "Q2 2026" };

function offerRow(id: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    job_id: 10,
    application_id: 100 + id,
    candidate_id: 1000 + id,
    opening_id: 5,
    status: "Accepted",
    version: 1,
    sent_on: "2026-05-01",
    resolved_at: "2026-05-10T12:00:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// H1: the two legs of the shared 422 fallback, asserted on the params ACTUALLY
// sent to the reader. The LIVE /v3/offers endpoint 422s every date filter the
// vendored contract advertises, so the native attempt has to come first (cheap
// where it is supported) and the bracket-free re-read has to window locally and
// SAY it did.
// ---------------------------------------------------------------------------
describe("H1 readHireSet — the shared 422 date fallback", () => {
  it("tries the bracket filter, re-reads without it on 422, windows locally, and discloses", async () => {
    const reader = fakeScopedReader((toolName, params) => {
      const hasBrackets = Object.keys(params ?? {}).some((key) => /\[(gte|lte|gt|lt)\]$/.test(key));
      if (hasBrackets) {
        throw new Error("Greenhouse API error: 422 Unprocessable Entity (/offers) [correlation_id=test]");
      }
      return scopedSuccess(toolName, [
        offerRow(1, { resolved_at: "2026-05-10T12:00:00.000Z" }),
        offerRow(2, { resolved_at: "2026-07-10T12:00:00.000Z" }), // after the window
        offerRow(3, { resolved_at: "2026-03-10T12:00:00.000Z" }), // before the window
        // The READ-layer sent_on fallback: Greenhouse never wrote a resolved_at for this hire, so
        // the local window has to place it on sent_on rather than dropping it.
        offerRow(4, { resolved_at: undefined, sent_on: "2026-05-05" }),
        // Neither clock. It cannot be placed in any window and is COUNTED as unplaceable rather
        // than disappearing into the difference between two numbers.
        offerRow(5, { resolved_at: undefined, sent_on: undefined }),
      ]);
    });
    const { runtime } = testRuntime(reader);

    const result = await readHireSet(runtime, "test_tool", { label: "everything you can see" }, WINDOW, undefined, {});

    assert.equal(result.kind, "rows");
    if (result.kind !== "rows") return;
    assert.deepStrictEqual(
      result.hires.map((row) => row.id),
      [1, 4],
      "the hire dated only by sent_on survives the local window beside the resolved_at one"
    );
    assert.equal(result.read.rowsMissingField, 1, "the row with neither clock is counted, not silently absorbed");

    // Leg one: the native bracket attempt, with the hire filters beside it.
    const first = reader.calls[0]!.params as Record<string, unknown>;
    assert.equal(first["resolved_at[gte]"], WINDOW.start);
    assert.equal(first["resolved_at[lte]"], WINDOW.end);
    assert.equal(first.status, "Accepted");
    assert.equal(first.current_only, true);
    // Leg two: the SAME filters minus the date brackets.
    const second = reader.calls[1]!.params as Record<string, unknown>;
    assert.equal(second["resolved_at[gte]"], undefined, "the rejected date params are dropped on the re-read");
    assert.equal(second["resolved_at[lte]"], undefined);
    assert.equal(second.status, "Accepted", "the filters the endpoint DOES accept are kept");
    assert.equal(second.current_only, true);
    assert.equal(reader.calls.length, 2, "exactly one fallback re-read");

    assert.equal(result.read.windowAppliedLocally, true, "the local window is disclosed, never silent");
    assert.deepStrictEqual(result.read.dateParamsRejected.sort(), ["resolved_at[gte]", "resolved_at[lte]"]);
  });

  it("asks the accepted native filter for the sent_on-dated hires too, so both legs return the same set", async () => {
    // A resolved_at range filter can never return a row that has no resolved_at. Before this the
    // 422 leg counted a sent_on-dated hire and the native leg silently did not, so the same
    // question got two different answers depending on an upstream behaviour nobody could see.
    const reader = fakeScopedReader((toolName, params) => {
      if (params?.["sent_on[gte]"] !== undefined) {
        return scopedSuccess(toolName, [
          offerRow(4, { resolved_at: undefined, sent_on: "2026-05-05" }),
          // Already returned by the resolved_at leg: it carries the primary field, so this leg
          // must NOT count it a second time.
          offerRow(1),
        ]);
      }
      return scopedSuccess(toolName, [offerRow(1)]);
    });
    const { runtime } = testRuntime(reader);

    const result = await readHireSet(runtime, "test_tool", { label: "everything you can see" }, WINDOW, undefined, {});

    assert.equal(result.kind, "rows");
    if (result.kind !== "rows") return;
    assert.deepStrictEqual(result.hires.map((row) => row.id), [1, 4], "no double count, no dropped fallback hire");
    assert.equal(reader.calls.length, 2, "one native leg per declared window field, never a full unfiltered read");
    const second = reader.calls[1]!.params as Record<string, unknown>;
    assert.equal(second["sent_on[gte]"], WINDOW.start);
    assert.equal(second["sent_on[lte]"], WINDOW.end);
    assert.equal(second["resolved_at[gte]"], undefined, "the primary field's brackets are swapped out, not stacked");
    assert.equal(second.status, "Accepted", "every other filter is kept");
    assert.equal(second.current_only, true, "including current_only — a chain-collapsing filter the leg must not drop");
    assert.equal(result.read.windowAppliedLocally, false);
    assert.deepStrictEqual(result.read.dateParamsRejected, []);
  });

  // The supplemental leg is a READ like any other, so it gets the same two legs the primary one
  // does. Without this a 422 on the sent_on leg turned into a warning and a `complete: true`
  // answer that was quietly missing every sent_on-dated hire.
  it("self-heals a 422 on the sent_on leg and recovers the hires it was asked for", async () => {
    const reader = fakeScopedReader((toolName, params) => {
      if (params?.["sent_on[gte]"] !== undefined) {
        throw new Error("Greenhouse API error: 422 Unprocessable Entity (/offers) [correlation_id=test]");
      }
      if (params?.["resolved_at[gte]"] !== undefined) return scopedSuccess(toolName, [offerRow(1)]);
      // The bracket-free re-read of the sent_on leg: the whole scoped set.
      return scopedSuccess(toolName, [
        offerRow(1),
        offerRow(4, { resolved_at: undefined, sent_on: "2026-05-05" }),
        offerRow(7, { resolved_at: undefined, sent_on: "2026-01-05" }), // before the window
      ]);
    });
    const { runtime } = testRuntime(reader);

    const result = await readHireSet(runtime, "test_tool", { label: "everything you can see" }, WINDOW, undefined, {});

    assert.equal(result.kind, "rows");
    if (result.kind !== "rows") return;
    assert.deepStrictEqual(result.hires.map((row) => row.id), [1, 4], "the sent_on-only hire is recovered, not lost to a warning");
    assert.equal(result.read.complete, true, "a leg that healed itself leaves the read complete");
  });

  it("marks the read incomplete and names the field when a fallback leg fails for any other reason", async () => {
    const reader = fakeScopedReader((toolName, params) => {
      if (params?.["sent_on[gte]"] !== undefined) {
        throw new Error("Greenhouse API error: 500 Internal Server Error (/offers) [correlation_id=test]");
      }
      return scopedSuccess(toolName, [offerRow(1)]);
    });
    const { runtime } = testRuntime(reader);

    const result = await readHireSet(runtime, "test_tool", { label: "everything you can see" }, WINDOW, undefined, {});

    assert.equal(result.kind, "rows");
    if (result.kind !== "rows") return;
    assert.deepStrictEqual(result.hires.map((row) => row.id), [1], "the primary leg's hires are real either way");
    assert.equal(result.read.complete, false, "a leg that never answered cannot leave the set complete");
    assert.equal(result.read.status, "incomplete_upstream");
    assert.ok(
      result.read.warnings.some((warning) => /sent_on/.test(warning)),
      `the failing field is named, got ${JSON.stringify(result.read.warnings)}`
    );
  });

  it("counts a supplemental leg that returned NOTHING in the read accounting", async () => {
    // A zero-row leg is still a page fetched and rows scanned upstream. Dropping it from the
    // accounting understated what the read cost and hid a leg that had run.
    const reader = fakeScopedReader((toolName, params) => {
      if (params?.["sent_on[gte]"] !== undefined) return scopedSuccess(toolName, []);
      return scopedSuccess(toolName, [offerRow(1)]);
    });
    const { runtime } = testRuntime(reader);

    const outcome = await readAllWithDateFallback(runtime, "test_tool", "list_offers", {
      "resolved_at[gte]": WINDOW.start,
      "resolved_at[lte]": WINDOW.end,
    }, [{ field: "resolved_at", fallbackFields: ["sent_on"], gte: WINDOW.start, lte: WINDOW.end }]);

    assert.equal(outcome.read.kind, "rows");
    if (outcome.read.kind !== "rows") return;
    assert.equal(outcome.read.pagesRead, 2, "both legs' pages are counted, including the empty one");
    assert.deepStrictEqual(outcome.fallbackFieldsQueried, ["sent_on"]);
  });

  it("derives the bracket keys from an lte-only and a gt/lt-only spec", async () => {
    // The stripped keys come from the SPEC, not from a hard-coded gte/lte pair: a one-sided or
    // exclusive window that 422s must strip exactly the keys it sent.
    for (const [spec, expected] of [
      [{ field: "resolved_at", lte: WINDOW.end }, ["resolved_at[lte]"]],
      [{ field: "resolved_at", gt: WINDOW.start, lt: WINDOW.end }, ["resolved_at[gt]", "resolved_at[lt]"]],
    ] as const) {
      const reader = fakeScopedReader((toolName, params) => {
        if (Object.keys(params ?? {}).some((key) => /^resolved_at\[/.test(key))) {
          throw new Error("Greenhouse API error: 422 Unprocessable Entity (/offers) [correlation_id=test]");
        }
        return scopedSuccess(toolName, []);
      });
      const { runtime } = testRuntime(reader);

      const outcome = await readAllWithDateFallback(
        runtime,
        "test_tool",
        "list_offers",
        { ...bracketParamsForWindows([spec]), job_ids: "1" },
        [spec]
      );

      assert.equal(outcome.windowAppliedLocally, true);
      assert.deepStrictEqual(outcome.dateParamsRejected, [...expected].sort());
      assert.equal((reader.calls[1]!.params as Record<string, unknown>).job_ids, "1", "the non-date filter survives");
    }
  });

  // The self-heal must fire on a DATE 422 and nothing else. A test-honesty mutation proved the
  // status check was unlocked: deleting it left 1609/1609 green because no fixture ever threw
  // anything but a 422 on the bracket leg. A fallback on any error would turn an auth failure or a
  // tenant outage into a silent full unfiltered read.
  for (const [label, thrown] of [
    ["a 401", new Error("Greenhouse API error: 401 Unauthorized (/offers) [correlation_id=test]")],
    ["a 403", new Error("Greenhouse API error: 403 Forbidden (/offers) [correlation_id=test]")],
    ["a 500", new Error("Greenhouse API error: 500 Internal Server Error (/offers) [correlation_id=test]")],
    // Not an HTTP error at all: httpErrorStatus finds no status, so there is no 422 to heal.
    ["a network failure", new Error("fetch failed: ECONNRESET")],
  ] as const) {
    it(`rethrows ${label} on the bracket leg instead of re-reading without the window`, async () => {
      const reader = fakeScopedReader(() => {
        throw thrown;
      });
      const { runtime } = testRuntime(reader);

      await assert.rejects(
        () => readHireSet(runtime, "test_tool", { label: "everything you can see" }, WINDOW, undefined, {}),
        (error: unknown) => error === thrown
      );
      assert.equal(reader.calls.length, 1, "exactly one upstream call — no bracket-free re-read");
    });
  }

  it("returns a denial, and makes no bracket-free re-read, when the bracket leg times out", async () => {
    const reader = fakeScopedReader(() => {
      throw new Error("SCOPED_GREENHOUSE_TOOL_TIMEOUT:deadline");
    });
    const { runtime } = testRuntime(reader);

    const result = await readHireSet(runtime, "test_tool", { label: "everything you can see" }, WINDOW, undefined, {});

    assert.equal(result.kind, "denial");
    if (result.kind !== "denial") return;
    assert.equal(result.result.ok === false && result.result.denial.code, "TOOL_TIMEOUT");
    assert.equal(reader.calls.length, 1, "a deadline is not a date 422; nothing is re-read unwindowed");
  });

  it("rethrows a 422 that carries none of this window's bracket params", async () => {
    // readAllWithDateFallback is shared. A caller passing no date window of its own must not have a
    // 422 about (say) a malformed job_ids list 'healed' into a full unfiltered read of the tenant.
    const thrown = new Error("Greenhouse API error: 422 Unprocessable Entity (/offers) [correlation_id=test]");
    const reader = fakeScopedReader(() => {
      throw thrown;
    });
    const { runtime } = testRuntime(reader);

    await assert.rejects(
      () => readAllWithDateFallback(runtime, "test_tool", "list_offers", { job_ids: "1,2" }, [
        { field: "resolved_at", gte: WINDOW.start, lte: WINDOW.end },
      ]),
      (error: unknown) => error === thrown
    );
    assert.equal(reader.calls.length, 1);
  });

  it("strips only the bracket params it added, keeping an unrelated range filter on the re-read", async () => {
    const reader = fakeScopedReader((toolName, params) => {
      if (params?.["resolved_at[gte]"] !== undefined) {
        throw new Error("Greenhouse API error: 422 Unprocessable Entity (/offers) [correlation_id=test]");
      }
      return scopedSuccess(toolName, [offerRow(1)]);
    });
    const { runtime } = testRuntime(reader);

    const outcome = await readAllWithDateFallback(
      runtime,
      "test_tool",
      "list_offers",
      { "resolved_at[gte]": WINDOW.start, "resolved_at[lte]": WINDOW.end, "salary[gte]": "100000" },
      [{ field: "resolved_at", gte: WINDOW.start, lte: WINDOW.end }]
    );

    assert.equal(outcome.windowAppliedLocally, true);
    const second = reader.calls[1]!.params as Record<string, unknown>;
    assert.equal(second["salary[gte]"], "100000", "a range filter this window never added survives the re-read");
    assert.deepStrictEqual(outcome.dateParamsRejected, ["resolved_at[gte]", "resolved_at[lte]"]);
  });

  it("carries current_only / status / resolved_at through the read-param allowlist", () => {
    // sanitizeReadParams drops unknown params SILENTLY, so the hire read's own filters have to be
    // named in an allowlist or the read quietly becomes an unfiltered one.
    for (const name of ["current_only", "status", "resolved_at", "job_ids", "per_page", "cursor"]) {
      assert.ok(HIRE_FACTS_OFFER_READ_PARAM_NAMES.has(name), `${name} must survive sanitizeReadParams`);
    }
  });
});

// ---------------------------------------------------------------------------
// H1b: the org-wide default scope carries NO job_ids, so an org-wide hire read is
// ONE permission-bounded read — not 23 chunks. Chunking is for a FROZEN explicit
// job set only.
// ---------------------------------------------------------------------------
describe("H1b readHireSet — chunking only on an explicit job set", () => {
  it("issues ONE offer read for a permission-wide scope", async () => {
    const reader = fakeScopedReader((toolName) => scopedSuccess(toolName, [offerRow(1)]));
    const { runtime } = testRuntime(reader);

    await readHireSet(runtime, "test_tool", { label: "everything you can see" }, WINDOW, undefined, {});

    // One leg per declared window field (resolved_at, then its sent_on fallback) — never one read
    // per permitted req. The chunking question is about job_ids, so it is counted on the primary leg.
    const offerCalls = reader.calls.filter((call) => call.toolName === "list_offers");
    const primaryLeg = offerCalls.filter((call) => call.params?.["resolved_at[gte]"] !== undefined);
    assert.equal(primaryLeg.length, 1, "a permission-wide read is one read, not one per permitted job");
    assert.equal(offerCalls.length, 2, "and its sent_on fallback leg, which is per-scope too");
    for (const call of offerCalls) {
      assert.equal(call.params?.job_ids, undefined, "no job_ids are invented for a permission-wide scope");
    }
  });

  it("reads NOTHING for an explicitly EMPTY job set, and never widens it to permission-wide", async () => {
    // `undefined` and `[]` are different scopes. Collapsing them meant a caller that resolved a
    // scope to zero reqs — a filter that matched nothing — got a count over the whole tenant.
    const reader = fakeScopedReader((toolName) => scopedSuccess(toolName, [offerRow(1)]));
    const { runtime } = testRuntime(reader);

    const result = await readHireSet(runtime, "test_tool", { jobIds: [], label: "no reqs" }, WINDOW, undefined, {
      includeChain: true,
      includeCandidates: true,
    });

    assert.equal(result.kind, "rows");
    if (result.kind !== "rows") return;
    assert.deepStrictEqual(result.hires, [], "zero reqs hire zero people");
    assert.equal(reader.calls.length, 0, "an empty explicit scope costs no upstream read at all");
    assert.equal(result.read.complete, true, "and it is a complete answer, not an incomplete one");
  });

  it("issues 3 offer reads for an explicit 120-job scope, 50 ids at a time", async () => {
    const reader = fakeScopedReader((toolName) => scopedSuccess(toolName, []));
    const { runtime } = testRuntime(reader);
    const jobIds = Array.from({ length: 120 }, (_, index) => 9_000_000 + index);

    await readHireSet(runtime, "test_tool", { jobIds, label: "120 named reqs" }, WINDOW, undefined, {});

    const offerCalls = reader.calls
      .filter((call) => call.toolName === "list_offers" && call.params?.["resolved_at[gte]"] !== undefined);
    assert.equal(offerCalls.length, 3, "120 explicit ids chunk into 50 + 50 + 20");
    const sent = offerCalls.map((call) => String(call.params?.job_ids ?? "").split(",").filter(Boolean).length);
    assert.deepStrictEqual(sent, [50, 50, 20]);
    const allIds = offerCalls.flatMap((call) => String(call.params?.job_ids ?? "").split(",").filter(Boolean));
    assert.deepStrictEqual([...new Set(allIds)].length, 120, "every named req is actually read");

    // The supplemental sent_on leg is a read of the same scope and chunks the same way; sending
    // 120 ids to it as one string is a URL Greenhouse will not answer.
    const fallbackCalls = reader.calls
      .filter((call) => call.toolName === "list_offers" && call.params?.["sent_on[gte]"] !== undefined);
    assert.deepStrictEqual(
      fallbackCalls.map((call) => String(call.params?.job_ids ?? "").split(",").filter(Boolean).length),
      [50, 50, 20],
      "the fallback-field leg chunks its job_ids too"
    );
  });
});

// ---------------------------------------------------------------------------
// H5: the optional enrichments are CONTAINED.
//
// The chain read, the candidate bridge and (on the line) the openings read are
// enrichments on top of a hire read that already succeeded. readAllScopedRows
// rethrows a 5xx, so an upstream failure on any of them used to escape as an
// exception and destroy a count that had already been computed. A cancellation
// is the one thing that still stops everything: the client is gone.
// ---------------------------------------------------------------------------
describe("H5 readHireSet — an optional enrichment never destroys the hire read", () => {
  function enrichmentReader(failing: "chain" | "candidates", thrown: Error) {
    return fakeScopedReader((toolName, params) => {
      if (toolName === "list_offers" && params?.current_only === false) {
        if (failing === "chain") throw thrown;
        return scopedSuccess(toolName, [offerRow(1)]);
      }
      if (toolName === "list_offers") return scopedSuccess(toolName, [offerRow(1)]);
      if (toolName === "list_candidates") {
        if (failing === "candidates") throw thrown;
        return scopedSuccess(toolName, [{ id: 1001, first_name: "Ada", last_name: "Hire" }]);
      }
      throw new Error(`unexpected scoped tool ${toolName}`);
    });
  }

  it("keeps the hires when the version chain read fails upstream", async () => {
    const reader = enrichmentReader("chain", new Error("Greenhouse API error: 500 Internal Server Error (/offers) [correlation_id=test]"));
    const { runtime } = testRuntime(reader);

    const result = await readHireSet(runtime, "test_tool", { label: "everything you can see" }, WINDOW, undefined, {
      includeChain: true,
    });

    assert.equal(result.kind, "rows", "a failed enrichment must not throw the hire read away");
    if (result.kind !== "rows") return;
    assert.equal(result.hires.length, 1);
    assert.equal(result.chain, undefined, "the chain says nothing rather than saying zero");
    assert.ok(
      result.read.warnings.some((warning) => /version chain/.test(warning)),
      `the failure is named, got ${JSON.stringify(result.read.warnings)}`
    );
  });

  it("keeps the hires when the candidate name bridge fails upstream", async () => {
    const reader = enrichmentReader("candidates", new Error("Greenhouse API error: 500 Internal Server Error (/candidates) [correlation_id=test]"));
    const { runtime } = testRuntime(reader);

    const result = await readHireSet(runtime, "test_tool", { label: "everything you can see" }, WINDOW, undefined, {
      includeCandidates: true,
    });

    assert.equal(result.kind, "rows");
    if (result.kind !== "rows") return;
    assert.equal(result.hires.length, 1);
    assert.equal(result.candidates, undefined);
    assert.ok(result.read.warnings.some((warning) => /candidate name bridge/.test(warning)));
  });

  for (const failing of ["chain", "candidates"] as const) {
    it(`propagates a cancellation on the ${failing} read instead of answering without it`, async () => {
      // read-all turns a cancellation into a CANCELLED DENIAL rather than an exception, so
      // degrading every denial to a warning answered a client that had already hung up.
      const reader = enrichmentReader(failing, new Error("SCOPED_GREENHOUSE_TOOL_CANCELLED"));
      const { runtime } = testRuntime(reader);

      const result = await readHireSet(runtime, "test_tool", { label: "everything you can see" }, WINDOW, undefined, {
        includeChain: failing === "chain",
        includeCandidates: failing === "candidates",
      });

      assert.equal(result.kind, "denial");
      if (result.kind !== "denial") return;
      assert.equal(result.result.ok === false && result.result.denial.code, "CANCELLED");
    });
  }
});

// ---------------------------------------------------------------------------
// H1c: names for the hires, bridged in 50-id chunks, with the private-candidate
// cost stated beside them.
// ---------------------------------------------------------------------------
describe("H1c readHireSet — the candidate bridge", () => {
  it("bridges candidate_ids in 50-id chunks and reports the withheld count", async () => {
    const hires = Array.from({ length: 120 }, (_, index) => offerRow(index + 1));
    const reader = fakeScopedReader((toolName, params) => {
      if (toolName === "list_offers") return scopedSuccess(toolName, hires);
      if (toolName === "list_candidates") {
        const ids = String(params?.ids ?? "").split(",").filter(Boolean).map(Number);
        // Greenhouse's private-candidate permission withholds one row per batch upstream.
        const returned = ids.slice(1).map((id) => ({ id, first_name: `First${id}`, last_name: "Hire", preferred_name: null }));
        return scopedSuccess(toolName, returned, null, {
          rowCounts: { raw: ids.length, returned: returned.length, permissionExcluded: 1, unresolved: 0, status: "complete", privacyWithheld: 1 },
        });
      }
      throw new Error(`unexpected scoped tool ${toolName}`);
    });
    const { runtime } = testRuntime(reader);

    const result = await readHireSet(runtime, "test_tool", { label: "everything you can see" }, WINDOW, undefined, {
      includeCandidates: true,
    });

    assert.equal(result.kind, "rows");
    if (result.kind !== "rows") return;
    const candidateCalls = reader.calls.filter((call) => call.toolName === "list_candidates");
    assert.equal(candidateCalls.length, 3, "120 candidate ids bridge as 50 + 50 + 20");
    assert.deepStrictEqual(
      candidateCalls.map((call) => String(call.params?.ids ?? "").split(",").filter(Boolean).length),
      [50, 50, 20]
    );
    assert.equal(result.candidates?.length, 117, "three withheld rows never arrive");
    assert.equal(result.candidatesRead?.privacyWithheld, 3, "and the cost of the withholding is stated");
    const named = result.hires.find((row) => row.id === 2) as Record<string, unknown>;
    assert.deepStrictEqual(named.candidate, { id: 1002, first_name: "First1002", last_name: "Hire" });
    const withheldHire = result.hires.find((row) => row.id === 1) as Record<string, unknown>;
    assert.ok(!("candidate" in withheldHire), "a withheld candidate is absent, never invented — no key at all");
  });

  it("reads the version chain keyed by the accepted set's application_ids when asked", async () => {
    const reader = fakeScopedReader((toolName, params) => {
      if (toolName === "list_offers" && params?.current_only === false) {
        return scopedSuccess(toolName, [
          { id: 1, job_id: 10, application_id: 101, status: "Accepted", version: 2, resolved_at: "2026-05-10T12:00:00.000Z" },
          { id: 9, job_id: 10, application_id: 101, status: "Deprecated", version: 1, resolved_at: "2026-05-01T12:00:00.000Z" },
        ]);
      }
      if (toolName === "list_offers") return scopedSuccess(toolName, [offerRow(1)]);
      throw new Error(`unexpected scoped tool ${toolName}`);
    });
    const { runtime } = testRuntime(reader);

    const result = await readHireSet(runtime, "test_tool", { label: "everything you can see" }, WINDOW, undefined, {
      includeChain: true,
    });

    assert.equal(result.kind, "rows");
    if (result.kind !== "rows") return;
    const chainCall = reader.calls.find((call) => call.params?.current_only === false);
    assert.ok(chainCall, "the chain read asks for every version, not just the current one");
    assert.equal(chainCall!.params?.application_ids, "101", "keyed by the accepted set's applications");
    assert.equal(chainCall!.params?.status, undefined, "a superseded version is not Accepted, so status must not filter it out");
    assert.equal(result.chain?.length, 2);
  });
});

// ---------------------------------------------------------------------------
// H4: an undated hire is disclosed, never silently dropped. requiredFields
// readiness is not enforced on the analysis path, so the honesty has to live in
// the fact builder itself.
// ---------------------------------------------------------------------------
describe("H4 buildHireFacts — dating a hire honestly", () => {
  it("dates a hire lacking resolved_at from sent_on, labels it, and counts it in omissions", () => {
    const built = buildHireFacts([
      offerRow(1, { resolved_at: "2026-05-10T12:00:00.000Z", sent_on: "2026-05-01" }),
      offerRow(2, { resolved_at: undefined, sent_on: "2026-05-02" }),
    ]);

    assert.equal(built.facts.length, 2, "the undated-by-resolved_at hire is NOT dropped");
    assert.equal(built.completeness, "complete");
    assert.deepStrictEqual(built.facts.map((fact) => fact.dated_from), ["resolved_at", "sent_on"]);
    assert.equal(built.facts[1]!.hired_at, "2026-05-02");
    assert.ok(
      built.omissions.some((line) => /sent_on/.test(line) && /1/.test(line)),
      `the sent_on fallback is disclosed, got ${JSON.stringify(built.omissions)}`
    );
  });

  it("excludes a hire with neither timestamp and says so", () => {
    const built = buildHireFacts([offerRow(1), offerRow(2, { resolved_at: undefined, sent_on: undefined })]);

    assert.equal(built.facts.length, 1);
    assert.ok(built.omissions.some((line) => /no resolved_at and no sent_on/.test(line)));
  });

  it("keeps only an exact Accepted status and discloses what it left out", () => {
    const built = buildHireFacts([
      offerRow(1),
      offerRow(2, { status: "Created" }),
      offerRow(3, { status: "Deprecated" }),
    ]);

    assert.deepStrictEqual(built.facts.map((fact) => fact.offer_id), [1]);
    assert.equal(built.completeness, "complete", "a non-accepted offer is out of scope, not a data defect");
    assert.ok(built.omissions.some((line) => /not Accepted/.test(line)));
  });

  // The status is classified against the ENUM the vendored contract publishes for
  // /v3/offers.status — Created / Accepted / Rejected / Deprecated — not by substring. A substring
  // read made "Not Accepted" a hire, which is the exact opposite of what the row says.
  it("classifies against the /v3/offers status enum the generated registry publishes", () => {
    const statusParam = getHarvestEndpointByPath("/v3/offers")?.parameters?.find((param) => param.name === "status");
    assert.deepStrictEqual(
      statusParam?.enumValues,
      ["Created", "Accepted", "Rejected", "Deprecated"],
      "the contract's own enum is the list this classifier is written against"
    );
    assert.deepStrictEqual(
      (statusParam?.enumValues ?? []).map((value) => classifyOfferStatus(value)),
      ["outstanding", "accepted", "rejected", "superseded"]
    );
  });

  it("does not read 'Not Accepted' as a hire, and tolerates case and whitespace on the real value", () => {
    const built = buildHireFacts([
      offerRow(1, { status: "ACCEPTED " }),
      offerRow(2, { status: "Not Accepted" }),
    ]);

    assert.deepStrictEqual(built.facts.map((fact) => fact.offer_id), [1], "'Not Accepted' is a refusal, not a hire");
    assert.equal(classifyOfferStatus("Not Accepted"), "unknown");
    assert.equal(classifyOfferStatus("ACCEPTED "), "accepted");
  });

  it("counts a status it does not recognize as an omission rather than guessing at it", () => {
    const built = buildHireFacts([offerRow(1), offerRow(2, { status: "Verbal yes" })]);

    assert.deepStrictEqual(built.facts.map((fact) => fact.offer_id), [1]);
    assert.ok(
      built.omissions.some((line) => /Verbal yes/.test(line) && /not.*recognized|unrecognized/i.test(line)),
      `the unrecognized value is named, got ${JSON.stringify(built.omissions)}`
    );
  });

  it("carries the offer's custom_fields, starts_on, version and opening_id", () => {
    const built = buildHireFacts([
      offerRow(1, { starts_on: "2026-07-01", version: 3, custom_fields: { base_salary: { amount: "1", currency_code: "USD" } } }),
    ]);

    assert.equal(built.facts[0]!.starts_on, "2026-07-01");
    assert.equal(built.facts[0]!.version, 3);
    assert.equal(built.facts[0]!.opening_id, 5);
    assert.deepStrictEqual(built.facts[0]!.custom_fields, { base_salary: { amount: "1", currency_code: "USD" } });
  });

  it("feeds hire_count, whose omissions carry the dating disclosure through to the answer", () => {
    const built = buildHireFacts([offerRow(1), offerRow(2, { resolved_at: undefined, sent_on: "2026-05-02" })]);
    const metric = computeMetric("hire_count", { facts: { hire_fact: built } });

    assert.equal(metric.completeness, "complete");
    assert.equal(metric.value, 2);
    assert.equal(metric.unit, "count");
    assert.ok(metric.omissions.some((line) => /sent_on/.test(line)));
  });
});

// ---------------------------------------------------------------------------
// H-cost: on the privacy-only branches every offer batch also walks
// application_id AND candidate_id upstream. The guard has to count UPSTREAM
// reads (pagination and the privacy walk included), not scoped-tool calls.
//
// The fixture 422s the bracketed request, because that is what the LIVE
// /v3/offers endpoint does and therefore the only path this cost is ever paid
// on. Measuring the native-filter path measured a route production never takes.
//
// MEASURED for one org-wide 500-hire read by an UNATTESTED actor: 22 upstream
// reads — 1 rejected bracket attempt, 1 bracket-free /offers page, 10
// /applications batches and 10 /candidates batches, the privacy walk paying 50
// ids at a time for each of the offer row's two carriers. The per-endpoint
// breakdown is asserted EXACTLY as well as against the ceiling: a ceiling alone
// stayed green when the privacy walk was deleted entirely (one /offers call
// still returns 500 hires), which is the one regression this test exists to
// catch. The ceiling is stated too, and loosely enough that a batching
// IMPROVEMENT does not fail the suite.
// ---------------------------------------------------------------------------
const ORG_WIDE_500_HIRE_UPSTREAM_READ_CEILING = 30;

// The 422 branch's own cost, which is the expensive one and the one live traffic
// pays. The fallback re-reads UNWINDOWED, so the privacy walk is paid over every
// row in scope and not just the ones the window keeps: 2,000 accepted offers in
// scope of which 500 land in the window cost 82 upstream reads — 1 rejected
// bracket attempt, 1 /offers page, 40 /applications and 40 /candidates batches —
// i.e. 16.4 reads per 100 rows the caller actually gets back.
//
// KNOWN AND DELIBERATELY NOT FIXED HERE: the structural fix is to apply the local
// window INSIDE scoped-core's privacy-only branch, before the carrier walk, so
// the walk pays for the windowed set rather than the scoped one. That is a
// scoped-core change and a follow-up, not this fold. The live blast radius is
// bounded because an ATTESTED actor takes the raw fast path and never walks at
// all; only unattested all-access actors pay this.
//
// MEASURED WITH PAGINATION (Greenhouse pages at 500): 85 upstream reads, not the
// 82 the single-page fixture reported — 1 rejected bracket attempt, 4 /offers
// pages, 40 /applications and 40 /candidates batches. 17 reads per 100 rows
// returned.
const UNWINDOWED_2000_ROW_UPSTREAM_READ_CEILING = 90;

function countingOfferReader(offers: Array<Record<string, unknown>>) {
  const calls: Array<{ path: string; params?: ReadParams }> = [];
  const rawReader: RawReadClient = {
    async read<T>(path: string, params?: ReadParams, cursor?: string): Promise<ApiResponse<T>> {
      calls.push({ path, params });
      if (path === "/offers") {
        // The live behaviour: every date filter the vendored contract advertises is rejected.
        if (Object.keys(params ?? {}).some((key) => /\[(gte|lte|gt|lt)\]$/.test(key))) {
          throw new Error("Greenhouse API error: 422 Unprocessable Entity (/offers) [correlation_id=test]");
        }
        // And the other live behaviour this fixture used to skip: Greenhouse PAGES. Handing back
        // 2,000 rows in one response measured a read that cannot happen, and hid four pages of
        // cost behind one call.
        // The cursor is the reader's THIRD argument, never a param (scoped-core refuses to combine
        // the two), so a fake that reads params.cursor pages for ever against a cursor guard.
        const perPage = Number(params?.per_page ?? 500);
        const start = cursor === undefined ? 0 : Number(cursor);
        const page = offers.slice(start, start + perPage);
        const nextStart = start + perPage;
        return { data: page as T, nextCursor: nextStart < offers.length ? String(nextStart) : null };
      }
      if (path === "/applications") {
        const ids = String(params?.ids ?? "").split(",").filter(Boolean).map(Number);
        return { data: ids.map((id) => ({ id, job_id: 10, candidate_id: id + 900 })) as T, nextCursor: null };
      }
      if (path === "/candidates") {
        const ids = String(params?.ids ?? "").split(",").filter(Boolean).map(Number);
        return { data: ids.map((id) => ({ id, private: false })) as T, nextCursor: null };
      }
      return { data: [] as unknown as T, nextCursor: null };
    },
  };
  // The unattested direct-operator branch: no attestation lookup at all, which is the
  // fail-closed direction, and the branch that pays for the whole privacy walk.
  const scopedReader = createScopedGreenhouseReader<AuthenticatedSession>({
    rawReader,
    actorResolver: { resolveActor: () => 100 },
    permissionProvider: { getPermittedJobIds: async () => new Set<number>([10]) },
    operatorActorIds: new Set([100]),
    scopePolicyRegistry: SCOPED_TOOL_SCOPE_POLICIES,
  });
  return { calls, scopedReader };
}

function byPath(calls: Array<{ path: string }>): Record<string, number> {
  return calls.reduce<Record<string, number>>((acc, call) => ({ ...acc, [call.path]: (acc[call.path] ?? 0) + 1 }), {});
}

describe("H-cost readHireSet — upstream read cost for an org-wide hire read", () => {
  it("keeps a 500-offer org-wide read under the stated upstream-read ceiling, walking every carrier", async () => {
    const offers = Array.from({ length: 500 }, (_, index) => offerRow(index + 1));
    const { calls, scopedReader } = countingOfferReader(offers);
    const { runtime } = testRuntime(scopedReader, { session: testSession() });

    const result = await readHireSet(runtime, "test_tool", { label: "everything you can see" }, WINDOW, undefined, {});

    assert.equal(result.kind, "rows");
    if (result.kind !== "rows") return;
    assert.equal(result.hires.length, 500, "every hire survives a walk that finds no private candidate");
    assert.equal(result.read.windowAppliedLocally, true, "the measured path is the live one: the bracket attempt 422'd");
    assert.deepStrictEqual(
      byPath(calls),
      { "/offers": 2, "/applications": 10, "/candidates": 10 },
      "the privacy walk is 50 ids at a time over BOTH carriers; deleting it would show as 1 offers call and nothing else"
    );
    assert.ok(
      calls.length <= ORG_WIDE_500_HIRE_UPSTREAM_READ_CEILING,
      `500 org-wide hires cost ${calls.length} upstream reads, over the ${ORG_WIDE_500_HIRE_UPSTREAM_READ_CEILING} ceiling: ${JSON.stringify(byPath(calls))}`
    );
  });

  it("states the 422 branch's cost over the UNWINDOWED set, which is larger than the window", async () => {
    // 2,000 accepted offers in scope; only 500 resolved inside Q2. The fallback leg reads all
    // 2,000 (the window cannot be pushed down), so the privacy walk is priced on 2,000 rows.
    const offers = Array.from({ length: 2000 }, (_, index) =>
      offerRow(index + 1, index < 500 ? {} : { resolved_at: "2026-01-10T12:00:00.000Z" })
    );
    const { calls, scopedReader } = countingOfferReader(offers);
    const { runtime } = testRuntime(scopedReader, { session: testSession() });

    const result = await readHireSet(runtime, "test_tool", { label: "everything you can see" }, WINDOW, undefined, {});

    assert.equal(result.kind, "rows");
    if (result.kind !== "rows") return;
    assert.equal(result.hires.length, 500, "the local window keeps a quarter of what the walk paid for");
    assert.deepStrictEqual(
      byPath(calls),
      // 1 rejected bracket attempt + 4 pages of 500, then the privacy walk paying 50 ids at a time
      // over both carriers on every page: 4 x (10 + 10).
      { "/offers": 5, "/applications": 40, "/candidates": 40 },
      "the walk is priced on the UNWINDOWED set — this is the cost the scoped-core follow-up removes"
    );
    assert.ok(
      calls.length <= UNWINDOWED_2000_ROW_UPSTREAM_READ_CEILING,
      `${calls.length} upstream reads is over the ${UNWINDOWED_2000_ROW_UPSTREAM_READ_CEILING} ceiling: ${JSON.stringify(byPath(calls))}`
    );
    const perHundredReturned = (calls.length / result.hires.length) * 100;
    assert.ok(
      perHundredReturned <= 20,
      `${perHundredReturned.toFixed(1)} upstream reads per 100 rows returned is over the stated 20`
    );
  });
});

// ---------------------------------------------------------------------------
// H1d: what "this row carries a date" means, and where the window's edges are.
//
// Three defects the fold-3 attack found in one helper: a malformed primary date
// suppressed a valid fallback one while the read still read as complete; an
// EXCLUSIVE lower bound was expanded to the end of its day, so a timestamp after
// the boundary was excluded through the whole of that day; and the missing-date
// count from every supplemental leg was computed and thrown away.
// ---------------------------------------------------------------------------
describe("H1d readAllWithDateFallback — parseable dates, exclusive bounds, honest missing counts", () => {
  it("dates a hire from sent_on when resolved_at is present but unparseable", async () => {
    // `isPresentString` accepted any non-empty string, so "garbage" read as a date, lost the
    // string comparison against the window's upper bound and dropped the row — silently, because
    // the row HAD a value in the primary field so it never counted as missing either.
    const reader = fakeScopedReader((toolName, params) => {
      if (Object.keys(params ?? {}).some((key) => /\[(gte|lte|gt|lt)\]$/.test(key))) {
        throw new Error("Greenhouse API error: 422 Unprocessable Entity (/offers) [correlation_id=test]");
      }
      return scopedSuccess(toolName, [
        offerRow(1),
        offerRow(8, { resolved_at: "garbage", sent_on: "2026-05-05" }),
      ]);
    });
    const { runtime } = testRuntime(reader);

    const result = await readHireSet(runtime, "test_tool", { label: "everything you can see" }, WINDOW, undefined, {});

    assert.equal(result.kind, "rows");
    if (result.kind !== "rows") return;
    assert.deepStrictEqual(
      result.hires.map((row) => row.id),
      [1, 8],
      "an unparseable resolved_at is not a date, so the declared sent_on fallback places the row"
    );
    assert.equal(result.read.rowsMissingField, 0, "the row was placed on a clock, so nothing is missing");
  });

  it("recovers the sent_on-only leg's rows past an unparseable primary date", async () => {
    // The structural-disjointness check has the same definition of "present": a row whose
    // resolved_at is junk could never have come back from the resolved_at leg, so the sent_on leg
    // is the only place it can be recovered from.
    const reader = fakeScopedReader((toolName, params) => {
      if (params?.["sent_on[gte]"] !== undefined) {
        return scopedSuccess(toolName, [
          offerRow(8, { resolved_at: "garbage", sent_on: "2026-05-05" }),
          offerRow(1),
        ]);
      }
      return scopedSuccess(toolName, [offerRow(1)]);
    });
    const { runtime } = testRuntime(reader);

    const result = await readHireSet(runtime, "test_tool", { label: "everything you can see" }, WINDOW, undefined, {});

    assert.equal(result.kind, "rows");
    if (result.kind !== "rows") return;
    assert.deepStrictEqual(
      result.hires.map((row) => row.id),
      [1, 8],
      "the row the primary filter structurally could not return is recovered exactly once"
    );
  });

  it("treats an exclusive lower bound as an instant, not as the end of its day", async () => {
    // `gt` was routed through the INCLUSIVE upper-bound expansion, so gt:"2026-05-01" excluded
    // everything up to 2026-05-01T23:59:59.999Z — a whole day of rows the caller asked for.
    const reader = fakeScopedReader((toolName, params) => {
      if (Object.keys(params ?? {}).some((key) => /\[(gte|lte|gt|lt)\]$/.test(key))) {
        throw new Error("Greenhouse API error: 422 Unprocessable Entity (/offers) [correlation_id=test]");
      }
      return scopedSuccess(toolName, [
        { id: 1, job_id: 10, status: "Accepted", resolved_at: "2026-05-01T12:00:00.000Z" },
        { id: 2, job_id: 10, status: "Accepted", resolved_at: "2026-05-01T00:00:00.000Z" },
      ]);
    });
    const { runtime } = testRuntime(reader);

    const outcome = await readAllWithDateFallback(
      runtime,
      "test_tool",
      "list_offers",
      { "resolved_at[gt]": "2026-05-01" },
      [{ field: "resolved_at", gt: "2026-05-01" }]
    );

    assert.equal(outcome.read.kind, "rows");
    if (outcome.read.kind !== "rows") return;
    assert.deepStrictEqual(
      outcome.read.rows.map((row) => row.id),
      [1],
      "12:00 on the bound date is AFTER the exclusive bound; midnight exactly is not"
    );
  });

  it("keeps an inclusive upper bound end-of-day for a date-only value", async () => {
    const reader = fakeScopedReader((toolName, params) => {
      if (Object.keys(params ?? {}).some((key) => /\[(gte|lte|gt|lt)\]$/.test(key))) {
        throw new Error("Greenhouse API error: 422 Unprocessable Entity (/offers) [correlation_id=test]");
      }
      return scopedSuccess(toolName, [
        { id: 1, job_id: 10, status: "Accepted", resolved_at: "2026-05-01T12:00:00.000Z" },
        { id: 2, job_id: 10, status: "Accepted", resolved_at: "2026-05-02T00:00:00.001Z" },
      ]);
    });
    const { runtime } = testRuntime(reader);

    const outcome = await readAllWithDateFallback(
      runtime,
      "test_tool",
      "list_offers",
      { "resolved_at[lte]": "2026-05-01" },
      [{ field: "resolved_at", lte: "2026-05-01" }]
    );

    assert.equal(outcome.read.kind, "rows");
    if (outcome.read.kind !== "rows") return;
    assert.deepStrictEqual(outcome.read.rows.map((row) => row.id), [1], "a timestamp ON the lte date stays in window");
  });

  it("carries the supplemental leg's missing-date count into the outcome", async () => {
    // The sent_on leg 422s, so its own bracket-free re-read returns the whole scoped set — and one
    // of those rows carries NEITHER clock. It is excluded, and before this the exclusion was
    // computed on the leg and dropped on the floor: the outer outcome hardcoded zero.
    const reader = fakeScopedReader((toolName, params) => {
      if (params?.["sent_on[gte]"] !== undefined) {
        throw new Error("Greenhouse API error: 422 Unprocessable Entity (/offers) [correlation_id=test]");
      }
      if (params?.["resolved_at[gte]"] !== undefined) return scopedSuccess(toolName, [offerRow(1)]);
      return scopedSuccess(toolName, [
        offerRow(1),
        offerRow(4, { resolved_at: undefined, sent_on: "2026-05-05" }),
        offerRow(5, { resolved_at: undefined, sent_on: undefined }),
      ]);
    });
    const { runtime } = testRuntime(reader);

    const outcome = await readAllWithDateFallback(
      runtime,
      "test_tool",
      "list_offers",
      { "resolved_at[gte]": WINDOW.start, "resolved_at[lte]": WINDOW.end },
      [{ field: "resolved_at", fallbackFields: ["sent_on"], gte: WINDOW.start, lte: WINDOW.end }]
    );

    assert.equal(outcome.read.kind, "rows");
    if (outcome.read.kind !== "rows") return;
    assert.deepStrictEqual(outcome.read.rows.map((row) => row.id), [1, 4]);
    assert.equal(outcome.rowsMissingField, 1, "the row with neither clock is counted by the leg that found it");
  });

  it("does not count a row the PRIMARY leg already dated as missing on the fallback leg", async () => {
    // The leg's own local window drops every row without sent_on, including the ones the primary
    // field dates perfectly well. Folding that raw number up would report most of the scoped set as
    // undatable; only the rows this leg was responsible for count.
    const reader = fakeScopedReader((toolName, params) => {
      if (params?.["sent_on[gte]"] !== undefined) {
        throw new Error("Greenhouse API error: 422 Unprocessable Entity (/offers) [correlation_id=test]");
      }
      if (params?.["resolved_at[gte]"] !== undefined) return scopedSuccess(toolName, [offerRow(1, { sent_on: undefined })]);
      return scopedSuccess(toolName, [offerRow(1, { sent_on: undefined })]);
    });
    const { runtime } = testRuntime(reader);

    const outcome = await readAllWithDateFallback(
      runtime,
      "test_tool",
      "list_offers",
      { "resolved_at[gte]": WINDOW.start, "resolved_at[lte]": WINDOW.end },
      [{ field: "resolved_at", fallbackFields: ["sent_on"], gte: WINDOW.start, lte: WINDOW.end }]
    );

    assert.equal(outcome.rowsMissingField, 0, "a row the primary clock places is not this leg's missing row");
  });
});

// ---------------------------------------------------------------------------
// H5b: a REQUESTED enrichment that failed is not the same as one nobody asked
// for. Both leave the field unset; only the first one makes the set short, and
// only the first one may make a status incomplete.
// ---------------------------------------------------------------------------
describe("H5b readHireSet — a requested enrichment that failed says so in a status", () => {
  function reader500(failing: "chain" | "candidates") {
    return fakeScopedReader((toolName, params) => {
      if (toolName === "list_offers" && params?.current_only === false) {
        if (failing === "chain") throw new Error("Greenhouse API error: 500 Internal Server Error (/offers) [correlation_id=test]");
        return scopedSuccess(toolName, [offerRow(1)]);
      }
      if (toolName === "list_offers") return scopedSuccess(toolName, [offerRow(1)]);
      if (toolName === "list_candidates") {
        if (failing === "candidates") throw new Error("Greenhouse API error: 500 Internal Server Error (/candidates) [correlation_id=test]");
        return scopedSuccess(toolName, [{ id: 1001, first_name: "Ada" }]);
      }
      throw new Error(`unexpected scoped tool ${toolName}`);
    });
  }

  it("reports a requested chain read that failed as incomplete_upstream, not as unread", async () => {
    const { runtime } = testRuntime(reader500("chain"));

    const result = await readHireSet(runtime, "test_tool", { label: "everything you can see" }, WINDOW, undefined, {
      includeChain: true,
    });

    assert.equal(result.kind, "rows");
    if (result.kind !== "rows") return;
    assert.equal(result.chain, undefined, "no rows are invented for a read that failed");
    assert.equal(result.chainRead?.status, "incomplete_upstream", "a requested read that failed carries a status");
    assert.equal(result.chainRead?.complete, false);
    assert.equal(result.read.complete, true, "the HIRE read itself completed and still says so");
  });

  it("reports a requested candidate bridge that failed as incomplete_upstream", async () => {
    const { runtime } = testRuntime(reader500("candidates"));

    const result = await readHireSet(runtime, "test_tool", { label: "everything you can see" }, WINDOW, undefined, {
      includeCandidates: true,
    });

    assert.equal(result.kind, "rows");
    if (result.kind !== "rows") return;
    assert.equal(result.candidates, undefined);
    assert.equal(result.candidatesRead?.status, "incomplete_upstream");
  });

  it("leaves an enrichment NOBODY asked for with no status at all", async () => {
    const { runtime } = testRuntime(reader500("chain"));

    const result = await readHireSet(runtime, "test_tool", { label: "everything you can see" }, WINDOW, undefined, {});

    assert.equal(result.kind, "rows");
    if (result.kind !== "rows") return;
    assert.equal(result.chainRead, undefined, "not asked for is not incomplete");
    assert.equal(result.candidatesRead, undefined);
    assert.equal(result.read.complete, true);
  });
});
