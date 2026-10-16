import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// The bin wrapper is PID 1 under Cloud Run. It spawns the tsx child that serves HTTP, so a bare
// SIGTERM to PID 1 would never reach the child and Cloud Run would SIGKILL it 10s later. This
// exercises the whole path end to end: forward the signal, drain, exit 0 well inside the window.
const wrapperPath = fileURLToPath(new URL("../bin/greenhouse-recruiter-mcp-http.mjs", import.meta.url));

describe("hosted HTTP PID 1 wrapper", () => {
  it("forwards SIGTERM to the child and waits for a clean drain", async () => {
    const child = spawn(process.execPath, [wrapperPath], {
      env: {
        PATH: process.env.PATH,
        GREENHOUSE_RECRUITER_MCP_PORT: "0",
        GREENHOUSE_RECRUITER_SHUTDOWN_GRACE_MS: "500",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    try {
      await waitFor(() => stderr.includes("streamable HTTP listening"), 8_000);
      const startedAt = Date.now();
      assert.equal(child.kill("SIGTERM"), true);
      const exit = await waitForExit(child, 8_000);

      assert.deepEqual(exit, { code: 0, signal: null }, "the wrapper exits cleanly, not on the raw signal");
      assert.match(stderr, /received SIGTERM; draining/);
      assert.ok(Date.now() - startedAt < 3_000, "the wrapper exits well inside Cloud Run's termination window");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  });
});

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for child process output");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function waitForExit(
  child: ReturnType<typeof spawn>,
  timeoutMs: number
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for child process exit")), timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
