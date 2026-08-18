# Scoped Recruiter Greenhouse MCP

This package is the recruiter-facing MCP adapter around `../scoped-greenhouse`. It is separate from `greenhouse-ops-control-plane` and registers only recruiter-safe read and analysis tools. Every registered recruiter tool carries MCP read-only, non-destructive, idempotent annotations so desktop clients can apply read-tool approval behavior instead of treating the catalog as write-capable.

## Exact Model-Facing Catalog

The approved production/model catalog is exactly these 44 read-only tools. Catalog validation rejects missing, duplicate, or unexpected names; the other 22 registered source readers remain hidden.

Question and deterministic analysis:

- `answer_my_recruiting_question`
- `analyze_scorecard_accountability`
- `analyze_interview_feedback_drag`
- `analyze_stage_latency`
- `analyze_pipeline_quality`
- `analyze_source_quality`
- `analyze_rejection_reason_drift`

Scope controls:

- `resolve_job_scope`
- `confirm_job_scope`
- `get_job_scope`
- `get_recruiting_capabilities`

Explicit resume read:

- `read_my_resume`

Scoped evidence reads:

- `search_my_jobs`
- `get_my_job`
- `search_my_applications`
- `get_my_application`
- `search_my_interviews`
- `search_my_offers`
- `search_my_openings`
- `search_my_users`
- `search_my_job_owners`
- `search_my_job_interview_stages`
- `search_my_application_stages`
- `search_my_job_hiring_managers`
- `search_my_job_posts`
- `search_my_candidates`
- `get_my_candidate`
- `search_my_scorecards`
- `search_my_rejection_details`
- `search_my_rejection_reasons`
- `search_my_notes`
- `search_my_attachments`
- `search_my_interviewers`
- `search_my_scorecard_question_answers`
- `search_my_candidate_educations`
- `search_my_candidate_employments`
- `get_my_user`
- `search_my_sources`
- `search_my_referrers`
- `search_my_custom_field_options`
- `search_my_custom_fields`
- `search_my_departments`
- `search_my_offices`
- `search_my_close_reasons`

The last three are org reference dictionaries with no PII: `search_my_close_reasons` is id and name, while `search_my_departments` also returns `parent_id`/`external_id` and `search_my_offices` also returns `location`/`parent_id` — the org-hierarchy and geography fields that make department and office rollups possible rather than just decodable. They are model-facing because catalog tools already emit ids only they decode: `search_my_jobs` returns `department_id`/`office_ids`, `search_my_openings` returns `close_reason_id`, and `resolve_job_scope` takes free-text department/office names the model would otherwise have no way to enumerate.

The scorecard tool computes deterministic rankings over scoped scorecards: total scorecards, unsubmitted count/rate, severity score, affected jobs, and evidence ids. The model narrates the output; code computes the numbers.

The interview-feedback tool computes deterministic rankings over scoped scorecards: late/missing feedback count/rate, submission delay, affected jobs, severity score, and evidence ids. It uses scorecard interview/submission timestamps and does not depend on the unresolved activity-feed surface.

The stage-latency tool computes deterministic bottleneck rankings over scoped applications: current-stage dwell time, aging application rate, affected jobs, job breakdown, and evidence ids. It uses scoped application rows only; it does not depend on the unresolved activity-feed surface.

The pipeline-quality tool computes deterministic scoped pipeline health: status mix, active/terminal balance, stale active applications, stage concentration, job breakdown, data-quality gaps, and evidence ids. It does not pretend to analyze source, agency, rejection reason, or offer quality.

The source-quality tool computes deterministic scoped source/referrer accountability over application rows: source and referrer ids, outcome mix, success rate, stale active drag, affected jobs, risk score, quality score, data-quality gaps, and evidence ids. It returns ids only; source/referrer names, agency labels, tracking-link labels, and candidate identity are intentionally not exposed.

The question-answer tool is a constrained planner for ambitious recruiter questions. It selects from the approved scoped analysis recipes, strips model-supplied identity params, runs deterministic computations, and returns structured recipe outputs plus evidence ids. It does not run arbitrary SQL, expose raw joins, or bypass `scopedRead`.

Analytical tools are compact by default. Pass `evidence_pack: true` to include a capped metadata-only `evidence_pack` of scoped `type:id` references grouped by record type. The pack is for drilldown planning only; it does not include candidate names, emails, note bodies, scorecard text, or raw rows.

Each analytical summary includes `rows_read`, `pages_read`, `page_limit`, and `pagination_truncated`. If `pagination_truncated` is true, the metrics are intentionally bounded by the runtime page limit and should be rerun with narrower filters or a larger operator-approved page budget before being treated as complete.

## Trust Model

The desktop surface uses a durable session issued after one-time work email onboarding. Recruiters should not have to re-verify routinely. The session identifies a verified work email, then the MCP resolves that email to one Greenhouse user id through an identity directory. Tool params never carry actor identity. Session tokens are forbidden from carrying Greenhouse permission claims such as `greenhouseUserId`, `jobIds`, or `permittedJobIds`.

Work email belongs in onboarding, roster preflight, session issuance, and desktop delivery evidence. It is not a model-callable identity override: identity-like tool params such as `email`, `work_email`, `user_email`, `recruiter_email`, `authenticated_email`, `subject`, and `sub` are stripped before any scoped Greenhouse read. A recruiter can type their email during onboarding, but the MCP runtime scopes them from the signed durable session plus server-side identity directory, not from whatever text appears in a chat request.

The recruiter runtime also applies per-tool raw-read parameter allowlists. Public schemas expose useful filters such as `job_ids`, status, stage, date windows, pagination, and source/referrer ids where a tool intentionally supports them; unsupported scalar params are dropped before `scopedRead`. Raw operator-only expansion controls such as `detail_profile`, `include_attachment_urls`, `reason`, ad hoc `fields`, and arbitrary unknown params are not forwarded through the recruiter surface.

Evidence tool outputs are projected again after `scopedRead` has filtered them. General evidence reads do not return candidate contact fields, attachment URLs, or resume contents; each read then applies its endpoint-specific privacy and permission projection. `read_my_resume` is the one narrow resume-content exception described below. The unscoped operator/analytics MCP remains unchanged; this projection applies only to the recruiter-scoped package.

## Resume Reads

Use `search_my_attachments` first, normally with `type=resume`, to inventory the resume versions visible through the recruiter's permitted jobs. That metadata-only result can include stable ids, filename, type, application/candidate associations, and timestamps, but never the file contents or expiring signed URL.

`read_my_resume` accepts only one positive integer `attachment_id`. It does not accept a URL and never chooses a resume version implicitly. Before downloading anything, the server performs a fresh permission-scoped attachment lookup and requires exactly one matching row whose type is `resume`; a missing, ambiguous, wrong-type, or unauthorized id returns no document data.

The server downloads and extracts PDF, DOCX, or UTF-8 plain-text content internally. It returns extracted text rather than the signed URL or raw file bytes. The download is capped at 10 MiB, extracted output is capped at 200,000 UTF-8 bytes with truncation reported, and metadata lookup, download, and parsing share one runtime-configured deadline with a hard 30-second ceiling. Resume reads bypass the response cache and single-flight layer, so the permission-scoped attachment lookup runs and a signed URL is fetched for every call (the normal short permission-provider cache still applies). If the first signed URL returns 401, 403, or 404, the server performs one more permission-scoped lookup, requires a different URL, and retries the download once.

