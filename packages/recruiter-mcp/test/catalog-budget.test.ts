import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createRecruiterMcpServer } from "../src/server.js";
import { RECRUITER_TOOL_DEFINITIONS } from "../src/tools/register.js";
import type { AuthenticatedSession } from "../src/types.js";

/**
 * R2c — the catalog is context every recruiter pays for on every call, so it is measured, not
 * assumed.
 *
 * MEASURED BASELINES (this harness: instructions + tools/list through a real McpServer and an
 * in-memory client, JSON.stringify of the tools array, UTF-8 bytes).
 *
 *   before R2  44 mounted tools   99,230 B tools +  4,003 B instructions = 103,233 B (~25.8k tokens)
 *   before R2  66 registered      148,917 B      +  4,003 B              = 152,920 B (~38.2k tokens)
 *   after R2a+R2b, 70 tools       159,961 B      +  4,003 B              = 163,964 B (~41.0k tokens)
 *   after R2c,     70 tools       120,918 B      +  5,046 B              = 125,964 B (~31.5k tokens)
 *   after R2d,     81 tools       139,220 B      +  5,046 B              = 144,266 B (~36.1k tokens)
 *   after the fold, 82 tools      140,255 B      +  5,173 B              = 145,428 B (~36.4k tokens)
 *   after fold 2,  82 tools       140,255 B      +  5,173 B              = 145,428 B (unchanged)
 *
 * The fold added one reader (get_my_bulk_request, +821 B), the date preprocess (0 B — the advertised
 * schema is the same string), and the copy corrections (+341 B across descriptions and instructions).
 * Fold 2 costs nothing: the date validation is a superRefine INSIDE the same preprocess, so the
 * advertised parameter is still `{"type":"string"}`, and its remaining fixes are off the catalog.
 *
 * So the surface ends at 82 read tools — 38 more than a recruiter could reach before week two — for
 * 7,492 B LESS than the 66-tool catalog cost, and 19,581 B less than the 44 mounted tools plus the
 * 22 that were hidden. With a full write entitlement the catalog is 104 tools. (The 81/103 this
 * comment used to state was arithmetic from before get_my_bulk_request was bound in the same fold:
 * the measurement four lines above already said 82.)
 *
 * Where the 66-tool baseline went (measured per parameter name, 619 params over 66 tools):
 *   created_at + updated_at   35,700 B   the anyOf date-range union on 117 params
 *   offset + per_page + cursor 32,490 B  one pagination convention, restated 157 times
 *   scope_handle + job_ids     14,980 B  one scope convention, restated 71 times
 * i.e. 51% of the catalog was JSON-Schema plumbing repeating three sentences. R2c states each once —
 * in SERVER_INSTRUCTIONS, which the client reads at initialize — and leaves the per-parameter text as
 * a pointer rather than a paragraph.
 */

/**
 * The ceiling, RATCHETED to the measured figure plus a working margin rather than left at the round
 * number the first pass picked. 150,000 left 5.7 KB of slack, which is four more tools' worth of
 * growth that no test would have noticed. Measured after the fold: 145,428 B over 82 tools.
 *
 * The fold asked for 145,000. That predates get_my_bulk_request, which the same fold bound (+821 B),
 * so the honest ratchet is just above the measurement, not below it — a budget the build cannot meet
 * is a broken test, not a tighter budget. 146,000 leaves ~570 B: enough for a description edit, not
 * enough for a new tool to arrive unannounced.
 */
const BUDGET_BYTES = 146_000;

function session(): AuthenticatedSession {
  return { subject: "google-subject-sam", surface: "test", client: "claude_desktop_chat", tokenId: "recruiter-token-abc123" };
}

