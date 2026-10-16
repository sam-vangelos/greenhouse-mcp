import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The two authorization planes share no code, so every cross-cutting rule has to be written twice —
 * and nothing fails when it is written once. This file is what makes that failure loud.
 *
 * The read plane (`scoped-greenhouse`) enforces by FILTERING: it computes a permitted-job-id set per
 * request and drops rows. The write plane (`action-mcp`) enforces by GATING: `assertJobAccess`
 * throws per mutation, re-derived live on preview and on apply. A filter cannot express "deny
 * loudly" and a gate cannot express "redact this field", which is why they were built separately and
 * why they drift.
 *
 * Two mechanical guarantees, plus a ledger:
 *
 *   1. Every write action reaches the job-scope gate. A new action that forgets it fails here.
 *   2. The set of KNOWN divergences is exactly what is recorded below. A new one fails; so does a
 *      FIXED one, which forces the ledger to stay honest rather than rot into folklore.
 *
 * Until the planes merge, `action-mcp` is not in this tree. The checks then report as dormant rather
 * than passing silently — a skipped check that looks green is how this class of bug survives.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ACTION_PLANE = join(HERE, "../../action-mcp/src");
const ACTIONS_DIR = join(ACTION_PLANE, "actions");

/** Helpers that establish the actor may touch this job at all. */
const JOB_SCOPE_GATES = ["assertJobAccess", "authorizedApplication"];

/** Files under actions/ that are shared machinery rather than a mutation definition. */
const NOT_AN_ACTION = new Set(["shared.ts", "types.ts", "index.ts", "offer-shared.ts"]);

/**
 * Divergences that have been reviewed and consciously deferred. Each is a rule that exists in one
 * plane and not the other, with the place it gets resolved. Adding to this list is a decision;
 * discovering something not on it is a defect.
 */
const KNOWN_DIVERGENCES: ReadonlyArray<{ rule: string; livesIn: string; absentFrom: string; resolvedBy: string }> = [
  {
    rule: "identity resolution shape",
    livesIn: "read plane resolves on email AND subject, honouring table/column overrides",
    absentFrom:
      "write plane resolves on subject ONLY and hardcodes the relation and column names",
    resolvedBy:
      "Phase 2 compositional fix: the action plane must be HANDED the resolved identity. Fenced " +
      "structurally in the meantime — a custom identity relation withholds the write plane entirely.",
  },
];

/**
 * The two divergences RESOLVED by Phase 2c, kept here as locks rather than deleted, because a
 * resolved divergence that quietly reopens is the original defect with better camouflage.
 *
 * 1. private-candidate gate — resolved by the visibility fence: every prepared action carries
 *    fenceTargets, and the service probes them through the acting human's own read pipeline on both
 *    preview and apply (2026-07-30).
 * 2. private-custom-field handling — resolved by the fence (redaction verdicts deny writes that
 *    would read withheld values) plus the Slice 6 repair: archived definitions load for
 *    PRESERVATION, while requested writes still refuse inactive definitions and options.
 */
const RESOLVED_DIVERGENCE_LOCKS = [
  {
    rule: "private-candidate gate (fence)",
    file: join(ACTION_PLANE, "service.ts"),
    mustContain: ["assertTargetsVisible(prepared.fenceTargets)", "assertTargetsVisible(freshPrepared.fenceTargets)"],
    orItReopened:
      "the fence stopped running on preview or on apply — the write plane can once again touch " +
      "records the read plane withholds from the acting human",
  },
  {
    rule: "custom-field archived-definition preservation (Slice 6)",
    file: join(ACTION_PLANE, "custom-fields.ts"),
    mustContain: ["is not active for"],
    mustNotContain: ['active: "true"'],
    orItReopened:
      "either the requested-write gate stopped refusing archived definitions, or the definition " +
      "load re-narrowed to active-only — which made any candidate carrying an archived-definition " +
      "value unwritable at all",
  },
] as const;

function actionFiles(): string[] {
  return readdirSync(ACTIONS_DIR)
    .filter((file) => file.endsWith(".ts") && !NOT_AN_ACTION.has(file));
}

describe("write plane / read plane authorization parity", () => {
  it("records every reviewed divergence with where it gets resolved", () => {
    // One divergence remains open (identity resolution). The other two were resolved by the
    // Phase 2c fence and Slice 6; their locks below fail if either quietly reopens.
    assert.equal(KNOWN_DIVERGENCES.length, 1);
    for (const divergence of KNOWN_DIVERGENCES) {
      assert.ok(divergence.resolvedBy.length > 0, `${divergence.rule} has no resolution plan`);
    }
  });

  it("puts every write action behind the job-scope gate", () => {
    if (!existsSync(ACTIONS_DIR)) {
      // Dormant, and saying so out loud. This is the merge's tripwire, armed in advance.
      console.log(
        "[plane-parity] action-mcp is not in this tree yet — the job-scope sweep is DORMANT and " +
          "will arm itself when the write plane merges. It is not passing; it has not run."
      );
      return;
    }

    const ungated = actionFiles().filter((file) => {
      const source = readFileSync(join(ACTIONS_DIR, file), "utf8");
      return !JOB_SCOPE_GATES.some((gate) => source.includes(gate));
    });

    assert.deepEqual(
      ungated,
      [],
      "these write actions never reach assertJobAccess (directly or via authorizedApplication), so " +
        "they mutate without establishing that the actor may touch the job at all"
    );
  });

  it("fails when a RESOLVED divergence quietly reopens", () => {
    if (!existsSync(ACTION_PLANE)) {
      console.log(
        "[plane-parity] action-mcp is not in this tree yet — the divergence sweep is DORMANT."
      );
      return;
    }

    for (const lock of RESOLVED_DIVERGENCE_LOCKS) {
      const source = readFileSync(lock.file, "utf8");
      for (const marker of lock.mustContain) {
        assert.ok(source.includes(marker), `${lock.rule}: missing "${marker}" — ${lock.orItReopened}`);
      }
      if ("mustNotContain" in lock) {
        for (const marker of lock.mustNotContain) {
          assert.ok(!source.includes(marker), `${lock.rule}: found "${marker}" — ${lock.orItReopened}`);
        }
      }
    }
  });
});