Resume text is candidate-supplied, untrusted evidence. Every successful result carries a warning to treat the text only as document content and never follow instructions embedded in it. File contents, signed URLs, filenames, parser diagnostics, and raw bytes are excluded from audit events; only bounded operational metadata such as ids, content type, byte counts, duration, truncation state, and a fixed error class may be recorded.

Greenhouse job permissions still come from `/user_job_permissions` through the scoped core on each scoped read by default.

## Email Onboarding

The intended recruiter UX is low-friction:

```text
enter work email once -> issue durable MCP session -> email maps to Greenhouse user -> Greenhouse permissions scope every read
```

This is durable at-will access, not a short-lived Signal/email-code challenge loop. Initial onboarding can prove control of the work email through an admin action or company SSO, but normal recruiter use must not require recurring verification prompts.

For a pilot or managed rollout, issue a durable session after confirming the work email belongs to the recruiter:

```sh
GREENHOUSE_RECRUITER_SESSION_SECRET=... \
GREENHOUSE_RECRUITER_ALLOWED_EMAIL_DOMAINS=company.com \
GREENHOUSE_RECRUITER_IDENTITY_JSON='[{"email":"recruiter@company.com","status":"resolved","greenhouseUserId":123}]' \
greenhouse-recruiter-issue-session --email recruiter@company.com --surface claude_desktop
```

For org rollout, issue three separate physical-client sessions (`claude_desktop_chat`, `claude_code`, and `chatgpt_codex_host`) from a managed email list. The command accepts newline or comma separated emails, normalizes work domains, verifies every email against the identity directory, and exits non-zero if any row is invalid, duplicate, unmapped, or ambiguous.

If the production identity directory has not been populated yet, build a token-free bootstrap plan from the managed roster and a Greenhouse users export, review denied rows, then apply only a clean plan:

```sh
GREENHOUSE_RECRUITER_ALLOWED_EMAIL_DOMAINS=company.com \
greenhouse-recruiter-bootstrap-identity \
  --emails-file recruiters.txt \
  --greenhouse-users-file greenhouse-users.json \
  --out identity-bootstrap-plan.json

GREENHOUSE_RECRUITER_ALLOWED_EMAIL_DOMAINS=company.com \
GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_URL=https://exampleprojectref000.supabase.co \
GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_KEY=... \
greenhouse-recruiter-bootstrap-identity \
  --emails-file recruiters.txt \
  --greenhouse-users-file greenhouse-users.json \
  --apply > identity-bootstrap-apply.json
```

The bootstrap command refuses to apply when any roster row is duplicated, unmapped, ambiguous, outside the allowed domains, or matched only to an inactive Greenhouse user. The output is token-free but includes recruiter emails and Greenhouse user ids, so keep it with rollout evidence rather than distributing it to users. Run the roster, issuance, and installation commands from the ignored `rollout-evidence/` workspace (or a secure directory outside the checkout), never from a source directory that could be staged. If you include `identityBootstrapEvidence` in the final rollout manifest, `greenhouse-recruiter-rollout-gate` validates that the bootstrap plan is clean, token-free, and matches the roster preflight Greenhouse user mapping.

First preflight the roster without a signing secret and without minting durable tokens:

```sh
GREENHOUSE_RECRUITER_ALLOWED_EMAIL_DOMAINS=company.com \
GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_URL=https://exampleprojectref000.supabase.co \
GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_KEY=... \
greenhouse-recruiter-preflight-roster \
  --emails-file recruiters.txt \
  --surface both \
  --source okta_group \
  --verified-by ops-reviewer@example.com > roster-preflight.json
```

The preflight report is token-free and includes `generatedAt`, `rosterSource`, and `verifiedBy` so final rollout evidence proves sessions were minted from a managed/admin roster, not from user-entered chat text. Supported sources are `admin_managed_roster`, `google_workspace_group`, `okta_group`, `hris_report`, and `greenhouse_users_export`. It exits non-zero if any email is invalid, duplicated, unmapped, ambiguously mapped, or mapped to an invalid Greenhouse user id. Use it to fix the identity directory before issuing durable sessions.

After the roster preflight is clean, issue durable sessions:

```sh
GREENHOUSE_RECRUITER_SESSION_SECRET=... \
GREENHOUSE_RECRUITER_ALLOWED_EMAIL_DOMAINS=company.com \
GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_URL=https://exampleprojectref000.supabase.co \
GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_KEY=... \
greenhouse-recruiter-issue-session \
  --emails-file recruiters.txt \
  --clients claude_desktop_chat,claude_code,chatgpt_codex_host \
  --out-dir ./issued-sessions > issued-sessions-manifest.json
```

The command fails closed if any row is invalid, duplicate, unmapped, or ambiguous. With `--out-dir`, it writes one token-bearing session file per normalized email/client and prints a manifest that omits durable tokens. The output directory is chmodded to `0700`; session files and the manifest are chmodded to `0600`. Claude Desktop, Claude Code, and ChatGPT/Codex credentials are distinct and must never be reused across clients.

Generate the non-Desktop client configs from the successful issuance report:

```sh
GREENHOUSE_RECRUITER_REMOTE_MCP_URL=https://greenhouse-recruiter-mcp.example.com/mcp \
greenhouse-recruiter-desktop-config --client chatgpt_codex_host \
  --issued-sessions-file ./issued-sessions/manifest.json \
  --out-dir ./desktop-configs/chatgpt

greenhouse-recruiter-desktop-config --client claude_code \
  --issued-sessions-file ./issued-sessions/manifest.json \
  --out-dir ./desktop-configs/claude-code
```

The config generator can consume either the legacy all-in-one issuance JSON or the token-free split session manifest. `--client` selects exactly one physical client. Claude Desktop intentionally hard-errors here and directs operators to the MCPB generator below. Generated directories are `0700`; files are `0600`, token-bearing, overwrite-protected, and intended for only the matching recruiter/client.

The issuer refuses to mint a session unless the normalized email resolves to exactly one Greenhouse user in the identity directory. Issued tokens have no routine expiry, and the validator rejects `expiresAt` / `expires_at` claims so broad org rollout stays durable and revocable rather than short-lived. New tokens contain only normalized email, subject, protocol surface, physical client, token id, and issued-at timestamp; old tokens without `client` remain temporarily readable as legacy sessions. They do not contain Greenhouse user ids, job ids, or permission claims. `GREENHOUSE_RECRUITER_SESSION_SECRET` must be at least 32 characters and contain no surrounding whitespace. Revoke by token id with `greenhouse-recruiter-revoke-session`; removing the identity mapping or disabling a surface also denies access centrally.

## Production Distribution

For broad org rollout, run `greenhouse-recruiter-mcp-http` as a hosted Streamable HTTP MCP server. Keep `GREENHOUSE_CLIENT_ID`, `GREENHOUSE_CLIENT_SECRET`, the session signing secret, identity-directory credentials, and token-revocation credentials on the server. Recruiter desktops receive only their durable session token and the MCP server URL.

A production container build artifact is checked in at `deploy/Dockerfile`. Build it from the workspace root so the image can include the control plane, the scoped core, the action write plane, and this recruiter-only HTTP entrypoint:

```sh
docker build \
  -f packages/recruiter-mcp/deploy/Dockerfile \
  -t greenhouse-recruiter-mcp .
```

When Docker is available, run the checked-in smoke harness from the repo root to make the packaging check repeatable:

