-- Temporal logbook (Option B, greenlit 2026-06-30 — docs/greenhouse-mcp-temporal-logbook-design.md).
-- Append-only DERIVED stage-occupancy snapshots (a few thousand small rows/year), NOT a mirror of
-- candidate/application rows: this is the only path to true stage-flow week-over-week on a tenant
-- whose application_stages.entered_at is null (live finding L3). One row per req-stage-week,
-- idempotent within the in-progress week.
--
-- NOT applied by the build. Sam applies it (supabase db push against exampleprojectref000) and
-- wires the weekly cron; the writer ships dormant behind GREENHOUSE_RECRUITER_SNAPSHOT_ENABLED.

create table if not exists public.pipeline_state_snapshot (
  id bigserial primary key,
  period_key date not null,                -- the Monday (UTC) of the ISO week this snapshot represents
  snapshot_at timestamptz not null,        -- when the snapshot was actually taken
  greenhouse_job_id integer not null,      -- the req
  stage_id integer,                        -- the interview stage; null = job-level rollup
  stage_name text,
  active_count integer not null,           -- candidates active in this stage at snapshot time
  status_mix jsonb,                        -- {active, hired, rejected, ...} counts, optional
  scope_hash text,                         -- provenance: the resolver scope that produced it
  actor_id integer,                        -- provenance
  created_at timestamptz not null default now()
);

-- Idempotent upsert target: one row per req-stage-week. A partial unique index (not a table
-- constraint) so the null-stage job-level rollup row also dedupes per req-week.
create unique index if not exists pipeline_state_snapshot_req_stage_week
  on public.pipeline_state_snapshot (period_key, greenhouse_job_id, stage_id)
  where stage_id is not null;
create unique index if not exists pipeline_state_snapshot_req_week_rollup
  on public.pipeline_state_snapshot (period_key, greenhouse_job_id)
  where stage_id is null;

-- Mirror the identity tables' posture (Slice F): RLS on, service_role-only writes.
alter table public.pipeline_state_snapshot enable row level security;
