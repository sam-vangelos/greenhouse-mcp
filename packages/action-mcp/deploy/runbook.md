# Greenhouse Action MCP release runbook

The action service is independent of the recruiter read service. Never change the read service's URL, OAuth credential, signing secret, catalog, or Render service during this release.

## 1. Verify the release

From the repository root:

```sh
npm --prefix packages/action-mcp ci
npm --prefix packages/action-mcp run verify
npm --prefix packages/action-mcp run smoke:sql
npm --prefix packages/action-mcp run smoke:docker
```

Record the tested commit:

```sh
git rev-parse HEAD
```

The Docker smoke must prove the dark `/mcp`, unauthenticated rejection, production test-session rejection, the authenticated 22-tool catalog, default-off apply denial, and the expected SHA. Do not deploy a different commit.

## 2. Provision the dedicated boundaries

1. Create two dedicated Harvest v3 OAuth credentials with exactly the scopes in the package README: one for the HTTP action service and one for the reconciler. Their client IDs must differ so token rotation in one process cannot invalidate the other. Do not modify the read credential.
2. If the assignment-only action pilot already issued sessions, carry forward its 32+ byte action signing secret so those legacy action sessions remain valid. Otherwise create a new action signing secret. Never reuse a recruiter-read session or scope-artifact secret.
3. Configure the canonical Greenhouse MCP Supabase URL and server key.
4. Put the signing secret, Supabase key, HTTP action client ID, and HTTP action client secret in a Render environment group named `greenhouse-action-secrets`. Reference it from both services. Put only `GREENHOUSE_ACTION_RECONCILER_CLIENT_ID` and `GREENHOUSE_ACTION_RECONCILER_CLIENT_SECRET` in `greenhouse-action-reconciler-secrets`, and reference that second group from the reconciler only.
5. Keep `GREENHOUSE_ACTION_SERVICE_ENABLED=false`, `GREENHOUSE_ACTION_WRITES_ENABLED=false`, and `GREENHOUSE_ACTION_WRITE_CAPABILITIES=`.
6. Keep `GREENHOUSE_ACTION_ATTRIBUTION_MODE=service_user` unless the per-human token probe and a Greenhouse sandbox UI attribution check have both passed.

The service-user mode still binds the human identity, entitlement, job permission, session, preview, approval, and ledger record; Greenhouse itself attributes the API call to the integration service user.

For a prospective `per_human` deployment:

```sh
npm --prefix packages/action-mcp run probe:tokens
```

Do not set `GREENHOUSE_ACTION_PER_HUMAN_TOKEN_PROBE_PASSED=true` from that JSON alone. Also prove in Greenhouse that permissions and UI attribution follow the requested `sub`.

## 3. Install the shared action state

Verify the exact install credential before inspecting, retiring, or applying state:

```sh
node packages/action-mcp/bin/greenhouse-action-access.mjs check-db-url
```

If `public.greenhouse_application_assignment_action` exists from the assignment-only pilot, retire it before installing the generic ledger:

1. Set the old `greenhouse-assignment-action-mcp` service's `GREENHOUSE_ACTION_SERVICE_ENABLED=false` and `GREENHOUSE_ACTION_WRITES_ENABLED=false`, deploy, and verify its `/mcp` returns 503.
2. Wait at least five minutes so every V1 assignment intent issued before the freeze has expired.
3. Keep the old reconciler running until `executing` plus `unknown` is zero. Resolve any persistent `unknown` through the old operator flow; do not discard it.
4. Stop the old assignment reconciler so nothing retains or reacquires the legacy table.
5. Run the checked retirement command below. It aborts unless unresolved rows are zero, locks and rechecks the table in one transaction, moves it to `greenhouse_mcp_archive.greenhouse_application_assignment_action`, revokes runtime access, and drops exactly the seven legacy RPCs. It does not delete the archived rows.

```sh
GREENHOUSE_ACTION_RETIRE_LEGACY_ASSIGNMENT_STATE=archive \
  npm --prefix packages/action-mcp run retire:legacy-assignment
```

If no legacy table exists, skip those five steps. Do not run the old and generic ledgers in parallel.

Apply only the action-owned SQL file. Do not run `supabase db push`; the read package contains unrelated migrations.

```sh
node packages/action-mcp/bin/greenhouse-action-access.mjs check-db-url
psql "$GREENHOUSE_ACTION_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f packages/action-mcp/supabase/action-state.sql
GREENHOUSE_MCP_REQUIRE_ACTION_STATE=true node scripts/greenhouse-mcp-supabase-guard.mjs
```

The URL check is intentionally adjacent to `psql`: it validates the exact install credential, accepts only the canonical project's direct or Supabase pooler form, and never prints it. The SQL still stops if the legacy table was not retired.