```sh
node packages/recruiter-mcp/deploy/docker-smoke-test.mjs

GREENHOUSE_RECRUITER_DOCKER_SMOKE_RUN=true \
node packages/recruiter-mcp/deploy/docker-smoke-test.mjs
```

The first command builds the image and runs the one-shot in-container non-HTTP MCP contract/parser self-check; it does not start the HTTP server. The second performs that same build/self-check, then starts the container with non-secret dummy readiness env, mounts a temporary Docker volume for `/app/audit`, and probes public `/healthz` plus token-protected `/readyz`. The contract check proves the packaged runtime can initialize, exposes exactly the approved 44-tool catalog with read-only annotations, and can extract the checked-in PDF/DOCX fixtures. It does not authenticate the HTTP `/mcp` route, call Greenhouse data APIs, or prove production/client behavior.

Treat local tests and that container smoke as packaging evidence only. Release evidence must come later from an approved isolated candidate deployment with real credentials: protected readiness, authenticated MCP initialize and `tools/list`, the exact 44-tool catalog, live permission probes, audit/revocation checks, and real ChatGPT/Claude client tests that exercise the intended routing. Until those credentialed candidate-HTTP and real-client artifacts exist and the rollout gate accepts them, deployment and client distribution remain blocked. Running the commands in this repository does not itself deploy or produce that evidence.

Run the image with secrets supplied by the host or orchestrator, not baked into the image. Start from `deploy/production.env.example` in your secret manager or deployment platform; it is a server-only template and intentionally excludes recruiter durable session tokens, remote validation tokens, `GREENHOUSE_RECRUITER_IDENTITY_JSON`, static-identity dev overrides, test-surface flags, and trusted `actAsUser` preview targets. `/readyz` fails if those desktop/operator-only values are present in the hosted process environment.

Before starting the hosted service, run the same secret-free readiness checks against the proposed server env file. This validates the file as-is and intentionally does not merge in the operator shell, so desktop session tokens or validation tokens in your terminal cannot contaminate the hosted readiness result:

```sh
greenhouse-recruiter-check-production-env --env-file ./greenhouse-recruiter-production.env
```

The report is safe to keep with rollout evidence because it emits check names, statuses, surfaces, and summaries only; it does not print Greenhouse credentials, Supabase keys, session secrets, readiness tokens, or recruiter durable tokens. This preflight does not call Greenhouse or Supabase and does not replace live `/readyz`, hosted distribution validation, live permission probes, revocation drill, audit review, or desktop attestations after deployment.

```sh
docker run --rm -p 3333:3333 \
  --env-file ./greenhouse-recruiter-production.env \
  -v greenhouse-recruiter-audit:/app/audit \
  greenhouse-recruiter-mcp
```

The image builds the shared Greenhouse client `dist/` because the scoped reader imports that library, but the runtime command starts only `bin/greenhouse-recruiter-mcp-http.mjs`; it does not start or expose the unscoped operator MCP. The image creates `/app/audit` as a writable directory for the non-root `node` user, but it does not set `GREENHOUSE_RECRUITER_AUDIT_JSONL_PATH` by default; production must explicitly mount or route that path to retained storage so `/readyz` proves audit retention is configured. The JSONL audit file is created and repaired as owner-only `0600` because it is metadata-only but still sensitive operational evidence. Docker health checks call public `/healthz`; detailed rollout readiness requires `GREENHOUSE_RECRUITER_READYZ_TOKEN` on the server and an `Authorization: Bearer ...` header from validation clients. Rollout readiness still depends on `/readyz`, hosted distribution validation, live probes, audit review, revocation drill, and desktop attestations.

Server-side identity directory options:

- `GREENHOUSE_RECRUITER_STATE_BACKEND=supabase_postgrest` for the hosted identity and revocation backend. This is the only implemented hosted state backend in this build.
- `GREENHOUSE_RECRUITER_IDENTITY_JSON` for local fixtures and small managed tests. It never satisfies hosted production readiness; `GREENHOUSE_RECRUITER_ALLOW_STATIC_IDENTITY_FOR_DEV=true` is dev/test-only.
- `GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_URL` plus `GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_KEY` for production PostgREST lookup and org rollout readiness.
- `GREENHOUSE_RECRUITER_IDENTITY_TABLE`, default `recruiter_identity_directory`.
- `GREENHOUSE_RECRUITER_IDENTITY_LOOKUP_TIMEOUT_MS`, default `5000`, bounds PostgREST identity lookups so unresolved auth denies instead of hanging.
- Optional column overrides: `GREENHOUSE_RECRUITER_IDENTITY_GREENHOUSE_USER_ID_COLUMN`, `GREENHOUSE_RECRUITER_IDENTITY_DIRECTORY_ID_COLUMN`, `GREENHOUSE_RECRUITER_IDENTITY_EMAIL_COLUMN`, `GREENHOUSE_RECRUITER_IDENTITY_SUBJECT_COLUMN`, `GREENHOUSE_RECRUITER_IDENTITY_STATUS_COLUMN`, `GREENHOUSE_RECRUITER_IDENTITY_RESOLVED_STATUS`.
- `GREENHOUSE_RECRUITER_IDENTITY_DIRECTORY_ID_COLUMN` (default `id`) names the directory row's own primary key, and it is the one override a custom table may legitimately have no answer for. Read authorization never uses it; it exists because a future write plane's entitlement is granted per directory row. A table or view without that column keeps resolving reads exactly as before — the server detects its absence on the first lookup and stops asking for the life of the process, not just the request — and simply cannot be write-eligible. Adding the column to such a table therefore takes a restart to become write-eligible.

Supabase/PostgREST URLs for identity and revocation must be HTTPS origins such as `https://<project>.supabase.co`, with no path, query string, fragment, or embedded credentials. Supabase/PostgREST API keys must be non-empty exact values with no leading or trailing whitespace. Table and column overrides are limited to plain Postgres-style identifiers containing letters, numbers, and underscores, starting with a letter or underscore. Hosted `/readyz`, hosted `/mcp`, session validation, identity lookup, identity bootstrap apply, and revocation writes all enforce this before sending API keys. If IT chooses DynamoDB, RDS/Aurora, or another internal DB, add and test a new identity/revocation adapter before treating hosted pilot readiness as green.

The default Supabase table shape is created by `supabase/migrations/0001_recruiter_identity_directory.sql` in this package's own dedicated Supabase migration tree (`packages/recruiter-mcp/supabase/`), applied with `supabase db push` from this package directory.

The hosted remote path accepts both `chatgpt_desktop` and `claude_desktop` durable session tokens by default. Set `GREENHOUSE_RECRUITER_REMOTE_SURFACES=chatgpt_desktop` or `GREENHOUSE_RECRUITER_REMOTE_SURFACES=claude_desktop` to restrict a deployment; unsupported, whitespace-padded, empty, or duplicated entries fail hosted readiness and the live remote request path denies all surfaces until the config is corrected. The HTTP server answers `OPTIONS` preflight on `/mcp`, `/healthz`, and `/readyz`; set `GREENHOUSE_RECRUITER_CORS_ORIGIN` to an exact comma-separated allowlist of approved HTTPS desktop/broker origins, for example `https://chatgpt.com,https://claude.ai`. Hosted readiness fails if the allowlist is missing, empty, whitespace-padded, duplicated, wildcarded, includes paths/query strings/fragments, or includes non-HTTPS origins, and the live HTTP server fails closed on malformed CORS config instead of ignoring bad entries. Detailed `/readyz` output is protected separately by `GREENHOUSE_RECRUITER_READYZ_TOKEN`; without that token configured it returns only a generic not-ready response, and with it configured callers must send `Authorization: Bearer <readyz-token>`. Browser requests from disallowed, malformed, or unconfigured origins receive `cors_origin_not_allowed` before bearer-token handling. CORS preflight does not bypass bearer-token authorization for MCP calls.

