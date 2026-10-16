#!/usr/bin/env node
import { spawn } from "node:child_process";

const moduleUrl = new URL("../src/http-server.ts", import.meta.url).href;
const code = `
  import(${JSON.stringify(moduleUrl)})
    .then((m) => m.runHttpRecruiterMcp())
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(\`[greenhouse-recruiter-mcp] http startup failed: \${message}\`);
      process.exit(1);
    });
`;

const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), "--eval", code], {
  env: process.env,
  stdio: "inherit",
});

// This wrapper is PID 1 under Cloud Run; the server runs in the spawned child. Cloud Run signals
// PID 1, so forward SIGTERM/SIGINT to the child (whose runHttpRecruiterMcp drains gracefully) rather
// than letting the child be orphaned and SIGKILLed at the 10s boundary.
const forwardSignal = (signal) => {
  if (child.exitCode === null && child.signalCode === null) child.kill(signal);
};
const forwardTerm = () => forwardSignal("SIGTERM");
const forwardInterrupt = () => forwardSignal("SIGINT");
process.on("SIGTERM", forwardTerm);
process.on("SIGINT", forwardInterrupt);

function removeSignalForwarders() {
  process.off("SIGTERM", forwardTerm);
  process.off("SIGINT", forwardInterrupt);
}

child.on("exit", (code, signal) => {
  removeSignalForwarders();
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

child.on("error", (error) => {
  console.error(`[greenhouse-recruiter-mcp] http startup failed: ${error.message}`);
  process.exit(1);
});
