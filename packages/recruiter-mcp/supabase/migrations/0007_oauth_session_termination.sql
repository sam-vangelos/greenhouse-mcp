-- OAuth session termination (CLO-272). Migration history lives in this tree; apply it the same way
-- as 0006.
--
-- Before this migration nothing an operator could do ended a hosted-Claude session: the
-- `greenhouse-recruiter-revoke-session` CLI kills one access-token jti, and the very next refresh
-- minted a fresh, unrevoked jti (redeem_oauth_refresh consulted only recruiter_mcp_oauth_revoked_families,
-- and nothing ever wrote that table except the reuse branch). Flipping the directory row failed tool
-- calls but left the connector "connected" and refreshing for 30 days.
--
-- Three changes, one durable property: once ANY access-token jti of a refresh family sits in
-- recruiter_mcp_session_revocation, or an operator revokes the family or the email, that family can
-- never rotate again and every jti it ever minted is on the revocation list.
--
--   1. revoke_oauth_family_locked(...)      the shared sweep; callers hold the family advisory lock
--   2. revoke_oauth_family(...)             operator RPC: one family, takes the lock, then sweeps
--      revoke_oauth_grants_for_email(...)   operator RPC: every live family of an email, each under its lock
--   3. redeem_oauth_refresh(...)            replaced: after the family lock and BEFORE the consume,
--                                            a family with a revoked jti is swept and refused
--                                            ({status:'family_revoked'}); everything else is 0006's body
--
-- Why the lock matters in the operator RPCs: a redeem holding the family lock has already read
-- "family not revoked"; an unlocked sweep that commits in that window revokes the rows that exist
-- NOW while the redeem seats a successor with a fresh jti that escapes. Taking the same
-- pg_advisory_xact_lock(hashtext(family_id)) serializes the sweep behind the redeem, so the
-- successor is visible to the sweep (or the redeem sees the revoked family). Families are locked
-- in family_id order so two multi-family sweeps cannot deadlock each other.
--
-- ROLLBACK (code revert FIRST, then this — the store calls the two RPCs and must not 404 on them),
-- in ONE management-API call so no statement runs against a half-rolled-back tree:
--   1. re-run the `create or replace function redeem_oauth_refresh` block from 0006 verbatim
--      (0007's body calls revoke_oauth_family_locked at runtime; drop the helper only once no
--      installed function references it);
--   2. drop function if exists revoke_oauth_grants_for_email(text, timestamptz, text, text);
--      drop function if exists revoke_oauth_family(text, timestamptz, text, text);
--      drop function if exists revoke_oauth_family_locked(text, timestamptz, text, text);
-- No columns or tables are added, so rows written under 0007 need no cleanup; families killed
-- under 0007 stay dead because 0006's rotation honours recruiter_mcp_oauth_revoked_families.

create or replace function revoke_oauth_family_locked(
  p_family text,
  p_now timestamptz,
  p_reason text,
  p_revoked_by text
) returns jsonb
language plpgsql
as $$
declare
  v_grants integer := 0;
  v_jtis integer := 0;
begin
  -- Caller holds pg_advisory_xact_lock(hashtext(p_family)).
  update recruiter_mcp_oauth_grants
    set revoked_at = coalesce(revoked_at, p_now)
    where family_id = p_family and revoked_at is null;
  get diagnostics v_grants = row_count;
  insert into recruiter_mcp_oauth_revoked_families (family_id, revoked_at, reason)
    values (p_family, p_now, coalesce(p_reason, 'operator_revocation'))
    on conflict (family_id) do nothing;
  with copied as (
    insert into recruiter_mcp_session_revocation (token_id, status, revoked_at, revoked_by, reason)
      select access_jti, 'revoked', p_now, coalesce(p_revoked_by, 'oauth_family_revocation'), coalesce(p_reason, 'operator_revocation')
      from recruiter_mcp_oauth_grants
      where family_id = p_family and access_jti is not null
      on conflict (token_id) do nothing
      returning token_id
  )
  select count(*) into v_jtis from copied;
  return jsonb_build_object('family_id', p_family, 'grants_revoked', v_grants, 'jtis_revoked', v_jtis);
end;
$$;

create or replace function revoke_oauth_family(
  p_family_id text,
  p_now timestamptz default now(),
  p_reason text default 'operator_revocation',
  p_revoked_by text default null
) returns jsonb
language plpgsql
as $$
declare
  v_result jsonb;
begin
  if p_family_id is null or btrim(p_family_id) = '' then
    return jsonb_build_object('status', 'invalid_family');
  end if;
  perform pg_advisory_xact_lock(hashtext(p_family_id));
  if not exists (select 1 from recruiter_mcp_oauth_grants where family_id = p_family_id) then
    return jsonb_build_object('status', 'not_found', 'family_id', p_family_id);
  end if;
  v_result := revoke_oauth_family_locked(p_family_id, p_now, p_reason, p_revoked_by);
  return v_result || jsonb_build_object('status', 'revoked', 'families_revoked', 1);
end;
$$;

create or replace function revoke_oauth_grants_for_email(
  p_email text,
  p_now timestamptz default now(),
  p_reason text default 'operator_revocation',
  p_revoked_by text default null
) returns jsonb
language plpgsql
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_family text;
  v_one jsonb;
  v_families integer := 0;
  v_grants integer := 0;
  v_jtis integer := 0;