Tokens with `surface: "test"` are denied on the hosted remote path by default. `GREENHOUSE_RECRUITER_ALLOW_TEST_SURFACE=true` exists only for automated/local harnesses; `/readyz` fails when it is enabled so it cannot silently ship into recruiter distribution.

## Claude Desktop

Claude Desktop does not consume the old `{url, headers}` config emitted by this project. Generate a personalized `.mcpb` from the recruiter's `claude_desktop_chat` session file:

```sh
greenhouse-recruiter-claude-mcpb \
  --issued-session-file ./issued-sessions/recruiter@example.com--claude-desktop-chat.json \
  --mcp-url https://greenhouse-recruiter-mcp.example.com/mcp \
  --out-dir ./desktop-configs/claude-desktop

greenhouse-recruiter-desktop-config \
  --merge-manifest ./desktop-configs/claude-desktop/manifest.json \
  --merge-manifest ./desktop-configs/claude-code/manifest.json \
  --merge-manifest ./desktop-configs/chatgpt/manifest.json \
  --out-dir ./desktop-configs
```

The MCPB embeds that one durable client credential, so it is sensitive. The artifact and metadata files are `0600`; the generator refuses overwrite. The token-free sidecar reports `artifactContainsToken: true` and `metadataContainsToken: false`. The final merge command refuses missing or duplicate clients and writes the portable, token-free `desktop-configs/manifest.json` consumed by delivery and rollout validation. Validate installation from a clean Claude Desktop profile, then quit/restart and confirm a second call retains the same token id.

## Claude Code

Use the separate `claude_code` JSON generated above. It contains the official remote HTTP MCP shape (`type: "http"`, HTTPS URL, and bearer header). Install it at user or local scope with Claude Code, verify the exact catalog and a scoped read, restart, and confirm audit events identify `client: "claude_code"`.

## ChatGPT / OpenAI MCP Surface

ChatGPT should use the same hosted remote MCP server. Current OpenAI docs describe two relevant paths: ChatGPT Developer Mode creates an app from a remote MCP server in ChatGPT settings, while the Responses API uses an MCP tool payload with `server_url`, `authorization`, `allowed_tools`, and `require_approval`. Treat the generated OpenAI payload as API/broker configuration, not by itself as proof that ChatGPT Desktop is installed and working. Broad rollout requires a real ChatGPT-surface attestation that names the attachment method used. This package includes a stateless Streamable HTTP entrypoint:

```sh
greenhouse-recruiter-mcp-http
```

Defaults:

- port: `3333`
- path: `/mcp`
- health: `/healthz`
- readiness: `/readyz`
- auth: `Authorization: Bearer <signed recruiter session token>`

The remote handler validates the token, resolves the human through the same identity-directory port, and creates a per-request scoped MCP server. If tenant-level private remote MCP attachment is unavailable, use a broker app that forwards authenticated requests to this remote handler; do not move identity into model/tool params.

Generate an OpenAI remote MCP payload for a specific recruiter's durable token:

```sh
GREENHOUSE_RECRUITER_DESKTOP_SURFACE=chatgpt_desktop \
GREENHOUSE_RECRUITER_CLIENT=chatgpt_codex_host \
GREENHOUSE_RECRUITER_REMOTE_MCP_URL=https://greenhouse-recruiter-mcp.example.com/mcp \
GREENHOUSE_RECRUITER_SESSION_TOKEN=admin-issued-user-token \
greenhouse-recruiter-desktop-config
```

The generated payload follows the Responses API remote MCP `server_url` / `authorization` / `allowed_tools` shape documented by OpenAI for MCP tools. It defaults `require_approval` to `always` so pilot users explicitly approve data-sharing calls while trust and audit review are being validated; set `GREENHOUSE_RECRUITER_CHATGPT_REQUIRE_APPROVAL=never` only after the rollout evidence gate is green and policy approves it. For direct ChatGPT usage, create or attach the remote MCP app through the supported ChatGPT app/developer-mode path for the tenant, then capture a desktop/surface attestation with `attachmentMethod` set to `chatgpt_developer_mode_remote_mcp`, `chatgpt_desktop_remote_mcp`, or `responses_api_broker`.

`/healthz` reports process liveness only. `/readyz` returns a detailed readiness report for the hosted durable-access prerequisites: Greenhouse client env, session signing secret, protected readiness-token configuration, implemented state backend, server-side token revocation source, identity source, retained JSONL audit sink, remote desktop surfaces, operator allowlist syntax, hosted env hygiene, external lookup timeout config, hosted POST body limit config, hosted endpoint route/port config, incoming HTTP timeout config, and server kill switch state. Configure `GREENHOUSE_RECRUITER_READYZ_TOKEN` as a separate 32+ character bearer token for operators and validation jobs; it is not a recruiter session token and should not be distributed in desktop configs. Hosted env hygiene fails when the server process contains desktop/validation-only tokens (`GREENHOUSE_RECRUITER_SESSION_TOKEN`, `GREENHOUSE_RECRUITER_REMOTE_AUTH_TOKEN`, `GREENHOUSE_RECRUITER_REMOTE_READY_TOKEN`, active/revoked drill tokens) or `GREENHOUSE_RECRUITER_TRUSTED_ACT_AS_USER_ID`; those belong in operator CLI sessions, desktop configs, or dedicated preview processes, not the broad hosted server. Configure `GREENHOUSE_RECRUITER_STATE_BACKEND=supabase_postgrest` plus `GREENHOUSE_RECRUITER_REVOCATION_SUPABASE_URL` and `GREENHOUSE_RECRUITER_REVOCATION_SUPABASE_KEY` with an exact non-whitespace API key so individual durable sessions can be centrally denied by token id on the next authenticated request without making users re-verify. `GREENHOUSE_RECRUITER_REVOCATION_LOOKUP_TIMEOUT_MS` defaults to `5000` so revocation-store outages fail closed instead of hanging authenticated requests.

Revoke one durable session centrally by token id; do not pass the signed token string itself:

```sh
GREENHOUSE_RECRUITER_REVOCATION_SUPABASE_URL=https://exampleprojectref000.supabase.co \
GREENHOUSE_RECRUITER_REVOCATION_SUPABASE_KEY=... \
greenhouse-recruiter-revoke-session \
  --token-id session-token-id-from-issued-manifest \
  --revoked-by ops-reviewer@example.com \
  --reason 'offboarding or lost device'
```

The command writes only the non-secret token id plus revocation metadata to `recruiter_mcp_session_revocation`. It rejects full signed token-looking values and emits a token-free report. The hosted MCP requires this server-side revocation source for remote durable sessions and checks it on authenticated requests, so a revoked session is denied on the next use while other recruiters keep at-will access. If the revocation source is missing or unavailable, the remote MCP path fails closed instead of accepting otherwise valid durable tokens.

