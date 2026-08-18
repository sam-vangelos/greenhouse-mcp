/**
 * Read-only capability catalogue for the recruiter MCP. It advertises the
 * approved scoped analysis recipes, the user modes, and the scope-resolution
 * contract. It never advertises write/admin tools or raw unscoped data paths.
 */

export interface RecruitingCapabilityRecipe {
  id: string;
  recipe: string;
  name: string;
  // Present only for single-executor recipes (availability: "available"): the one analysis tool
  // that runs the recipe. Omitted for model-composed recipes (availability: "limited" or "planned"),
  // which have no single executor — the model composes `required_tools` instead. Pointing a
  // composed recipe at one tool misdirected the model to a different analysis (#19).
  tool?: string;
  read_only: true;
  requires_confirmed_scope: boolean;
  required_tools: string[];
  required_scope: "single_job" | "job_set" | "recruiter_permitted_jobs" | "confirmed_operator_scope";
  required_data_domains: string[];
  verification: string[];
  completeness_requirements: string[];
  safety_notes: string[];
  availability: "available" | "limited" | "planned";
  description: string;
  summary: string;
  example_question: string;
  example_questions: string[];
}

export interface RecruitingCapabilities {
  surface: "greenhouse-recruiter-mcp";
  read_only: true;
  model_visible_tools?: string[];
  scope_resolution: {
    required_before_analysis: boolean;
    flow: string[];
    tools: string[];
    notes: string[];
  };
  user_modes: Array<{
    mode: "recruiter" | "operator_site_admin";
    description: string;
    auto_confirm_allowed: boolean;
    guardrails: string[];
  }>;
  recipes: RecruitingCapabilityRecipe[];
  browsing_tools: Array<{ tool: string; purpose: string }>;
  excluded: string[];
  limitations: string[];
}

