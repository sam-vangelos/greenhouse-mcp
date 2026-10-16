# Greenhouse Scoped Core

This package is the permission boundary between recruiter-facing tools and the raw Greenhouse read client. It resolves an authenticated actor, derives current job access, filters each supported response, and denies records whose scope cannot be established.

## Surface Contract

A surface supplies three ports:

- `ActorResolver`: resolves the authenticated session identity to a Greenhouse user id. Do not read this from model params, Slack text, or any client-supplied tool argument.
- `PermissionProvider`: returns the current job ids visible to a Greenhouse user, or an explicit `{ kind: "all" }` scope for a real all-jobs Greenhouse grant.
- `RawReadClient`: wraps the existing Greenhouse MCP read client functions (`apiGet` and, for cursors, `apiGetWithCursor`).

Example:

```ts
import {
  createGreenhouseRawReader,
  createHarvestPermissionProvider,
  createOperatorActorIds,
  createScopedGreenhouseReader,
} from "./scoped-core/src/index.js";
import { apiGet, apiGetWithCursor } from "../control-plane/dist/client.js";

const rawReader = createGreenhouseRawReader({ apiGet, apiGetWithCursor });

const scopedGreenhouse = createScopedGreenhouseReader({
  rawReader,
  actorResolver: {
    async resolveActor(session) {
      return session.greenhouseUserId;
    },
  },
  permissionProvider: createHarvestPermissionProvider({ rawReader }),
  operatorActorIds: createOperatorActorIds(process.env),
});

const result = await scopedGreenhouse.scopedRead(
  authenticatedSession,
  "list_applications",
  { status: "active" }
);
```

## Permissions

The default permission provider calls `/user_job_permissions` with `user_ids=<greenhouse user id>` and extracts `job_id` from returned rows. The current Harvest v3 docs describe each row as a `(user_id, job_id, role_id)` assignment and list `user_ids`, `job_ids`, and `role_ids` as supported filters. The provider also recognizes explicit all-jobs role markers, such as an all-jobs role name with no `job_id`, and returns `{ kind: "all" }`.

The provider resolves permissions on each `scopedRead` by default. A short `ttlMs` can be supplied, but there is no permanent or one-time cache. If permission lookup fails, `scopedRead` returns `PERMISSION_LOOKUP_FAILED` and does not fall through to unscoped data.

To inspect tenant-specific permission and note visibility shapes without logging PII values:

```sh
SCOPED_GREENHOUSE_PER_JOB_USER_ID=123 \
SCOPED_GREENHOUSE_ALL_JOBS_USER_ID=456 \
npx tsx scripts/probe.ts
```

## Operators And `actAsUser`

`OPERATOR_ACTOR_IDS` is a comma-separated list of Greenhouse user ids, parsed with the same positive-integer allowlist idiom used by the existing Greenhouse actor gates.

Operator behavior:

- Operator without `actAsUser`: unscoped passthrough to the raw read, except for candidate privacy (`candidate.is_private`), which is evaluated separately from job membership (`scoped-core` and `packages/recruiter-mcp/src/private-custom-fields.ts`). When an operator attestation (`privateCandidateAttestation`) is required and absent, private candidates outside the actor's own per-job `"Private"` Job Admin roles are withheld (`packages/recruiter-mcp/src/private-candidate-attestation.ts`, `0008_private_candidate_attestation.sql`), `permissionScope` reports `privateCandidatesWithheld: true`, and `scoped` stays `false`.
- Operator with `actAsUser`: reads the raw data, then filters it as that user.
- Non-operator with `actAsUser`: explicit denial.

`actAsUser` is an option passed by trusted surface code. It is not read from tool params. Identity-looking params such as `on_behalf_of_user_id`, `actor_id`, and `actAsUserId` are stripped before raw reads.

## Filtering contract

The default registry covers the raw objects used by the recruiter catalog, including jobs, applications, candidates, interviews, scorecards, notes, attachments, offers, openings, users, stage history, ownership, and reference dictionaries. Unsupported tool names receive a `TOOL_NOT_AVAILABLE` denial.

Filtering is default-deny:

- Directly job-scoped rows must name a permitted job.
- Applications and their dependent records resolve through the application-to-job relationship.
- Candidate rows are scoped through visible applications, and embedded applications are pruned.
- Notes must satisfy both job scope and note-visibility rules.
- Global reference dictionaries use explicit projection policies rather than inheriting broad records by default.
- Unknown permission shapes and unresolved associations are denied.

Write tools are absent from the raw read registry. The recruiter runtime mounts the separate action package only after session, identity, visibility, and entitlement checks.

## Verify

From the workspace root:

```bash
npm --workspace @greenhouse-mcp/scoped-core run verify
```

The suite covers permission lookup, operator impersonation, cursor pagination, relationship resolution, filtering, default-deny behavior, and cancellation.