When `GREENHOUSE_RECRUITER_MCP_DISABLED=true`, `/mcp` returns a central disabled denial and does not construct the scoped MCP server. `/healthz` remains available and `/readyz` reports not ready so operators can distinguish process health from safe serving state.

For retained audit evidence, set `GREENHOUSE_RECRUITER_AUDIT_JSONL_PATH=/secure/path/greenhouse-recruiter-audit.jsonl` on the hosted process. The path must be absolute and end with `.jsonl`, so readiness cannot pass with a relative working-directory file or a non-JSONL sink. The server appends one JSON audit event per scoped tool call, creates the parent directory when needed, and creates/repairs the audit file mode as owner-only `0600`. Audit writes are part of request handling: if the configured sink cannot write, the call fails closed with a sanitized `AUDIT_UNAVAILABLE` denial instead of returning Greenhouse data or silently dropping audit evidence. Audit events include surface, tool, actor/effective actor ids, operator state, permission-scope counts, rows read/returned, denial code, duration, and correlation id. They intentionally do not include candidate names, emails, note bodies, scorecard text, raw prompts, or Greenhouse secrets.

Before final rollout, generate an audit-review report from the retained JSONL file:

```sh
GREENHOUSE_RECRUITER_AUDIT_JSONL_PATH=/secure/path/greenhouse-recruiter-audit.jsonl \
GREENHOUSE_RECRUITER_AUDIT_REVIEWER=ops-reviewer@example.com \
greenhouse-recruiter-review-audit > audit-review.json
```

The review command parses the JSONL audit sample, enforces the closed metadata-only schema, requires success and denial events, requires both hosted surfaces plus v2 attribution for Claude Desktop, Claude Code, and ChatGPT/Codex, requires evidence and analysis tool calls, and fails if email-like values or unexpected payload keys appear. Put the generated `audit-review.json` path in the rollout evidence manifest.

## Remote Distribution Validation

Before connecting Claude Desktop or ChatGPT Desktop users to a hosted endpoint, validate the exact remote MCP URL and durable session token that a desktop client will use:

```sh
GREENHOUSE_RECRUITER_REMOTE_MCP_URL=https://greenhouse-recruiter-mcp.example.com/mcp \
GREENHOUSE_RECRUITER_REMOTE_READY_TOKEN=operator-readyz-token \
GREENHOUSE_RECRUITER_EXPECTED_COMMIT_SHA=<40-character-candidate-git-sha> \
GREENHOUSE_RECRUITER_SESSION_TOKEN=admin-issued-user-token \
greenhouse-recruiter-validate-distribution
```

The command checks `/healthz`, verifies unauthenticated `/readyz` is denied, reads protected `/readyz`, binds same-origin `/version` to the exact expected 40-character candidate commit, and checks MCP `initialize` plus `tools/list`. It fails if any check is missing, the catalog differs from the approved 44 tools, a write/admin tool appears, or read-only annotations are incomplete. It records the token's non-secret `sessionSurface`, `sessionClient`, `sessionTokenId`, and `sessionIssuedAt` in the report, and the final rollout gate binds those values to the issuance/config manifests. It does not call Greenhouse data tools. Localhost remains suitable for development, but candidate release evidence must come from the real HTTPS endpoint with its exact deployed SHA.

Optional overrides:

- `GREENHOUSE_RECRUITER_REMOTE_AUTH_TOKEN`, if the validation token should differ from `GREENHOUSE_RECRUITER_SESSION_TOKEN`.
- `GREENHOUSE_RECRUITER_REMOTE_READY_TOKEN`, if the protected `/readyz` token should differ from the local `GREENHOUSE_RECRUITER_READYZ_TOKEN` value.
- `GREENHOUSE_RECRUITER_REMOTE_HEALTH_URL`, `GREENHOUSE_RECRUITER_REMOTE_READY_URL`, and `GREENHOUSE_RECRUITER_REMOTE_VERSION_URL`, if the deployment exposes non-default health/readiness/version paths. Final rollout still requires same-origin `/version`.
- `GREENHOUSE_RECRUITER_VALIDATE_EXPECT_TOOLS=tool_a,tool_b`, only for an intentional one-off catalog assertion. Normal validation derives the exact active catalog from the fail-closed allowlist and other runtime catalog controls; with no explicit controls it expects the exact 44-tool catalog listed above.

## Live Readiness Probe

Before running Greenhouse data probes, verify the durable session and identity directory resolve to exactly one Greenhouse actor without using any Greenhouse API credentials:

```sh
GREENHOUSE_RECRUITER_SESSION_TOKEN=admin-issued-user-token \
greenhouse-recruiter-check-identity
```

The command validates the signed durable session, loads the same static JSON or Supabase/PostgREST identity directory as the hosted server, and exits non-zero for invalid, unresolved, ambiguous, or invalid mappings. It intentionally does not configure or call the raw Greenhouse client.

Before adding pilot users, run the additive probe command with the same session, identity, and Greenhouse env that the desktop surface will use:

```sh
GREENHOUSE_RECRUITER_PROBE_PROFILE=small_req_set \
GREENHOUSE_RECRUITER_BUILD_SHA=<40-character-candidate-git-sha> \
GREENHOUSE_RECRUITER_PROBE_EXPECT_VISIBLE_DATA=true \
GREENHOUSE_RECRUITER_PROBE_STRICT=true \
GREENHOUSE_RECRUITER_PROBE_EXPECT_JOB_IDS=123,456 \
GREENHOUSE_RECRUITER_PROBE_FORBIDDEN_JOB_IDS=789 \
greenhouse-recruiter-probe > live-probe-small-req-set.json
```

It prints a JSON report and exits non-zero if any required check fails. The probe uses the production scoped reader and recruiter tool runtime; it does not register an MCP tool and does not call raw Greenhouse mutation helpers.

Optional env checks:

- `GREENHOUSE_RECRUITER_PROBE_EXPECT_JOB_IDS=123,456` verifies known-visible jobs return through `get_my_job`.
- `GREENHOUSE_RECRUITER_PROBE_FORBIDDEN_JOB_IDS=789` verifies known-non-visible or recently removed jobs do not return through `get_my_job`.
- `GREENHOUSE_RECRUITER_PROBE_STRICT=true` is for the three data-bearing rollout profiles: it fails if expected/forbidden job ids are missing or if shape-validation warnings remain. Repeat the command with profiles `many_req_set` and `all_jobs_or_operator`; for `no_permissions`, set strict and expect-visible-data to false. Every rollout probe must use the exact candidate build SHA when the host does not inject `RENDER_GIT_COMMIT`.

The probe samples scoped jobs, applications, candidates, scorecards, notes, and runs `analyze_scorecard_accountability`, `analyze_interview_feedback_drag`, `analyze_stage_latency`, `analyze_pipeline_quality`, `analyze_source_quality`, and a constrained `answer_my_recruiting_question` recipe check. It intentionally reports activity endpoint validation as skipped because v1 does not expose `list_activity`.

The final rollout gate now treats those probe check names as part of the production evidence contract. A stale probe report that omits applications, candidates, notes, any analysis check, the constrained question-planner check, or the explicit activity-scoping decision is rejected even if its `ok` field is true.

