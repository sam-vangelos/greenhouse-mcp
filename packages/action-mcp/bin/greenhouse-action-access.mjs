#!/usr/bin/env node
import { spawn } from "node:child_process";

const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), new URL("../src/access-cli.ts", import.meta.url).pathname, ...process.argv.slice(2)], {
  env: process.env,
  stdio: "inherit",
});
child.on("exit", (code, signal) => signal ? process.kill(process.pid, signal) : process.exit(code ?? 1));
child.on("error", (error) => { console.error(error.message); process.exit(1); });
