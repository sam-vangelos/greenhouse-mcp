-- Shared metadata-only authorization, idempotency, fencing, and reconciliation
-- state for the Greenhouse action MCP. Apply this file explicitly to the
-- canonical Greenhouse MCP Supabase project; do not run the repository's
-- unrelated migration chain.

begin;

create table if not exists public.greenhouse_action_entitlement (
  identity_id uuid not null references public.recruiter_identity_directory(id) on delete restrict,
  greenhouse_user_id bigint not null check (greenhouse_user_id > 0),
  client text not null,
  can_preview boolean not null default false,
  can_apply boolean not null default false,
  can_apply_high_impact boolean not null default false,
  status text not null default 'active' check (status in ('active', 'disabled')),
  expires_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (identity_id, client),
  check (not can_apply or can_preview)
);

-- Upgrade the assignment-only entitlement table in place before checking for
-- its legacy action ledger. This keeps existing installs operable and makes
-- the eventual generic-ledger migration a deliberate, separate step.
alter table public.greenhouse_action_entitlement
  add column if not exists can_apply_high_impact boolean not null default false;
alter table public.greenhouse_action_entitlement
  drop constraint if exists greenhouse_action_entitlement_client_check;
alter table public.greenhouse_action_entitlement
  add constraint greenhouse_action_entitlement_client_check
  check (client in ('codex', 'claude_code', 'claude_desktop_chat', 'test'));
alter table public.greenhouse_action_entitlement
  drop constraint if exists greenhouse_action_entitlement_high_impact_requires_apply;
alter table public.greenhouse_action_entitlement
  add constraint greenhouse_action_entitlement_high_impact_requires_apply
  check (not can_apply_high_impact or can_apply);

create index if not exists greenhouse_action_entitlement_user
  on public.greenhouse_action_entitlement(greenhouse_user_id, client)
  where status = 'active';

alter table public.greenhouse_action_entitlement enable row level security;
revoke all on table public.greenhouse_action_entitlement from public, anon, authenticated;
grant select, insert, update on table public.greenhouse_action_entitlement to service_role;

commit;

do $$
begin
  if to_regclass('public.greenhouse_application_assignment_action') is not null then
    raise exception 'legacy assignment action table exists; entitlement upgraded; stop and migrate the ledger explicitly';
  end if;
end;
$$;

begin;

create table if not exists public.greenhouse_action (
  action_id uuid primary key,
  action_kind text not null check (action_kind ~ '^[a-z][a-z0-9_]{0,95}$'),
  lock_key text not null check (lock_key ~ '^(application|candidate|job|offer-chain):[1-9][0-9]{0,18}$'),
  scope_job_id bigint check (scope_job_id is null or scope_job_id > 0),
  binding jsonb not null check (jsonb_typeof(binding) = 'object' and pg_column_size(binding) <= 65536),
  identity_id uuid not null references public.recruiter_identity_directory(id) on delete restrict,
  actor_user_id bigint not null check (actor_user_id > 0),
  subject_fingerprint text not null check (subject_fingerprint ~ '^[A-Za-z0-9_-]{43}$'),
  session_fingerprint text not null check (session_fingerprint ~ '^[A-Za-z0-9_-]{43}$'),
  client text not null check (client in ('codex', 'claude_code', 'claude_desktop_chat', 'test')),
  current_fingerprint text not null check (current_fingerprint ~ '^[A-Za-z0-9_-]{43}$'),
  desired_fingerprint text not null check (desired_fingerprint ~ '^[A-Za-z0-9_-]{43}$'),
  approval_fingerprint text not null check (approval_fingerprint ~ '^[A-Za-z0-9_-]{43}$'),
  high_impact boolean not null,
  intent_expires_at timestamptz not null,
  not_applied_before timestamptz not null,
  status text not null check (status in ('executing', 'succeeded', 'failed', 'unknown', 'reconciled')),
  phase text not null check (phase in ('preflight', 'mutation_sent')),
  owner_token uuid not null,
  lease_expires_at timestamptz not null,
  observation text check (observation is null or observation in ('desired_observed', 'not_observed', 'conflict')),
  error_code text check (error_code is null or error_code ~ '^[A-Z][A-Z0-9_]{0,95}$'),
  upstream_status integer check (upstream_status is null or upstream_status between 100 and 599),
  upstream_request_id text check (upstream_request_id is null or char_length(upstream_request_id) between 1 and 255),
  upstream_resource_id bigint check (upstream_resource_id is null or upstream_resource_id > 0),
  first_original_observation_at timestamptz,
  resolution_source text check (resolution_source is null or resolution_source in ('automatic', 'operator')),
  resolved_by_fingerprint text check (resolved_by_fingerprint is null or resolved_by_fingerprint ~ '^[A-Za-z0-9_-]{43}$'),
  completed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check (status <> 'unknown' or phase = 'mutation_sent'),
  check ((status in ('succeeded', 'failed', 'reconciled')) = (completed_at is not null)),
  check (status <> 'succeeded' or observation = 'desired_observed'),
  check ((status = 'reconciled') = (resolution_source is not null)),
  check (
    (resolution_source is null and resolved_by_fingerprint is null)
    or (resolution_source = 'automatic' and resolved_by_fingerprint is null)
    or (resolution_source = 'operator' and resolved_by_fingerprint is not null)
  )
);