The recruiter-scoped surface is list/filter-first. Single-record recruiter tools such as `get_my_job`, `get_my_application`, and `get_my_candidate` are implemented through Greenhouse list endpoints with exact id filters, then scoped and exact-matched in-process. Secondary hydration for analysis tools also uses list filters such as `ids`, `job_ids`, `application_ids`, or `candidate_ids`; direct Greenhouse single-resource paths are not allowed in the recruiter surface unless they are added to this endpoint contract and live-verified. This rule applies only to the scoped recruiter surface; the core Greenhouse MCP and existing analytics consumers keep their unscoped read paths unchanged.

For operator leakage sampling, run an allowlisted operator session against a target recruiter with trusted server-side `actAsUser`:

```sh
GREENHOUSE_RECRUITER_LEAKAGE_ACT_AS_USER_ID=123 \
GREENHOUSE_RECRUITER_LEAKAGE_FORBIDDEN_JOB_IDS=789 \
GREENHOUSE_RECRUITER_LEAKAGE_STRICT=true \
GREENHOUSE_RECRUITER_BUILD_SHA=<40-character-candidate-git-sha> \
greenhouse-recruiter-sample-leakage
```

The command samples `list_jobs` unscoped as the operator and again through `actAsUser`, then verifies known forbidden jobs are visible to the operator but hidden from the recruiter's scoped preview. It is an operator rollout artifact only; it is not registered as an MCP tool.

## Rollout Evidence Gate

After live probes and desktop validation are complete, collect the JSON outputs plus real desktop user-test attestations into one manifest and run:

```sh
greenhouse-recruiter-init-rollout-evidence --out ./rollout-evidence
```

The initializer creates a red-by-default manifest, desktop attestation templates, and a `RUNBOOK.md` with the ordered production evidence commands. It does not generate passing live probe, distribution, audit, or desktop evidence; those files must come from the real checks below.

Before the final gate, or whenever a rollout directory looks unclear, run the compact status check:

```sh
greenhouse-recruiter-rollout-status --dir ./rollout-evidence
# or
greenhouse-recruiter-rollout-status --manifest ./rollout-evidence/manifest.json
```

The status command checks whether the manifest exists, verifies every manifest-referenced evidence file is present and portable, runs the same rollout gate underneath, and emits only a compact ready/not-ready summary with failing check names and next actions. It is an operator convenience, not a substitute for a green `greenhouse-recruiter-rollout-gate`.

Then run the final gate:

```sh
GREENHOUSE_RECRUITER_ROLLOUT_EVIDENCE_MANIFEST=/path/to/manifest.json \
GREENHOUSE_RECRUITER_ROLLOUT_LIVE_READYZ_URL=https://greenhouse-recruiter-mcp.example.com/readyz \
GREENHOUSE_RECRUITER_READYZ_TOKEN=<operator-readyz-token> \
greenhouse-recruiter-rollout-gate
```

The deploy-time gate sends the readiness token only after that URL matches the manifest-pinned candidate origin. It then fetches the same candidate's public `/version` and requires the currently running commit to equal the pinned 40-character SHA.

If the evidence files were generated outside the scaffold directory, copy them into the rollout evidence directory and build the final manifest without hand-editing JSON. When `--out` is set, evidence paths are stored relative to the manifest directory; cwd-relative or absolute paths must resolve inside that directory, and escaping paths are rejected.

```sh
greenhouse-recruiter-build-rollout-manifest \
  --force \
  --out ./rollout-evidence/manifest.json \
  --candidate-mcp-url https://greenhouse-recruiter-mcp.example.com/mcp \
  --candidate-commit <40-character-candidate-git-sha> \
  --small-req-probe ./rollout-evidence/probes/small.json \
  --many-req-probe ./rollout-evidence/probes/many.json \
  --all-jobs-probe ./rollout-evidence/probes/all-jobs.json \
  --no-permissions-probe ./rollout-evidence/probes/no-permissions.json \
  --chatgpt-distribution ./rollout-evidence/distribution-chatgpt.json \
  --claude-distribution ./rollout-evidence/distribution-claude.json \
  --claude-code-distribution ./rollout-evidence/distribution-claude-code.json \
  --production-env ./rollout-evidence/production-env-check.json \
  --claude-revocation-drill ./rollout-evidence/revocation-drill-claude-desktop.json \
  --claude-code-revocation-drill ./rollout-evidence/revocation-drill-claude-code.json \
  --chatgpt-revocation-drill ./rollout-evidence/revocation-drill-chatgpt-codex.json \
  --claude-session-revocation ./rollout-evidence/session-revocation-claude-desktop.json \
  --claude-code-session-revocation ./rollout-evidence/session-revocation-claude-code.json \
  --chatgpt-session-revocation ./rollout-evidence/session-revocation-chatgpt-codex.json \
  --roster-preflight ./rollout-evidence/roster-preflight.json \
  --session-issuance ./rollout-evidence/issued-sessions/manifest.json \
  --desktop-config ./rollout-evidence/desktop-configs/manifest.json \
  --desktop-delivery ./rollout-evidence/desktop-delivery.json \
  --chatgpt-desktop-test ./rollout-evidence/desktop-chatgpt.json \
  --claude-desktop-test ./rollout-evidence/desktop-claude.json \
  --claude-code-desktop-test ./rollout-evidence/desktop-claude-code.json \
  --leakage-sample ./rollout-evidence/leakage-sample.json \
  --audit-review ./rollout-evidence/audit-review.json \
  --removed-req-disappeared-on-next-read \
  --added-req-appeared-without-deploy \
  --private-notes-dropped \
  --scoped-vs-unscoped-leakage-sample-passed \
  --durable-access-tested-without-routine-reverification \
  --permission-freshness-verified-at 2026-06-23T00:00:00.000Z \
  --permission-freshness-verified-by ops-reviewer@example.com \
  --removed-req-id 123 \
  --removed-req-rows-before 1 \
  --removed-req-rows-after 0 \
  --added-req-id 456 \
  --added-req-rows-before 0 \
  --added-req-rows-after 1 \
  --private-note-id 789 \
  --private-note-rows-returned 0 \
  --durable-session-email recruiter@example.com \
  --durable-session-surface chatgpt_desktop \
  --durable-session-token-id <issued-token-id> \
  --durable-session-token-id-after-restart <same-issued-token-id> \
  --durable-session-issued-at <issued-at-timestamp> \
  --durable-session-issued-at-after-restart <same-issued-at-timestamp>
```

The manifest builder requires every permission-freshness confirmation plus token-free sample fields: removed-req before/after counts, added-req before/after counts, private-note returned count, reviewer/timestamp, and matching durable session email, surface, token ids, and issued-at timestamps before and after desktop restart. The durable session email, surface, token id, and issued-at timestamp used for permission freshness must be present in both the issued-session manifest and desktop-config manifest; the post-restart values must match exactly. The final rollout gate requires timestamped dynamic evidence to be no more than 14 days old when the gate runs: permission freshness `verifiedAt`, live probe `generatedAt`, distribution validation `checkedAt`, central session revocation `revokedAt`, revocation drill `checkedAt`, desktop delivery `deliveredAt`, desktop user-test `testedAt`, leakage sample `generatedAt`, and audit review `reviewedAt`. This recency rule applies to rollout proof only; issued recruiter sessions remain durable until revoked. The rollout gate remains the authoritative check and fails unless these structured samples and the real probe, session issuance, desktop config, leakage, audit, and desktop attestation files pass.

The manifest shape is shown in `examples/rollout-evidence/manifest.example.json`. The gate requires:

