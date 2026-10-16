import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildRecruiterMcpReadinessReport, type ReadinessCheck } from "./readiness.js";
import type { RecruiterSurface } from "./types.js";

export interface ProductionEnvCheckOptions {
  env?: NodeJS.ProcessEnv;
  envFile?: string;
  now?: () => number;
}

export interface ProductionEnvCheckReport {
  ok: boolean;
  status: "ready" | "not_ready";
  generatedAt: string;
  source: "process_env" | "env_file";
  envFile?: string;
  checks: ReadinessCheck[];
  configuredSurfaces: RecruiterSurface[];
}

const ENV_KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

export function parseProductionEnvFile(text: string, label = "env file"): NodeJS.ProcessEnv {
  const parsed: NodeJS.ProcessEnv = {};
  const seen = new Set<string>();
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const lineNumber = index + 1;
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    if (line !== trimmed) {
      throw new Error(`${label}:${lineNumber}: environment entries must not contain leading or trailing whitespace.`);
    }
    if (line.startsWith("export ")) {
      throw new Error(`${label}:${lineNumber}: export syntax is not supported; use KEY=value.`);
    }
    const equalsIndex = line.indexOf("=");
    if (equalsIndex <= 0) {
      throw new Error(`${label}:${lineNumber}: expected KEY=value.`);
    }
    const key = line.slice(0, equalsIndex);
    const value = line.slice(equalsIndex + 1);
    if (!ENV_KEY_PATTERN.test(key)) {
      throw new Error(`${label}:${lineNumber}: invalid environment key ${JSON.stringify(key)}.`);
    }
    if (seen.has(key)) {
      throw new Error(`${label}:${lineNumber}: duplicate environment key ${key}.`);
    }
    if (value.startsWith("\"") || value.startsWith("'") || value.endsWith("\"") || value.endsWith("'")) {
      throw new Error(`${label}:${lineNumber}: quoted values are not supported; provide the exact literal value.`);
    }
    seen.add(key);
    parsed[key] = value;
  }
  return parsed;
}

export async function runProductionEnvCheck(options: ProductionEnvCheckOptions = {}): Promise<ProductionEnvCheckReport> {
  const source = options.envFile ? "env_file" : "process_env";
  const envFile = options.envFile ? resolve(options.envFile) : undefined;
  const env = envFile
    ? parseProductionEnvFile(await readFile(envFile, "utf8"), envFile)
    : (options.env ?? process.env);
  const readiness = buildRecruiterMcpReadinessReport(env, options.now);
  return {
    ...readiness,
    source,
    ...(envFile ? { envFile } : {}),
  };
}

export async function startProductionEnvCheckCli(
  env: NodeJS.ProcessEnv = process.env,
  args: string[] = process.argv.slice(2)
): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(usage());
    return;
  }
  try {
    const options = parseArgs(args);
    const report = await runProductionEnvCheck({ env, ...options });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.ok) {
      process.exitCode = 1;
    }
  } catch (error) {
    const generatedAt = new Date().toISOString();
    const message = error instanceof Error ? error.message : "Production env preflight failed.";
    const report: ProductionEnvCheckReport = {
      ok: false,
      status: "not_ready",
      generatedAt,
      source: "env_file",
      checks: [
        {
          name: "env_file_parse",
          status: "fail",
          summary: message,
        },
      ],
      configuredSurfaces: [],
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = 1;
  }
}

function parseArgs(args: string[]): Pick<ProductionEnvCheckOptions, "envFile"> {
  let envFile: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--env-file" && args[index + 1]) {
      envFile = args[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--env-file") {
      throw new Error("--env-file requires a path.");
    }
    throw new Error(`Unknown argument ${arg}.`);
  }
  return { envFile };
}

function usage(): string {
  return "Usage: greenhouse-recruiter-check-production-env [--env-file ./greenhouse-recruiter-production.env]\n";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startProductionEnvCheckCli().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[greenhouse-recruiter-check-production-env] ${message}\n`);
    process.exit(1);
  });
}
