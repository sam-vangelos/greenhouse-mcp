# Greenhouse Action MCP

This is the dedicated write plane for Greenhouse. It is deployed separately from the recruiter read MCP and does not share that service's endpoint, Harvest credential, signing secret, catalog, or runtime.

The server exposes 11 fixed action capabilities as 22 paired tools:

| Capability | Preview | Apply |
| --- | --- | --- |
| Application assignment | `preview_application_assignment_change` | `apply_application_assignment_change` |
| Job owner | `preview_job_owner_change` | `apply_job_owner_change` |
| Application stage | `preview_application_stage_move` | `apply_application_stage_move` |
| Application rejection | `preview_application_rejection` | `apply_application_rejection` |
| Application unreject | `preview_application_unreject` | `apply_application_unreject` |
| Candidate note | `preview_candidate_note_create` | `apply_candidate_note_create` |
| Job note | `preview_job_note_change` | `apply_job_note_change` |
| Application attribution | `preview_application_attribution_change` | `apply_application_attribution_change` |
| Candidate record | `preview_candidate_record_update` | `apply_candidate_record_update` |
| Offer create | `preview_offer_create` | `apply_offer_create` |
| Offer update | `preview_offer_update` | `apply_offer_update` |

There is no bulk tool and no model-selectable HTTP method or endpoint. Preview resolves the actor, current Greenhouse state, permissions, destination, and effects, then returns a five-minute signed intent. Apply accepts that exact intent and approval echo, repeats the material reads, claims a resource lock, crosses a mutation fence once, sends one fixed mutation, and verifies the result by readback.

## Runtime controls

- `GREENHOUSE_ACTION_SERVICE_ENABLED` gates the HTTP MCP catalog and defaults to `false`.
- `GREENHOUSE_ACTION_WRITES_ENABLED` gates every apply and defaults to `false`.
- `GREENHOUSE_ACTION_CAPABILITIES` is the comma-separated catalog allowlist. Omit it for all 11 capabilities or set it to an empty string for none.
- `GREENHOUSE_ACTION_WRITE_CAPABILITIES` is the comma-separated apply allowlist. Omit it to mirror the catalog; it must be a subset of the catalog.
- Per-user entitlements provide `can_preview`, `can_apply`, and `can_apply_high_impact`. Stage moves and offer currency changes require the high-impact flag.
- `service_user` is the default Greenhouse attribution mode. `per_human` remains blocked until the token probe and a Greenhouse UI attribution test are both complete.

Catalog allowlists affect new MCP calls only. The reconciler retains all 11 action definitions so an action can be resolved after its tools are withdrawn.

## Action and recovery contract

- A signed intent binds action kind, target IDs, actor/session, current and desired fingerprints, approval fingerprint, resource lock, and expiry. It does not contain note bodies, candidate contact arrays, offer compensation values, bearer tokens, or prompts.
- The shared `public.greenhouse_action` ledger stores metadata and keyed fingerprints only. Unresolved work is serialized by `application:{id}`, `candidate:{id}`, `job:{id}`, or `offer-chain:{application_id}`.
- Replaying an action ID returns its recorded state and never sends a second mutation.
- Network failure, timeout, HTTP 408/5xx, asynchronous acknowledgement without conclusive readback, or conflicting readback becomes `unknown`. The server never retries that mutation.
- The reconciler only reads Greenhouse and updates existing ledger rows. It never writes business data. Desired state resolves as applied; the original state must be observed twice at least 30 seconds apart after the action-specific grace period before resolving as not applied. Conflicts stay locked for operator resolution.

## Dedicated Harvest credentials

Create two dedicated Harvest v3 OAuth credentials: one for the HTTP action service and one for the reconciler. They must have different client IDs so their single-active-token lifecycles cannot invalidate each other. Do not reuse or widen the recruiter read credential. For operational simplicity, grant both action credentials exactly these scopes:

```text
harvest:applications:list
harvest:applications:update
harvest:applications:move
harvest:applications:reject
harvest:applications:unreject
harvest:users:list
harvest:jobs:list
harvest:user_job_permissions:list
harvest:job_owners:list
harvest:job_owners:create
harvest:job_owners:destroy
harvest:application_stages:list
harvest:job_interview_stages:list
harvest:rejection_reasons:list
harvest:rejection_details:list
harvest:candidates:list
harvest:candidates:update
harvest:notes:list
harvest:notes:create
harvest:job_notes:list
harvest:job_notes:create
harvest:job_notes:update
harvest:job_notes:destroy
harvest:sources:list
harvest:referrers:list
harvest:offers:list
harvest:offers:create
harvest:offers:update
harvest:custom_fields:list
harvest:custom_field_options:list
```

Do not grant opening, permission-write, candidate delete/merge/anonymize, application hire/destroy, user-admin, or Greenhouse configuration-write scopes.