- manifest-referenced evidence paths that are relative to `manifest.json` and stay under the rollout evidence directory; split session/config manifests must also use `outputDir: "."`, relative `manifestPath`, and relative file entries. Absolute paths and `..` escapes fail before evidence files are trusted.
- a recent secret-free `greenhouse-recruiter-check-production-env --env-file` report proving the proposed hosted server env is ready, env-file based, warning-free, and configured for both ChatGPT Desktop and Claude Desktop before the service starts
- live `greenhouse-recruiter-probe` reports for a small req-set recruiter, a many-req recruiter, an all-jobs/operator case, and a no-permissions user
- hosted `greenhouse-recruiter-validate-distribution` reports for `claude_desktop_chat`, `claude_code`, and `chatgpt_codex_host`, generated against the production HTTPS MCP URL rather than localhost, each with `sessionSurface` and `sessionClient` matching the manifest identity, `sessionTokenId` and `sessionIssuedAt` present in the issued-session and desktop-config manifests, and an exact approved recruiter tool catalog with no unexpected tools
- three token-free `greenhouse-recruiter-revoke-session` reports proving a distinct revoked drill token id for each physical client was written to the central revocation table with operator/reason metadata
- three token-free `greenhouse-recruiter-revocation-drill` v2 reports from the production HTTPS MCP URL, one each for Claude Desktop, Claude Code, and ChatGPT/Codex, proving an active issued credential initializes, the same-client revoked credential is denied, and both tokens carry matching surface, client, token-id, and issued-at metadata
- a recent token-free `greenhouse-recruiter-preflight-roster` report proving the recruiter email roster came from a managed/admin source, was reviewed by an operator, and is fully resolved for both desktop surfaces before durable sessions are minted
- a token-free split session issuance manifest generated by `greenhouse-recruiter-issue-session --out-dir`, with distinct credentials for `claude_desktop_chat`, `claude_code`, and `chatgpt_codex_host`, token metadata matching the manifest, and no Greenhouse server credentials, permission claims, or expiry claims
- token-free installation metadata covering a personalized Claude Desktop MCPB, a Claude Code HTTP config, and a ChatGPT/Codex payload; each token-bearing artifact must match its email/client/token metadata, use the production HTTPS endpoint, and contain no Greenhouse server credentials
- a token-free desktop delivery report proving every generated desktop config was delivered only through an approved channel (`managed_desktop_install`, `mdm_profile`, `endpoint_management`, or `secure_vault_delivery`) to the matching recruiter email/surface/token id/issued-at timestamp from the desktop config manifest
- real client user-test JSON generated by `greenhouse-recruiter-record-desktop-test`; each test must include the physical `client`, actual `attachmentMethod`, non-secret token metadata, a matching post-restart token id/timestamp, an evidence read, an analysis call, and a lightweight usefulness outcome
- a strict `greenhouse-recruiter-sample-leakage` report proving known unassigned reqs are visible to an operator but hidden from the target recruiter's scoped preview
- timestamped dynamic rollout evidence, no more than 14 days old at gate time, covering production env preflight, roster preflight, live probes, hosted distribution validation, central session revocation, revocation drill, desktop config delivery, real desktop user tests, leakage sampling, audit review, and permission freshness; this keeps rollout proof current without making recruiter sessions short-lived
- audit-review v2 evidence generated by `greenhouse-recruiter-review-audit`, proving retained audit events include success and denial cases, coherent start/terminal attribution for `claude_desktop_chat`, `claude_code`, and `chatgpt_codex_host`, both evidence/analysis tool families, and no candidate names, emails, note bodies, scorecard text, raw prompts, or Greenhouse secrets

The gate also cross-checks roster preflight, session issuance, and desktop config evidence. Every preflighted recruiter must have exactly one issued session file and one generated artifact for each of the three required physical clients, no session/config file may appear for a recruiter outside the preflighted roster, and token metadata must agree for each recruiter/surface/client identity.

After the gate is green, build a token-free review/share bundle from the manifest instead of zipping the working rollout directory. The working directory can contain token-bearing files under `issued-sessions/` and `desktop-configs/`; `greenhouse-recruiter-pack-rollout-evidence` copies only manifest-referenced evidence JSON, rejects copied token/config payloads, writes `bundle-report.json`, and reports generated session/config files as skipped.

```sh
greenhouse-recruiter-pack-rollout-evidence \
  --manifest ./rollout-evidence/manifest.json \
  --out-dir ./rollout-evidence-token-free-review-bundle
```

Generate desktop delivery evidence after distributing the generated config files:

```sh
greenhouse-recruiter-record-desktop-delivery \
  --desktop-config-manifest ./rollout-evidence/desktop-configs/manifest.json \
  --delivered-by ops-reviewer@example.com \
  --delivery-channel managed_desktop_install \
  --attest-delivered-to-matching-recruiters \
  --out ./rollout-evidence/desktop-delivery.json
```

The delivery helper reads only the token-free desktop config manifest and writes one metadata row per generated config with matching `email`, `recipientEmail`, `surface`, `client`, `tokenId`, `issuedAt`, and `configPath`. It refuses to run without the explicit matching-recipient attestation and never writes durable tokens, Authorization headers, or config payloads.

Generate desktop user-test evidence after a real recruiter opens Claude Desktop or ChatGPT Desktop, uses the installed config, restarts the desktop client, and runs at least one evidence tool and at least one analysis tool without any routine re-verification prompt. First save one `<case-id>=<actual+ordered+tool+sequence>` line for every actual routing run in `routing-checks-chatgpt.txt`; every canonical case must appear at least three times:

```bash
routing_args=()
while IFS= read -r routing_check; do
  routing_args+=(--routing-check "$routing_check")
done < ./routing-checks-chatgpt.txt

greenhouse-recruiter-record-desktop-test \
  --surface chatgpt_desktop \
  --client chatgpt_codex_host \
  --tester-email recruiter@example.com \
  --mcp-url https://greenhouse-recruiter-mcp.example.com/mcp \
  --attachment-method chatgpt_developer_mode_remote_mcp \
  --session-issuance-manifest ./rollout-evidence/issued-sessions/manifest.json \
  --desktop-config-manifest ./rollout-evidence/desktop-configs/manifest.json \
  --session-token-id-after-restart <same-issued-token-id> \
  --session-issued-at-after-restart <same-issued-at-timestamp> \
  --client-version '<version shown by the client>' \
  --model-version '<version shown by the client>' \
  --exercised-tools '<comma-separated unique tools actually observed>' \
  "${routing_args[@]}" \
  --attest-resume-instructions-untrusted \
  --attest-durable-session-access \
  --attest-session-persisted-across-restart \
  --attest-no-routine-reverification \
  --attest-no-write-admin-tools-visible \
  --task-outcome useful \
  --task-outcome-reason answer_received \
  --out ./rollout-evidence/desktop-chatgpt-desktop.json
```

Repeat the command for Claude Desktop with `--surface claude_desktop`, `--client claude_desktop_chat`, `--attachment-method claude_desktop_mcpb`, and `--out ./rollout-evidence/desktop-claude-desktop.json`. Use `--client claude_code --attachment-method claude_code_http_mcp` for Claude Code. Attestations bind the tester, physical client, token id, and issued-at timestamp to the issuance and installation manifests, then require identical post-restart metadata.

The structured report proves candidate routing conformance. It does not manufacture a pre-change baseline: retain same-client/model baseline results separately wherever they can be collected, compare them before release, and treat a missing zero-regression comparison as a manual release blocker.

