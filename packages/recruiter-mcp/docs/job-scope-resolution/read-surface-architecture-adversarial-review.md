# Adversarial Review — Read-Surface Architecture Analysis

*Reviewer: Claude (Opus 4.8), adversarial principal-engineer posture, with Sam Vangelos · 2026-06-27*

> **Current catalog note (2026-07-25).** The model-facing recruiter catalog is now the exact 44-tool allowlist in [`../../README.md`](../../README.md); the three reference dictionaries (`search_my_departments`, `search_my_offices`, `search_my_close_reasons`) were added after this review was written. Every "41-tool catalog" below is the count as reviewed on 2026-06-27, not a current release claim. The verdicts are unaffected: claim 2 turns on 44 still sitting inside the 30–50 band Anthropic measured and on the catalog being single-domain and low-confusability, which three id→name dictionaries do not change.

This is the refutation pass on `read-surface-architecture-analysis.md` and the Perplexity brief it
synthesizes (`~/Downloads/Greenhouse_LLM_Architecture.md`). The job was to break the thesis, not to
polish it: attack the seven claims that carry the argument, default to skepticism, and award "Survives"
to nothing I could not independently support. Every claim went through an attack pass and a separate
verification pass that re-checked the attacker's citations against source and the public Greenhouse
contract; where the attacker overreached, the verifier corrected it, and two "Refuted" verdicts were
pulled back to "Unprovable-as-stated" for exactly that reason. Process honesty: the claim-3 attacker
agent failed and returned a placeholder, so claim 3's verdict rests entirely on the verifier's
independent re-derivation against source — which is high-confidence and quoted below.

The headline: the architecture is a legitimate long-horizon bet, but the document oversells it on almost
every empirical leg, and the one fact it presents as its firmest ground truth — the "verified v3
connector" it wants to seed the registry from — is the weakest joint in the whole structure.

## Verdict scorecard