const RECIPES: RecruitingCapabilityRecipe[] = [
  {
    id: "scorecard_accountability",
    recipe: "scorecard_accountability",
    name: "Scorecard Accountability",
    tool: "analyze_scorecard_accountability",
    read_only: true,
    requires_confirmed_scope: false,
    required_tools: ["analyze_scorecard_accountability", "search_my_scorecards", "search_my_applications", "get_my_application"],
    required_scope: "recruiter_permitted_jobs",
    required_data_domains: ["scorecards", "applications"],
    verification: [
      "The analyzer uses its internal scoped scorecard reader and validates application/job association before ranking.",
      "Application/job associations are reloaded through the scoped reader before ranking.",
      "Attribute by job_id → recruiter owner: scorecard.interviewer_id is the only populated WHO source (interview.organizer_id is ~0% populated), so never attribute to a per-panel interviewer.",
      "A feedback-pending status (e.g. collect_feedback/awaiting_feedback) is not debt; only a scorecard owed against a past interview counts.",
    ],
    completeness_requirements: [
      "Scorecard pagination must be complete for a complete result; truncated pages mark the analysis incomplete.",
      "Rows without resolvable scoped application/job associations are counted as exclusions.",
    ],
    safety_notes: [
      "Reports scorecard metadata and operational accountability metrics only.",
      "This accountability analysis does not read candidate contact, resume or attachment content, or raw private feedback.",
      "Broad operators must use a confirmed scope_handle or exact job_ids before analysis.",
    ],
    availability: "available",
    description: "Rank scorecard accountability (unsubmitted rate, severity, affected jobs) across scoped jobs.",
    summary: "Ranks unsubmitted scorecard debt and affected jobs using scoped scorecard/application metadata.",
    example_question: "Who is sitting on unsubmitted scorecards across my reqs?",
    example_questions: ["Who is sitting on unsubmitted scorecards across my reqs?"],
  },
  {
    id: "interview_feedback_drag",
    recipe: "interview_feedback_drag",
    name: "Interview Feedback Drag",
    tool: "analyze_interview_feedback_drag",
    read_only: true,
    requires_confirmed_scope: false,
    required_tools: ["analyze_interview_feedback_drag", "search_my_scorecards", "search_my_applications", "get_my_application"],
    required_scope: "recruiter_permitted_jobs",
    required_data_domains: ["scorecards", "applications"],
    verification: [
      "Scorecard timing is read through the analyzer's internal scoped evidence reader.",
      "Application/job associations are revalidated through scoped application reads.",
      "Time-to-submit clocks from the scorecard's own interviewed_at (effectively always populated; no /interviews join needed, and organizer_id is ~0%) to submitted_at; cards without a resolvable clock are excluded, not assumed late.",
    ],
    completeness_requirements: [
      "Scorecard pages must not truncate for a complete result.",
      "Unresolved application/job associations are counted as excluded rows.",
    ],
    safety_notes: [
      "Uses scorecard timing/status metadata, not raw candidate feedback text.",
      "Broad operators must use a confirmed scope_handle or exact job_ids before analysis.",
    ],
    availability: "available",
    description: "Surface late/overdue interview feedback against an SLA across scoped jobs.",
    summary: "Ranks delayed or missing feedback by interviewer/submitter over scoped scorecard metadata.",
    example_question: "Where is interview feedback dragging past two days?",
    example_questions: ["Where is interview feedback dragging past two days?"],
  },
  {
    id: "stage_latency",
    recipe: "stage_latency",
    name: "Stage Latency",
    tool: "analyze_stage_latency",
    read_only: true,
    requires_confirmed_scope: false,
    required_tools: ["analyze_stage_latency", "search_my_applications", "get_my_application"],
    required_scope: "recruiter_permitted_jobs",
    required_data_domains: ["applications"],
    verification: [
      "Application rows are read through scoped application search.",
      "Stage labels and ids are projected operational fields only.",
      "Harvest v3 exposes stage-transition history via /v3/application_stages; conversion and furthest-stage are computed from row existence (count distinct application_id per job_interview_stage_id), so dwell duration is probe-gated and proxied or labeled unavailable where the stage clock is absent, never reported as zero.",
      "Stage ordering ranks job_interview_stages by sort_order and the funnel id-join is application_stages.job_interview_stage_id resolving to job_interview_stages.id; the disjoint-id-space warning applies only to application.stage_id, a different field that does not join to job_interview_stages.id.",
    ],
    completeness_requirements: [
      "Application pagination must be complete for a complete result.",
      "Rows missing stage timestamps are omitted by the analysis and reflected in counts.",
    ],
    safety_notes: [
      "Uses application/stage operational metadata only.",
      "Broad operators must use a confirmed scope_handle or exact job_ids before analysis.",
    ],
    availability: "available",
    description: "Find aging/stuck applications and stage bottlenecks across scoped jobs.",
    summary: "Finds aging applications and stage bottlenecks across scoped job/application rows.",
    example_question: "Which stages are stalling for my Forward Deployed Engineer reqs?",
    example_questions: ["Which stages are stalling for my Forward Deployed Engineer reqs?"],
  },
  {
    id: "pipeline_quality",
    recipe: "pipeline_quality",
    name: "Pipeline Quality",
    tool: "analyze_pipeline_quality",
    read_only: true,
    requires_confirmed_scope: false,
    required_tools: ["analyze_pipeline_quality", "search_my_applications", "get_my_application"],
    required_scope: "recruiter_permitted_jobs",
    required_data_domains: ["applications"],
    verification: [
      "Application status/stage rows are read only through scoped application search.",
      "Job and candidate ids are projected ids used for grouping and evidence references.",
      "Live applications are queried with status=active and the response comes back with status=in_process — the query/response status vocabulary is asymmetric, not an error — so the response is filtered on status===\"in_process\"; last_activity_at is the composite motion proxy that absorbs stage moves, interviews, and offers.",
    ],
    completeness_requirements: [
      "Application pagination must be complete for a complete result.",
      "Missing job/stage/activity fields are surfaced in data quality counts.",
    ],
    safety_notes: [
      "Does not expose candidate contact or raw profiles.",
      "Broad operators must use a confirmed scope_handle or exact job_ids before analysis.",
    ],
    availability: "available",
    description: "Summarize pipeline health, status mix, conversion, and stale active pipeline across scoped jobs.",
    summary: "Summarizes scoped pipeline health, status mix, stale active rows, and job/stage concentration.",
    example_question: "How healthy is the pipeline for these jobs?",
    example_questions: ["How healthy is the pipeline for these jobs?"],
  },
  {
    id: "source_quality",
    recipe: "source_quality",
    name: "Source Quality",
    tool: "analyze_source_quality",
    read_only: true,
    requires_confirmed_scope: false,
    required_tools: ["analyze_source_quality", "search_my_applications", "get_my_application", "search_my_sources", "search_my_referrers"],
    required_scope: "recruiter_permitted_jobs",
    required_data_domains: ["applications"],
    verification: [
      "Source/referrer ids are read only from scoped application rows.",
      "Names are resolved through internal safe-reference reads (null when an id has no match); names are never trusted from an application-row embed. Tracking-link labels are not exposed.",
      "Source and referrer ids are read flat-or-nested (source_id or source.id); a genuinely empty ranking is reported as honest-zero, not a failure or a data gap.",
    ],
    completeness_requirements: [
      "Application pagination must be complete for a complete result.",
      "Rows missing source/referrer/timestamp fields are counted in data quality output.",
    ],
    safety_notes: [
      "Returns source/referrer ids and reference names plus aggregate metrics, not candidate identity or contact data.",
      "Broad operators must use a confirmed scope_handle or exact job_ids before analysis.",
    ],
    availability: "available",
    description: "Rank source/referrer yield quality across scoped jobs.",
    summary: "Ranks scoped application source/referrer ids by outcome quality and stale active drag.",
    example_question: "Which sources are converting for this role?",
    example_questions: ["Which sources are converting for this role?"],
  },
  {
    id: "silent_reqs_projected_limited",
    recipe: "silent_reqs_projected_limited",
    name: "Silent Reqs (Projected Limited)",
    read_only: true,
    requires_confirmed_scope: false,
    required_tools: ["analyze_pipeline_quality", "search_my_jobs", "search_my_applications", "search_my_notes"],
    required_scope: "recruiter_permitted_jobs",
    required_data_domains: ["jobs", "applications", "public_notes"],
    verification: [
      "Jobs, applications, and public note metadata are available through scoped read tools.",
      "Recruiter-owner attribution is not claimed until a projected job-owner domain exists.",
    ],
    completeness_requirements: [
      "Application and note pagination must be complete to call a req truly silent.",
      "Owner attribution is omitted or marked unavailable in this limited recipe.",
    ],
    safety_notes: [
      "Uses public note metadata only; private note bodies are unavailable.",
      "This silent-req recipe does not read candidate contact, resume or attachment content, or raw note bodies.",
    ],
    availability: "planned",
    description: "Find open reqs with little scoped application or public-note activity, without owner attribution.",
    summary: "Projected-limited silent-req triage using scoped jobs, applications, and public note metadata.",
    example_question: "Which open reqs have gone quiet recently?",
    example_questions: ["Which open reqs have gone quiet recently?"],
  },
  {
    id: "scorecard_debt",
    recipe: "scorecard_debt",
    name: "Scorecard Debt Ledger",
    read_only: true,
    requires_confirmed_scope: false,
    required_tools: ["search_my_interviews", "search_my_scorecards", "search_my_job_owners", "search_my_users", "search_my_jobs"],
    required_scope: "recruiter_permitted_jobs",
    required_data_domains: ["interviews", "scorecards", "job_owners", "users", "jobs"],
    verification: [
      "Interviews are bounded by permitted job/application association before projection.",
      "Scorecards are application-backed and public/projectable before they are returned.",
      "Job owners are direct job-scoped rows; users are global-reference projected metadata only.",
    ],
    completeness_requirements: [
      "Interview and scorecard pagination must be complete to call debt complete.",
      "User rows are reference metadata and must not be represented as job-filtered.",
    ],
    safety_notes: [
      "Reports debt counts, stale timing, owner ids/names, and evidence ids; no candidate contact or raw feedback.",
      "Private scorecards and private notes remain unavailable.",
    ],
    availability: "limited",
    description: "Identify interviews that appear to need scorecard follow-up, with scoped owner attribution. NOTE: model-composed from required_tools (no single executor); the planner may route similar phrasings to an adjacent available recipe - for THIS analysis, read the required_tools and compose.",
    summary: "Projected scorecard-debt recipe using scoped interviews, scorecards, job owners, users, and jobs.",
    example_question: "Which interviews happened but still need scorecards?",
    example_questions: ["Which interviews happened but still need scorecards?"],
  },
  {
    id: "stalled_and_strong_projected_limited",
    recipe: "stalled_and_strong_projected_limited",
    name: "Stalled Strong Candidates (Projected Limited)",
    read_only: true,
    requires_confirmed_scope: false,
    required_tools: ["analyze_stage_latency", "search_my_scorecards", "search_my_applications", "search_my_candidates"],
    required_scope: "recruiter_permitted_jobs",
    required_data_domains: ["scorecards", "applications", "candidates_projected"],
    verification: [
      "Scorecard ratings and application stage metadata are scoped through application/job joins.",
      "Candidate reads are projected to ids and scoped application references only.",
    ],
    completeness_requirements: [
      "Scheduled interview data is unavailable until a scoped interview domain is added.",
      "Use the result as a stalled-signal preview, not a definitive no-next-step finding.",
    ],
    safety_notes: [
      "This limited recipe does not read candidate contact, resume or attachment content, or raw profiles.",
      "Scorecard free-text answers are not used by this limited recipe.",
    ],
    availability: "limited",
    description: "Surface strong scored applications with stage latency using projected candidate/application metadata. NOTE: model-composed from required_tools (no single executor); the planner may route similar phrasings to an adjacent available recipe - for THIS analysis, read the required_tools and compose.",
    summary: "Projected-limited stalled-strong analysis using scoped scorecards, applications, and projected candidates.",
    example_question: "Which strong candidates look stuck with no movement?",
    example_questions: ["Which strong candidates look stuck with no movement?"],
  },
  {
    id: "rejection_reason_drift",
    recipe: "rejection_reason_drift",
    name: "Rejection Reason Drift",
    tool: "analyze_rejection_reason_drift",
    read_only: true,
    requires_confirmed_scope: false,
    required_tools: ["search_my_rejection_details", "search_my_rejection_reasons", "search_my_applications", "search_my_jobs", "search_my_job_owners", "search_my_users"],
    required_scope: "recruiter_permitted_jobs",
    required_data_domains: ["rejection_details", "rejection_reasons", "applications", "jobs", "job_owners", "users"],
    verification: [
      "Internal rejection-detail reads are application-backed and filtered through permitted applications.",
      "Rejection reasons and users are internal safe-reference projections, not fake job-scoped rows.",
    ],
    completeness_requirements: [
      "Rejected application and rejection-detail pagination must be complete for a complete drift read.",
      "Rows without structured rejection details are counted as omitted or unknown.",
    ],
    safety_notes: [
      "Reports reason ids/labels and aggregate concentration only; no per-candidate decision review.",
      "Candidate contact, raw profiles, private notes, and write disposition tools remain unavailable.",
    ],
    availability: "available",
    description: "Detect concentration or drift in structured rejection reasons across scoped reqs.",
    summary: "Projected rejection-reason recipe using scoped rejection details and safe reference reasons.",
    example_question: "Which reqs are overusing one rejection reason?",
    example_questions: ["Which reqs are overusing one rejection reason?"],
  },
  {
    id: "slow_vs_doomed_projected_limited",
    recipe: "slow_vs_doomed_projected_limited",
    name: "Slow vs Doomed Triage (Projected Limited)",
    read_only: true,
    requires_confirmed_scope: false,
    required_tools: ["search_my_openings", "search_my_jobs", "search_my_applications", "search_my_job_interview_stages", "search_my_rejection_details", "search_my_rejection_reasons", "search_my_job_owners", "search_my_users"],
    required_scope: "recruiter_permitted_jobs",
    required_data_domains: ["openings", "jobs", "applications", "job_interview_stages", "rejection_details", "rejection_reasons", "job_owners", "users"],
    verification: [
      "Openings, job stages, and job owners are direct job-scoped rows.",
      "Applications and rejection details are bounded through permitted jobs/applications.",
      "Users and rejection reasons are safe global-reference projections.",
    ],
    completeness_requirements: [
      "Openings, applications, stage, and rejection-detail pagination must be complete for a complete verdict.",
      "Offer/compensation signals remain unavailable on the recruiter surface.",
    ],
    safety_notes: [
      "No offer compensation, candidate contact, private notes, or admin/write endpoints are exposed.",
      "Reason classes are diagnostic hints and must include omitted-domain metadata.",
    ],
    availability: "limited",
    description: "Triage long-running reqs using scoped openings, pipeline movement, stages, and rejection taxonomy. NOTE: model-composed from required_tools (no single executor); the planner may route similar phrasings to an adjacent available recipe - for THIS analysis, read the required_tools and compose.",
    summary: "Projected slow-vs-doomed recipe using bounded scoped read domains without offer/private data.",
    example_question: "Which long-running reqs are slow but alive versus dead?",
    example_questions: ["Which long-running reqs are slow but alive versus dead?"],
  },
  {
    id: "stage_skip_integrity_projected_limited",
    recipe: "stage_skip_integrity_projected_limited",
    name: "Stage-Skip Integrity (Projected Limited)",
    read_only: true,
    requires_confirmed_scope: false,
    required_tools: ["search_my_jobs", "search_my_applications", "search_my_job_interview_stages", "search_my_scorecards", "search_my_job_owners", "search_my_users"],
    required_scope: "recruiter_permitted_jobs",
    required_data_domains: ["jobs", "applications", "job_interview_stages", "scorecards", "job_owners", "users"],
    verification: [
      "Jobs, stages, and owner rows are job-scoped before projection.",
      "Applications and scorecards are bounded by permitted job/application association.",
    ],
    completeness_requirements: [
      "Application, stage, and scorecard pagination must be complete for a complete anomaly list.",
      "Stage transition history is available via application_stages, but this limited recipe asserts no per-transition timeline; it flags deep active applications lacking scorecard signal from current-stage and scorecard metadata only.",
    ],
    safety_notes: [
      "Flags deep active applications with no recorded scoped scorecard metadata; does not assert misconduct.",
      "No candidate contact, raw feedback, private notes, or write/admin operations are exposed.",
    ],
    availability: "limited",
    description: "Flag deep active applications with no recorded scorecard signal using scoped stage and scorecard metadata. NOTE: model-composed from required_tools (no single executor); the planner may route similar phrasings to an adjacent available recipe - for THIS analysis, read the required_tools and compose.",
    summary: "Projected stage-skip integrity recipe constrained to current-stage and scorecard metadata.",
    example_question: "Which candidates are deep in process with no scorecard recorded?",
    example_questions: ["Which candidates are deep in process with no scorecard recorded?"],
  },
];

