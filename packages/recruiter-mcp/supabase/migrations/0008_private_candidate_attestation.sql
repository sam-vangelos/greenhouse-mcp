-- Private-candidate attestation for all-access actors (CLO-273).
--
-- Greenhouse decides who may see a private candidate with a USER-SPECIFIC permission ("Can create
-- and view private candidates"), and no Harvest v3 endpoint exposes it. The scoped read plane
-- infers all-access two ways — /v3/users.site_admin, and an all-jobs role marker on
-- /v3/user_job_permissions — and neither says anything about that permission. So an all-access
-- actor read every private candidate in the tenant whether or not the organization had granted
-- them the permission that governs exactly that. These columns are the missing input: an operator's
-- attestation, recorded per directory row, that Greenhouse itself grants it.
--
-- Default false. Every row that already exists, and every row a first sign-in enrolls, is
-- UNATTESTED until an operator runs greenhouse-recruiter-attest-private-candidates. An unattested
-- all-access actor keeps everything else they could read, plus the private candidates their
-- per-job Greenhouse roles grant them; only the org-wide private set is withheld.
--
-- Re-runnable, like every migration in this folder (0006:71, action-state.sql:27): each statement
-- is `add column if not exists`, so applying it twice is a no-op. No RLS or grant statements — the
-- table's RLS posture is set in 0001 and new columns inherit it.

alter table recruiter_identity_directory
  add column if not exists private_candidates_attested boolean not null default false;

alter table recruiter_identity_directory
  add column if not exists private_candidates_attested_at timestamptz;

alter table recruiter_identity_directory
  add column if not exists private_candidates_attested_by text;

comment on column recruiter_identity_directory.private_candidates_attested is
  'True when an operator has attested that Greenhouse grants this user the org-wide "Can create and view private candidates" permission. Only an attested all-access actor sees private candidates across the tenant; set by greenhouse-recruiter-attest-private-candidates.';

comment on column recruiter_identity_directory.private_candidates_attested_at is
  'When the attestation was recorded (ISO timestamp). Null while unattested.';

comment on column recruiter_identity_directory.private_candidates_attested_by is
  'Who recorded the attestation, as passed to the CLI''s --by. Null while unattested.';
