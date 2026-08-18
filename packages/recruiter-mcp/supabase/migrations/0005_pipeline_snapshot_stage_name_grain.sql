-- 0005: re-grain the logbook to (week, job, stage NAME).
--
-- v3's stage_id on an application row is a PER-APPLICATION stage-instance id, never shared:
-- the first corrected sweep produced 167,697 stage buckets of size exactly 1 — a shadow copy
-- of applications, the grain the design doc explicitly forbids. Stage names are the shared
-- vocabulary on this endpoint (111 distinct org-wide), and /v3/applications offers no
-- job-interview-stage definition id, so the durable grain is
-- (period_key, greenhouse_job_id, stage_name), with '' = the job-level rollup row
-- (same NULL-breaks-dedupe reasoning as 0003's stage_id sentinel).
--
-- The truncate discards only wrong-grain rows written by the first sweeps on 2026-07-02;
-- no reader consumes this table yet (temporal wiring is deliberately activation-gated).
-- Gated on the old column still existing so a re-run never wipes real name-grain history.

do $$ begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'pipeline_state_snapshot' and column_name = 'stage_id'
  ) then
    execute 'truncate table public.pipeline_state_snapshot';
  end if;
end $$;

alter table public.pipeline_state_snapshot
  drop constraint if exists pipeline_state_snapshot_req_stage_week_key;
alter table public.pipeline_state_snapshot
  drop column if exists stage_id;

update public.pipeline_state_snapshot set stage_name = '' where stage_name is null;
alter table public.pipeline_state_snapshot alter column stage_name set default '';
alter table public.pipeline_state_snapshot alter column stage_name set not null;

alter table public.pipeline_state_snapshot
  add constraint pipeline_state_snapshot_req_stage_week_key
  unique (period_key, greenhouse_job_id, stage_name);
