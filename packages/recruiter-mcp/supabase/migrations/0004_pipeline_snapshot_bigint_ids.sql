-- 0004: Greenhouse ids exceed int4.
--
-- The first real sweep failed with PostgREST 22003: value "4111111004" is out of
-- range for type integer. Harvest v3 ids (jobs, stages, users) run ~4.1e9, past
-- int4's 2,147,483,647 ceiling. Migration 0001 already used bigint for
-- greenhouse_user_id; 0002 regressed to integer for the three id columns here.
-- Counts (active_count) stay integer — they are tallies, not Greenhouse ids.
--
-- Idempotent: re-altering to the same type is a no-op.

alter table public.pipeline_state_snapshot
  alter column greenhouse_job_id type bigint,
  alter column stage_id type bigint,
  alter column actor_id type bigint;
