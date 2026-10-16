/**
 * Analysis-intent vocabulary: words that describe WHAT a recruiter wants to know
 * (the analysis) rather than WHICH job. The resolver uses this to recognize a
 * role-less analysis question — e.g. "which of my reqs are stalling" — that names
 * no job and therefore has no scope signal, so it can offer the caller's permitted
 * scope for confirmation instead of dead-ending at no_match.
 *
 * Kept aligned with the planner's recipe keyword families (the `keywords` regexes
 * in tools/question-answer.ts recipes + detectMissingDomain's recognized-domain
 * vocab). This is the resolver-side lexicon of the same intent; the planner keeps
 * its own per-recipe routing regexes.
 *
 * SAFETY: this can only ever promote to a broad, confirmation-gated scope when the
 * query has NO scope signal at all (no material token matches any accessible job's
 * searchable text — see scopeSignalTokens in resolver.ts). A word that is also a
 * real title token can never trigger it, and a broad set never auto-confirms, so a
 * genuine unknown-role miss ("blockchain wizard") still returns no_match.
 */
export const ANALYSIS_INTENT_TERMS: ReadonlySet<string> = new Set<string>([
  // scorecard / accountability (question-answer.ts scorecard_accountability keywords)
  "scorecard", "scorecards", "unsubmitted", "submitted", "submitter", "submitters",
  "accountability", "accountable", "offender", "offenders", "overdue", "debt",
  // interview feedback (interview_feedback_drag)
  "feedback", "interview", "interviews", "interviewer", "interviewers", "late", "delay", "delayed", "sla",
  // stage latency (stage_latency)
  "stage", "stages", "stuck", "aging", "aged", "latency", "bottleneck", "bottlenecks",
  "dwell", "slow", "slowness", "slower", "stall", "stalls", "stalling", "stalled", "stale",
  // pipeline quality (pipeline_quality)
  "pipeline", "pipelines", "quality", "health", "healthy", "conversion", "convert",
  "converting", "converted", "hired", "hire", "reject", "rejected", "rejecting",
  "rejection", "rejections", "fallout", "terminal", "weekly", "volume", "movement",
  "moving", "throughput", "velocity", "doomed", "dead", "alive",
  // source / attribution (source_quality)
  "source", "sources", "sourcing", "referrer", "referrers", "referral", "referrals",
  "agency", "agencies", "channel", "channels", "yield", "attribution",
  // rejection-reason drift + silent-req domains
  "reason", "reasons", "drift", "overusing", "overused", "concentration", "silent", "quiet", "gone", "idle",
  // recognized-but-projected domains (detectMissingDomain)
  "offer", "offers", "opening", "openings", "headcount", "approval", "approvals",
  "prospect", "prospects", "scheduling", "coordinator",
  // generic analytic verbs/nouns that carry no scope signal on their own
  "doing", "trend", "trends", "trending", "rate", "rates", "count", "counts",
  "breakdown", "distribution", "performance", "progress", "losing", "lose", "lost",
  "dropping", "dropoff", "movement",
]);

/**
 * True when every token is analysis-intent vocabulary (and there is at least one).
 * Callers gate this on "no scope signal present" so a query that names a real job
 * is never treated as a role-less analysis request.
 */
export function isAnalysisIntent(tokens: readonly string[]): boolean {
  if (tokens.length === 0) return false;
  return tokens.every((token) => ANALYSIS_INTENT_TERMS.has(token));
}
