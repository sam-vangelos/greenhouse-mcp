# Greenhouse MCP Supabase Project

The canonical Supabase project for the scoped Greenhouse MCP is:

- Project name: `Greenhouse MCP`
- Project ref: `exampleprojectref000`
- Organization id: `exampleorgid00000000`

This Supabase project is an access-state backend for the MCP. It is not a Greenhouse analytical mirror.

Expected public tables:

- `public.recruiter_identity_directory`: maps authenticated MCP users to their Greenhouse identity and access status.
- `public.recruiter_mcp_session_revocation`: stores durable MCP session/token revocations.

Do not use `recruiting-ops-analytics` (`otherprojectref00000`) when checking Greenhouse MCP Supabase state. That is a different project and can contain recruiting-ops/YTD analytics tables that do not belong to this MCP.

## Source-controlled schema (dedicated migration tree)

The schema for these two tables lives in **this package's own migration tree**, scoped to the MCP
project by its own `config.toml`:

- `packages/recruiter-mcp/supabase/config.toml`
- `packages/recruiter-mcp/supabase/migrations/0001_recruiter_identity_directory.sql`

It deliberately does **not** live in the repo-root `supabase/migrations/` tree, which belongs to the
separate `recruiting-ops-analytics` project (sweeps, YTD, notifications, ledgers). Keeping the MCP
schema in its own tree makes the project boundary structural: each project's `supabase db push` only
ever enumerates its own migrations.

The runtime also asserts this boundary in code — `assertCanonicalSupabaseProjectRef`
(`src/supabase-config.ts`) extracts the project ref from every `*_SUPABASE_URL` env value on the
identity, revocation, bootstrap, and readiness paths and rejects any host that is not
`exampleprojectref000`, so a misconfigured deploy fails loudly instead of silently reading the wrong
project.

## Verifying the linked project and tables

Before making claims about the Greenhouse MCP Supabase database, run:

```bash
npm run control:greenhouse-mcp-supabase
```

## Applying schema (MCP project only)

Run Supabase schema commands for the MCP project **from this package directory**, so the CLI uses the
MCP migration tree and the MCP-bound link — never from the repo root:

```bash
cd packages/recruiter-mcp
supabase link --project-ref exampleprojectref000 --yes
supabase db push
```

> Do **not** relink the repo-root checkout to `exampleprojectref000` and `supabase db push` from
> there: that would apply the analytics migrations to the MCP project. The MCP tree and the analytics
> tree are linked and pushed independently, each from its own directory.
