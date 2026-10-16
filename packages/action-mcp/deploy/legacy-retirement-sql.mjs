const LEGACY_TABLE = "public.greenhouse_application_assignment_action";
const ARCHIVE_SCHEMA = "greenhouse_mcp_archive";
const ARCHIVE_TABLE = `${ARCHIVE_SCHEMA}.greenhouse_application_assignment_action`;

export function legacyRetirementSql() {
  return `
begin;
lock table ${LEGACY_TABLE} in access exclusive mode;
create schema if not exists ${ARCHIVE_SCHEMA};
revoke all on schema ${ARCHIVE_SCHEMA} from public, anon, authenticated, service_role;
do $$
begin
  if exists (select 1 from ${LEGACY_TABLE} where status in ('executing', 'unknown')) then
    raise exception 'legacy assignment actions are still unresolved';
  end if;
  if to_regclass('${ARCHIVE_TABLE}') is not null then
    raise exception 'legacy assignment archive table already exists';
  end if;
end;
$$;

alter table ${LEGACY_TABLE} set schema ${ARCHIVE_SCHEMA};
revoke all on table ${ARCHIVE_TABLE} from public, anon, authenticated, service_role;

drop function if exists public.claim_greenhouse_application_assignment_action(uuid, uuid, bigint, text, text, text, bigint, bigint, text, bigint, bigint, text, text, timestamptz, uuid);
drop function if exists public.begin_greenhouse_application_assignment_mutation(uuid, uuid);
drop function if exists public.finish_greenhouse_application_assignment_action(uuid, uuid, text, text, text, integer, text);
drop function if exists public.prepare_greenhouse_assignment_reconciliation(uuid);
drop function if exists public.defer_greenhouse_assignment_unknown(uuid);
drop function if exists public.reconcile_greenhouse_assignment_original_observation(uuid);
drop function if exists public.resolve_greenhouse_assignment_unknown(uuid, text, text, text, text, text);
commit;
`;
}

export { ARCHIVE_TABLE, LEGACY_TABLE };
