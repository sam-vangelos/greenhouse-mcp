import { readFile } from "node:fs/promises";

/**
 * MCP service-health telemetry (audit O5), scoped by the two-product boundary: this emits
 * SERVICE-health signal only (call volume, denial mix, error spikes, per-actor counts) — never
 * recruiting analytics, which are Product B's (the analytics hub's) job. The rollup is computed
 * from the durable audit JSONL the /mcp gate already requires and, when a Slack incoming-webhook
 * URL is configured, posted once per interval. DORMANT BY DEFAULT: without the webhook env the
 * timer never starts (the migration-gated-writeback rule — shipped dark, activated by env).
 */

export interface AuditSummary {
  windowStart: string;
  windowEnd: string;
  totalEvents: number;
  successEvents: number;
  denialEvents: number;
  denialsByCode: Record<string, number>;
  eventsByActor: Record<string, number>;
  upstreamErrorEvents: number;
  rateLimitedEvents: number;
  undatedLegacyEvents: number;
}

export function buildAuditSummary(jsonlText: string, windowStartMs: number, nowMs: number): AuditSummary {
  const summary: AuditSummary = {
    windowStart: new Date(windowStartMs).toISOString(),
    windowEnd: new Date(nowMs).toISOString(),
    totalEvents: 0,
    successEvents: 0,
    denialEvents: 0,
    denialsByCode: {},
    eventsByActor: {},
    upstreamErrorEvents: 0,
    rateLimitedEvents: 0,
    undatedLegacyEvents: 0,
  };
  for (const line of jsonlText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue; // a torn/partial trailing line must never fail the rollup
    }
    const at = typeof event.at === "string" ? Date.parse(event.at) : Number.NaN;
    if (!Number.isFinite(at)) {
      summary.undatedLegacyEvents += 1;
      continue;
    }
    if (at < windowStartMs || at > nowMs) continue;
    if (event.schemaVersion === 2 && event.auditStage === "start") continue;
    summary.totalEvents += 1;
    const actor = event.actorGreenhouseUserId ?? event.actor_greenhouse_user_id;
    if (typeof actor === "number") {
      const key = String(actor);
      summary.eventsByActor[key] = (summary.eventsByActor[key] ?? 0) + 1;
    }
    const denialCode = event.denialCode ?? event.denial_code;
    if (typeof denialCode === "string" && denialCode.length > 0) {
      summary.denialEvents += 1;
      summary.denialsByCode[denialCode] = (summary.denialsByCode[denialCode] ?? 0) + 1;
      if (denialCode === "UPSTREAM_ERROR") summary.upstreamErrorEvents += 1;
      if (denialCode === "RATE_LIMITED") summary.rateLimitedEvents += 1;
    } else {
      summary.successEvents += 1;
    }
  }
  return summary;
}

export function formatAuditSummarySlackText(summary: AuditSummary): string {
  const denials = Object.entries(summary.denialsByCode)
    .sort(([, a], [, b]) => b - a)
    .map(([code, count]) => `${code}: ${count}`)
    .join(", ") || "none";
  const actors = Object.keys(summary.eventsByActor).length;
  return [
    `Greenhouse MCP health (${summary.windowStart} → ${summary.windowEnd})`,
    `calls: ${summary.totalEvents} (${summary.successEvents} ok / ${summary.denialEvents} denied) across ${actors} actor(s)`,
    `denials: ${denials}`,
    summary.undatedLegacyEvents > 0 ? `legacy undated rows excluded from window: ${summary.undatedLegacyEvents}` : null,
    summary.upstreamErrorEvents > 0 ? `⚠️ upstream errors: ${summary.upstreamErrorEvents}` : null,
    summary.rateLimitedEvents > 0 ? `⚠️ rate-limited: ${summary.rateLimitedEvents}` : null,
  ].filter(Boolean).join("\n");
}

export interface AuditSummaryTimerConfig {
  webhookUrl: string | null;
  jsonlPath: string | null;
  intervalMs: number;
}

export function readAuditSummaryConfig(env: NodeJS.ProcessEnv = process.env): AuditSummaryTimerConfig {
  const webhook = env.GREENHOUSE_RECRUITER_AUDIT_SUMMARY_WEBHOOK_URL?.trim();
  const rawInterval = env.GREENHOUSE_RECRUITER_AUDIT_SUMMARY_INTERVAL_MS?.trim();
  const interval = rawInterval && /^[1-9]\d*$/.test(rawInterval) ? Number.parseInt(rawInterval, 10) : 24 * 60 * 60 * 1000;
  return {
    webhookUrl: webhook && webhook.startsWith("https://") ? webhook : null,
    jsonlPath: env.GREENHOUSE_RECRUITER_AUDIT_JSONL_PATH?.trim() || null,
    intervalMs: interval,
  };
}

/**
 * Start the dormant summary timer. Returns null (and starts nothing) unless BOTH the webhook
 * and the audit JSONL path are configured. Failures are logged and swallowed — health telemetry
 * must never take the serving path down with it.
 */
export function maybeStartAuditSummaryTimer(env: NodeJS.ProcessEnv = process.env): NodeJS.Timeout | null {
  const config = readAuditSummaryConfig(env);
  if (!config.webhookUrl || !config.jsonlPath) return null;
  const timer = setInterval(async () => {
    try {
      const nowMs = Date.now();
      const text = await readFile(config.jsonlPath as string, "utf8");
      const summary = buildAuditSummary(text, nowMs - config.intervalMs, nowMs);
      await fetch(config.webhookUrl as string, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: formatAuditSummarySlackText(summary) }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.name : "unknown";
      console.error(`[greenhouse-recruiter-mcp] audit summary post failed error_name=${message}`);
    }
  }, config.intervalMs);
  timer.unref?.();
  console.error(`[greenhouse-recruiter-mcp] audit health summary enabled (interval ${config.intervalMs}ms)`);
  return timer;
}