Create a roster file for the pilot. The operator command resolves every subject uniquely before writing any entitlement, upserts the client rows, and creates one 30-day session per listed user/client:

```json
{
  "users": [
    {
      "subject": "<pilot-identity-subject>",
      "clients": ["codex", "claude_code"],
      "can_apply": false,
      "can_apply_high_impact": false
    }
  ]
}
```

```sh
node packages/action-mcp/bin/greenhouse-action-access.mjs provision \
  --roster ./action-pilot-roster.json \
  --out-dir ./action-pilot-sessions
```

Use the directory's Google subject when it is populated. For identities
onboarded through the deployed email-session path, use
`email:<normalized-primary-email>`; the operator resolves that exact value
against `primary_email` before it writes either entitlement.

The command must report one resolved user, two entitlements, and two session files. Entitlement expiry rotates to the same time as the new session. `manifest.json` is token-free; every sibling `session-*.json` contains one bearer token and must go only to that user/client.

Disable one user/client entitlement without deleting its session or action history:

```sh
node packages/action-mcp/bin/greenhouse-action-access.mjs disable \
  --subject '<resolved-identity-subject>' \
  --client codex
```

If provisioning reports unknown entitlement state or a bearer-file cleanup failure:

1. Keep `GREENHOUSE_ACTION_WRITES_ENABLED=false` and do not retry provisioning.
2. Open the retained token-free `.manifest-*.pending.json`.
3. Run `disable` for every listed subject/client and `revoke` for every listed token ID.
4. Verify each disable/revocation, delete any listed bearer files and the pending manifest, then retry in a fresh directory.

## 4. Deploy dark and gate the SHA

Create the new services from [`render-action.yaml`](render-action.yaml). Leave auto-deploy off, supply the action-only secrets, and deploy the tested commit.

With both switches false:

- `/healthz` returns 200.
- `/version` returns `name:greenhouse-action-mcp`, `version:0.2.0`, and the exact tested commit.
- `/readyz` returns 503 because the catalog is intentionally dark.
- `/mcp` returns 503.
- One reconciler run exits successfully and returns an `actions` array, even when it is empty; the sweep probes the dedicated reconciler OAuth credential before reading the ledger.
- The recruiter read service health and catalog are unchanged.

Example SHA gate:

```sh
curl -fsS https://greenhouse-action-mcp.example.com/version
```

Do not proceed if `commit` is `unknown` or differs from `git rev-parse HEAD`.

## 5. Enable preview and prove the client approval boundary

Set only `GREENHOUSE_ACTION_SERVICE_ENABLED=true` and deploy the same SHA. Leave global writes false and the write-capability list empty.

Verify:

- `/readyz` returns 200, `writes_enabled:false`, all 11 catalog capabilities, no write capabilities, and the expected commit.
- An authenticated MCP `tools/list` returns exactly the 22 documented tools.
- Every preview succeeds or returns a business refusal without sending a mutation.
- Every apply returns `WRITES_DISABLED`.

Deliver each previously generated bearer token only through the matching pilot/client's local `GREENHOUSE_ACTION_SESSION_TOKEN`. After the recipient verifies the configured token, delete that `session-*.json`; retain only the token-free manifest. Install the matching examples under [`../client/`](../client/).

During an assignment-pilot upgrade, replace the client's old required `greenhouse_assignment_action` server block with the new `greenhouse_action` block in the same managed config update. Do not leave both action endpoints registered or keep the old block marked required.

In both Codex and Claude Code, invoke at least one preview and then its apply. Capture evidence that:

- preview runs without a write prompt;
- the human sees the exact target, before, after, and effects before apply;
- the client pauses on a physical approval prompt for apply;
- approval cannot be persistently bypassed for that apply tool; and
- apply remains denied by the server while writes are false.

A typed or spoken “yes” is not sufficient. If the physical prompt is missing or bypassable, keep writes disabled.

## 6. Run one-write canaries

For a canary, grant `can_apply=true` to one pilot/client, add exactly one action kind to `GREENHOUSE_ACTION_WRITE_CAPABILITIES`, set `GREENHOUSE_ACTION_WRITES_ENABLED=true`, and deploy the same SHA. Grant `can_apply_high_impact=true` only for a witnessed stage move or offer currency change.

For every capability:

1. Record the Greenhouse state before preview.
2. Preview once and inspect the exact target, before, after, and effects.
3. Approve one physical apply prompt.
4. Verify the returned state by Greenhouse readback and UI inspection.
5. Replay the exact apply arguments. It must return the same `action_id` and send no second mutation.
6. Inspect the action ledger for IDs, status, timestamps, and fingerprints only. No note body, candidate PII array, prompt, bearer token, or compensation value may be present.
7. Record [`pilot-evidence.json.example`](pilot-evidence.json.example).
8. Remove the write capability and set global writes false until the evidence is reviewed.

