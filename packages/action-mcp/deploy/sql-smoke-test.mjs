#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { legacyRetirementSql } from "./legacy-retirement-sql.mjs";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const actionSql = readFileSync(new URL("../supabase/action-state.sql", import.meta.url), "utf8");
const container = `greenhouse-action-sql-smoke-${process.pid}-${Date.now()}`;

function docker(args, options = {}) {
  const result = spawnSync("docker", args, {
    cwd: packageRoot,
    encoding: "utf8",
    stdio: options.input === undefined ? "pipe" : ["pipe", "pipe", "pipe"],
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`docker ${args[0]} failed: ${(result.stderr || result.stdout || "unknown error").trim()}`);
  }
  return result.stdout.trim();
}

function psql(sql) {
  return docker([
    "exec", "-i", container,
    "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-X", "-q",
  ], { input: sql });
}

function psqlFailure(sql, expectedMessage) {
  const result = spawnSync("docker", [
    "exec", "-i", container,
    "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-X", "-q",
  ], { cwd: packageRoot, encoding: "utf8", input: sql });
  if (result.status === 0) throw new Error(`Expected PostgreSQL failure containing: ${expectedMessage}`);
  const output = `${result.stderr ?? ""}${result.stdout ?? ""}`;
  if (!output.includes(expectedMessage)) {
    throw new Error(`PostgreSQL failed for the wrong reason: ${output.trim()}`);
  }
}

function psqlAsync(sql) {
  const child = spawn("docker", [
    "exec", "-i", container,
    "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-X", "-q",
  ], { cwd: packageRoot, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.end(sql);
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status) => {
      if (status === 0) resolve(stdout.trim());
      else reject(new Error(`asynchronous psql failed: ${(stderr || stdout || "unknown error").trim()}`));
    });
  });
}

function waitForContainerFile(path) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = spawnSync("docker", ["exec", container, "test", "-f", path], { stdio: "ignore" });
    if (result.status === 0) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  throw new Error(`Timed out waiting for PostgreSQL smoke marker ${path}.`);
}

function waitForBlockedQuery(marker) {
  const escaped = marker.replaceAll("'", "''");
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const count = docker([
      "exec", container,
      "psql", "-U", "postgres", "-d", "postgres", "-X", "-q", "-t", "-A", "-c",
      `select count(*) from pg_stat_activity where pid <> pg_backend_pid() and state = 'active' and wait_event_type = 'Lock' and query like '%${escaped}%';`,
    ]);
    if (Number(count) > 0) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  throw new Error("Timed out waiting for the mutation-fence row-lock contention fixture.");
}

