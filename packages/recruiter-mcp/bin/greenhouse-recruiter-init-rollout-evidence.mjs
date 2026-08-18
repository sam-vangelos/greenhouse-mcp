#!/usr/bin/env node
import { spawn } from "node:child_process";

const moduleUrl = new URL("../src/rollout-evidence-init.ts", import.meta.url).href;
const code = `
  import(${JSON.stringify(moduleUrl)})
    .then((m) => m.startRolloutEvidenceInitCli(${JSON.stringify(process.argv.slice(2))}))
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(\`[greenhouse-recruiter-init-rollout-evidence] failed: \${message}\`);
      process.exit(1);
    });
`;

const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), "--eval", code], {
  env: process.env,
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

child.on("error", (error) => {
  console.error(`[greenhouse-recruiter-init-rollout-evidence] failed: ${error.message}`);
  process.exit(1);
});
