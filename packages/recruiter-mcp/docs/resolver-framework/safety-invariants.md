# Resolver Framework Safety Invariants

These are blocker rules. If the implementation would violate one, stop and report the issue instead of working around it.

## Protected Paths

Do not modify:

- `packages/control-plane/src/*`

- env files with real values
- rollout evidence or issued desktop/session artifacts

Tokenless `*.example.json` rollout scaffolds may be updated when contracts change. Real generated evidence, issued-session files, desktop configs with tokens, and operator rollout proof remain protected.

The unscoped operator and analytics paths must remain unchanged.

## Public Surface

- Keep the recruiter MCP read-only.
- Do not expose write/admin tools.
- Do not add a generic model-facing resolver tool.
- Preserve current public tool names and general input compatibility.
- Do not require users to know resolver internals.

## Identity And Authorization

- Never trust model/client-supplied actor identity.
- `actAsUser` remains trusted-server/operator-only.
- Exact `job_ids` remain model/user supplied until server-validated and permission-revalidated.
- A signed scope artifact never grants access by itself; permissions must be rechecked at analysis time.

## Scope Artifacts

- Scope handles and confirmation tokens must stay tamper-evident.
- Scope handles must bind to the authenticated session subject.
- Scope handles must expire.
- Cross-user redemption must fail.
- Confirmation can narrow a proposed scope, never widen it.

## Completeness And Fail-Closed Behavior

- Partial inventory cannot silently power broad/site-admin analysis.
- Pagination truncation must be represented in completeness metadata.
- Analysis must not treat missing associations as confident evidence.
- Unknown or unresolved evidence must be counted and surfaced through metadata.

## Privacy

Do not place these in resolver metadata, unresolved evidence, audit logs, or framework fixtures:

- candidate contact info;
- resumes;
- attachments;
- raw profiles;
- raw private note content;
- raw custom fields unless explicitly sanitized;
- Greenhouse credentials;
- Supabase keys;
- session tokens;
- desktop config tokens.

## Refactor Scope

This packet is a framework refactor only. Do not implement:

- source normalization;
- stage normalization;
- rejection normalization;
- user-role attribution;
- scheduled-interview-backed scorecard accountability;
- persistent saved scopes;
- deployment or hosted evidence work.