try {
  docker([
    "run", "-d", "--rm", "--name", container,
    "-e", "POSTGRES_PASSWORD=action-smoke-only",
    "postgres:16-alpine",
  ]);

  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = spawnSync("docker", ["exec", container, "pg_isready", "-U", "postgres"], {
      encoding: "utf8",
      stdio: "pipe",
    });
    const logs = spawnSync("docker", ["logs", container], { encoding: "utf8", stdio: "pipe" });
    if (result.status === 0 && `${logs.stdout}${logs.stderr}`.includes("PostgreSQL init process complete; ready for start up.")) {
      ready = true;
      break;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  if (!ready) throw new Error("PostgreSQL smoke container did not become ready.");

  psql(`
    create role anon noinherit;
    create role authenticated noinherit;
    create role service_role noinherit;
    create table public.recruiter_identity_directory (
      id uuid primary key,
      google_subject text not null,
      greenhouse_user_id bigint,
      status text not null
    );
    create table public.greenhouse_action_entitlement (
      identity_id uuid not null references public.recruiter_identity_directory(id) on delete restrict,
      greenhouse_user_id bigint not null check (greenhouse_user_id > 0),
      client text not null check (client in ('codex', 'test')),
      can_preview boolean not null default false,
      can_apply boolean not null default false,
      status text not null default 'active' check (status in ('active', 'disabled')),
      expires_at timestamptz,
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp(),
      primary key (identity_id, client),
      check (not can_apply or can_preview)
    );
    create table public.greenhouse_application_assignment_action (
      action_id uuid primary key,
      status text not null,
      retained_marker text not null
    );
    insert into public.greenhouse_application_assignment_action
      values ('99999999-9999-4999-8999-999999999999', 'executing', 'preserve-me');

    create function public.claim_greenhouse_application_assignment_action(
      uuid, uuid, bigint, text, text, text, bigint, bigint, text, bigint, bigint, text, text, timestamptz, uuid
    ) returns jsonb language sql as 'select ''{}''::jsonb';
    create function public.begin_greenhouse_application_assignment_mutation(uuid, uuid)
      returns boolean language sql as 'select false';
    create function public.finish_greenhouse_application_assignment_action(uuid, uuid, text, text, text, integer, text)
      returns jsonb language sql as 'select ''{}''::jsonb';
    create function public.prepare_greenhouse_assignment_reconciliation(uuid)
      returns jsonb language sql as 'select ''{}''::jsonb';
    create function public.defer_greenhouse_assignment_unknown(uuid)
      returns jsonb language sql as 'select ''{}''::jsonb';
    create function public.reconcile_greenhouse_assignment_original_observation(uuid)
      returns jsonb language sql as 'select ''{}''::jsonb';
    create function public.resolve_greenhouse_assignment_unknown(uuid, text, text, text, text, text)
      returns jsonb language sql as 'select ''{}''::jsonb';
    grant select on table public.greenhouse_application_assignment_action to service_role;
  `);

  psqlFailure(actionSql, "legacy assignment action table exists");
  psql(`
    do $$
    begin
      if not exists (
        select 1 from information_schema.columns
         where table_schema = 'public' and table_name = 'greenhouse_action_entitlement'
           and column_name = 'can_apply_high_impact'
      ) then
        raise exception 'entitlement upgrade did not commit before the legacy stop gate';
      end if;
      if to_regclass('public.greenhouse_action') is not null then
        raise exception 'generic ledger was created despite the legacy stop gate';
      end if;
      if not has_table_privilege('service_role', 'public.greenhouse_application_assignment_action', 'select') then
        raise exception 'legacy ACL fixture is not representative';
      end if;
    end;
    $$;
  `);

  psqlFailure(legacyRetirementSql(), "legacy assignment actions are still unresolved");
  psql(`
    do $$
    begin
      if to_regclass('public.greenhouse_application_assignment_action') is null
         or to_regclass('greenhouse_mcp_archive.greenhouse_application_assignment_action') is not null then
        raise exception 'failed retirement did not roll back atomically';
      end if;
    end;
    $$;
    update public.greenhouse_application_assignment_action set status = 'succeeded';
  `);
  psql(legacyRetirementSql());
  psql(`
    do $$
    declare
      legacy_function_count integer;
    begin
      if to_regclass('public.greenhouse_application_assignment_action') is not null
         or to_regclass('greenhouse_mcp_archive.greenhouse_application_assignment_action') is null then
        raise exception 'legacy table was not archived';
      end if;
      if not exists (
        select 1 from greenhouse_mcp_archive.greenhouse_application_assignment_action
         where retained_marker = 'preserve-me' and status = 'succeeded'
      ) then
        raise exception 'legacy archive did not preserve its row';
      end if;
      if has_table_privilege('service_role', 'greenhouse_mcp_archive.greenhouse_application_assignment_action', 'select') then
        raise exception 'runtime role retained access to the legacy archive';
      end if;
      select count(*) into legacy_function_count
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname in (
         'claim_greenhouse_application_assignment_action',
         'begin_greenhouse_application_assignment_mutation',
         'finish_greenhouse_application_assignment_action',
         'prepare_greenhouse_assignment_reconciliation',
         'defer_greenhouse_assignment_unknown',
         'reconcile_greenhouse_assignment_original_observation',
         'resolve_greenhouse_assignment_unknown'
       );
      if legacy_function_count <> 0 then raise exception 'legacy RPCs were not all dropped'; end if;
    end;
    $$;
  `);
  psql(actionSql);
  psql(actionSql);
  psql(`
    insert into public.recruiter_identity_directory (id, google_subject, greenhouse_user_id, status)
    values ('11111111-1111-4111-8111-111111111111', 'subject', 10, 'resolved');

    insert into public.greenhouse_action_entitlement (
      identity_id, greenhouse_user_id, client, can_preview, can_apply, can_apply_high_impact
    ) values (
      '11111111-1111-4111-8111-111111111111', 10, 'claude_code', true, true, true
    );

    do $$
    begin
      if not exists (
        select 1 from public.greenhouse_action_entitlement
         where client = 'claude_code' and can_apply_high_impact = true
      ) then
        raise exception 'assignment-only entitlement table was not upgraded';
      end if;
    end;
    $$;

    do $$
    declare
      claimed jsonb;
      changed boolean;
      finished jsonb;
    begin
      -- A generic resource lock serializes different action kinds on the same target.
      claimed := public.claim_greenhouse_action(
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'application_assignment_change', 'application:100', 200,
        '{"application_id":100,"assignment_role":"recruiter","previous_user_id":20,"proposed_user_id":40}'::jsonb,
        '11111111-1111-4111-8111-111111111111', 10,
        repeat('A', 43), repeat('B', 43), 'codex',
        repeat('C', 43), repeat('D', 43), repeat('E', 43), false,
        clock_timestamp() + interval '5 minutes', 300,
        'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
      );
      if claimed->>'disposition' <> 'owned' then raise exception 'first claim was not owned'; end if;

      claimed := public.claim_greenhouse_action(
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'application_assignment_change', 'application:100', 200, '{}'::jsonb,
        '11111111-1111-4111-8111-111111111111', 10,
        repeat('F', 43), repeat('G', 43), 'codex',
        repeat('H', 43), repeat('I', 43), repeat('J', 43), false,
        clock_timestamp() + interval '5 minutes', 300,
        'ffffffff-ffff-4fff-8fff-ffffffffffff'
      );
      if claimed->>'disposition' <> 'replay'
         or claimed->'record'->>'action_kind' <> 'application_assignment_change' then
        raise exception 'action-id replay did not return the recorded action';
      end if;

      claimed := public.claim_greenhouse_action(
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        'application_rejection', 'application:100', 200,
        '{"application_id":100,"rejection_reason_id":50,"previous_interview_stage_id":60,"has_notes":false}'::jsonb,
        '11111111-1111-4111-8111-111111111111', 10,
        repeat('K', 43), repeat('L', 43), 'claude_code',
        repeat('M', 43), repeat('N', 43), repeat('O', 43), false,
        clock_timestamp() + interval '5 minutes', 300,
        'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'
      );
      if claimed->>'disposition' <> 'target_busy' then
        raise exception 'cross-kind same-target lock did not serialize';
      end if;

      -- Different resource keys can be claimed concurrently.
      claimed := public.claim_greenhouse_action(
        'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        'candidate_record_update', 'candidate:201', 201,
        '{"candidate_id":201,"context_application_id":101,"fields":["title"]}'::jsonb,
        '11111111-1111-4111-8111-111111111111', 10,
        repeat('P', 43), repeat('Q', 43), 'codex',
        repeat('R', 43), repeat('S', 43), repeat('T', 43), false,
        clock_timestamp() + interval '5 minutes', 1800,
        'cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa'
      );
      if claimed->>'disposition' <> 'owned' then raise exception 'independent candidate lock was blocked'; end if;

      claimed := public.claim_greenhouse_action(
        'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        'job_note_change', 'job:301', 301,
        '{"job_id":301,"verb":"update","note_id":401,"visibility":"privately_visible","baseline_count":0,"baseline_fingerprint":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}'::jsonb,
        '11111111-1111-4111-8111-111111111111', 10,
        repeat('U', 43), repeat('V', 43), 'codex',
        repeat('W', 43), repeat('X', 43), repeat('Y', 43), false,
        clock_timestamp() + interval '5 minutes', 300,
        'dddddddd-eeee-4fff-8aaa-bbbbbbbbbbbb'
      );
      if claimed->>'disposition' <> 'owned' then raise exception 'independent job lock was blocked'; end if;

      -- Only the current owner can cross the fence, and it opens once.
      changed := public.begin_greenhouse_action_mutation(
        'cccccccc-cccc-4ccc-8ccc-cccccccccccc', '99999999-9999-4999-8999-999999999999'
      );
      if changed then raise exception 'wrong owner crossed the mutation fence'; end if;

      changed := public.begin_greenhouse_action_mutation(
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
      );
      if not changed then raise exception 'mutation fence did not open'; end if;
      changed := public.begin_greenhouse_action_mutation(
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
      );
      if changed then raise exception 'mutation fence opened twice'; end if;

      finished := public.finish_greenhouse_action(
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        'unknown', 'conflict', 'UPSTREAM_RESULT_CONFLICT', null, null, null
      );
      if finished->>'status' <> 'unknown' then raise exception 'unknown result was not recorded'; end if;
      finished := public.resolve_greenhouse_action_unknown(
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'reconciled', 'desired_observed', null, 'automatic', null
      );
      if finished is not null then raise exception 'automatic resolution overwrote a conflict'; end if;
      finished := public.resolve_greenhouse_action_unknown(
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'reconciled', 'desired_observed',
        'OPERATOR_RESOLVED_APPLIED', 'operator', repeat('Z', 43)
      );
      if finished->>'resolution_source' <> 'operator' then raise exception 'operator resolution was not audited'; end if;

      -- Terminal resolution releases the target lock; the formerly blocked kind can own it.
      claimed := public.claim_greenhouse_action(
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        'application_rejection', 'application:100', 200,
        '{"application_id":100,"rejection_reason_id":50,"previous_interview_stage_id":60,"has_notes":false}'::jsonb,
        '11111111-1111-4111-8111-111111111111', 10,
        repeat('K', 43), repeat('L', 43), 'claude_code',
        repeat('M', 43), repeat('N', 43), repeat('O', 43), false,
        clock_timestamp() + interval '5 minutes', 300,
        'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'
      );
      if claimed->>'disposition' <> 'owned' then raise exception 'terminal action did not release lock'; end if;
      changed := public.begin_greenhouse_action_mutation(
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'
      );
      finished := public.finish_greenhouse_action(
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
        'succeeded', 'desired_observed', null, 200, 'request-1', null
      );
      if finished->>'status' <> 'succeeded' then raise exception 'terminal finish failed'; end if;
      claimed := public.claim_greenhouse_action(
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        'application_rejection', 'application:100', 200, '{}'::jsonb,
        '11111111-1111-4111-8111-111111111111', 10,
        repeat('1', 43), repeat('2', 43), 'codex',
        repeat('3', 43), repeat('4', 43), repeat('5', 43), false,
        clock_timestamp() + interval '5 minutes', 300,
        '12121212-1212-4121-8121-121212121212'
      );
      if claimed->>'disposition' <> 'replay' or claimed->'record'->>'status' <> 'succeeded' then
        raise exception 'terminal replay was not stable';
      end if;

      -- Original-state reconciliation needs the grace period and two spaced observations.
      changed := public.begin_greenhouse_action_mutation(
        'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'dddddddd-eeee-4fff-8aaa-bbbbbbbbbbbb'
      );
      if not exists (
        select 1 from public.greenhouse_action
         where action_id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
           and not_applied_before = lease_expires_at + interval '5 minutes'
      ) then
        raise exception 'not-applied boundary was not kept one grace period beyond the mutation lease';
      end if;
      finished := public.finish_greenhouse_action(
        'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'dddddddd-eeee-4fff-8aaa-bbbbbbbbbbbb',
        'unknown', 'not_observed', 'UPSTREAM_RESULT_NOT_OBSERVED', null, null, null
      );
      finished := public.defer_greenhouse_action_unknown('dddddddd-dddd-4ddd-8ddd-dddddddddddd');
      if finished->>'status' <> 'unknown' then raise exception 'unknown action was not deferred'; end if;
      finished := public.reconcile_greenhouse_action_original_observation('dddddddd-dddd-4ddd-8ddd-dddddddddddd');
      if finished->>'status' <> 'unknown' or finished->>'first_original_observation_at' is not null then
        raise exception 'pre-grace original observation primed automatic resolution';
      end if;
      update public.greenhouse_action
         set not_applied_before = clock_timestamp() - interval '1 second',
             first_original_observation_at = clock_timestamp() - interval '31 seconds'
       where action_id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
      finished := public.reconcile_greenhouse_action_original_observation('dddddddd-dddd-4ddd-8ddd-dddddddddddd');
      if finished->>'status' <> 'unknown' or finished->>'first_original_observation_at' is null then
        raise exception 'first post-grace original observation was not quarantined';
      end if;
      update public.greenhouse_action
         set not_applied_before = clock_timestamp() - interval '2 minutes',
             first_original_observation_at = clock_timestamp() - interval '31 seconds'
       where action_id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
      finished := public.reconcile_greenhouse_action_original_observation('dddddddd-dddd-4ddd-8ddd-dddddddddddd');
      if finished->>'status' <> 'reconciled'
         or finished->>'resolution_source' <> 'automatic'
         or finished->>'error_code' <> 'UPSTREAM_RESULT_NOT_APPLIED' then
        raise exception 'eligible original state did not reconcile atomically';
      end if;

      -- An expired post-send lease recovers to unknown, while a stale preflight fails closed.
      claimed := public.claim_greenhouse_action(
        'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        'offer_update', 'offer-chain:401', 401,
        '{"application_id":401,"offer_id":501,"version":1,"fields":["starts_on"],"has_currency":false}'::jsonb,
        '11111111-1111-4111-8111-111111111111', 10,
        repeat('6', 43), repeat('7', 43), 'codex',
        repeat('8', 43), repeat('9', 43), repeat('a', 43), false,
        clock_timestamp() + interval '5 minutes', 300,
        'eeeeeeee-ffff-4aaa-8bbb-cccccccccccc'
      );
      changed := public.begin_greenhouse_action_mutation(
        'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'eeeeeeee-ffff-4aaa-8bbb-cccccccccccc'
      );
      update public.greenhouse_action set lease_expires_at = clock_timestamp() - interval '1 second'
       where action_id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
      finished := public.prepare_greenhouse_action_reconciliation('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
      if finished->>'status' <> 'unknown' or finished->>'error_code' <> 'STALE_MUTATION' then
        raise exception 'stale mutation did not recover to unknown';
      end if;
      finished := public.resolve_greenhouse_action_unknown(
        'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'reconciled', 'not_observed',
        'OPERATOR_RESOLVED_NOT_APPLIED', 'operator', repeat('b', 43)
      );

      claimed := public.claim_greenhouse_action(
        'ffffffff-ffff-4fff-8fff-ffffffffffff',
        'application_stage_move', 'application:501', 501,
        '{"application_id":501,"from_application_stage_id":601,"from_interview_stage_id":701,"to_interview_stage_id":702}'::jsonb,
        '11111111-1111-4111-8111-111111111111', 10,
        repeat('c', 43), repeat('d', 43), 'codex',
        repeat('e', 43), repeat('f', 43), repeat('g', 43), true,
        clock_timestamp() + interval '5 minutes', 300,
        'abababab-abab-4aba-8aba-abababababab'
      );
      finished := public.finish_greenhouse_action(
        'ffffffff-ffff-4fff-8fff-ffffffffffff', '12121212-1212-4121-8121-121212121212',
        'failed', null, 'WRONG_OWNER', null, null, null
      );
      if finished is not null then raise exception 'wrong owner finished preflight action'; end if;
      update public.greenhouse_action set lease_expires_at = clock_timestamp() - interval '1 second'
       where action_id = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
      finished := public.prepare_greenhouse_action_reconciliation('ffffffff-ffff-4fff-8fff-ffffffffffff');
      if finished->>'status' <> 'failed' or finished->>'error_code' <> 'STALE_PREFLIGHT' then
        raise exception 'stale preflight did not fail closed';
      end if;
    end;
    $$;
  `);

  // A waiter must re-check expiry against a fresh clock after acquiring the
  // action row lock. statement_timestamp() is stale across this wait and would
  // incorrectly authorize the mutation after the holder commits an expired lease.
  psql(`
    select public.claim_greenhouse_action(
      '13131313-1313-4131-8131-131313131313',
      'candidate_record_update', 'candidate:999', 200,
      '{"candidate_id":999,"fields":["title"]}'::jsonb,
      '11111111-1111-4111-8111-111111111111', 10,
      repeat('h', 43), repeat('i', 43), 'codex',
      repeat('j', 43), repeat('k', 43), repeat('l', 43), false,
      clock_timestamp() + interval '5 minutes', 1800,
      '14141414-1414-4141-8141-141414141414'
    );
  `);
  const holderReady = "/tmp/greenhouse-action-holder-ready";
  const releaseHolder = "/tmp/greenhouse-action-release-holder";
  const holder = psqlAsync(`
    begin;
    select 1 from public.greenhouse_action
     where action_id = '13131313-1313-4131-8131-131313131313'
     for update;
    \\! touch ${holderReady}
    \\! while [ ! -f ${releaseHolder} ]; do sleep 0.01; done
    with boundary as (select clock_timestamp() + interval '100 milliseconds' as expires_at)
    update public.greenhouse_action
       set lease_expires_at = boundary.expires_at,
           not_applied_before = boundary.expires_at + interval '30 minutes'
      from boundary
     where action_id = '13131313-1313-4131-8131-131313131313';
    select pg_sleep(0.25);
    commit;
  `);
  waitForContainerFile(holderReady);
  const waitMarker = "fence-wait-regression";
  const waiter = psqlAsync(`
    do $$
    begin
      /* fence-wait-regression */
      if public.begin_greenhouse_action_mutation(
        '13131313-1313-4131-8131-131313131313',
        '14141414-1414-4141-8141-141414141414'
      ) then
        raise exception 'mutation fence accepted an action that expired while waiting for its row lock';
      end if;
    end;
    $$;
  `);
  try {
    waitForBlockedQuery(waitMarker);
    docker(["exec", container, "touch", releaseHolder]);
    await Promise.all([holder, waiter]);
  } catch (error) {
    spawnSync("docker", ["exec", container, "touch", releaseHolder], { stdio: "ignore" });
    await Promise.allSettled([holder, waiter]);
    throw error;
  }
  process.stdout.write("PostgreSQL generic action-state smoke test passed.\n");
} finally {
  spawnSync("docker", ["rm", "-f", container], { stdio: "ignore" });
}