export function getRecruitingCapabilities(modelVisibleTools?: ReadonlySet<string>): RecruitingCapabilities {
  const visible = (name: string) => !modelVisibleTools || modelVisibleTools.has(name);
  const recipes = modelVisibleTools
    ? RECIPES
        .filter((recipe) => recipe.tool !== undefined && modelVisibleTools.has(recipe.tool))
        .map((recipe) => ({ ...recipe, required_tools: recipe.required_tools.filter(visible) }))
    : RECIPES;
  return {
    surface: "greenhouse-recruiter-mcp",
    read_only: true,
    ...(modelVisibleTools ? { model_visible_tools: [...modelVisibleTools].sort() } : {}),
    scope_resolution: {
      required_before_analysis: true,
      flow: ["resolve_job_scope", "confirm_job_scope (when required)", "scope_handle", "analyze_* / answer_my_recruiting_question"],
      tools: ["resolve_job_scope", "confirm_job_scope", "get_job_scope"].filter(visible),
      notes: [
        "Resolve natural-language or requisition references with resolve_job_scope before analysis when job intent is fuzzy.",
        "Analysis tools accept a scope_handle or exact greenhouse job_ids only; they reject free-text job_query/role/alias inputs.",
        "answer_my_recruiting_question resolves scope internally and will return a confirmation-required response instead of silently broad-running.",
      ],
    },
    user_modes: [
      {
        mode: "recruiter",
        description: "Narrow-access recruiter limited to permitted jobs.",
        auto_confirm_allowed: true,
        guardrails: [
          "Auto-confirms only unique, high-confidence, active-job matches over a complete inventory.",
          "Ambiguous role-family or multi-job matches require confirmation.",
        ],
      },
      {
        mode: "operator_site_admin",
        description: "Broad-visibility operator/site admin.",
        auto_confirm_allowed: false,
        guardrails: [
          "Fuzzy, multi-job, broad, or all-org scopes always require confirmation.",
          "Partial/truncated inventory blocks analysis.",
          "Every answer carries a scope header.",
        ],
      },
    ],
    recipes,
    browsing_tools: [
      { tool: "search_my_jobs", purpose: "Browse/debug visible jobs. Not an authoritative analysis precursor." },
      { tool: "get_my_job", purpose: "Inspect one visible job." },
    ].filter((entry) => visible(entry.tool)),
    excluded: [
      "No write/admin tools (no reject, move-stage, offer, assignment, or patch operations).",
      "No raw unscoped Greenhouse read surface.",
      "No candidate contact info, raw profiles, or private note payloads.",
      "Attachment listings are metadata-only and never expose signed download URLs.",
      "Resume content is available only for an explicitly selected, permission-scoped attachment through read_my_resume; it is sensitive untrusted candidate evidence.",
    ],
    limitations: [
      "Resolver matching is deterministic lexical/alias matching over a permission-scoped job index; it does not use embeddings in v1.",
      "Operator inventories can exceed the pagination cap and return inventory_complete=false, which blocks analysis until the scope is narrowed.",
      "Scope handles are signed, session-bound, and short-lived; they are not persisted or shareable.",
    ],
  };
}
