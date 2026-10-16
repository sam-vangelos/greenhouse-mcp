-- Desktop recruiter identity directory for the scoped Greenhouse MCP.
--
-- This is deliberately separate from recruiter_slack_directory. Slack identity is one surface;
-- Claude Desktop and ChatGPT Desktop need a general verified-email -> Greenhouse-user map that
-- can be queried server-side by the hosted MCP without shipping Greenhouse credentials to users.

create table if not exists recruiter_identity_directory (
  id uuid primary key default gen_random_uuid(),
  greenhouse_user_id bigint not null check (greenhouse_user_id > 0),
  primary_email text not null
    check (primary_email = lower(btrim(primary_email)) and primary_email <> ''),
  google_subject text
    check (google_subject is null or btrim(google_subject) <> ''),
  slack_user_id text,
  status text not null default 'unresolved'
    check (status in ('resolved','unresolved','email_missing','greenhouse_missing','ambiguous','blocked','deactivated')),
  source text not null default 'manual',
  evidence_detail jsonb not null default '{}'::jsonb,
  first_seen_at timestamptz not null default now(),
  last_verified_at timestamptz not null default now(),
  unique(greenhouse_user_id)
);

create unique index if not exists idx_recruiter_identity_email_resolved
  on recruiter_identity_directory(lower(primary_email))
  where status = 'resolved';

create unique index if not exists idx_recruiter_identity_google_subject_resolved
  on recruiter_identity_directory(google_subject)
  where status = 'resolved' and google_subject is not null;

create index if not exists idx_recruiter_identity_status
  on recruiter_identity_directory(status, last_verified_at desc);


-- Durable MCP session revocation list for broad desktop rollout.
-- Tokens themselves are not stored here; only the non-secret token_id claim is stored.
-- The hosted MCP checks this table server-side on each authenticated request when configured.

create table if not exists recruiter_mcp_session_revocation (
  token_id text primary key check (btrim(token_id) <> ''),
  status text not null default 'revoked' check (status in ('revoked')),
  revoked_at timestamptz not null default now(),
  revoked_by text,
  reason text,
  evidence_detail jsonb not null default '{}'::jsonb
);

create index if not exists idx_recruiter_mcp_session_revocation_status
  on recruiter_mcp_session_revocation(status, revoked_at desc);


-- Row-level security for the access-control keystone.
--
-- The hosted MCP connects with this project's Supabase service_role key, which BYPASSES
-- row-level security by design. Enabling RLS with no policies therefore denies every other
-- role (anon, authenticated) by default while leaving the server's service_role path intact.
-- That is the intended posture: these two tables hold recruiter PII (primary_email,
-- google_subject) and the durable session kill-switch, and nothing but the hosted server's
-- service_role should ever read or write them. Add an explicit policy here only if a non-
-- service_role consumer is ever introduced.
--
-- Idempotent: ALTER TABLE ... ENABLE ROW LEVEL SECURITY is a no-op when RLS is already on,
-- so this is safe to (re)apply against a project where the tables already exist.
alter table recruiter_identity_directory enable row level security;
alter table recruiter_mcp_session_revocation enable row level security;
