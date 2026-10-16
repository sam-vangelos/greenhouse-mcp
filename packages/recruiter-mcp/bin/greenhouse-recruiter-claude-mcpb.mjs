#!/usr/bin/env node
import { spawn } from "node:child_process";

const moduleUrl = new URL("../src/claude-mcpb.ts", import.meta.url).href;
const code = `import(${JSON.stringify(moduleUrl)}).then((m) => m.startClaudeMcpbCli(process.argv.slice(1)))`;
const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), "--eval", code, "--", ...process.argv.slice(2)], {
  env: process.env,
  stdio: "inherit",
});
child.on("exit", (code, signal) => signal ? process.kill(process.pid, signal) : process.exit(code ?? 1));
child.on("error", () => process.exit(1));
