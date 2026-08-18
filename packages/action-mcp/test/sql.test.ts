import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

const sqlPath = fileURLToPath(new URL("../supabase/action-state.sql", import.meta.url));

describe("durable action SQL", () => {
  test("uses one generic lock-key ledger with DB-clock mutation fencing", async () => {
    const sql = await readFile(sqlPath, "utf8");
    assert.match(sql, /create table if not exists public\.greenhouse_action\s*\(/i);
    assert.match(sql, /on public\.greenhouse_action\(lock_key\)[\s\S]*where status in \('executing', 'unknown'\)/i);
    assert.match(sql, /statement_timestamp\(\) \+ interval '90 seconds'/i);
    assert.match(sql, /select \* into observed[\s\S]*for update/i);
    assert.match(sql, /boundary_at := clock_timestamp\(\)/i);
    assert.match(sql, /observed\.lease_expires_at <= boundary_at or observed\.intent_expires_at <= boundary_at/i);
    assert.match(sql, /p_reconciliation_grace_seconds < 300 or p_reconciliation_grace_seconds > 1800/i);
    assert.match(sql, /not_applied_before\s*=\s*boundary_at \+ interval '120 seconds'[\s\S]*observed\.not_applied_before - observed\.lease_expires_at/i);
  });

  test("defines exactly the seven generic RPCs and revokes client access", async () => {
    const sql = await readFile(sqlPath, "utf8");
    const names = [...sql.matchAll(/create or replace function public\.(\w+)/gi)].map((match) => match[1]);
    assert.deepEqual(names, [
      "claim_greenhouse_action",
      "begin_greenhouse_action_mutation",
      "finish_greenhouse_action",
      "prepare_greenhouse_action_reconciliation",
      "defer_greenhouse_action_unknown",
      "reconcile_greenhouse_action_original_observation",
      "resolve_greenhouse_action_unknown",
    ]);
    assert.match(sql, /greenhouse_action_entitlement enable row level security/i);
    assert.match(sql, /greenhouse_action enable row level security/i);
    assert.match(sql, /revoke all on table public\.greenhouse_action from public, anon, authenticated/i);
    assert.match(sql, /grant select on table public\.greenhouse_action to service_role/i);
    assert.doesNotMatch(sql, /grant select, insert, update on table public\.greenhouse_action to service_role/i);
    for (const name of names) {
      assert.match(sql, new RegExp(`revoke all on function public\\.${name}\\(`, "i"));
      assert.match(sql, new RegExp(`grant execute on function public\\.${name}\\(`, "i"));
    }
  });

  test("keeps metadata-only state and requires two separated original-state observations", async () => {
    const sql = await readFile(sqlPath, "utf8");
    assert.match(sql, /binding jsonb not null[\s\S]*pg_column_size\(binding\) <= 65536/i);
    assert.match(sql, /resolved_by_fingerprint/);
    assert.match(sql, /resolution_source.*automatic.*operator/i);
    assert.match(sql, /clock_timestamp\(\) < observed\.not_applied_before[\s\S]*first_original_observation_at = null/i);
    assert.match(sql, /first_original_observation_at >= observed\.not_applied_before/i);
    assert.match(sql, /first_original_observation_at \+ interval '30 seconds'/i);
    assert.match(sql, /observation is distinct from 'conflict'/i);
    assert.doesNotMatch(sql, /candidate_(?:name|email)|note_body|offer_amount|salary|compensation|prompt|bearer_token|signed_url/i);
  });

  test("refuses to silently coexist with the legacy assignment ledger", async () => {
    const sql = await readFile(sqlPath, "utf8");
    assert.match(sql, /to_regclass\('public\.greenhouse_application_assignment_action'\)/i);
    assert.match(sql, /legacy assignment action table exists; entitlement upgraded; stop and migrate the ledger explicitly/i);
  });

  test("upgrades assignment-only entitlements before gating the legacy ledger", async () => {
    const sql = await readFile(sqlPath, "utf8");
    const entitlementUpgrade = sql.indexOf("add column if not exists can_apply_high_impact");
    const firstCommit = sql.indexOf("commit;");
    const legacyGate = sql.indexOf("to_regclass('public.greenhouse_application_assignment_action')");
    assert.ok(entitlementUpgrade > 0 && entitlementUpgrade < firstCommit);
    assert.ok(firstCommit < legacyGate);
    // The constraint must be REPLACED (drop-then-add) so an existing install is upgraded in place,
    // and it must admit every client the code can produce. Asserted as membership rather than an
    // exact tuple: the union grew to carry claude_desktop_chat and an exact match would fail on
    // every legitimate addition while catching nothing this does not.
    assert.match(sql, /drop constraint if exists greenhouse_action_entitlement_client_check[\s\S]*add constraint greenhouse_action_entitlement_client_check/i);
    for (const client of ["codex", "claude_code", "claude_desktop_chat", "test"]) {
      assert.match(
        sql,
        new RegExp(`add constraint greenhouse_action_entitlement_client_check[\\s\\S]{0,200}?'${client}'`, "i"),
        `the entitlement client check must admit ${client}, or no entitlement can be written for it`
      );
    }
    assert.match(sql, /greenhouse_action_entitlement_high_impact_requires_apply[\s\S]*not can_apply_high_impact or can_apply/i);
  });
});