create unique index if not exists greenhouse_action_one_unresolved_per_lock
  on public.greenhouse_action(lock_key)
  where status in ('executing', 'unknown');

create index if not exists greenhouse_action_recovery_queue
  on public.greenhouse_action(status, lease_expires_at, created_at)
  where status in ('executing', 'unknown');

alter table public.greenhouse_action enable row level security;

create or replace function public.claim_greenhouse_action(
  p_action_id uuid,
  p_action_kind text,
  p_lock_key text,
  p_scope_job_id bigint,
  p_binding jsonb,
  p_identity_id uuid,
  p_actor_user_id bigint,
  p_subject_fingerprint text,
  p_session_fingerprint text,
  p_client text,
  p_current_fingerprint text,
  p_desired_fingerprint text,
  p_approval_fingerprint text,
  p_high_impact boolean,
  p_intent_expires_at timestamptz,
  p_reconciliation_grace_seconds integer,
  p_owner_token uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  existing_action public.greenhouse_action%rowtype;
begin
  select * into existing_action from public.greenhouse_action where action_id = p_action_id;
  if found then
    return jsonb_build_object('disposition', 'replay', 'record', to_jsonb(existing_action));
  end if;

  if p_intent_expires_at <= clock_timestamp()
     or p_intent_expires_at > clock_timestamp() + interval '6 minutes' then
    raise exception 'action intent expiry is outside the accepted window' using errcode = '22023';
  end if;
  if p_reconciliation_grace_seconds < 300 or p_reconciliation_grace_seconds > 1800 then
    raise exception 'action reconciliation grace is outside the accepted window' using errcode = '22023';
  end if;
  if jsonb_typeof(p_binding) <> 'object' or pg_column_size(p_binding) > 65536 then
    raise exception 'action binding is invalid' using errcode = '22023';
  end if;

  begin
    insert into public.greenhouse_action (
      action_id, action_kind, lock_key, scope_job_id, binding,
      identity_id, actor_user_id, subject_fingerprint, session_fingerprint, client,
      current_fingerprint, desired_fingerprint, approval_fingerprint, high_impact,
      intent_expires_at, not_applied_before, status, phase, owner_token, lease_expires_at
    ) values (
      p_action_id, p_action_kind, p_lock_key, p_scope_job_id, p_binding,
      p_identity_id, p_actor_user_id, p_subject_fingerprint, p_session_fingerprint, p_client,
      p_current_fingerprint, p_desired_fingerprint, p_approval_fingerprint, p_high_impact,
      p_intent_expires_at,
      statement_timestamp() + interval '90 seconds' + make_interval(secs => p_reconciliation_grace_seconds),
      'executing', 'preflight', p_owner_token, statement_timestamp() + interval '90 seconds'
    ) returning * into existing_action;
    return jsonb_build_object('disposition', 'owned', 'record', to_jsonb(existing_action));
  exception when unique_violation then
    select * into existing_action from public.greenhouse_action where action_id = p_action_id;
    if found then
      return jsonb_build_object('disposition', 'replay', 'record', to_jsonb(existing_action));
    end if;
    select * into existing_action
      from public.greenhouse_action
     where lock_key = p_lock_key and status in ('executing', 'unknown')
     order by created_at limit 1;
    if found then
      return jsonb_build_object('disposition', 'target_busy', 'record', to_jsonb(existing_action));
    end if;
    raise exception 'action claim conflict could not be resolved' using errcode = '40001';
  end;
end;
$$;

create or replace function public.begin_greenhouse_action_mutation(
  p_action_id uuid,
  p_owner_token uuid
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  observed public.greenhouse_action%rowtype;
  boundary_at timestamptz;
begin
  select * into observed
    from public.greenhouse_action
   where action_id = p_action_id
   for update;

  if not found
     or observed.owner_token is distinct from p_owner_token
     or observed.status <> 'executing'
     or observed.phase <> 'preflight' then
    return false;
  end if;

  -- Capture one fresh database clock only after the row lock is acquired. A
  -- statement timestamp can predate lock contention and must not authorize a
  -- mutation whose lease or intent expired while this call was waiting.
  boundary_at := clock_timestamp();
  if observed.lease_expires_at <= boundary_at or observed.intent_expires_at <= boundary_at then
    return false;
  end if;

  update public.greenhouse_action
     set phase = 'mutation_sent',
         not_applied_before = boundary_at + interval '120 seconds'
           + (observed.not_applied_before - observed.lease_expires_at),
         lease_expires_at = boundary_at + interval '120 seconds',
         updated_at = boundary_at
   where action_id = p_action_id;
  return true;
end;
$$;

create or replace function public.finish_greenhouse_action(
  p_action_id uuid,
  p_owner_token uuid,
  p_status text,
  p_observation text default null,
  p_error_code text default null,
  p_upstream_status integer default null,
  p_upstream_request_id text default null,
  p_upstream_resource_id bigint default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  finished public.greenhouse_action%rowtype;
begin
  if p_status not in ('succeeded', 'failed', 'unknown', 'reconciled') then
    raise exception 'invalid terminal action status' using errcode = '22023';
  end if;
  update public.greenhouse_action
     set status = p_status,
         observation = p_observation,
         error_code = p_error_code,
         upstream_status = p_upstream_status,
         upstream_request_id = p_upstream_request_id,
         upstream_resource_id = p_upstream_resource_id,
         resolution_source = case when p_status = 'reconciled' then 'automatic' else null end,
         resolved_by_fingerprint = null,
         completed_at = case when p_status in ('succeeded', 'failed', 'reconciled') then clock_timestamp() else null end,
         updated_at = clock_timestamp()
   where action_id = p_action_id
     and owner_token = p_owner_token
     and status = 'executing'
     and lease_expires_at > clock_timestamp()
     and (phase = 'mutation_sent' or p_status = 'failed')
  returning * into finished;
  if not found then return null; end if;
  return to_jsonb(finished);
end;
$$;

create or replace function public.prepare_greenhouse_action_reconciliation(p_action_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  recoverable public.greenhouse_action%rowtype;
begin
  select * into recoverable from public.greenhouse_action where action_id = p_action_id for update;
  if not found then return null; end if;
  if recoverable.status <> 'executing' or recoverable.lease_expires_at > clock_timestamp() then
    return to_jsonb(recoverable);
  end if;
  if recoverable.phase = 'preflight' then
    update public.greenhouse_action
       set status = 'failed', error_code = 'STALE_PREFLIGHT', completed_at = clock_timestamp(), updated_at = clock_timestamp()
     where action_id = p_action_id returning * into recoverable;
  else
    update public.greenhouse_action
       set status = 'unknown', error_code = 'STALE_MUTATION', completed_at = null, updated_at = clock_timestamp()
     where action_id = p_action_id returning * into recoverable;
  end if;
  return to_jsonb(recoverable);
end;
$$;

create or replace function public.defer_greenhouse_action_unknown(p_action_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  deferred public.greenhouse_action%rowtype;
begin
  update public.greenhouse_action set updated_at = clock_timestamp()
   where action_id = p_action_id and status = 'unknown' and observation is distinct from 'conflict'
  returning * into deferred;
  if not found then return null; end if;
  return to_jsonb(deferred);
end;
$$;

create or replace function public.reconcile_greenhouse_action_original_observation(p_action_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  observed public.greenhouse_action%rowtype;
begin
  select * into observed from public.greenhouse_action where action_id = p_action_id for update;
  if not found then return null; end if;
  if observed.status <> 'unknown' or observed.observation = 'conflict' then return to_jsonb(observed); end if;
  if clock_timestamp() < observed.not_applied_before then
    update public.greenhouse_action
       set observation = 'not_observed', first_original_observation_at = null, updated_at = clock_timestamp()
     where action_id = p_action_id returning * into observed;
  elsif observed.first_original_observation_at is not null
     and observed.first_original_observation_at >= observed.not_applied_before
     and clock_timestamp() >= observed.first_original_observation_at + interval '30 seconds' then
    update public.greenhouse_action
       set status = 'reconciled', observation = 'not_observed', error_code = 'UPSTREAM_RESULT_NOT_APPLIED',
           resolution_source = 'automatic', resolved_by_fingerprint = null,
           completed_at = clock_timestamp(), updated_at = clock_timestamp()
     where action_id = p_action_id returning * into observed;
  else
    update public.greenhouse_action
       set observation = 'not_observed',
           first_original_observation_at = case
             when first_original_observation_at is null or first_original_observation_at < not_applied_before
               then clock_timestamp()
             else first_original_observation_at
           end,
           updated_at = clock_timestamp()
     where action_id = p_action_id returning * into observed;
  end if;
  return to_jsonb(observed);
end;
$$;

create or replace function public.resolve_greenhouse_action_unknown(
  p_action_id uuid,
  p_status text,
  p_observation text,
  p_error_code text default null,
  p_resolution_source text default 'automatic',
  p_resolved_by_fingerprint text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  resolved public.greenhouse_action%rowtype;
begin
  if p_status not in ('unknown', 'reconciled') then raise exception 'invalid reconciliation status' using errcode = '22023'; end if;
  if p_observation not in ('desired_observed', 'not_observed', 'conflict') then raise exception 'invalid reconciliation observation' using errcode = '22023'; end if;
  if p_resolution_source is null or p_resolution_source not in ('automatic', 'operator')
     or (p_resolution_source = 'operator') <> (p_resolved_by_fingerprint is not null) then
    raise exception 'invalid reconciliation source' using errcode = '22023';
  end if;
  if p_resolution_source = 'automatic'
     and not ((p_status = 'reconciled' and p_observation = 'desired_observed')
       or (p_status = 'unknown' and p_observation = 'conflict')) then
    raise exception 'invalid automatic reconciliation transition' using errcode = '22023';
  end if;
  if p_resolution_source = 'operator'
     and (p_status <> 'reconciled' or p_observation not in ('desired_observed', 'not_observed')) then
    raise exception 'invalid operator reconciliation transition' using errcode = '22023';
  end if;
  update public.greenhouse_action
     set status = p_status, observation = p_observation, error_code = p_error_code,
         resolution_source = case when p_status = 'reconciled' then p_resolution_source else null end,
         resolved_by_fingerprint = case when p_status = 'reconciled' then p_resolved_by_fingerprint else null end,
         completed_at = case when p_status = 'reconciled' then clock_timestamp() else null end,
         updated_at = clock_timestamp()
   where action_id = p_action_id and status = 'unknown'
     and (p_resolution_source = 'operator' or observation is distinct from 'conflict')
  returning * into resolved;
  if not found then return null; end if;
  return to_jsonb(resolved);
end;
$$;

revoke all on table public.greenhouse_action from public, anon, authenticated;
grant select on table public.greenhouse_action to service_role;

revoke all on function public.claim_greenhouse_action(uuid, text, text, bigint, jsonb, uuid, bigint, text, text, text, text, text, text, boolean, timestamptz, integer, uuid) from public, anon, authenticated;
revoke all on function public.begin_greenhouse_action_mutation(uuid, uuid) from public, anon, authenticated;
revoke all on function public.finish_greenhouse_action(uuid, uuid, text, text, text, integer, text, bigint) from public, anon, authenticated;
revoke all on function public.prepare_greenhouse_action_reconciliation(uuid) from public, anon, authenticated;
revoke all on function public.defer_greenhouse_action_unknown(uuid) from public, anon, authenticated;
revoke all on function public.reconcile_greenhouse_action_original_observation(uuid) from public, anon, authenticated;
revoke all on function public.resolve_greenhouse_action_unknown(uuid, text, text, text, text, text) from public, anon, authenticated;

grant execute on function public.claim_greenhouse_action(uuid, text, text, bigint, jsonb, uuid, bigint, text, text, text, text, text, text, boolean, timestamptz, integer, uuid) to service_role;
grant execute on function public.begin_greenhouse_action_mutation(uuid, uuid) to service_role;
grant execute on function public.finish_greenhouse_action(uuid, uuid, text, text, text, integer, text, bigint) to service_role;
grant execute on function public.prepare_greenhouse_action_reconciliation(uuid) to service_role;
grant execute on function public.defer_greenhouse_action_unknown(uuid) to service_role;
grant execute on function public.reconcile_greenhouse_action_original_observation(uuid) to service_role;
grant execute on function public.resolve_greenhouse_action_unknown(uuid, text, text, text, text, text) to service_role;

commit;
