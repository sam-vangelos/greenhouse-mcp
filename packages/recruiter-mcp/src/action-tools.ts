/**
 * What a per-session grant is allowed to name.
 *
 * A grant exists for ONE purpose: to admit the write plane's `preview_…`/`apply_…` tools for a
 * recruiter who holds an entitlement. It is not a general reopen-the-allowlist mechanism, and the
 * 22 withheld source readers are not grantable through it. `RecruiterToolConfig.grantedTools` is
 * typed against `ActionToolName` so that property is a compile error to violate, and every gate
 * that consults a grant re-tests the name at runtime (`limits.ts`), so a cast, a JS caller, or a
 * grant rehydrated from JSON cannot smuggle a read name past the type.
 *
 * ## Why a SHAPE and not a list
 *
 * The 22 names live in `ACTION_DEFINITIONS` on `codex/greenhouse-action-mcp`
 * (`action-mcp/src/actions/index.ts:15`), which Phase 1 must not import — the package is not on
 * this branch, and `docs/job-scope-resolution/phase-1e-action-package-spec.md` §4.4 gives Phase 2
 * the one sanctioned specifier for it. That leaves two ways to constrain grants here, and only one
 * of them survives contact with time:
 *
 *   - Copy the 22 names. A hand-maintained duplicate of another branch's catalog, with nothing
 *     anywhere to notice when the two disagree. This is exactly the drift the `ActionClientName`
 *     comment (auth.ts) refuses for a THREE-member union; a 22-member one is worse.
 *   - Pin the naming rule the action package already follows and enforces on its own side. Read
 *     from source: all 11 definitions name their pair `preview_${kind}` / `apply_${kind}` over the
 *     11 `ActionKind`s (`application_stage_move` -> `preview_application_stage_move`, and so on),
 *     and `action-mcp/scripts/verify-package.mjs:43-44` fails that package's build unless exactly
 *     11 `preview_` and 11 `apply_` tools are found under `src/actions/`.
 *
 * The shape is chosen. It is as strong as the list for the property that matters here — no read
 * tool in this package's catalog has that shape, locked by a test in `test/limits.test.ts` — and it
 * costs nothing to keep true.
 *
 * ## How Phase 2 binds the exact 22
 *
 * The shape is the OUTER bound; Phase 2 narrows it to the real catalog without respelling anything:
 *
 * ```ts
 * import { ACTION_DEFINITIONS } from "../../action-mcp/dist/index.js";
 * const grant = createActionToolGrant(
 *   ACTION_DEFINITIONS.flatMap((definition) => [definition.previewTool, definition.applyTool])
 * );
 * ```
 *
 * The action package stays the single source of the names, `createActionToolGrant` throws if it
 * ever emits one outside the shape, and no scoped source file spells an action tool name — the
 * property phase-1e §4.4 already relies on to keep the write-helper denylist from tripping.
 */
export type ActionToolName = `preview_${string}` | `apply_${string}`;

// snake_case after the verb, same as every ActionKind. `preview_`/`apply_` with nothing after it,
// or with capitals/dots/hyphens, is not a name the action package can produce.
const ACTION_TOOL_NAME_PATTERN = /^(?:preview|apply)_[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

/** True only for a name the write plane could have produced. Read names never match. */
export function isActionToolName(name: string): name is ActionToolName {
  return ACTION_TOOL_NAME_PATTERN.test(name);
}

/**
 * Build a grant set from names, refusing anything that is not an action tool. This is the only
 * sanctioned constructor: it turns "the caller passed the wrong list" into a loud throw at grant
 * assembly instead of a silently over-broad catalog at registration.
 */
export function createActionToolGrant(names: Iterable<string>): ReadonlySet<ActionToolName> {
  const grant = new Set<ActionToolName>();
  for (const name of names) {
    if (!isActionToolName(name)) {
      throw new Error(
        `Recruiter MCP tool grants admit write-plane action tools only; refusing to grant ${JSON.stringify(name)}.`
      );
    }
    grant.add(name);
  }
  return grant;
}
