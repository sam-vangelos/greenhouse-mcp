// Read-only recruiting-ops recipe registry advertised by the base MCP.

export type RecipeVerification = "live_verified" | "shape_verified";

/**
 * A pre-designed recruiting-ops analysis the connector advertises so an AI
 * workspace discovers sophisticated things it can do beyond ad-hoc queries.
 * The connector does not execute these; it surfaces the question and the
 * tool choreography, and the model runs it with the read tools. Full specs
 * live in prompts/recipes/.
 *
 * verification is optional only because buyer-authored standing queries
 * (ValidatedCustomRecipe below) share this shape and intentionally carry no
 * verification claim — they surface separately as custom_recipes with
 * source: "buyer_defined". Every entry in GREENHOUSE_RECIPES must set it;
 * the control-plane test enforces that.
 */
export interface RecipeDefinition {
  id: string;
  name: string;
  example_question: string;
  summary: string;
  required_tools: string[];
  verification?: RecipeVerification;
}

/**
 * Recruiting-ops recipes. Each is a sophisticated, named analysis a raw ATS
 * API connector can't offer out of the box. Surfaced in
 * get_control_plane_capabilities so an LLM client (and the buyer) discovers
 * the menu instead of facing a blank prompt.
 */
export const GREENHOUSE_RECIPES: RecipeDefinition[] = [
  {
    id: "scorecard-effort",
    verification: "live_verified",
    name: "Scorecard Effort & Box-Checking Leaderboard",
    example_question:
      "Which of my interviewers are phoning in their scorecards this month — owing them, filing them slowly, or box-checking with empty or copy-pasted feedback?",
    summary:
      "Interviewer leaderboard in three layers: scorecard debt (owed, never filed), time-to-submit (slow, split into overloaded vs disengaged), and effort/box-checking detection (empty scorecards, paste-jobs, fast-and-thin submissions). Reads per-question answer text to score effort; reports signals and scores, never raw candidate feedback.",
    required_tools: [
      "list_interviews",
      "list_scorecards",
      "list_scorecard_question_answers",
      "list_users",
      "list_jobs",
      "list_job_owners",
    ],
  },
  {
    id: "scorecard-debt",
    verification: "live_verified",
    name: "Scorecard Debt Ledger",
    example_question:
      "Which interviews actually happened and never got a scorecard, which reqs and recruiters are accumulating that debt, and how stale is it?",
    summary:
      "Interviews with a resolvable PAST interview time whose application has no completed scorecard — ranked by a volume-plus-staleness composite, attributed to the job and its recruiter owner, with how many active candidates each debt blocks. Filters out never-scheduled placeholder interview slots (a feedback-pending status alone is not debt) and reports honest-zero when the pipeline is clean.",
    required_tools: ["list_interviews", "list_scorecards", "list_jobs", "list_job_owners", "list_users"],
  },
  {
    id: "silent-reqs",
    verification: "live_verified",
    name: "Silent Reqs",
    example_question:
      "Which open reqs has nobody actually worked in the last two weeks — no new candidates, no stage moves, no interviews, no notes?",
    summary:
      "Open jobs with zero forward motion in N days, ranked by silence age and attributed to the recruiter owner. Last-touch is a composite of applications.last_activity_at (which absorbs stage moves, interviews, and offers) plus job notes; the job record itself carries neither activity nor owner, so both are derived. Splits silent reqs into 'candidates stuck' (active applicants stranded — urgent) and 'empty' (sourcing gap), and flags unowned reqs.",
    required_tools: ["list_jobs", "list_applications", "list_job_notes", "list_job_owners", "list_users"],
  },
  {
    id: "stalled-and-strong",
    verification: "live_verified",
    name: "Stalled-and-Strong Candidates",
    example_question:
      "Which strong candidates are stuck with no next step — the good ones nobody's moving?",
    summary:
      "Candidates with a strong scorecard rating (strong_yes/yes) whose application is still in_process, has no future scheduled interview, and has gone quiet — ranked by rating strength, then funnel depth, then staleness. The most directly recoverable losses: they did everything right and the process dropped them. The 'next step' signal is list_interviews status=scheduled (v3 has no scheduled_interviews endpoint).",
    required_tools: ["list_scorecards", "list_applications", "list_interviews", "list_candidates", "list_jobs"],
  },
  {
    id: "ghost-pipeline",
    verification: "live_verified",
    name: "Ghost Pipeline",
    example_question:
      "How many candidates are still active on reqs that have already closed — stranded with no rejection and no next step — which reqs are the worst, how long have they been sitting, and who owns the cleanup?",
    summary:
      "Active applications stranded on already-closed reqs — the ghosts that inflate active-pipeline counts and leave real candidates un-dispositioned. Deterministic job_ids-keyed join: list_jobs status=closed -> list_applications job_ids=<batch> status=active, then filter the RESPONSE on status === 'in_process' (querying in_process 422s — the query/response status vocabulary is asymmetric). Buckets stranded age on last_activity_at (no stage-transition history on v3), attributes each ghost req to its recruiter owner (never per candidate), and reports honest-zero when a tenant is fully dispositioned.",
    required_tools: ["list_jobs", "list_applications", "list_openings", "list_job_owners", "list_users", "get_user"],
  },
  {
    id: "calibration-drift",
    verification: "live_verified",
    name: "Calibration Drift",
    example_question:
      "Are my interviewers grading on the same scale, or do I have an easy grader and a hard grader whose 'yes' and 'no' mean different things — and where two of them scored the same candidate, do they actually agree?",
    summary:
      "Inter-interviewer rating consistency from one bounded scorecard pull: an easy-vs-hard-grader ranking (each interviewer's candidate_rating pass-rate vs the cohort baseline), a discordant-panel list (one application_id with >=2 complete scorecards whose graders split), and a drift watchlist over submitted_at. Attributes by the scorecard's own interviewer_id, never organizer_id. The headline move is stage control: pass-rate is stage-confounded, so the easy/hard verdict is gated on an optional stage join and labeled stage-uncontrolled when absent. Reads only enumerated ratings and metadata — no free-text, no candidate PII.",
    required_tools: ["list_scorecards", "list_users", "list_job_interviews", "list_job_interview_stages"],
  },
  {
    id: "interviewer-bus-factor",
    verification: "live_verified",
    name: "Interviewer Bus-Factor & Single-Point Coverage",
    example_question:
      "Across my open reqs, is interview load piling onto a handful of people, and are there reqs whose entire scored loop rests on a single interviewer — so their PTO stalls the whole req?",
    summary:
      "Interviewer load concentration plus a single-point-of-coverage list of open reqs whose entire scored loop ran through one person. Keyed on scorecard.interviewer_id (the only populated WHO source; the interview record's organizer_id is ~0%), grouped to the job via application.job_id, with a >=2-loop floor so single-loop reqs aren't mislabeled. Per-stage coverage is not claimed (no scorecard->stage join on v3); the configured-vs-realized gap is surfaced at the interview-kit grain via default_interviewers. Reads loop counts and identities only — never ratings or feedback text.",
    required_tools: ["list_scorecards", "list_applications", "list_jobs", "list_users", "list_default_interviewers"],
  },
  {
    id: "interviewer-gaming-detector",
    verification: "live_verified",
    name: "Leaderboard Gaming / Manipulation Detector",
    example_question:
      "Now that people know I'm watching scorecard speed, who's gaming the metric — an interviewer who used to be slow and thorough but is now submitting fast and empty just to look compliant?",
    summary:
      "The Goodhart's-law immune system for the scorecard-leaderboard family: flags interviewers whose own behavior changed in the gaming signature — speeding up while effort drops — within a window. Builds a per-interviewer series from the scorecard's own timestamps (speed = submitted_at - interviewed_at, no /interviews join, sidestepping the organizer_id and placeholder-slot traps), unions both feedback surfaces (notes/public_notes/private_notes plus scorecard_question_answers) into a within-person effort delta, and flags only those whose later half is >40% faster AND >25% emptier. Both arms required; effort is relative-within-interviewer, never an absolute cross-interviewer threshold. Deltas/counts/enums only, never raw feedback.",
    required_tools: ["list_scorecards", "list_scorecard_question_answers", "list_users"],
  },
  {
    id: "rejection-reason-drift",
    verification: "live_verified",
    name: "Reason-Code Concentration & Other-Drift",
    example_question:
      "Of the rejections that carry a structured reason, which reqs have collapsed into a single catch-all code, and is that concentration rising over time?",
    summary:
      "Disposition-taxonomy health keyed on the job: builds the rejection-reason vocabulary from list_rejection_reasons (with the we/they split from the nested type.key), joins rejected applications via list_rejection_details, and computes top-reason share + Herfindahl concentration per req and org-wide. Flags reqs whose disposition vocabulary has functionally collapsed to one catch-all code (top reason >=60%) and trends each outlier's share by month from rejected_at. Reports counts, shares, reason labels, and job names only — never a per-candidate decision review; the owner column is best-effort and req-grain.",
    required_tools: ["list_rejection_reasons", "list_applications", "list_rejection_details", "list_jobs", "list_job_owners", "list_users"],
  },
  {
    id: "slow-vs-doomed",
    verification: "live_verified",
    name: "Slow vs Doomed Discriminator",
    example_question:
      "Of my long-running open reqs, which are progressing slowly but alive versus functionally dead — and for each dead one, why (spec mismatch / comp problem / neglected) so I know whether to re-scope, re-band, or close?",
    summary:
      "Triage over long-open reqs: a SLOW vs DEAD verdict plus the reason class that dictates the action. Distinct from silent-reqs (which finds reqs nobody works) — this judges reqs that ARE worked and asks whether the work goes anywhere. Per cohort job: live in_process depth (stage join by NAME, since application.stage_id and job_interview_stages.id are different id-spaces, ranked by sort_order), freshest last_activity_at, for-cause reject rate (rejection type.key), and a declined-offer signal (offer status === 'Rejected', the real declined value — NOT Deprecated). Reason class routes to re-band (comp), re-scope (spec mismatch), or close (neglected). Attributes to the recruiter owner; honest-zero when every long-open req is alive-but-slow.",
    required_tools: ["list_openings", "list_jobs", "list_applications", "list_job_interview_stages", "list_rejection_details", "list_rejection_reasons", "list_offers", "list_job_owners", "list_users"],
  },
  {
    id: "stage-skip-detection",
    verification: "live_verified",
    name: "Stage-Skip Integrity Flag",
    example_question:
      "Which live candidates are sitting deep in the funnel — at or past an interview gate — with no completed scorecard recorded anywhere on the application, so they either skipped a scored gate or the loop never got written up?",
    summary:
      "Point-in-time integrity flag: live in_process applications sitting deep in their job's stage ladder while carrying ZERO completed scorecards — a process-shortcut-or-data-gap anomaly, attributed to the recruiter owner. Reframed off the catalog's unsourceable 'reconstruct stage history / moved-backward' idea (v3 exposes no transition history; list_application_stages is degenerate) to key on DEPTH + total scorecard absence. Depth joins by stage NAME ranked by sort_order (application.stage_id and job_interview_stages.id are disjoint id-spaces; an id-join resolves 0 rows), pages the AGED in_process tail (the freshest page is honest-zero for scorecards by construction), and bounds the scorecard check via application_ids batches (never a date-windowed /scorecards sweep). The sophistication move is restraint: the API carries no scored-gate marker, so it reports 'advanced deep, no recorded scored loop' and leaves skip-vs-data-gap to investigation rather than over-claiming a skipped gate. Honest-near-zero is the expected result.",
    required_tools: ["list_jobs", "list_applications", "list_job_interview_stages", "list_scorecards", "list_job_owners", "get_user"],
  },
];

export const RECIPES_NOTE =
  "Pre-designed recruiting-ops analyses; the model executes each with the listed read tools — the connector never runs them itself. verification levels: live_verified = ran end-to-end against a real production tenant; shape_verified = endpoints, fields, and behaviors confirmed on a seeded trial tenant (real-tenant field-population rates unproven).";