Use this order so each shared behavior is proven once before its dependents:

1. `application_assignment_change`
2. `application_rejection`, `application_unreject`, then witnessed `application_stage_move`
3. `candidate_note_create`, then job-note create/update/delete
4. `offer_create`, non-currency `offer_update`, then witnessed currency changes
5. `job_owner_change` and `application_attribution_change`
6. `candidate_record_update`, with custom fields after the tenant's definitions/options normalize successfully

Capability-specific stop checks:

- Assignment: the unselected assignment field is unchanged.
- Job owner: add/remove resolves the exact job, user, role, and row; no candidate-responsibility bulk reassignment occurs.
- Stage: the destination belongs to the same job; treat configured transition email as a disclosed effect.
- Rejection: no candidate email is attached. Unreject restores the bound pre-rejection stage.
- Candidate note: destination, author, type, visibility, and body match. A candidate note is not rolled back by deletion.
- Job note: update cannot move a note to another job; delete is permanent.
- Attribution: only supplied source/referrer fields change; a referrer ID is not treated as a user ID.
- Candidate: complete touched collections preserve all untouched entries; async acknowledgement without desired readback is not success.
- Offer: create refuses an existing offer chain; update follows the current offer version even if its ID changes; compensation requires high-impact entitlement.

Any wrong target, stale-state acceptance, readback mismatch, duplicate mutation, unexpected email, unexpected offer-chain result, or `unknown` canary is a stop gate.

## 7. Claude Code + Granola candidate-note canary

Granola orchestration stays entirely in the client:

1. The pilot selects the meeting in Granola and tells Claude Code which artifact to read.
2. Claude Code reads that artifact through the Granola connector.
3. Claude Code uses the recruiter read MCP to resolve the intended candidate/application; it does not infer the destination from name alone.
4. Claude Code drafts the note and calls `preview_candidate_note_create` with the resolved application, exact body, note type, and visibility.
5. The pilot verifies the destination and full note in the preview.
6. The pilot approves the physical `apply_candidate_note_create` prompt once.
7. Verify exactly one note in Greenhouse and replay to prove no duplicate POST.

Do not add a Granola token, webhook, transcript store, or background worker to the action service.

## 8. Reconciliation and operator resolution

The cron service runs every five minutes even while the HTTP catalog and writes are disabled. It reads Greenhouse and updates existing ledger rows; it never retries a business mutation.

Run a manual sweep with:

```sh
node packages/action-mcp/bin/greenhouse-action-reconcile.mjs
```

Every `unknown` action retains its resource lock. After manually checking Greenhouse and the metadata-only action record, resolve a persistent conflict or unavailable readback without another business mutation:

```sh
node packages/action-mcp/bin/greenhouse-action-reconcile.mjs \
  --resolve-action '<action-uuid>' \
  --outcome applied \
  --operator '<stable-operator-id>'
```

Use `--outcome not_applied` only when the bound original state is conclusive. The ledger stores a keyed operator fingerprint, not the raw operator identifier.

## 9. Expand to the team

After all capability canaries pass, set `GREENHOUSE_ACTION_WRITE_CAPABILITIES` to the reviewed full list and onboard cohorts: owners, 3–5 pilots, then the 20–25-person team. Run `greenhouse-action-access provision` with a reviewed roster for each cohort. Keep `can_apply` and `can_apply_high_impact` explicit per person and retain each token-free manifest.

The rollout is complete only when every registered pair has a successful first-use record, there are no unresolved canary actions, both clients have physical-approval evidence, the revocation drill passes, and `/version` still reports the approved SHA.

## 10. Revoke and roll back

Revoke a single session immediately using only its issued `token_id`:

```sh
node packages/action-mcp/bin/greenhouse-action-access.mjs revoke \
  --token-id '<action:token-id>' \
  --revoked-by '<stable-operator-id>' \
  --reason '<reason>'
```

The command upserts the central revocation row and prints token-free evidence. Confirm the next request using that session returns 401.

Rollback order:

1. Set `GREENHOUSE_ACTION_WRITES_ENABLED=false`, clear `GREENHOUSE_ACTION_WRITE_CAPABILITIES`, deploy, and verify apply returns `WRITES_DISABLED`.
2. If full isolation is required, set `GREENHOUSE_ACTION_SERVICE_ENABLED=false`, deploy, and verify `/mcp` returns 503.
3. Revoke affected token IDs and/or run `greenhouse-action-access disable` for each affected subject/client entitlement.
4. Keep the reconciler running until every unresolved action is resolved.
5. Verify the recruiter read `/healthz`, `/readyz`, and catalog are unchanged.

Do not delete unresolved action rows. Reverse completed business state only through a new preview and separately approved action.
