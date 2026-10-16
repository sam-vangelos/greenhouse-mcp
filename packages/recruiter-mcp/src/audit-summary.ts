import { basename } from "node:path";
import { readAuditJsonlAcrossPartitions } from "./audit.js";
import {
  buildGcsAuditConfigFromEnv,
  readAuditBackendFromEnv,
  readGcsAuditEvents,
  resolveGcsAuditStorage,
  type GcsAuditTarget,
} from "./audit-gcs.js";

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
    // Half-open [windowStartMs, nowMs): consecutive timer ticks [T-i, T) / [T, T+i) tile without
    // double-counting an event stamped exactly at a tick boundary — on EITHER backend.
    if (at < windowStartMs || at >= nowMs) continue;
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

// storeLabel names the store the digest summarized ("jsonl:<basename>" / "gcs:<bucket>/<prefix>"),
// so a reader of the two-store coexistence era always knows which audit trail a digest covers. The
// timer always passes it; omitting it keeps the pre-stamp headline for direct callers.
export function formatAuditSummarySlackText(summary: AuditSummary, storeLabel?: string): string {
  const denials = Object.entries(summary.denialsByCode)
    .sort(([, a], [, b]) => b - a)
    .map(([code, count]) => `${code}: ${count}`)
    .join(", ") || "none";
  const actors = Object.keys(summary.eventsByActor).length;
  return [
    `Greenhouse MCP health (${summary.windowStart} → ${summary.windowEnd})${storeLabel ? ` — store: ${storeLabel}` : ""}`,
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
  gcs: GcsAuditTarget | null;
}

export function readAuditSummaryConfig(env: NodeJS.ProcessEnv = process.env): AuditSummaryTimerConfig {
  const webhook = env.GREENHOUSE_RECRUITER_AUDIT_SUMMARY_WEBHOOK_URL?.trim();
  const rawInterval = env.GREENHOUSE_RECRUITER_AUDIT_SUMMARY_INTERVAL_MS?.trim();
  const interval = rawInterval && /^[1-9]\d*$/.test(rawInterval) ? Number.parseInt(rawInterval, 10) : 24 * 60 * 60 * 1000;
  let jsonlPath = env.GREENHOUSE_RECRUITER_AUDIT_JSONL_PATH?.trim() || null;
  let gcs: GcsAuditTarget | null = null;
  try {
    if (readAuditBackendFromEnv(env) === "gcs_object") {
      gcs = buildGcsAuditConfigFromEnv(env);
      jsonlPath = null; // the GCS backend ignores the file-path env entirely
    }
  } catch (error) {
    // Telemetry never takes serving down and never guesses: an invalid backend or malformed GCS
    // config keeps the timer dormant here — readiness and the request preflight fail it loudly.
    // Dormancy still announces itself once, name-only, so a misconfigured deploy is not silently
    // digest-less: never the message, never config values.
    const errorName = error instanceof Error && error.name ? error.name : typeof error;
    console.error(`[greenhouse-recruiter-mcp] audit summary timer dormant: invalid audit backend config error_name=${errorName}`);
    gcs = null;
    jsonlPath = null;
  }
  return {
    webhookUrl: webhook && webhook.startsWith("https://") ? webhook : null,
    jsonlPath,
    intervalMs: interval,
    gcs,
  };
}

/**
 * One summary tick against a resolved config: read the audit window, build the summary, post it.
 * Failures PROPAGATE — the interval wrapper below is what logs-and-swallows. Exported so the tick
 * is testable by direct call: the timer is unref'd (it must never hold a server process open), so
 * a test awaiting a real interval tick deadlocks whenever nothing else keeps the event loop alive —
 * exactly the CI-only cancellation that motivated this seam.
 */
export async function runAuditSummaryTickOnce(config: AuditSummaryTimerConfig, nowMs: number): Promise<void> {
  // GCS arm: WINDOWED read of only the summary interval (month-dir narrowed via the object-name
  // timestamp contract), so the periodic rollup never fetches a whole month per tick. File arm:
  // scan every monthly partition (and the legacy base file), not just the base path — the sink
  // spreads records across …/audit-YYYY-MM.jsonl files, so reading only the base would
  // summarize nothing.
  const { text } = config.gcs
    ? await readGcsAuditEvents(await resolveGcsAuditStorage(), config.gcs.bucket, config.gcs.prefix, {
        fromMs: nowMs - config.intervalMs,
        toMs: nowMs,
      })
    : await readAuditJsonlAcrossPartitions(config.jsonlPath as string);
  const summary = buildAuditSummary(text, nowMs - config.intervalMs, nowMs);
  // The digest names the store it summarized — basename only on the file arm, never the path.
  const storeLabel = config.gcs
    ? `gcs:${config.gcs.bucket}/${config.gcs.prefix}`
    : `jsonl:${basename(config.jsonlPath as string)}`;
  await fetch(config.webhookUrl as string, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: formatAuditSummarySlackText(summary, storeLabel) }),
  });
}

/**
 * Start the dormant summary timer. Returns null (and starts nothing) unless the webhook AND a
 * retained audit source (the JSONL path, or a fully configured GCS backend) are configured.
 * Failures are logged and swallowed — health telemetry must never take the serving path down.
 */
export function maybeStartAuditSummaryTimer(env: NodeJS.ProcessEnv = process.env): NodeJS.Timeout | null {
  const config = readAuditSummaryConfig(env);
  if (!config.webhookUrl || (!config.jsonlPath && !config.gcs)) return null;
  const timer = setInterval(async () => {
    try {
      await runAuditSummaryTickOnce(config, Date.now());
    } catch (error) {
      const message = error instanceof Error ? error.name : "unknown";
      console.error(`[greenhouse-recruiter-mcp] audit summary post failed error_name=${message}`);
    }
  }, config.intervalMs);
  timer.unref?.();
  console.error(`[greenhouse-recruiter-mcp] audit health summary enabled (interval ${config.intervalMs}ms)`);
  return timer;
}
