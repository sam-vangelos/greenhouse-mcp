# Scoped Recruiter Greenhouse MCP

This package is the current recruiter-facing runtime. It serves a curated MCP
catalog over stdio or Streamable HTTP, resolves each session to a Greenhouse user,
and permission-filters every read before data reaches the client model.

For sessions with an active write entitlement, the runtime also mounts the action
package's preview/apply tools. Unentitled sessions receive the same read-only
catalog they would receive in a deployment without the action plane.

## Request path

```mermaid
flowchart LR
    C["MCP client"] --> T["stdio or HTTP transport"]
    T --> S["Signed recruiter session"]
    S --> ID["Identity directory"]
    ID --> SR["scoped-reader"]
    SR --> SC["scoped-core"]
    SC --> GH["Read-only Harvest client"]
    GH --> API["Greenhouse Harvest v3"]
    SR --> P["Tool-specific projection"]
    P --> C
    S --> E{"Action entitlement"}
    E -->|present| AP["Mounted action tools"]
```

Session tokens carry identity, protocol surface, physical client, token id, and
issue time. They do not carry Greenhouse roles, job ids, or permission claims.
The runtime resolves current ATS access for each scoped read and denies unknown
permission shapes.

Candidate privacy (`candidate.is_private`) and private custom fields
(`custom_fields` entries marked private in `/v3/custom_fields`) are evaluated
separately from job membership (`scoped-core` and
`packages/recruiter-mcp/src/private-custom-fields.ts`). When an operator
attestation is required and absent, private candidates are withheld
(`packages/recruiter-mcp/src/private-candidate-attestation.ts`,
`0008_private_candidate_attestation.sql`; CLI
`greenhouse-recruiter-attest-private-candidates --greenhouse-user-id <id> --by
"<name> (attested YYYY-MM-DD)"`, or `--clear` to withdraw). Unattested is the
fail-closed default and is disclosed per read, and per session on `get_job_scope`
and `confirm_job_scope` as `private_candidates_visible`.

## Model-facing catalog

The canonical catalog is defined and ordered in
[`src/tools/register.ts`](src/tools/register.ts). `test/catalog-registrar.test.ts`
and `src/container-self-check.ts` reject missing, duplicate, reordered, or
unexpected tools.

| Tool family | Purpose |
|---|---|
| Job scope | Resolve, confirm, and inspect the requisitions available to the session |
| Deterministic analysis | Feedback accountability, interview drag, stage latency, pipeline state, source outcomes, and rejection-reason drift |
| Evidence reads | Scoped jobs, applications, interviews, offers, candidates, scorecards, notes, attachments, stages, owners, and reference dictionaries |
| Document read | Explicit attachment-id lookup and bounded text extraction |

Analysis tools calculate their metrics in code and return structured evidence
references. The model can explain the result, but it does not calculate the
underlying counts, rates, rankings, or risk scores.

The tool surface exposes only supported parameters. Actor identity and raw
operator-only controls are removed before the scoped reader runs.

## Read boundaries

`src/scoped-reader.ts` is the sole sanctioned caller of raw Greenhouse read
primitives. `scripts/verify-package.mjs` (`scripts/verify-guards.mjs`) statically
enforces that chokepoint and forbids recruiter runtime imports of the write
plane outside the mount seam.

Returned records pass through two filters:

1. `scoped-core` removes rows the current Greenhouse user cannot access and
   withholds unattested private candidates (`candidate.is_private`).
2. The individual tool projection removes fields outside that tool's contract
   and strips private custom fields (`src/private-custom-fields.ts`).

Candidate tools return the candidate's name, email addresses, and phone numbers
(what a Job Admin sees in Greenhouse). No candidate tool returns resume
contents; document text comes only through `read_my_resume`. No tool returns
home addresses, raw profiles, signed attachment URLs, or raw rows. Audit events
contain bounded operational metadata rather than candidate content.

