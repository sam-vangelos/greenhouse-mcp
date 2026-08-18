#!/usr/bin/env node
import { spawn } from "node:child_process";

const moduleUrl = new URL("../src/container-self-check.ts", import.meta.url).href;
const code = `
  import(${JSON.stringify(moduleUrl)})
    .then((m) => m.runContainerSelfCheck())
    .then((report) => process.stdout.write(JSON.stringify(report) + "\\n"))
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(\`[greenhouse-recruiter-container-self-check] failed: \${message}\`);
      process.exit(1);
    });
`;

const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), "--eval", code], {
  env: process.env,
  stdio: "inherit",
});

child.on("exit", (exitCode, signal) => {
  if (signal) return process.kill(process.pid, signal);
  process.exit(exitCode ?? 1);
});

child.on("error", (error) => {
  console.error(`[greenhouse-recruiter-container-self-check] failed: ${error.message}`);
  process.exit(1);
});
