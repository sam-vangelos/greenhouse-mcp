# Phase 1e — change spec: making the action package consumable

Scope: what must change on `codex/greenhouse-action-mcp` (and in three files on
`codex/greenhouse-mcp-permission-gates`) before Phase 2 can compose the 22 action tools into the
scoped recruiter server. No code in this worktree changes; the action package does not exist here,
so this document is the deliverable.

All `action-mcp/...` paths below live on `codex/greenhouse-action-mcp` and were read via
`git show codex/greenhouse-action-mcp:packages/action-mcp/<path>`. All other paths are in this
worktree.

---

## 1. The three claims, confirmed

**No `main`.** `action-mcp/package.json:1-12` declares exactly `name`, `version`, `private`, `type`,
`description`, `bin`, then `scripts`/`dependencies`/`devDependencies`. There is no `main` key.

**No `exports`.** Same range, same evidence — the key is absent.

**No declarations emitted.** `action-mcp/tsconfig.build.json:8` sets `"declaration": false`, and
line 7 sets `"sourceMap": false`. The base config it extends
(`action-mcp/tsconfig.json:11`) sets `"noEmit": true`, so `tsconfig.build.json` is the only config
that emits anything, and it emits `.js` only.

---

## 2. The blocker is `declaration`, not `main`/`exports`

The plan review recorded this as "Define exports/dependency, update both lockfiles, and copy runtime
output/dependencies" (`reviews/phase-1-5-plan-review.md:59`). The dependency half of that
recommendation should not be executed, and `exports` is not what unblocks Phase 2. Here is why.

The scoped package does not depend on the base package as an npm dependency. Its dependency block is
`scoped-recruiter-mcp/package.json:45-50` — `@modelcontextprotocol/sdk`, `mammoth`, `pdf-parse`,
`yauzl`, `zod`, and nothing else. It reaches the base package by **relative path into the sibling's
built output**, at exactly two call sites:

```
scoped-recruiter-mcp/src/scoped-reader.ts:7
  import { apiGet, apiGetWithCursor, configure } from "../../dist/client-readonly.js";

scoped-recruiter-mcp/src/read-all.ts:13
  import { RATE_LIMIT_ERROR_NAME } from "../../dist/client-readonly.js";
```

A relative specifier never consults the target package's `main` or `exports`; Node and TypeScript
resolve the file directly. The base package's `"main": "dist/index.js"`
(`mcp/greenhouse/package.json:7`) is inert for this consumption path. What actually makes the base
package consumable is `mcp/greenhouse/tsconfig.json:12-13` — `"declaration": true` and
`"declarationMap": true` — which put `dist/client-readonly.d.ts` next to `dist/client-readonly.js`
so the scoped package's `strict` + `Node16` typecheck can resolve types.

Verified by construction, using the scoped package's own compiler options for both sides:

| producer `declaration` | consumer `tsc -p tsconfig.json` |
| --- | --- |
| `false` | `error TS7016: Could not find a declaration file for module '../../producer/dist/index.js'` — exit 2 |
| `true` | exit 0 |

Note the error is TS7016, not TS2307. The `.js` file resolves fine; it is the missing `.d.ts` that
fails, and it fails under `noImplicitAny` (from `strict`). Turning `declaration` on is necessary and,
as section 4 shows, sufficient.

---

## 3. Chosen mechanism: mirror the base-package precedent exactly

Phase 2 should consume the action package the same way the scoped package already consumes the base
package — a relative deep import of a built, declaration-bearing sibling `dist/`, with **one**
sanctioned specifier. Concretely, `../../action-mcp/dist/index.js` from
`scoped-recruiter-mcp/src/`.

Two reasons this is the right shape rather than an npm dependency, beyond consistency.

The scoped package's boundary guards are written to police *specifiers*, not package graphs.
`scoped-recruiter-mcp/scripts/verify-guards.mjs:36-38` pins the base boundary with
`WRITE_CLIENT_MODULE_PATTERN` and `RAW_CLIENT_NAME_PATTERN`, and the comment at `:20-35` explains
that the whole point is a single chokepoint file that one regex can hold. An action-plane boundary
guard in Phase 2 wants the same affordance, which means the action package needs one entry module
rather than a widening set of `dist/` subpaths.