## Sessions and clients

Codex and Claude Code use separate signed sessions. The default and maximum lifetime is 30 days; production rejects the `test` client.

If upgrading the assignment-only action pilot, retain its action signing secret so already-issued legacy assignment sessions continue to validate. Never share a recruiter-read session or scope-artifact secret with this service.

```sh
node bin/greenhouse-action-issue-session.mjs \
  --subject '<resolved-identity-subject>' \
  --client codex

node bin/greenhouse-action-issue-session.mjs \
  --subject '<resolved-identity-subject>' \
  --client claude_code
```

Identity subjects may be the directory's Google subject or the deployed
email-session form `email:<normalized-primary-email>`. The latter resolves
against `primary_email` and keeps action sessions compatible with the current
recruiter-read rollout when `google_subject` has not been populated.

Issuance returns the bearer `token` once plus token-free `token_id`, `client`, `issued_at`, and `expires_at` metadata. Keep the token only in the user's `GREENHOUSE_ACTION_SESSION_TOKEN` environment variable. Record the other fields in the issuance manifest. Revoke one session with `greenhouse-action-access revoke`; it writes the issued `token_id` to the existing central revocation table, which the HTTP service checks on every authenticated request.

For a pilot or team cohort, prefer the batch operator command. It uniquely resolves the whole roster before writing entitlements, issues per-user/client session files with mode `0600`, and writes a token-free manifest:

```sh
node bin/greenhouse-action-access.mjs provision \
  --roster ./action-roster.json \
  --out-dir ./action-sessions

node bin/greenhouse-action-access.mjs revoke \
  --token-id 'action:<id>' \
  --revoked-by '<operator>' \
  --reason '<reason>'

node bin/greenhouse-action-access.mjs disable \
  --subject '<resolved-identity-subject>' \
  --client codex
```

Roster entries use `subject`, optional `clients` (defaulting to both `codex` and `claude_code`), and explicit `can_apply` / `can_apply_high_impact` booleans. The generated `session-*.json` files contain bearer tokens; `manifest.json` does not. Delete each session file after the intended user verifies delivery, retain only the manifest, and note that provisioning rotates entitlement expiry to the new session expiry.

If provisioning reports unknown entitlement state or a bearer-file cleanup failure, keep global writes off and do not retry. Use the retained token-free `.manifest-*.pending.json` to run `disable` for every subject/client and `revoke` for every token ID, verify those operations, delete any listed bearer files plus the pending manifest, then retry in a fresh directory.

When replacing the assignment-only pilot, freeze its service, let its five-minute V1 intents expire, reconcile the old ledger to zero `executing`/`unknown` rows, stop its reconciler, then run `npm run retire:legacy-assignment`. Replace the old required `greenhouse_assignment_action` client block with `greenhouse_action` in the same client config update; do not register both endpoints. The full checked sequence is in the release runbook.

The examples under [`client/`](client/) register every preview tool for automatic use and every apply tool for a physical approval prompt. A conversational “yes” is not the approval boundary; the client must stop on the actual apply tool call.

### Granola orchestration

Granola remains a client-side Claude Code connector, not a server integration. The intended flow is:

1. The human selects the Granola meeting artifact.
2. Claude Code reads it through the Granola connector and drafts a note.
3. Claude Code uses the recruiter read MCP to resolve the candidate and application.
4. Claude Code calls `preview_candidate_note_create` and shows the exact destination, note type, visibility, and body.
5. After the human approves the physical apply prompt, Claude Code calls `apply_candidate_note_create` once.

No Granola webhook, background synchronization, extra database, or Granola-specific Greenhouse credential beyond the two action-service credentials is required.

## Verification

```sh
npm ci
npm run verify
npm run smoke:sql
npm run smoke:docker
```

The PostgreSQL smoke proves cross-kind locking, independent locks, replay, fencing, recovery, and operator resolution. The Docker smoke proves the dark endpoint, authentication failures, production test-session rejection, the authenticated 22-tool catalog, default-off apply denial, and the expected build SHA. When the service is enabled, `/readyz` additionally performs bounded live probes of Supabase authorization state and Greenhouse OAuth.

## Deployment

- Environment contract: [`deploy/production.env.example`](deploy/production.env.example)
- SQL install: [`supabase/action-state.sql`](supabase/action-state.sql)
- Render blueprint: [`deploy/render-action.yaml`](deploy/render-action.yaml)
- Release, canary, reconciliation, and rollback: [`deploy/runbook.md`](deploy/runbook.md)
- Pilot evidence template: [`deploy/pilot-evidence.json.example`](deploy/pilot-evidence.json.example)

Apply the SQL file explicitly. Do not run the scoped read package's dormant migration chain wholesale.
