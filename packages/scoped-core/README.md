# Scoped Greenhouse Reads

This module adds a per-user read-scoping layer around the Greenhouse MCP raw read client. It is additive: it does not modify `greenhouse/src`, and it does not change the existing org-wide operator or analytics path.

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
} from "./scoped-greenhouse/src/index.js";
import { apiGet, apiGetWithCursor } from "../dist/client.js";

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

- Operator without `actAsUser`: unscoped passthrough to the raw read.
- Operator with `actAsUser`: reads the raw data, then filters it as that user.
- Non-operator with `actAsUser`: explicit denial.

`actAsUser` is an option passed by trusted surface code. It is not read from tool params. Identity-looking params such as `on_behalf_of_user_id`, `actor_id`, and `actAsUserId` are stripped before raw reads.

## Registered Scoped Tools

The v1 scoped read registry includes:

- `list_applications`, `get_application`
- `list_candidates`, `get_candidate`
- `list_scorecards`
- `list_notes`
- `list_jobs`, `get_job`

Unsupported tools return an explicit `TOOL_NOT_AVAILABLE` denial. Write tools are not in the registry, so they are denied by the same default-deny path; the scoped surface never calls raw write helpers.

Filtering is default-deny. Rows with no resolvable job association are dropped. Candidate rows are scoped through their applications; embedded application arrays are pruned to permitted jobs, and candidates with no permitted application are dropped. Scoped note reads also require public note visibility.
