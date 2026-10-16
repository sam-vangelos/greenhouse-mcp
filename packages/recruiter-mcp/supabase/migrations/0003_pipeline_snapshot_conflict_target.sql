-- Fix the upsert conflict target (live failure 2026-07-02): ON CONFLICT (cols) cannot infer a
-- PARTIAL unique index, so migration 0002's two partial indexes made every PostgREST upsert fail
-- with 42P10. Replace the nullable stage_id + partial indexes with a 0-sentinel (0 = job-level
-- rollup row) and ONE plain unique constraint the upsert can target. NULL stage_id would also have
-- broken dedupe outright (UNIQUE treats NULLs as distinct -> duplicate rollups every refresh).

update public.pipeline_state_snapshot set stage_id = 0 where stage_id is null;
alter table public.pipeline_state_snapshot alter column stage_id set default 0;
alter table public.pipeline_state_snapshot alter column stage_id set not null;

drop index if exists pipeline_state_snapshot_req_stage_week;
drop index if exists pipeline_state_snapshot_req_week_rollup;

alter table public.pipeline_state_snapshot
  drop constraint if exists pipeline_state_snapshot_req_stage_week_key;
alter table public.pipeline_state_snapshot
  add constraint pipeline_state_snapshot_req_stage_week_key
  unique (period_key, greenhouse_job_id, stage_id);