Audit is fail-closed when required. If the configured sink cannot accept the
event, the protected result is not returned.

## Document reads (`read_my_resume`)

`read_my_resume` (`src/tools/resume.ts`) accepts one positive `attachment_id`
(selected from `search_my_attachments`). Before fetching the file, the runtime
performs a fresh scoped attachment lookup and requires that `attachment_id`
match a single attachment on a visible candidate (resumes, cover letters,
take-homes, and offer packets on a visible candidate can all be read when
explicitly selected by `attachment_id`).

`validateDownloadUrl` enforces `https:`, default/443 port, no URL credentials,
no IP literals, and no `localhost` / `.localhost` / `.local` / `.internal`
hostnames, and follows up to 3 (`RESUME_MAX_REDIRECTS = 3`) same-origin
redirects while re-validating each hop and stripping headers. The server streams
at most 10 MiB (`RESUME_DOWNLOAD_MAX_BYTES`) within a 30-second tool budget
(`HARD_MAX_TOOL_DURATION_MS = 30_000`) and parses PDF or DOCX in a spawned child
Node process (`--max-old-space-size=96`, `--max-semi-space-size=16`,
`src/resume-parser-worker.mjs`) with 50 ms RSS polling capped at 192 MiB
(`RESUME_PARSER_MAX_RSS_BYTES`). Extracted output is capped at 200,000 UTF-8
bytes (`RESUME_TEXT_MAX_BYTES`) and marked as untrusted candidate-authored
content.

## Mounted action tools

The action plane is loaded from `../action-mcp` into the recruiter runtime. It is
withheld when its service flag is off, configuration is incomplete, session
derivation fails, the entitlement store is unavailable, or the current identity
has no preview entitlement. A write-plane failure does not remove recruiter read
access.

An entitled session receives the action package's fixed preview/apply pairs after
the read catalog. The session's own scoped read path supplies the visibility fence
for each target. Apply remains separately gated by write flags, capability
allowlists, approval binding, current-state checks, and the action ledger.

See [`../action-mcp/README.md`](../action-mcp/README.md) for the action contract.

## Transports and image

| Surface | Entrypoint |
|---|---|
| Streamable HTTP | `bin/greenhouse-recruiter-mcp-http.mjs` |
| stdio | `bin/greenhouse-recruiter-mcp.mjs` |
| Container self-check | `bin/greenhouse-recruiter-container-self-check.mjs` |

Build the combined recruiter/action image from the workspace root:

```bash
docker build -f packages/recruiter-mcp/deploy/Dockerfile .
```

The image runs the HTTP entrypoint as a non-root user and exposes public liveness
plus protected readiness checks. The environment contract is
[`deploy/production.env.example`](deploy/production.env.example).

## Session and rollout operations

The package includes commands for identity bootstrap, roster preflight, session
issuance and revocation, client configuration, live probing, leakage sampling,
audit review, distribution validation, and rollout-gate evaluation. Their
entrypoints are listed under `bin/`; sanitized evidence shapes live under
`examples/rollout-evidence/`.

Issued session files contain bearer credentials. Generate them only in an ignored
or external secure directory, deliver each file to its intended user and client,
then retain token-free manifests rather than token-bearing artifacts.

The rollout gate evaluates current environment checks, catalog and transport
validation, scoped live probes, leakage samples, audit review, session revocation,
and real-client tests. The default unit suite validates the gate logic but does
not create live rollout evidence.

## Verification

From the workspace root:

```bash
npm ci
npm run verify
node packages/recruiter-mcp/scripts/verify-package.mjs
```

The package-level gate is also available directly:

```bash
npm --workspace @greenhouse-mcp/recruiter-mcp run verify
```

The credential-free suite covers scoping, projections, identity, sessions,
transports, audit behavior, action mounting, catalog integrity, and rollout
evidence validation. Live probes and distribution checks require their own
credentials and evidence directories.