And the `file:` dependency alternative fails silently in the deploy path. See section 6.

---

## 4. Change spec, file by file

### 4.1 `action-mcp/tsconfig.build.json` — REQUIRED

Replace line 8. This is the only change that is strictly load-bearing.

```diff
   "compilerOptions": {
     "noEmit": false,
     "rootDir": "src",
     "outDir": "dist",
     "sourceMap": false,
-    "declaration": false
+    "declaration": true,
+    "declarationMap": true
   },
```

`declarationMap` matches `mcp/greenhouse/tsconfig.json:13` and gives Phase 2 authors go-to-definition
into the action source. It is optional; `declaration` is not.

Verified: the real action source emits cleanly under both flags. Running
`tsc -p tsconfig.build.json --declaration --declarationMap` over the package (with `node_modules`
symlinked from the scoped package, whose `typescript`, `zod`, and `@modelcontextprotocol/sdk`
versions match the action lockfile) exits **0** and emits 33 `.d.ts` files. There is no TS4023-class
"cannot be named" fallout — a real risk when `declaration` is flipped on for the first time on a
package that was never checked for it, and the reason this was tested rather than assumed.

### 4.2 `action-mcp/src/index.ts` — NEW FILE

Create the chokepoint barrel. Exact content:

```ts
// Single import chokepoint for in-process consumers of the action plane.
//
// The scoped recruiter package consumes its sibling base package through exactly one
// specifier (`../../dist/client-readonly.js`, scoped-recruiter-mcp/src/scoped-reader.ts:7)
// so that one guard regex can police the boundary. This barrel gives the action plane the
// same property: consumers import `../../action-mcp/dist/index.js` and nothing deeper, so a
// future guard can assert on one path instead of a growing list of dist subpaths.
//
// `./main.js` is deliberately absent and must stay absent: it is the only module in this
// package that self-executes on import (main.ts:3 calls startHttpActionMcp()). Every CLI
// module is `import.meta.url === file://${process.argv[1]}`-guarded and therefore
// import-safe, but the operator CLIs (access, issue-session, token-probe, reconcile) are
// excluded anyway — they are provisioning tooling, not server composition.
export * from "./actions/index.js";
export * from "./crypto.js";
export * from "./diagnostics.js";
export * from "./env.js";
export * from "./errors.js";
export * from "./greenhouse.js";
export * from "./service.js";
export * from "./store.js";
export * from "./types.js";
export * from "./version.js";
```

The exclusion list is not a guess. `main.ts:3` calls `startHttpActionMcp()` at module scope and is
the only unconditional side effect in the package; `access-cli.ts`, `issue-session-cli.ts`,
`reconcile-cli.ts`, and `token-probe.ts` all end in an
`if (import.meta.url === \`file://${process.argv[1]}\`)` guard and are therefore import-safe, but
none of them is server composition. `server.ts` and `http-server.ts` are omitted because the unified
plane brings its own MCP server and HTTP router; `server.ts` in particular constructs its own
`McpServer` (`action-mcp/src/server.ts:19-29`), which is the wrong shape for composition (see
section 7).

Verified: this exact file was written into a scratch checkout and built. Exit **0**, no `export *`
name collisions, and the emitted `dist/index.d.ts` is the ten-line re-export.

Also verified: the *type closure* reachable from `index.d.ts` pulls in `zod` and `node:*` only. The
`@modelcontextprotocol/sdk` import lives in `server.d.ts`, which the barrel does not reach. The scoped
package already resolves `zod` at 3.25.76, identical to the action lockfile pin, so Phase 2 adds no
new type dependency.

### 4.3 `action-mcp/package.json` — add `main` and `types`, do NOT add `exports`

```diff
   "type": "module",
   "description": "Typed preview/apply Greenhouse action MCP.",
+  "main": "dist/index.js",
+  "types": "dist/index.d.ts",
   "bin": {
```

Insert after line 6, before the `bin` block at line 7. This mirrors `mcp/greenhouse/package.json:7`,
which declares `main` and no `exports`.

These two keys are honestly inert for the chosen mechanism — a relative specifier ignores both. Add
them anyway because they make the package self-describing and cost nothing; a future consumer that
does resolve by package name gets a correct answer instead of a guess at `index.js`.

Do not add `exports`. It would gain nothing (nothing resolves this package by name) while narrowing
subpath resolution, and the base package sets the precedent of `main` without `exports`. The four
`bin` entries are unaffected either way — they resolve `../src/*.ts` relatively through `tsx`
(`action-mcp/bin/greenhouse-action-mcp-http.mjs:4`,
`action-mcp/bin/greenhouse-action-reconcile.mjs:4`), never through the package's export map.

No guard change is needed on the action side. `action-mcp/scripts/verify-package.mjs` asserts on
`packageJson.name` (`:88`) and on every `bin` key starting with `greenhouse-action-` (`:90`); neither
`main` nor `types` is inspected. Adding `src/index.ts` is likewise safe: `:40` scopes the action-tool
scan to files under `src/actions`, `:43-44` count 11 preview and 11 apply tools from that subset, and
`:87` forbids `from "../../…"` — which a barrel of `./` specifiers does not trip. The file count at
`:102` is a log message, not an assertion.

### 4.4 The scoped-side import (Phase 2 writes this; recorded here for the boundary)

```ts
import { ACTION_DEFINITIONS, /* … */ } from "../../action-mcp/dist/index.js";
```

Checked against every existing scoped guard, this passes clean:

- `WRITE_CLIENT_MODULE_PATTERN` (`verify-guards.mjs:36-37`) matches `\bclient\.js\b`,
  `packages/control-plane/src`, and `../../src/`. The action path matches none. Confirmed there is no
  `client.ts` anywhere in `action-mcp/src/`, so no `client.js` appears in its `dist`.
- `RAW_CLIENT_NAME_PATTERN` (`:38`) matches `apiGet|apiGetWithCursor|configure`. The action package
  exports none of those names.
- `RECRUITER_WRITE_HELPER_PATTERN` (`:17-18`) forbids `apiPost|apiPatch|apiDelete|adminApi*|
  configureAdminAdapter|reject_application|move_application_to_stage|create_offer_draft|
  update_application_assignment|patch_` in any `src/` or `bin/` file. All 22 action tool names were
  enumerated from the action sources and checked against this: they are `preview_*`/`apply_*` over
  the 11 kinds (`preview_application_rejection`, `apply_application_stage_move`,
  `apply_offer_create`, and so on). None matches. The near-misses are inversions —
  `reject_application` vs `apply_application_rejection`, `move_application_to_stage` vs
  `apply_application_stage_move` — so the guard holds by luck of naming, not by design.
- `test/server-contract.test.ts:212` and `:222` re-assert the same two properties from the test side;
  both pass for the same reason.

Worth stating because it is a real property rather than a coincidence: if Phase 2 registers tools by
iterating `ACTION_DEFINITIONS`, no scoped source file ever needs to *spell* an action tool name. The
composition is name-free, so it cannot trip a name-based denylist at all.

### 4.5 `.github/workflows/greenhouse-mcp-verify.yml` — add a second sibling build

CI already carries the exact precedent, with the reasoning written out at lines 38-41:

> The scoped package statically imports the sibling mcp/greenhouse package's compiled
> dist/client-readonly.js (gitignored), so its typecheck/tests cannot resolve that module on a clean
> checkout unless the sibling is built first. Without this step CI fails with TS2307 before verify
> runs.

`.gitignore:49` is `mcp/**/dist/`, which covers `action-mcp/dist/` identically — confirmed by
`git ls-files packages/control-plane/dist` returning zero tracked files. So the action package needs the same
treatment. After the existing step at `:42-44`, add:

```yaml
      # Same reason as the step above, for the action plane: the scoped package statically
      # imports action-mcp/dist/index.js (gitignored), so it must be built on a clean
      # checkout before verify can typecheck. Without this, CI fails with TS7016 — the .js
      # resolves and the missing .d.ts is what breaks under strict.
      - name: Build sibling Greenhouse action plane (dist for scoped imports)
        working-directory: packages/action-mcp
        run: npm ci && npm run build
```

The workflow's `paths` filter at `:8-17` is already `mcp/greenhouse/**`, so action-package changes
trigger it with no filter edit. Note this step only becomes possible once `action-mcp` exists on the
target branch — it is a merge-order dependency, not something this branch can add today.

### 4.6 `scoped-recruiter-mcp/deploy/Dockerfile` — build and ship the action dist

Three edits. Deps stage, after line 8 (base `npm ci`) and before line 9:

```dockerfile
WORKDIR /app/packages/action-mcp
COPY packages/action-mcp/package.json packages/action-mcp/package-lock.json ./
RUN --mount=type=secret,id=npm_ca,required=false \
    if [ -f /run/secrets/npm_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/npm_ca; fi; \
    npm ci --include=dev --no-audit --no-fund
```

Build stage, after line 20:

```dockerfile
COPY packages/action-mcp packages/action-mcp
```

and a build invocation after line 22:

```dockerfile
WORKDIR /app/packages/action-mcp
RUN npm run build
```

Runtime stage, after line 31:

```dockerfile
COPY --from=build /app/packages/action-mcp/dist packages/action-mcp/dist
```

Do **not** copy `action-mcp/node_modules` into the runtime stage. Node resolves from the importing
file upward, so `packages/action-mcp/dist/*.js` walks to `mcp/greenhouse/node_modules`, which
line 28 already copies. Verified that this resolves correctly: the base package's installed
`@modelcontextprotocol/sdk` is 1.29.0 and `zod` is 3.25.76, and the action lockfile pins the same
1.29.0 and 3.25.76.

This is the better configuration, not merely the cheaper one. Action definitions expose whole
`z.ZodTypeAny` schemas (`action-mcp/src/actions/types.ts:29-32`) which Phase 2 must hand to a
registrar typed `Record<string, z.ZodTypeAny>` (`scoped-recruiter-mcp/src/tools/register.ts:107-115`).
Two copies of zod in the image would make those two `ZodTypeAny`s structurally similar but
instance-distinct, and schema conversion is instance-sensitive. One hoisted zod removes that class of
bug before it can happen. If a future dependency bump ever splits the versions, this is the thing to
re-check.

### 4.7 `scoped-recruiter-mcp/deploy/Dockerfile.dockerignore` — allowlist the action package

The file is a strict deny-then-reinclude allowlist: `**` at line 1, then `!` re-includes. The action
package is not re-included, so today it is not even present in the build context and every COPY in
4.6 would fail. After line 13, add:

```
!packages/action-mcp/
!packages/action-mcp/package.json
!packages/action-mcp/package-lock.json
!packages/action-mcp/tsconfig.json
!packages/action-mcp/tsconfig.build.json
!packages/action-mcp/src/
!packages/action-mcp/src/**
```

`tsconfig.build.json` must be listed explicitly — the existing entries for the base and scoped
packages only re-include `tsconfig.json`, because neither has a second build config. Missing it is
the easiest way to get a build that fails deep in the Docker stage with a confusing message.

---

## 5. The dependency line for `scoped-recruiter-mcp/package.json`

**None. No line should be added, and neither lockfile should change.**

That is the answer the evidence supports, and it is the same answer the base package already gives:
`scoped-recruiter-mcp/package.json:45-50` lists five dependencies and the base package is not among
them, despite being imported at `src/scoped-reader.ts:7` and `src/read-all.ts:13`. Adding a
dependency edge for the action package while the base package has none would make the manifest
describe two different truths for two identical relationships.

Lockfile implications of the chosen path, stated explicitly so a reviewer can confirm nothing was
missed: `scoped-recruiter-mcp/package-lock.json` is unchanged (163 top-level packages, root deps as
listed above); `mcp/greenhouse/package-lock.json` is unchanged; `action-mcp/package-lock.json` is
unchanged, because `declaration: true`, a new source file, and two package.json metadata keys add no
dependencies. The npm caches keyed on
`packages/recruiter-mcp/package-lock.json` (workflow `:37`) stay valid. This is the
whole reason to prefer it.

### The rejected alternative, and the exact way it fails

The `file:` protocol path would be:

```jsonc
// scoped-recruiter-mcp/package.json, inside "dependencies"
"@ta-ops/greenhouse-action-mcp": "file:../action-mcp"
```

which regenerates `scoped-recruiter-mcp/package-lock.json` with two entries — a `"../action-mcp"`
key describing the out-of-tree target, and `"node_modules/@ta-ops/greenhouse-action-mcp": { "resolved": "../action-mcp", "link": true }`.
The first of those is the tell: the lockfile stops being self-contained and starts asserting a fact
about a path outside its own package root.

That assertion is false in the deploy path. `deploy/Dockerfile:9-13` copies **only**
`scoped-recruiter-mcp/package.json` and `package-lock.json` into the deps stage and runs `npm ci`
there; `../action-mcp` does not exist at that point in the build.

The failure mode was reproduced rather than assumed, and it is worse than a build break. With the
`file:` target absent, `npm ci`:

- exits **0**
- prints `added 1 package`
- creates a **dangling symlink**, `node_modules/@probe/target -> ../../../target`

and the failure surfaces only later, at import time, as
`ERR_MODULE_NOT_FOUND: Cannot find package '@probe/target'`. A green deps layer that produces a
broken image is exactly the silent-success class this repo has been burned by, and it is a strong
enough reason on its own to keep the dependency edge out.

If a future maintainer still wants the dependency edge for manifest honesty, the correct move is to
add it for **both** siblings at once (base and action), and to restructure the Dockerfile deps stage
to copy all three package roots before any `npm ci`. That is a deliberate, separately reviewable
change. It is not Phase 1e, and it must not be done for one sibling only.

---

## 6. Symbols Phase 2 needs, with current paths

Every symbol below is exported today and reachable through the section 4.2 barrel. Paths are relative
to `action-mcp/`.

**Catalog** — the 22 tools and their metadata.

| Symbol | Path:line | Kind |
| --- | --- | --- |
| `ACTION_DEFINITIONS` | `src/actions/index.ts:15` | `readonly ActionDefinition[]`, the 11 entries |
| `actionDefinition(kind)` | `src/actions/index.ts:41` | lookup by kind, throws on unknown |
| `ActionDefinition` | `src/actions/types.ts:20` | type; carries `previewTool`/`applyTool`, titles, descriptions, `destructive`, and the four Zod schemas |
| `ActionContext` | `src/actions/types.ts:13` | type |
| `ACTION_KINDS` / `ActionKind` | `src/types.ts:1` / `:15` | the 11 kinds |

**Service** — preview/apply execution.

| Symbol | Path:line |
| --- | --- |
| `GreenhouseActionService` | `src/service.ts:41` |
| `GreenhouseActionServiceConfig` | `src/service.ts:30` |
| `createGreenhouseActionServiceFromEnv(session, env?, runtime?)` | `src/env.ts:99` |
| `reconcileRecoverableActions({store, greenhouse, signingSecret, clock?})` | `src/service.ts:351` |

`reconcileRecoverableActions` is the symbol that answers the plan review's "Cloud Scheduler has no
target" blocker (`reviews/phase-1-5-plan-review.md:83`). It is a plain exported function, so a
scheduled Cloud Run job or an authenticated route can call it directly; `runReconciliation`
(`src/reconcile-cli.ts:7`) only adds operator-argument parsing on top and is deliberately outside the
barrel.

**Store and gateway constructors.**

| Symbol | Path:line |
| --- | --- |
| `createActionRuntimeFromEnv(env?, fetchImpl?)` | `src/env.ts:23` |
| `createActionRuntimeProvider(env?, fetchImpl?)` | `src/env.ts:33` |
| `ActionRuntime` (`{store, greenhouse}`) | `src/env.ts:18` |
| `createSupabaseActionStore(config)` | `src/store.ts:34` |
| `createActionStoreFromEnv(env?, fetchImpl?)` | `src/store.ts:240` |
| `readActionSupabaseConfig(env?)` | `src/store.ts:248` |
| `ActionStoreError` | `src/store.ts:27` |
| `createGreenhouseGateway(config)` | `src/greenhouse.ts:52` |
| `createGreenhouseGatewayFromEnv(env?, fetchImpl?)` | `src/greenhouse.ts:192` |
| `createGreenhouseReconcilerGatewayFromEnv(env?, fetchImpl?)` | `src/greenhouse.ts:201` |
| `GreenhouseError` | `src/greenhouse.ts:26` |

`createActionRuntimeProvider` is the one to prefer for the unified server. It memoizes both the store
and the gateway (`src/env.ts:37-38`), which preserves the OAuth token cache held in the gateway
closure (`src/greenhouse.ts:59-70`). Constructing a gateway per request throws that cache away — the
hazard already flagged at `reviews/phase-1-5-plan-review.md:81`. Only the session-bearing
`GreenhouseActionService` should be request-scoped.

**Capability gating** — this is the 44-vs-66 mechanism.

| Symbol | Path:line |
| --- | --- |
| `readActionRuntimeFlags(env?)` | `src/env.ts:41` |
| `ActionRuntimeFlags` | `src/env.ts:10` |
| `validateActionEnvironment(env?, runtime?)` | `src/env.ts:66` |
| `validateActionReadiness(env?, fetchImpl?, runtime?)` | `src/env.ts:77` |
| `readActionSigningSecret(env?)` | `src/env.ts:58` |
| `ACTION_SIGNING_SECRET_ENV` | `src/env.ts:8` |
| `readExactBoolean(env, name, fallback)` | `src/env.ts:117` |

`ActionRuntimeFlags` keeps `catalogCapabilities` and `writeCapabilities` separate (`src/env.ts:14-15`),
enforcing the subset relation at `:46-48`. Registration reads the former (`src/server.ts:18,31-32`)
and apply reads the latter (`src/service.ts:127-129`). Phase 2 must preserve both fields; collapsing
them to one list makes "66 visible tools" and "canary one capability at a time" mutually exclusive.

**Session and intent crypto.**

| Symbol | Path:line |
| --- | --- |
| `validateActionSession(token, secret, nowMs?)` | `src/crypto.ts:72` |
| `issueActionSession(...)` | `src/crypto.ts:46` |
| `issueActionIntent(input, secret)` | `src/crypto.ts:84` |
| `verifyActionIntent(token, secret)` | `src/crypto.ts:118` |
| `fingerprintValue` / `fingerprintSubject` / `fingerprintSession` / `fingerprintOperator` | `src/crypto.ts:125` / `:134` / `:138` / `:142` |
| `parseActionBinding(kind, value)` | `src/crypto.ts:146` |
| `DEFAULT_SESSION_TTL_MS` / `MAX_SESSION_TTL_MS` / `INTENT_TTL_MS` | `src/crypto.ts:42` / `:43` / `:44` |
| `ActionSession` / `ActionClient` | `src/types.ts:20` / `:16` |

**Errors and diagnostics.**

| Symbol | Path:line |
| --- | --- |
| `ActionDeniedError` | `src/errors.ts:7` |
| `ActionDeniedDiagnostic` | `src/errors.ts:1` |
| `reportActionError(event, error, details?)` | `src/diagnostics.ts:3` |

**Durable types** — `src/types.ts` exports the full set (`ActionStore:206`, `ActionRecord:167`,
`ActionIntent:139`, `GreenhouseGateway:250`, `PreparedAction:266`, `MutationPlan:281`, `Clock:261`,
`ResolvedIdentity:31`, `ActionEntitlement:36`, `ClaimResult:201`, `Observation:165`, and the eleven
`*Binding` interfaces at `:45-137`).

---

## 7. Gap this slice found: the error envelope is module-private

Phase 2 cannot reuse `createGreenhouseActionMcpServer` (`src/server.ts:10`) for composition — it
constructs and returns its own `McpServer` (`:19-29`, `:57`), whereas the unified plane needs tools
registered into the *scoped* server. So Phase 2 will re-implement the registration loop over
`ACTION_DEFINITIONS`.

The loop body is not the hard part. The hard part is `toolResult` at `src/server.ts:60` — a
module-private `async function`, not exported. It owns the entire public-error contract: mapping
`ActionDeniedError` to `{code, message}`, conditionally attaching `upstream_status` and
`upstream_request_id`, collapsing every non-`ActionDeniedError` to
`ACTION_SERVICE_UNAVAILABLE` so internals never leak, deciding when to emit a correlation id
(`:78-92`), and setting `isError: true` with `structuredContent` preserved (`:62-66`).

Two ways forward, and they are not equivalent. Duplicating that logic into the scoped package puts a
security-relevant error-redaction contract in two places that will drift. Exporting it keeps one
implementation. **Export it** — add `toolResult` (renamed to something less generic at module scope,
e.g. `actionToolResult`) to the action package's exports and to the section 4.2 barrel.

This is a one-line change to `src/server.ts` plus a barrel line, but it is not in section 4 because it
is a judgement call about the action package's API surface rather than a mechanical consumability
fix, and because `server.ts` is guard-sensitive: `action-mcp/scripts/verify-package.mjs:50` asserts
`count(serverSource, "server.registerTool(") === 2`, and `:51` asserts the file still contains
`for (const definition of ACTION_DEFINITIONS)`. Adding an `export` keyword trips neither, but any
larger refactor of that file will.

Related and already known: `src/tools/register.ts:107-115` types the registrar's `paramsSchema` as
`Record<string, z.ZodTypeAny>` while action definitions carry whole-object `z.ZodTypeAny` schemas
(`src/actions/types.ts:29-32`). An adapter is required either way; that is Phase 2's problem, noted
here only because it is the second consumer-side impedance mismatch in the same seam.

---

## 8. Verification performed

Nothing in this document is inferred from filenames or imports. Specifically:

- Read in full: `action-mcp/` `package.json`, `tsconfig.json`, `tsconfig.build.json`,
  `src/index.ts` (absent — confirmed by `git ls-tree`), `src/actions/index.ts`, `src/actions/types.ts`,
  `src/service.ts`, `src/store.ts`, `src/greenhouse.ts`, `src/server.ts`, `src/env.ts`, `src/types.ts`,
  `src/http-server.ts`, `src/main.ts`, `scripts/verify-package.mjs`, `deploy/Dockerfile`, and the
  head/tail of every CLI module.
- Read in full in this worktree: `mcp/greenhouse/package.json`, `mcp/greenhouse/tsconfig.json`,
  `scoped-recruiter-mcp/package.json`, `tsconfig.json`, `scripts/verify-guards.mjs`,
  `scripts/verify-package.mjs`, `deploy/Dockerfile`, `deploy/Dockerfile.dockerignore`,
  `.github/workflows/greenhouse-mcp-verify.yml`, and the relevant ranges of `src/scoped-reader.ts`,
  `src/read-all.ts`, `src/tools/register.ts`, `test/server-contract.test.ts`.
- Compiler A/B: producer with `declaration:false` → consumer TS7016 exit 2; producer with
  `declaration:true` → consumer exit 0. Both sides used the scoped package's exact compiler options.
- Real-source declaration build: `tsc -p tsconfig.build.json --declaration --declarationMap` over the
  actual action package, exit 0, 33 `.d.ts` emitted.
- Barrel build: section 4.2's file written to a scratch checkout and compiled, exit 0, no `export *`
  collisions, `index.d.ts` correct.
- Type-closure check: only `zod` and `node:*` are reachable from `index.d.ts`; the MCP SDK is not.
- Version match: base `node_modules` has `@modelcontextprotocol/sdk` 1.29.0 and `zod` 3.25.76; the
  action lockfile pins 1.29.0 and 3.25.76.
- `file:` dependency reproduction: lock generated, target removed, `npm ci` run — exit 0,
  `added 1 package`, dangling symlink, `ERR_MODULE_NOT_FOUND` at import.
- Guard cross-check: all 22 action tool names enumerated from source and tested against all four
  scoped denylist patterns.
- `.gitignore:49` (`mcp/**/dist/`) confirmed to cover `action-mcp/dist/` via
  `git check-ignore -v` and `git ls-files`.

Everything used for the builds lives outside the worktree and is disposable: the action-package
scratch checkout at `/tmp/action-mcp-scratch/` (including the `src/index.ts` barrel from 4.2 and its
`dist-barrel/` output), the compiler A/B at `scratchpad/probe-decl/`, and the `file:` dependency
reproduction at `scratchpad/probe-filedep/`. They are left in place because `rm -rf` is blocked in
this sandbox; delete them at will. The only file added inside the worktree is this document.