This gate is intentionally stricter than `npm run verify:rollout`: it is for the final pre-distribution evidence bundle, not ordinary local development.

## Operators

`OPERATOR_ACTOR_IDS` is parsed by the scoped core using the same positive-integer allowlist idiom as the existing Greenhouse gates. Operator unscoped passthrough is available only for those actors and can be shut off with `GREENHOUSE_RECRUITER_DISABLE_OPERATOR_UNSCOPED=true`. The recruiter production bridge and hosted readiness both reject `OPERATOR_ACTOR_IDS` when it contains any non-empty value that is not a positive Greenhouse user id, so a malformed operator allowlist cannot silently ship into distribution evidence or live unscoped passthrough.

Operator `actAsUser` is a trusted runtime option and is not exposed as a model-callable parameter in this package. To run a controlled preview, start the server with `GREENHOUSE_RECRUITER_TRUSTED_ACT_AS_USER_ID=<greenhouse-user-id>` for the target recruiter while authenticating as an actor in `OPERATOR_ACTOR_IDS`. The scoped core denies this option for non-operators. Tool params named like `actAsUser`, `on_behalf_of_user_id`, `actor_id`, or `greenhouse_user_id` are stripped before reads reach the scoped core.

## Activity Scoping

This v1 does not expose `list_activity`. Activity-like analysis uses scorecards, notes, stage/application timestamps, and candidate/application associations only. True activity endpoint support requires a live Harvest shape probe proving safe job/application/candidate association.

## Ops Controls

Environment switches:

- `GREENHOUSE_RECRUITER_MCP_DISABLED=true`
- `GREENHOUSE_RECRUITER_DISABLE_TOOLS=tool_a,tool_b`
- `GREENHOUSE_RECRUITER_DISABLE_EVIDENCE=true`
- `GREENHOUSE_RECRUITER_DISABLE_ANALYTICS=true`
- `GREENHOUSE_RECRUITER_DISABLE_CLAUDE_DESKTOP=true`
- `GREENHOUSE_RECRUITER_DISABLE_CHATGPT_DESKTOP=true`
- `GREENHOUSE_RECRUITER_DISABLE_OPERATOR_UNSCOPED=true`
- `GREENHOUSE_RECRUITER_TRUSTED_ACT_AS_USER_ID=123`
- `GREENHOUSE_RECRUITER_PERMISSION_TTL_MS=120000`
- `GREENHOUSE_RECRUITER_FORCE_PERMISSION_TTL_ZERO=true`
- `GREENHOUSE_RECRUITER_REMOTE_SURFACES=chatgpt_desktop,claude_desktop`
- `GREENHOUSE_RECRUITER_REVOKED_TOKEN_IDS=session_a,session_b` for emergency/static revocation; hosted remote MCP still requires the Supabase/PostgREST revocation source below
- `GREENHOUSE_RECRUITER_REVOCATION_SUPABASE_URL=https://<project>.supabase.co`
- `GREENHOUSE_RECRUITER_REVOCATION_SUPABASE_KEY=<postgrest-or-service-role-key>`
- `GREENHOUSE_RECRUITER_REVOCATION_TABLE=recruiter_mcp_session_revocation`
- `GREENHOUSE_RECRUITER_RATE_LIMIT_DISABLED=true`
- `GREENHOUSE_RECRUITER_RATE_LIMIT_WINDOW_MS=60000`
- `GREENHOUSE_RECRUITER_MAX_CALLS_PER_WINDOW=120`
- `GREENHOUSE_RECRUITER_MAX_ANALYSIS_CALLS_PER_WINDOW=30`
- `GREENHOUSE_RECRUITER_MAX_PER_PAGE=100`
- `GREENHOUSE_RECRUITER_MAX_LOOKBACK_DAYS=180`
- `GREENHOUSE_RECRUITER_MAX_TOOL_DURATION_MS=30000`
- `GREENHOUSE_RECRUITER_MAX_HTTP_BODY_BYTES=262144`
- `GREENHOUSE_RECRUITER_HTTP_HEADERS_TIMEOUT_MS=10000`
- `GREENHOUSE_RECRUITER_HTTP_REQUEST_TIMEOUT_MS=300000`
- `GREENHOUSE_RECRUITER_HTTP_KEEP_ALIVE_TIMEOUT_MS=5000`

Every tool call emits a scoped audit event with surface, tool name, actor/effective actor, operator/actAsUser status, permission scope kind, permitted job count when job-scoped, rows read/returned, denial code, duration, and correlation id. If the audit sink is unavailable, evidence and analysis tools return `AUDIT_UNAVAILABLE` without data. Audit events must not include candidate names, emails, note bodies, scorecard prose, or raw prompt text.

Hosted and stdio runtimes enforce an in-process per-session call budget before reading Greenhouse. The default budget is 120 total tool calls and 30 analytical calls per 60-second window. Exceeding the budget returns a `RATE_LIMITED` denial and emits the usual metadata-only audit event with no rows read. Hosted `/readyz` fails if `GREENHOUSE_RECRUITER_RATE_LIMIT_DISABLED=true`, so broad distribution cannot accidentally run without this budget. Hosted POST bodies are parsed with a bounded JSON cap before the MCP transport sees them (`GREENHOUSE_RECRUITER_MAX_HTTP_BODY_BYTES`, default 262144). Oversized or malformed authenticated requests return JSON-RPC errors before any scoped runtime or tool is created. Hosted incoming header/body receive timeouts are explicit (`GREENHOUSE_RECRUITER_HTTP_HEADERS_TIMEOUT_MS`, `GREENHOUSE_RECRUITER_HTTP_REQUEST_TIMEOUT_MS`) and keep-alive idle sockets are bounded (`GREENHOUSE_RECRUITER_HTTP_KEEP_ALIVE_TIMEOUT_MS`). These are transport abuse controls and do not cap normal MCP response/SSE duration. Scoped reads have a configurable lower timeout with a hard 30-second ceiling (`GREENHOUSE_RECRUITER_MAX_TOOL_DURATION_MS`); whole analyses and the question front door likewise have a configurable lower budget with a hard 120-second ceiling (`GREENHOUSE_RECRUITER_MAX_ANALYSIS_DURATION_MS`). Slow upstream reads return `TOOL_TIMEOUT` and audit with no rows read; multi-read analyses return an honest incomplete result before the front-door ceiling.

Permission lookup is fresh per scoped read by default. `GREENHOUSE_RECRUITER_PERMISSION_TTL_MS` may be used only for a controlled short in-process pilot cache, and `GREENHOUSE_RECRUITER_FORCE_PERMISSION_TTL_ZERO=true` overrides it for rollout or incident response. Hosted `/readyz` fails for a nonzero effective permission TTL, which keeps req additions/removals reflected on the next scoped read for production distribution.

## Verification

```sh
npm run verify
```

Before a pilot or broader distribution, run the whole workspace verification from the repo root:

```sh
npm run verify
```

It builds the control plane, then runs every package's typecheck, tests, and static guardrails — including the proof that the recruiter runtime source plus command entrypoints stayed read-only and that raw Greenhouse client usage is isolated to `src/scoped-reader.ts`.

Broad rollout is still gated on live Greenhouse permission probes, real desktop auth/identity wiring, and ChatGPT remote MCP attachment or broker confirmation.

This package is additive. It does not modify `packages/control-plane/src/*` and does not change the existing unscoped operator/analytics path.