begin
  if v_email = '' then
    return jsonb_build_object('status', 'invalid_email');
  end if;
  -- Every family the email ever had that still holds an unrevoked row, locked one at a time in a
  -- stable order. A family that is already fully revoked is skipped: nothing left to sweep, and
  -- its revoked_families row (if any) already makes it dead.
  for v_family in
    select distinct family_id
    from recruiter_mcp_oauth_grants
    where email = v_email and revoked_at is null
    order by family_id
  loop
    perform pg_advisory_xact_lock(hashtext(v_family));
    v_one := revoke_oauth_family_locked(v_family, p_now, p_reason, p_revoked_by);
    v_families := v_families + 1;
    v_grants := v_grants + coalesce((v_one->>'grants_revoked')::integer, 0);
    v_jtis := v_jtis + coalesce((v_one->>'jtis_revoked')::integer, 0);
  end loop;
  -- Nothing to sweep is reported as such, so a typo'd email cannot read as a successful revocation
  -- (the single-family RPC says not_found for the same situation; the CLI exits non-zero).
  return jsonb_build_object(
    'status', case when v_families = 0 then 'not_found' else 'revoked' end,
    'email', v_email,
    'families_revoked', v_families,
    'grants_revoked', v_grants,
    'jtis_revoked', v_jtis
  );
end;
$$;

-- 0006's rotation, with one new guard between the family lock and the consume: a family whose
-- access-token jti has been revoked (the session kill switch) is swept and refused. Everything
-- from the consume onward is 0006's body verbatim.
create or replace function redeem_oauth_refresh(
  p_token_hash text,
  p_client_id text,
  p_now timestamptz,
  p_successor_hash text,
  p_successor_expires_at timestamptz,
  p_successor_jti text default null
) returns jsonb
language plpgsql
as $$
declare
  v_row recruiter_mcp_oauth_grants%rowtype;
  v_family text;
  v_family_revoked boolean;
  v_jti_revoked boolean;
begin
  select * into v_row from recruiter_mcp_oauth_grants where token_hash = p_token_hash;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  v_family := v_row.family_id;
  perform pg_advisory_xact_lock(hashtext(v_family));
  select * into v_row from recruiter_mcp_oauth_grants where token_hash = p_token_hash for update;
  v_family_revoked := exists (
    select 1 from recruiter_mcp_oauth_revoked_families where family_id = v_family
  );

  -- The session kill switch reaches the family: any jti this lineage minted that an operator has
  -- revoked makes the WHOLE lineage dead, before the presented token is even judged. The sweep runs
  -- under the lock we already hold, so a concurrent redeem cannot seat an escaping successor.
  if not v_family_revoked then
    v_jti_revoked := exists (
      select 1
      from recruiter_mcp_oauth_grants g
      join recruiter_mcp_session_revocation r on r.token_id = g.access_jti
      where g.family_id = v_family and r.status = 'revoked'
    );
    if v_jti_revoked then
      perform revoke_oauth_family_locked(v_family, p_now, 'session_revoked', 'redeem_oauth_refresh');
      return jsonb_build_object('status', 'family_revoked');
    end if;
  end if;

  if v_row.consumed_at is null and v_row.revoked_at is null and not v_family_revoked then
    update recruiter_mcp_oauth_grants set consumed_at = p_now where token_hash = p_token_hash;
    if v_row.grant_kind <> 'refresh' then
      return jsonb_build_object('status', 'wrong_kind');
    end if;
    if v_row.expires_at < p_now then
      return jsonb_build_object('status', 'expired');
    end if;
    if v_row.client_id <> p_client_id then
      return jsonb_build_object('status', 'client_mismatch');
    end if;
    insert into recruiter_mcp_oauth_grants (
      token_hash, grant_kind, family_id, client_id, email, surface, client, resource, scope,
      access_jti, created_at, expires_at
    ) values (
      p_successor_hash, 'refresh', v_family, v_row.client_id, v_row.email, v_row.surface,
      v_row.client, v_row.resource, v_row.scope, p_successor_jti, p_now, p_successor_expires_at
    );
    return jsonb_build_object(
      'status', 'rotated',
      'family_id', v_family,
      'email', v_row.email,
      'surface', v_row.surface,
      'client', v_row.client,
      'resource', v_row.resource,
      'scope', v_row.scope
    );
  end if;

  if v_row.grant_kind = 'refresh' and v_row.consumed_at is not null and not v_family_revoked then
    update recruiter_mcp_oauth_grants
      set revoked_at = coalesce(revoked_at, p_now)
      where family_id = v_family;
    insert into recruiter_mcp_oauth_revoked_families (family_id, revoked_at, reason)
      values (v_family, p_now, 'refresh_reuse')
      on conflict (family_id) do nothing;
    insert into recruiter_mcp_session_revocation (token_id, status, revoked_at, revoked_by, reason)
      select access_jti, 'revoked', p_now, 'oauth_refresh_reuse', 'oauth_refresh_reuse'
      from recruiter_mcp_oauth_grants
      where family_id = v_family and access_jti is not null
      on conflict (token_id) do nothing;
    return jsonb_build_object('status', 'reuse_revoked');
  end if;

  return jsonb_build_object('status', 'not_redeemable');
end;
$$;

-- Two new RPC names: ask PostgREST to reload its schema cache so the store does not PGRST202
-- until the DDL watcher gets around to it.
notify pgrst, 'reload schema';
