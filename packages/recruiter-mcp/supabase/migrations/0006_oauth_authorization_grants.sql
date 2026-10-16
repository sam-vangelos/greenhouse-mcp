-- Durable OAuth authorization grants for the connector sign-in layer (CLO-198).
--
-- One table carries both short-lived one-time authorization codes (grant_kind = 'code') and
-- rotating refresh tokens (grant_kind = 'refresh'). Access tokens are NOT stored — they are
-- self-contained signed tokens killed through the existing recruiter_mcp_session_revocation
-- table by jti. To make that kill switch reach OAuth sessions, each refresh row records the
-- access-token jti minted alongside it (access_jti); on a refresh-reuse response the rotation
-- function copies the family's outstanding jtis into recruiter_mcp_session_revocation, so a
-- stolen access token dies with the family instead of living out its full hour.
--
-- Secrets never live here: token_hash is the sha256 hex digest of the code / refresh-token
-- string, CHECK-pinned to that shape so a raw secret cannot even be inserted by mistake.
-- family_id ties a refresh lineage together: rotation inserts the successor into the same
-- family, and a reuse of an already-consumed refresh token revokes the whole family at once
-- (RFC 6749 §10.4 refresh-token replay response).

create table if not exists recruiter_mcp_oauth_grants (
  token_hash text primary key
    check (token_hash ~ '^[0-9a-f]{64}$'),
  grant_kind text not null
    check (grant_kind in ('code', 'refresh')),
  family_id text not null
    check (btrim(family_id) <> ''),
  -- The OAuth client identity: a CIMD HTTPS metadata URL, or the env-listed static client id.
  client_id text not null
    check (btrim(client_id) <> ''),
  -- Authorization codes bind the redirect and the PKCE challenge; refresh rows carry neither.
  redirect_uri text
    check (redirect_uri is null or btrim(redirect_uri) <> ''),
  code_challenge text
    check (code_challenge is null or btrim(code_challenge) <> ''),
  check (grant_kind <> 'code' or (redirect_uri is not null and code_challenge is not null)),
  -- The resolved recruiter identity the grant was issued for.
  email text not null
    check (email = lower(btrim(email)) and email <> ''),
  surface text not null
    check (surface in ('claude_desktop', 'chatgpt_desktop')),
  client text not null
    check (client in ('claude_desktop_chat', 'claude_code', 'chatgpt_codex_host')),
  -- RFC 8707: the resource the grant is bound to (the canonical /mcp URL).
  resource text not null
    check (btrim(resource) <> ''),
  scope text
    check (scope is null or btrim(scope) <> ''),
  -- The access-token jti minted with this refresh row, so the session kill switch can reach it
  -- (codes mint no access token and carry none). Same non-secret token-id shape as auth.ts.
  access_jti text
    check (access_jti is null or access_jti ~ '^[A-Za-z0-9:_-]{1,160}$'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  revoked_at timestamptz
);

create index if not exists idx_recruiter_mcp_oauth_grants_family
  on recruiter_mcp_oauth_grants(family_id)
  where revoked_at is null;

-- Row-level security, zero policies: same posture as migration 0001. The hosted MCP connects
-- with this project's service_role key, which bypasses RLS by design; enabling RLS with no
-- policies denies every other role (anon, authenticated) by default. These rows gate sign-in
-- and carry recruiter emails, so nothing but the hosted server's service_role may touch them.
alter table recruiter_mcp_oauth_grants enable row level security;

-- Idempotency backstop for access_jti. It is declared in the create-table above, but this file was
-- edited in place to add it alongside the rotation RPC, and `create table if not exists` will NOT
-- add a column to a table an earlier draft already created. Adding it explicitly is a no-op on a
-- fresh create and the difference between a working kill switch and a runtime 500 (the RPC inserts
-- and the reuse sweep selects access_jti) on any project where a prior version was applied.
alter table recruiter_mcp_oauth_grants
  add column if not exists access_jti text
    check (access_jti is null or access_jti ~ '^[A-Za-z0-9:_-]{1,160}$');


-- Family revocation as a durable PROPERTY, not a sweep of the rows that happen to exist NOW.
-- A row here means the entire refresh lineage is dead: rotation refuses to seat a successor into
-- a revoked family, so a successor inserted concurrently with (or after) the reuse response can
-- never survive as a live token. Presence is the whole signal; the timestamp is for forensics.
create table if not exists recruiter_mcp_oauth_revoked_families (
  family_id text primary key
    check (btrim(family_id) <> ''),
  revoked_at timestamptz not null default now(),
  reason text
);

alter table recruiter_mcp_oauth_revoked_families enable row level security;


-- Atomic refresh rotation (RFC 6749 section 10.4). The race and the partial-write that a
-- consume-then-insert pair could not avoid are BOTH closed here by doing consume, reuse-detect,
-- family-revoke, and successor-seat in ONE transaction under a per-family advisory lock:
--   * concurrent reuse can no longer let a winner's successor land after a loser's revoke — the
--     lock serializes them, and the successor is refused the moment the family is revoked;
--   * a PRE-commit transient failure rolls the whole transaction back, so the presented token is
--     never left consumed-without-a-successor. (A failure AFTER commit but before the HTTP 200
--     reaches the client — a dropped response or a pod restart — is not covered: the client still
--     holds the now-rotated token, and its honest retry reads as reuse and kills the family. That
--     is bounded and recoverable — the user re-signs-in, no live token survives — and preferable
--     to relaxing always-kill-on-reuse, which is the RFC 10.4 theft control.)
-- consume-before-verify is preserved: a consumable row is burned before grant_kind / expiry /
-- client_id are judged, so a wrong client or an expired token still spends the presented secret.
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
begin
  select * into v_row from recruiter_mcp_oauth_grants where token_hash = p_token_hash;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  v_family := v_row.family_id;
  -- Serialize every redeem / reuse decision for this family: consume, reuse-revoke, and the
  -- successor seat can never interleave across concurrent /token calls for the same lineage.
  perform pg_advisory_xact_lock(hashtext(v_family));
  select * into v_row from recruiter_mcp_oauth_grants where token_hash = p_token_hash for update;
  v_family_revoked := exists (
    select 1 from recruiter_mcp_oauth_revoked_families where family_id = v_family
  );

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

  -- Not consumable. A reused (already-consumed) refresh token is the theft signal: the whole
  -- family dies FIRST, as a durable property, before the caller learns anything — and every
  -- access-token jti the family ever minted is dropped into the session revocation list in the
  -- SAME transaction, so a stolen access token dies now instead of living out its hour.
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


-- Atomic authorization-code consume. The code leg keeps its verifier checks (PKCE, redirect,
-- client, expiry) in the application AFTER this call, so this only burns the code single-winner
-- under the family lock and refuses a code whose family was already revoked; the app then judges
-- the returned row. consume-before-verify is intact: the code is spent here, before PKCE runs.
create or replace function redeem_oauth_code(
  p_token_hash text,
  p_now timestamptz
) returns jsonb
language plpgsql
as $$
declare
  v_row recruiter_mcp_oauth_grants%rowtype;
begin
  select * into v_row from recruiter_mcp_oauth_grants where token_hash = p_token_hash;
  if not found then
    return jsonb_build_object('status', 'not_consumable');
  end if;
  perform pg_advisory_xact_lock(hashtext(v_row.family_id));
  select * into v_row from recruiter_mcp_oauth_grants where token_hash = p_token_hash for update;
  if v_row.consumed_at is not null
     or v_row.revoked_at is not null
     or exists (select 1 from recruiter_mcp_oauth_revoked_families where family_id = v_row.family_id) then
    return jsonb_build_object('status', 'not_consumable');
  end if;
  update recruiter_mcp_oauth_grants set consumed_at = p_now where token_hash = p_token_hash;
  return jsonb_build_object(
    'status', 'consumed',
    'token_hash', v_row.token_hash,
    'grant_kind', v_row.grant_kind,
    'family_id', v_row.family_id,
    'client_id', v_row.client_id,
    'redirect_uri', v_row.redirect_uri,
    'code_challenge', v_row.code_challenge,
    'email', v_row.email,
    'surface', v_row.surface,
    'client', v_row.client,
    'resource', v_row.resource,
    'scope', v_row.scope,
    'expires_at', v_row.expires_at
  );
end;
$$;