| # | The proposition under attack | Verdict | One line |
|---|---|---|---|
| 1 | The doc: compile-then-execute is **optimal** here | **Unprovable-as-stated** | Not shown optimal; decisively not optimal for the near-term need. The only durable pro-rebuild value is real but doesn't need a DSL. |
| 2 | The doc: the tool-count benchmarks **force ≤8 tools** | **Refuted** (skeptic's reading survives) | The ≤8 evidence is cited out of context; a curated ~30-tool single-domain surface sits at or under the real threshold. |
| 3 | The doc: planner→compiler, scope→multi-hop RLS, recipes→Prompts is **reuse, not rewrite** | **Unprovable-as-stated** (leans rewrite) | Reuse is real but small (~15 LOC leaf predicate + the envelope); the §5 table over-credits the planner and scope-filter rows into machinery that doesn't exist. |
| 4 | The doc: its **status-enum correction** (query `active` / respond `in_process`; brief is inverted; `in_process` query is a 422) | **Refuted** as stated | The response-leg safe default is fine, but the 422 hook is unexercisable in code and contradicted by the public docs (invalid status → empty 200), and "the brief is inverted" self-refutes — the connector ships the brief's exact enum as its query vocabulary. |
| 5 | The doc: seed the registry from the **verified-v3 reference connector** ("a working connector beats any doc") | **Unprovable-as-stated** | "Verified v3" is false on the connector's face (v1/v3 hybrid, write-capable, self-contradicting, single "Initial import" commit). The defensible reading — seed read *shapes* + mandatory live probe — survives, but it inverts the doc's emphasis: the probe is the foundation, not the connector. |
| 6 | The skeptic: it's **worse than "multi-month"**, and determinism is unachievable over this data | **Survives** | The doc undersells it. The grain-safe compiler, join-cost planner, and scope-at-every-hop don't exist in source; determinism over ~0%-populated fields is deterministically-shaped garbage; interactive aggregation is arithmetically infeasible under the rate ceiling. (The literal "6+ months" number is itself unprovable; "worse than a confident multi-month" holds.) |
| 7 | The skeptic: **breadth now** beats the deferred compiler | **Survives** | Incremental read-porting is the *demonstrated* safe cadence on this branch; the rewrite's unique value is small, late, and gated behind the highest-risk phase. |

Net: of the five propositions the document advances (1–5), none survives intact — one is refuted, two
are unprovable-as-stated, one (the ≤8 justification) is refuted, and the keystone is unprovable as
worded. Of the two harsher counter-theses (6–7), both survive. The document is right about the *shape*
of a mature semantic layer and wrong about whether this team, this domain, and this data are at the
point where building one pays.

## What I verified first-hand (not relayed)

Three of the load-bearing facts I read myself before trusting any subagent:

- The status filter belt-and-suspenders both values. `pipeline-quality.ts:428`, `source-quality.ts:438`,
  and `stage-latency.ts:389` all define liveness as `status === "active" || status === "in_process"`.
  The team's own code does *not* trust a single response value — which already undercuts the doc's
  confident "live v3 responds with `in_process`."
- The reference connector is v3-*default*, not v3-*only*. `client.ts:7-8` sets
  `DEFAULT_BASE_PATH = "/v3"`, but `client.ts:104-109` passes any `/v{n}/`-prefixed path through
  unchanged. It is a v3 client with a v1 escape hatch, and the only stage-history source (the activity
  feed) is a `/v1/` path.
- The "planner" is a recipe selector. `question-answer.ts:41-87`: `selectRecipes()` filters a fixed
  five-entry `RECIPES[]` list and loops `recipe.run()`. The comment at line 86 says the rest of the
  catalog is "model-composed from scoped reads, not planner-run." It is not an intent-to-plan compiler,
  so the planner→compiler "migration" has almost nothing to migrate.

## Claim-by-claim

### 1. Architecture fit — Unprovable-as-stated

The doc calls the convergence argument "the strongest single argument" (line 35) and rests it on
Snowflake (51%→90%+) and Databricks (32%→>90%). Those lifts do not transfer. The 39–40-point gains come
from schema-breadth disambiguation over wide, arbitrary warehouse schemas where the model hallucinates
joins across hundreds of unknown tables — the failure mode that barely exists in a fixed ~22-entity
recruiting domain whose join graph a human can enumerate once. The isolated compile-then-execute step,
the one piece that actually transfers, buys about 4.5 points on Spider (SQLStructEval, Direct 0.742 →
Compile 0.785), and its own thesis is structural *consistency*, not accuracy. The Databricks "32%"
baseline is a different system (a coding agent), not an earlier Genie. Strip the mis-applied numbers and
the convergence pillar adjudicates to a single-digit transferable gain, not the 40 points that would
justify a multi-month rebuild.

Where the attacker overreached, and the verifier corrected: "Refuted" requires showing the cheaper path
is actually superior, and the digest instead shows the *supports* for "optimal" are weak while the
alternative is "not excluded." That is a burden-of-proof argument, not contradicting evidence — so the
verdict is Unprovable-as-stated, not Refuted. One genuine pro-rebuild lever does survive, and it's the
one to take seriously: the five analysis tools each hand-roll ratio/mean/percentile with bespoke
hardcoded weights, and a central grain-safe aggregator genuinely de-risks the wrong-grain double-count
class in a way thirty bespoke aggregate tools do not. That value is real. It is also, as the alternative
below argues, a function-library problem, not a grammar problem.

Break-even: a compile-then-execute layer earns its cost when the domain is wide enough that
join-selection is the dominant error, *and* multi-hop grain bugs are frequent and costly, *and* the data
is populated enough that determinism of form yields correctness of answer. This team is past break-even
on none of the three.

### 2. Benchmark transfer — the doc's ≤8 justification is Refuted

The skeptic's reading survives on independent, converging support. Every degradation curve that bites at
low tool counts is built on adversarial, confusability-ranked near-clone distractors, not a clean
single-domain surface. The steepest "monotonic decline" study (Linköping diva2:2072520) tests small/fast
tiers — gpt-5-nano, gemini-flash-lite, gpt-oss — with no Claude or frontier model, and builds its
distractors by ranking the top N-1 tools by a name/description/parameter confusability score from a
4,099-tool catalog. LiveMCPBench's "retrieval errors ≈ half of failures" is a RAG-router artifact over
527 tools where the agent sees ~2.71 tools per task — there is no router in a 30-tool surface. BFCL's
5–10-point drop is multi-turn state loss, explicitly "not the size of the tool set." MCP-Bench shows
frontier models holding >98% schema compliance with 100+ distractors attached. The dispositive fact: with
*random* distractors frontier selection holds 93.5–95.5%, and only with *hard* semantically-overlapping
negatives does it collapse (94.5% at one candidate → 69.75% at five). The driver is confusability and
multi-turn state, not raw count.

Anthropic's own vendor threshold — the most directly applicable number for frontier Claude — is "30–50
tools loaded at once," measured on a 58-tool, five-server *cross-domain* setup whose dominant failure is
"tools have similar names." The connector's exact 41-tool *single-domain* model catalog sits inside that
band and is materially less confusable than the cross-domain configuration it was measured on. The ordered
`PILOT_TOOL_NAMES` catalog makes that curated surface actual rather than hypothetical. The doc's own ≤8
target leans on the identical mis-applied evidence (lines 95–97), and the ≤8 floor itself is folk synthesis
("industry consensus through painful experience"), not a published result. The evidence neither forces ≤8
nor forbids the exact 41-tool catalog.

### 3. Reuse, not rewrite — Unprovable-as-stated, leaning rewrite

`scoped-greenhouse` is a single file. All filtering is flat single-row set-membership:
`filterDirectJobScopedRow` (index.ts:570-575), `applicationIsPermitted` (716-730), `extractJobIds`
(979-1005). The only "join" anywhere is one hardcoded application→job backfill
(`filterApplicationBackedRow`, 584-605 → `loadApplication`, 732-750). A grep across `src` for
`authorized_application`, `reapply`, `DataLoader`, `plan_query`, `executionDAG`, `symmetric-aggregate`,
`join-cost` returns nothing. The planner is the five-entry regex selector. So the §5 table over-credits
two rows: "the scope filters → Per-entity RLS predicate / in the compiler from the first plan" maps a
~15-line leaf predicate onto a scope-across-joins engine that does not exist, and "the planner → the
compiler" maps a recipe selector onto a validator + grain-safe aggregator + join-cost planner + REST
DataLoader, none of which exist.

Why Unprovable rather than Refuted: the doc never asserts "reuse not rewrite" as a quantified guarantee.
§6 (161–174) already concedes the grain-safe compiler, the join-cost planner, and fail-closed
scope-re-application-per-hop are "the hard, multi-month work," and open questions 3 and 4 (195–197) pose
exactly "is scope-already-built optimistic?" and "is planner→compiler a real reuse or a near-rewrite
mislabeled as reuse?" The document already holds the skeptical position, so a binary reuse-vs-rewrite
cannot be cleanly refuted — it hinges on the structure of a compiler that doesn't exist to inspect. The
honest reading: reuse is real but small and concentrated outside the two relabeled rows (the leaf
predicate, the PII projection, the completeness envelope, the caps — all in separate modules), and the
§5 mapping inflates it.

### 4. The status-enum correction — Refuted as stated

This is the one place the doc claims a verified Greenhouse fact, and the verified fact doesn't hold up.
The response-leg behavior the doc describes is code-accurate — `capabilities.ts:152` is quoted verbatim,
and the filters do treat `{active, in_process}` as live. But the hook the doc hangs its argument on —
"sending `status=in_process` is a 422" — is unexercisable: the only application-status query enum in the
connector, `index.ts:573-576`, is `z.enum(["active","rejected","hired","converted"])`, so Zod rejects
`in_process` before any HTTP call. There is no captured 422 body, no probe artifact, no HAR. The
"reference Harvest map corroborates" citation is circular — it resolves to the doc itself (line 113) and
a self-authored test *name* (`projection-candidates.test.ts:330`); no standalone harvest-map file exists.

The external ground truth contradicts the 422 claim outright. The canonical Greenhouse source
(`grnhse/greenhouse-api-docs`, `_applications.md`) documents a single enum
`{active, rejected, hired, converted}` for *both* legs, returns `"status": "active"` in its example JSON,
and states the explicit exception that an *invalid* status filter returns an empty 200, not a 422. The
token `in_process` appears in zero official docs (v1 source, v3 reference, v3 list-endpoints, the March
2026 release notes — all negative). And the "brief is inverted" framing self-refutes: the doc brands the
brief's `{active, rejected, hired, converted}` enum "confidently, specifically wrong," yet `index.ts:574`
ships precisely that enum as the connector's legitimate query vocabulary.

The fair reading, which the verifier insisted on: the doc self-labels this "tenant-verified ground truth
on the response leg," not a platform contract — so filtering on the two-element set is the correct safe
*operational* default for the pilot tenant. What's refuted is the load-bearing packaging: the 422 hook
(unexercisable in code, contradicted by the public spec's empty-200 behavior) and the claim that the
brief is the one that's wrong. The doc is right about its own code's filter shape and wrong about the API
contract it claims to encode — and "the brief's API facts are a hypothesis" cuts both ways.

### 5. The registry keystone — Unprovable-as-stated

The keystone (§4, line 133): seed the registry from `ats-ops-control-plane` because "a working v3
connector is a far better source than any doc." As worded, that's a category error, on three
independently verified grounds. First, "verified v3" is false on the connector's face — `client.ts:7-8`
sets the v3 base path, but `client.ts:104-109` is a designed-in bypass that concatenates ten `/v1/` call
sites raw onto the origin (application reject/patch, the OBO read, every hiring_team read *and* write at
index.ts:237/684/734/743/831/928/1028/1125/1225/1526). Greenhouse removes Harvest v1/v2 on 2026-08-31, so
seeding from this code silently pins endpoints to an API version that disappears in two months. Second,
the connector contradicts its own repo's v3 reference doc, which is titled "Harvest API v3 — Master
Reference," never mentions `hiring_team` or `/v1`, and lists those same operations under `/v3` — code and
contract were never reconciled. Third, the threat model is wrong for what would inherit it: it's
write-capable by default (`write-ops.ts:56` enables writes unless explicitly disabled), env-token-gated
rather than per-recruiter-scoped (`admin-control-plane.ts:87-127`), and injects an On-Behalf-Of header on
writes — the opposite of a per-recruiter scoped-read posture. And it demonstrably can import errors with
the same false confidence the doc fears from a research model:
`projection-scorecards.ts:53-59` coalesces `candidate_rating ?? overall_recommendation ?? overall_rating`
because the author wasn't certain which API version is live, over a single "Initial import" commit
(5ddb7d7) with zero verification history and a "Verified live 2026-06-10" comment that cannot be checked.

Why Unprovable rather than Refuted: the doc's *operative* keystone is "seed the read projections and
filters, paired with a mandatory live tenant probe and a drift-watch" (124–126, 178). The read
projections (`projection-applications/scorecards/offers`) contain zero `/v1` — the contamination and all
write capability live in modules a read-only seed never touches. So pillars (1) and (3) attack code
outside the seed's stated scope; they prove the connector isn't a clean v3 connector overall, not that
the read-shape seed imports those specific errors. The word "verified" equivocates: the connector
verifies field *shapes* by observation, not the v3-ness or correctness the word implies — and the *probe*,
not the connector, does the real verifying. So the strong wording ("verified connector beats any doc") is
unsupported, the narrow reading ("seed shapes as a hypothesis, prove every fact on the wire") survives,
and the right verdict is Unprovable-as-stated. The §3 lesson the doc draws — registry facts need
empirical grounding, not a research-model guess — is correct, but it argues for the live probe, which the
doc treats as a supplement, not for the connector, which the doc treats as the foundation.

### 6. Cost and risk — Survives (the doc undersells it)

Both limbs hold. The build is worse than a confident multi-month estimate because its highest-risk phase
hangs on three components that do not exist in source — the grain-safe symmetric-aggregate compiler, the
join-cost planner, and fail-closed scope-re-application at every join hop — which the doc itself names as
"the hard, multi-month work" (161–163) and "where a bug is a cross-scope data leak, not a wrong number,"
and then lists "where does it become a 6-month build?" as an unresolved open question (199). And the
determinism the layer promises is unachievable over this data: organizer_id ~0%, current_stage_at ~0%,
overall_recommendation ~0%, `application_stages` degenerate (422 on application_id, null timings — never
citable), no stage-transition history on v3 at all (phase-2-execution-brief.md:69-75, mirrored at
capabilities.ts:122). A deterministic compiler over sparse, degenerate source data produces
deterministically-shaped garbage for exactly the funnel and time-in-stage questions it's being built to
win.

The infeasibility is arithmetic. Harvest does zero server-side aggregation, so per-application analysis
is O(applications) reads. At v1's confirmed 5 req/s a 5,000-application scorecard fan-out is ~17 minutes;
at v3's ~2.5 req/s it's ~33 minutes — against a 90-second interactive budget that buys under 10% of the
pipeline. The system already concedes this by failing closed
(`inventory.ts:146` `complete = !truncated && unnormalizableRows === 0`; `capabilities.ts:416`
"inventory_complete=false … blocks analysis until the scope is narrowed") rather than returning a broad
aggregate. The only fix — pre-aggregation and materialized stage history — is deferred to Phase 4+, out
of the near-term scope. The one honest caveat the verifier flagged: the literal "6+ months" figure has no
measured velocity behind it and is itself Unprovable-as-stated, but "worse than a confident multi-month,
staked on machinery that doesn't exist, promising a determinism the data can't support" is fully
grounded.

### 7. Opportunity cost — Survives (breadth now wins)

Value deferral is real and large: the compiler returns zero incremental recruiter value until Phase 1's
spine clears a 30-question gate, and every Phase 0/1 month is spent rebuilding a surface the recruiter
already has. The incremental path isn't hypothetical — it's the demonstrated, shipping cadence on this
exact branch. The phase-2 execution brief is a worked instance of "port the missing reads as tools": a
fixed nine-site lockstep that added `list_offers` in one autonomous turn, with
`list_openings`/`list_rejection_details`/`list_users` cited as prior worked templates, under the team's
own red→green, per-task-commit discipline. That is the precise plan the doc claims to "formally retire."
The anti-incrementalism stance is borrowed authority, not derived analysis: the doc cites "Sam's 'be
ambitious, avoid incrementalism' sanctions the rebuild" (173), and its actual technical justification for
retiring incremental read-porting is the ≤8-tool argument — which claim 2 shows doesn't bind here.

The strongest counterexample to this claim — a genuinely novel join-spanning aggregate recruiters ask
weekly that no recipe covers — is the doc's own example, `scorecard → application → status where
overall_recommendation=strong_yes and status=rejected` (line 65). It fails as a counterexample on two
counts: overall_recommendation is "v1 and 0% populated" on the tenant, so the query returns deterministic
emptiness regardless of architecture, and the join-spanning rate cost (~33 minutes at v3) makes it
non-interactive even when built. The unique value the rewrite buys over a widened tool surface is small,
late, and gated behind the highest-risk phase — which strengthens the case for shipping breadth now and
earning the rewrite only if the simple surface demonstrably fails.

## The single most likely way the thesis is wrong

The one assumption whose failure collapses the most is the §5 keystone: that the registry can be safely
seeded from the reference connector because "a working v3 connector is a far better source than any doc."
It carries the most weight because the doc deliberately routes the project's entire ground-truth strategy
through it — it denies the research brief any authority and grants the connector all of it, so every
downstream API fact the build depends on (status vocabulary, id-spaces, endpoint shapes, the `in_process`
asymmetry, what reads exist) inherits its trust from this single source. If "verified v3" is false, the
cascade hits claims 4, 5, 6, and 7 at once: the status-enum correction loses its only corroboration and
reduces to an unprobed tenant artifact; the keystone fails; the build estimate inherits a connector that
hard-codes `/v1` paths Greenhouse removes on 2026-08-31, adding migration cost the multi-month figure
never priced; and the breadth-now argument strengthens because the supposedly-safe seed turns out to need
a live probe to be trustworthy anyway. I'm confident this is the weak joint rather than the tool-count or
the 51→90 assumptions because those are merely *mis-applied* — wrong but inert, they only fail to *prove*
"optimal." This one is *affirmatively false* on three grounds that all sit inside the repo: the
v1/v3-hybrid URL bypass, the connector contradicting its own v3 reference doc, and the version-uncertainty
baked into a read projection over a single "Initial import" commit. The word "verified" is doing all the
work and is unearned — and this is the same team whose green suites have hidden shipped shape bugs and
slipped safety mutations. The correction is small and it inverts the doc's logic: the registry's ground
truth must come from the live tenant probe the doc treats as a supplement, not from the connector it
treats as the foundation.

## The strongest alternative the author dismissed

The most revealing move in the document is at line 35, where Cloudflare Code Mode is paraded as
convergent evidence ("2,500→2 tools") and then quietly discarded in favor of a bespoke typed-plan DSL —
the `plan_query`/`explain_plan` grammar, the validator, the compiler, the executor, the aggregator that
§6 itself calls "the hard, multi-month work." Code Mode isn't a tool-count anecdote; it's the architecture
the cited source actually recommends, and the doc cites its conclusion while inverting its method. The
alternative the author dismissed is Code Mode proper: expose the existing scoped reads to the model as a
small typed API inside a sandboxed code-execution loop, let it write TypeScript that calls those reads,
joins, and aggregates in code, and run that code behind the scope and PII boundary that already exists —
rather than inventing a DSL and a compiler to interpret it.

It dominates on the exact axes the doc's own evidence collapses to. The grain-safety value is real, but a
DSL is the wrong instrument: symmetric-aggregate correctness is a function-library problem, not a grammar
problem. A single audited `measures.ts` of grain-keyed aggregation helpers, callable from sandboxed code,
gives the model exactly one correct way to roll up a one-to-many join and refuses the forward fan-out —
with none of the cost of building a plan grammar, a join-cost planner, and a compiler to interpret a
language the model must first learn to emit. The novel join-spanning capability that is the sole thing the
DSL buys over a wider tool surface falls out of Code Mode for free: code is Turing-complete over the read
primitives, so there's no fixed set of three plan shapes to outgrow. And the leak-risk class doesn't
change shape — scope is re-applied at the read primitive (the existing per-row predicate, the ~15 lines
that genuinely survive), so the sandbox inherits the same fail-closed boundary whether the model writes
code or emits a plan; the join hops become author-side helper calls, not a new authorization surface to
invent and pen-test.

Code Mode wins under exactly this codebase's conditions: a fixed ~22-entity domain whose join graph is
enumerable once (so the schema-breadth disambiguation that earned Snowflake and Databricks their 40 points
is absent, and a typed sandbox API delivers the ~4.5-point structural gain at compile time anyway);
frontier Claude as the model (which the tool-count evidence shows tolerates ~30 tools and is far better at
writing code than at emitting a novel grammar — Cloudflare's own measured finding); and data so sparse and
rate-limited that the broad deterministic aggregates the compiler is built to win are infeasible
interactively regardless, which means the compiler's marginal value lands late while Code Mode ships the
granular and single-job-aggregate value now. It loses only where the domain is wide and ambiguous enough
that compile-time plan rejection over an enormous unknown schema is the dominant error mode (the warehouse
regime), or where untrusted multi-tenant code runs without a sandbox — neither of which holds here.
Against the doc's own widened option (a), Code Mode is strictly better because it captures the grain-safety
and novel-question value option (a) can't, at lower long-run cost than the DSL; against buy-vs-build
(Cube/dbt-MCP over a warehouse sync), it wins on time-to-value and on not introducing an ETL/freshness
surface for a pilot, while leaving the warehouse path open as the genuine Phase 4+ materialization answer.
The author found the right reference, quoted its result, and then built the thing it was arguing against.

## The cheapest experiment that settles it

Build the 30-question regression suite the doc already mandates as its Phase-1 gate — but build it *now*,
before the compiler, and run it as a two-arm bake-off plus a one-shot feasibility probe, all of which fit
in a week. Arm A is the cheap path: the existing surface (the ~19 evidence read tools plus the five
executable analysis recipes) widened by porting three-to-five more reads through the nine-site lockstep
the phase-2 brief already proved works in one autonomous turn. Arm B is a throwaway plan-grammar prototype
wired to exactly three entities (application → scorecard → job, the one real forward-rollup the compiler is
supposed to uniquely unlock) — no DataLoader, no join-cost planner, no symmetric-aggregate engine, just
enough to answer the join-spanning subset by hand. Score both on the same 30 questions, graded for
correct-*and-honest* answers (an explicit "unavailable on v3" counts as correct where the data is
genuinely degenerate; an invented number counts as wrong), stratified into granular, aggregate-over-one-job,
and join-spanning.

Decision rule: if Arm A lands within 10 points of Arm B on the full 30 *and* ties it on the granular and
single-job-aggregate strata, the compiler isn't earning its cost — ship breadth now and re-open the rewrite
only if a later, larger suite shows the cheap path stalling specifically on join-spanning questions. The
compiler is justified only if Arm B beats Arm A by more than 10 points *and* that entire margin lives in
the join-spanning stratum. Run the feasibility probe in parallel as a hard gate on either arm: fire one
realistic funnel query (a scorecard fan-out across a single mid-sized req's applications) against the live
pilot-tenant credential and capture two numbers — the actual `X-RateLimit-Limit` header on this
credential's tier (the doc's "75/30s" is illustrative, unverified for custom integrations) and the
wall-clock to complete the fan-out. If one req's funnel can't finish inside 90 seconds, interactive
aggregation is dead for the marquee questions regardless of architecture, which kills the compiler's
headline value outright. The same probe must re-confirm the three population facts the entire value case
rests on — whether `application_stages` is still degenerate and whether `current_stage_at` and
`organizer_id` are still ~0% on the pilot tenant. If those fields are dead, the funnel/time-in-stage
questions are deterministically unanswerable by either arm, and the compiler's correctness advantage
evaporates before a line of it is written. In one sentence: fund the compiler only if Arm B's win over the
widened tool surface exceeds 10 points *and* is concentrated in join-spanning questions *and* the live
probe shows a single funnel completing under 90 seconds with the relevant fields populated — fail any one
of the three and the rebuild is over-engineered for this team at this scale.

## Bottom line

Adopt the document's *vocabulary* and reject its *sequencing*. The semantic-layer concepts — named
measures with declared grain, a completeness envelope, scope as a property of the data rather than the
tool — are the right mental model and the team should keep them. But the document has not earned the
multi-month rebuild it asks for: its convergence argument doesn't transfer, its ≤8 forcing function
doesn't bind, its "reuse" is mostly rewrite, its firmest "verified" fact is its weakest joint, and the
determinism it sells is unachievable over this tenant's data at interactive latency. The defensible next
move is the week-long bake-off above. If it clears the three gates, fund the compiler with eyes open. If
it doesn't — and the data-population and rate-limit findings predict it won't — ship breadth now through
the lockstep that already works, deliver the grain-safety value as an audited `measures.ts` behind a Code
Mode loop over the connector that already exists, and earn the rewrite only when the simple surface
demonstrably fails. The honest "unavailable" the team already returns beats an invented funnel number, and
it beats a multi-month compiler that returns the same "unavailable" over the same dead fields.