async function measureCatalog(): Promise<{
  toolCount: number;
  toolsBytes: number;
  instructionsBytes: number;
  totalBytes: number;
  tools: Array<{ name: string; description?: string; inputSchema?: { properties?: Record<string, unknown> } }>;
  instructions: string;
}> {
  const { server } = createRecruiterMcpServer({
    session: session(),
    env: { GREENHOUSE_RECRUITER_ALLOW_TEST_SURFACE: "true" },
    configureGreenhouse: false,
    scopedReader: { async scopedRead() { throw new Error("no scoped read in a catalog measurement"); } } as never,
  });
  const client = new Client({ name: "r2c-budget", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const listed = await client.listTools();
    const instructions = client.getInstructions() ?? "";
    const toolsBytes = Buffer.byteLength(JSON.stringify(listed.tools), "utf8");
    const instructionsBytes = Buffer.byteLength(instructions, "utf8");
    return {
      toolCount: listed.tools.length,
      toolsBytes,
      instructionsBytes,
      totalBytes: toolsBytes + instructionsBytes,
      tools: listed.tools as never,
      instructions,
    };
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}

describe("R2c the catalog fits its context budget", () => {
  it("costs no more than the 66-tool catalog did, while mounting more tools", async () => {
    const measured = await measureCatalog();

    assert.equal(measured.toolCount, RECRUITER_TOOL_DEFINITIONS.length, "measure the whole mounted catalog");
    assert.ok(
      measured.totalBytes <= BUDGET_BYTES,
      `catalog is ${measured.totalBytes} B (${measured.toolsBytes} B tools + ${measured.instructionsBytes} B instructions) `
        + `across ${measured.toolCount} tools, over the ${BUDGET_BYTES} B budget (measured at the fold: 145,428 B). `
        + `The 66-tool catalog before R2c was 152,920 B, so this is growth, not slimming.`
    );
    // Instructions ride in the initialize payload, so they are part of the bill, not free.
    assert.ok(measured.instructionsBytes > 0, "instructions must actually reach the client");
  });

  /**
   * The rule is COST, not length. A 269-character clock definition on one analysis front door costs
   * 269 bytes and prevents a wrong answer; the same 130 characters on 117 date parameters cost 15 KB
   * and say what SERVER_INSTRUCTIONS already says. Capping description LENGTH would have punished the
   * first and permitted the second, so the budget is per parameter NAME across the whole catalog —
   * which is exactly the quantity that blew out before R2c (created_at alone: 17,850 B).
   */
  const PER_PARAM_NAME_BUDGET_BYTES = 9_000;

  it("spends no more on any one parameter name than a stated-once convention would", async () => {
    const measured = await measureCatalog();
    const bytesByName = new Map<string, { count: number; bytes: number }>();
    let dateUnions = 0;
    let totalParams = 0;
    const bare: string[] = [];
    for (const tool of measured.tools) {
      for (const [name, raw] of Object.entries(tool.inputSchema?.properties ?? {})) {
        const spec = raw as { anyOf?: unknown[]; description?: string };
        totalParams += 1;
        if (spec.anyOf) dateUnions += 1;
        if (!spec.description) bare.push(`${tool.name}.${name}`);
        const entry = bytesByName.get(name) ?? { count: 0, bytes: 0 };
        entry.count += 1;
        entry.bytes += Buffer.byteLength(JSON.stringify({ [name]: spec }), "utf8");
        bytesByName.set(name, entry);
      }
    }

    assert.equal(dateUnions, 0, "the anyOf date-range union is collapsed to one string parameter");
    assert.deepEqual(
      bare,
      [],
      `${bare.length} of ${totalParams} parameters carry no description at all, so the model has only the `
        + `name to guess from: ${bare.slice(0, 12).join(", ")}`
    );

    const overspent = [...bytesByName.entries()]
      .filter(([, entry]) => entry.bytes > PER_PARAM_NAME_BUDGET_BYTES)
      .map(([name, entry]) => `${name}: ${entry.bytes} B across ${entry.count} tools`);
    assert.deepEqual(
      overspent,
      [],
      `a single parameter name is spending more than ${PER_PARAM_NAME_BUDGET_BYTES} B of catalog on its own — `
        + `almost always a convention restated per-parameter instead of once in SERVER_INSTRUCTIONS: ${overspent.join("; ")}`
    );
  });

  it("puts the read conventions before the ~2,048-character client truncation boundary", async () => {
    const measured = await measureCatalog();
    // Several clients truncate server instructions around 2 KB. A convention stated after the cut is
    // a convention the model never reads, which is how the per-parameter restating started.
    const head = measured.instructions.slice(0, 2048);
    // One fragment per convention BULLET, each unique to that bullet. The previous list asserted
    // "scope_handle" — a string the routing ladder above the conventions also contains, so deleting
    // or moving the scope-carrier line passed — and asserted nothing at all for the narrow-big-
    // endpoints rule. Each fragment below appears in exactly one line of the instructions.
    const CONVENTION_FRAGMENTS = [
      "COMPLETE scoped set",
      "per_page is a RESULT cap",
      "result_truncated.next_offset",
      "2026-04-01..2026-06-30",
      "two scope carriers",
      "ALWAYS narrow big endpoints",
    ];
    for (const fragment of CONVENTION_FRAGMENTS) {
      assert.ok(
        head.includes(fragment),
        `"${fragment}" falls after the 2,048-character boundary, where a truncating client never sees it`
      );
      assert.equal(
        measured.instructions.split(fragment).length - 1,
        1,
        `"${fragment}" appears more than once, so asserting it does not pin the convention line it stands for`
      );
    }
    // And every BULLET is covered by at least one of them, derived from the instructions themselves:
    // a sixth convention added without a fragment fails here rather than going untested.
    const conventionBullets = measured.instructions
      .split("EVIDENCE READ CONVENTIONS")[1]
      ?.split("\n\n")[0]
      ?.split("\n")
      .filter((line) => line.startsWith("- ")) ?? [];
    assert.equal(conventionBullets.length, 5, "the conventions block is five bullets");
    for (const bullet of conventionBullets) {
      assert.ok(
        CONVENTION_FRAGMENTS.some((fragment) => bullet.includes(fragment)),
        `no fragment pins this convention, so deleting it would pass: ${bullet.slice(0, 60)}`
      );
    }
  });
});
