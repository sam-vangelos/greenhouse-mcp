import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PILOT_TOOL_NAMES } from "../src/tools/register.js";

const dockerfile = readFileSync("deploy/Dockerfile", "utf8");
const dockerignore = readFileSync("deploy/Dockerfile.dockerignore", "utf8");
const dockerSmokeScript = readFileSync("deploy/docker-smoke-test.mjs", "utf8");
const productionEnvExample = readFileSync("deploy/production.env.example", "utf8");
const packageGuardScript = readFileSync("scripts/verify-guards.mjs", "utf8");
const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const chatGptExample = JSON.parse(readFileSync("examples/rollout-evidence/desktop-configs/recruiter-chatgpt.example.json", "utf8"));
const distributionExamples = [
  "distribution-chatgpt-desktop.example.json",
  "distribution-claude-desktop.example.json",
  "distribution-claude-code.example.json",
].map((name) => JSON.parse(readFileSync(`examples/rollout-evidence/${name}`, "utf8")));

describe("hosted deployment artifacts", () => {
  it("keeps static boundary guards in the package verify path", () => {
    assert.match(packageJson.scripts.guard, /node scripts\/verify-package\.mjs/);
    assert.match(packageJson.scripts.guard, /node scripts\/check-harvest-v3-registry\.mjs/);
    assert.match(packageJson.scripts.verify, /npm run guard/);
    assert.match(packageGuardScript, /evidence payload hygiene boundary/);
    assert.match(packageGuardScript, /src\/evidence-hygiene\.ts/);
  });

  it("builds the Greenhouse client before starting the scoped recruiter HTTP MCP", () => {
    assert.match(dockerfile, /COPY package\.json package-lock\.json \.\//);
    assert.match(dockerfile, /mount=type=secret,id=npm_ca,required=false/);
    assert.match(dockerfile, /npm ci --include=dev --no-audit --no-fund/);
    assert.match(dockerfile, /COPY packages\/recruiter-mcp\/package\.json packages\/recruiter-mcp\/package\.json/);
    assert.doesNotMatch(dockerfile, /COPY .*npm_ca|COPY .*cert\.pem/);
    assert.match(dockerfile, /COPY packages packages/);
    assert.match(dockerfile, /RUN npm run build/);
    assert.match(dockerfile, /test -f packages\/control-plane\/dist\/client-readonly\.js/);
    assert.match(dockerfile, /COPY --from=build \/app\/packages packages/);
    assert.match(dockerfile, /greenhouse-recruiter-mcp-http\.mjs/);
    assert.match(dockerfile, /RUN node packages\/recruiter-mcp\/bin\/greenhouse-recruiter-container-self-check\.mjs/);
  });

  it("runs as the non-root node user with healthcheck and no embedded secrets", () => {
    assert.match(dockerfile, /USER node/);
    assert.match(dockerfile, /EXPOSE 3333/);
    assert.match(dockerfile, /HEALTHCHECK/);
    assert.match(dockerfile, /GREENHOUSE_RECRUITER_MCP_PORT/);
    assert.match(dockerfile, /mkdir -p \/app\/audit/);
    assert.match(dockerfile, /chown node:node \/app\/audit/);
    assert.doesNotMatch(dockerfile, /GREENHOUSE_RECRUITER_AUDIT_JSONL_PATH\s*=/);
    assert.doesNotMatch(dockerfile, /GREENHOUSE_CLIENT_SECRET\s*=/);
    assert.doesNotMatch(dockerfile, /GREENHOUSE_RECRUITER_SESSION_SECRET\s*=/);
    assert.doesNotMatch(dockerfile, /GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_KEY\s*=/);
    // The image must never START the control plane. That is the service-recreation incident: a
    // repo-root default built the Next.js hub onto the MCP's URL and /healthz stayed green.
    //
    // Asserted against the ENTRYPOINT and CMD rather than as a substring ban on the whole file. The
    // ban was over-broad — it also forbade naming any `dist/index.js` anywhere, including a build
    // stage verifying that a DIFFERENT package produced its entry — and an assertion that fires on
    // things it was not written to catch gets loosened by whoever trips it next. This one is
    // strictly narrower in what it permits and no weaker in what it forbids.
    const launchLines = dockerfile.split("\n").filter((line) => /^\s*(CMD|ENTRYPOINT)\b/.test(line));
    assert.ok(launchLines.length > 0, "the image must declare how it starts");
    for (const line of launchLines) {
      assert.doesNotMatch(line, /greenhouse-ops-control-plane|dist\/index\.js/,
        "the recruiter image must not launch the control plane");
    }
    assert.doesNotMatch(dockerfile, /greenhouse-ops-control-plane/,
      "the control-plane package must not appear anywhere in the recruiter image build");
    assert.match(
      dockerfile,
      /CMD \[\"node\", \"packages\/recruiter-mcp\/bin\/greenhouse-recruiter-mcp-http\.mjs\"\]/,
      "and it must launch the recruiter MCP explicitly"
    );
  });

  it("keeps the Docker context narrow and excludes local secrets and dependencies", () => {
    assert.match(dockerignore, /^\*\*$/m);
    assert.match(dockerignore, /!packages\/control-plane\/src\/\*\*/);
    assert.match(dockerignore, /!packages\/recruiter-mcp\/src\/\*\*/);
    assert.match(dockerignore, /!packages\/recruiter-mcp\/bin\/\*\*/);
    assert.match(dockerignore, /!package-lock\.json/);
    assert.doesNotMatch(dockerignore, /!packages\/recruiter-mcp\/test/);
    assert.doesNotMatch(dockerignore, /!packages\/recruiter-mcp\/examples/);
    assert.doesNotMatch(dockerignore, /!packages\/recruiter-mcp\/deploy/);
    assert.match(dockerignore, /^\.env$/m);
    assert.match(dockerignore, /^\.env\.\*$/m);
    assert.match(dockerignore, /\*\*\/node_modules/);
  });

  it("provides an operator-run Docker smoke test for build, health, and readiness", () => {
    assert.match(dockerSmokeScript, /^#!\/usr\/bin\/env node/);
    assert.match(dockerSmokeScript, /runDocker\(\["build", \.\.\.caArgs, "-f", dockerfilePath, "-t", imageTag, "\."\]/);
    assert.match(dockerSmokeScript, /id=npm_ca,src=\$\{npmCaFile\}/);
    assert.match(dockerSmokeScript, /runDockerJson\(\[/);
    assert.match(dockerSmokeScript, /greenhouse-recruiter-container-self-check\.mjs/);
    assert.match(dockerSmokeScript, /authenticatedMcpHttpValidated: false/);
    assert.match(dockerSmokeScript, /catalogToolCount !== 44/);
    assert.match(dockerSmokeScript, /hiddenToolCount !== 22/);
    assert.match(dockerSmokeScript, /real issued recruiter session/);
    assert.match(dockerSmokeScript, /GREENHOUSE_RECRUITER_DOCKER_SMOKE_RUN/);
    assert.match(dockerSmokeScript, /runDocker\(\[\s*"run"/);
    assert.match(dockerSmokeScript, /127\.0\.0\.1:\$\{port\}/);
    assert.match(dockerSmokeScript, /\/healthz/);
    assert.match(dockerSmokeScript, /\/readyz/);
    assert.match(dockerSmokeScript, /authorization: `Bearer \$\{readinessToken\}`/);
    assert.match(dockerSmokeScript, /GREENHOUSE_RECRUITER_STATE_BACKEND: "supabase_postgrest"/);
    assert.match(dockerSmokeScript, /GREENHOUSE_RECRUITER_AUDIT_JSONL_PATH: "\/app\/audit\/audit\.jsonl"/);
    // The smoke container mounts a durable volume at /app/audit; the durable-mount env must be
    // declared too or readiness (audit_sink) fails and the /readyz probe times out. Lock it here so
    // the smoke env cannot drift from the readiness requirement.
    assert.match(dockerSmokeScript, /GREENHOUSE_RECRUITER_AUDIT_DURABLE_MOUNT_PATH: "\/app\/audit"/);
    assert.match(dockerSmokeScript, /GREENHOUSE_RECRUITER_SCOPE_SIGNING_SECRET: "smoke-scope-signing-secret-32-characters-minimum"/);
    assert.match(dockerSmokeScript, /GREENHOUSE_RECRUITER_READYZ_TOKEN: readinessToken/);
    assert.match(dockerSmokeScript, /GREENHOUSE_RECRUITER_REVOCATION_SUPABASE_URL: "https:\/\/exampleprojectref000\.supabase\.co"/);
    assert.match(dockerSmokeScript, /GREENHOUSE_RECRUITER_CORS_ORIGIN: "https:\/\/chatgpt\.com,https:\/\/claude\.ai"/);
    assert.match(dockerSmokeScript, /!\/\^\[1-9\]\\d\*\$\/\.test\(value\)/);
    assert.match(dockerSmokeScript, /Invalid \$\{label\}: \$\{raw\}/);
    assert.doesNotMatch(dockerSmokeScript, /Number\.parseInt\(String\(raw \?\? ""\), 10\)/);
    assert.doesNotMatch(dockerSmokeScript, /GREENHOUSE_USER_ID|permittedJobIds|GREENHOUSE_RECRUITER_ALLOW_TEST_SURFACE/);
    assert.doesNotMatch(dockerSmokeScript, /sk-[A-Za-z0-9]|ghp_[A-Za-z0-9]/);
  });

  it("provides a production env template without recruiter tokens or dev-only identity settings", () => {
    for (const required of [
      "GREENHOUSE_CLIENT_ID",
      "GREENHOUSE_CLIENT_SECRET",
      "GREENHOUSE_RECRUITER_STATE_BACKEND",
      "GREENHOUSE_RECRUITER_SESSION_SECRET",
      "GREENHOUSE_RECRUITER_SCOPE_SIGNING_SECRET",
      "GREENHOUSE_RECRUITER_READYZ_TOKEN",
      "GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_URL",
      "GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_KEY",
      "GREENHOUSE_RECRUITER_IDENTITY_LOOKUP_TIMEOUT_MS",
      "GREENHOUSE_RECRUITER_REVOCATION_SUPABASE_URL",
      "GREENHOUSE_RECRUITER_REVOCATION_SUPABASE_KEY",
      "GREENHOUSE_RECRUITER_REVOCATION_LOOKUP_TIMEOUT_MS",
      "GREENHOUSE_RECRUITER_AUDIT_JSONL_PATH",
      "GREENHOUSE_RECRUITER_REMOTE_SURFACES",
      "GREENHOUSE_RECRUITER_CORS_ORIGIN",
      "OPERATOR_ACTOR_IDS",
      "GREENHOUSE_RECRUITER_FORCE_PERMISSION_TTL_ZERO",
      "GREENHOUSE_RECRUITER_RATE_LIMIT_DISABLED",
      "GREENHOUSE_RECRUITER_MAX_TOOL_DURATION_MS",
      "GREENHOUSE_RECRUITER_MAX_ANALYSIS_DURATION_MS",
      "GREENHOUSE_RECRUITER_ALLOWED_TOOLS",
      "GREENHOUSE_RECRUITER_MAX_HTTP_BODY_BYTES",
      "GREENHOUSE_RECRUITER_HTTP_HEADERS_TIMEOUT_MS",
      "GREENHOUSE_RECRUITER_HTTP_REQUEST_TIMEOUT_MS",
      "GREENHOUSE_RECRUITER_HTTP_KEEP_ALIVE_TIMEOUT_MS",
    ]) {
      assert.match(productionEnvExample, new RegExp(`^${required}=`, "m"));
    }
    assert.doesNotMatch(productionEnvExample, /^GREENHOUSE_RECRUITER_SESSION_TOKEN=/m);
    assert.doesNotMatch(productionEnvExample, /^GREENHOUSE_RECRUITER_REMOTE_AUTH_TOKEN=/m);
    assert.doesNotMatch(productionEnvExample, /^GREENHOUSE_RECRUITER_IDENTITY_JSON=/m);
    assert.doesNotMatch(productionEnvExample, /^GREENHOUSE_RECRUITER_ALLOW_STATIC_IDENTITY_FOR_DEV=/m);
    assert.doesNotMatch(productionEnvExample, /^GREENHOUSE_RECRUITER_ALLOW_TEST_SURFACE=/m);
    assert.doesNotMatch(productionEnvExample, /^GREENHOUSE_RECRUITER_TRUSTED_ACT_AS_USER_ID=/m);
    assert.doesNotMatch(productionEnvExample, /admin-issued-user-token|sk-[A-Za-z0-9]|ghp_[A-Za-z0-9]/);
  });

  it("locks production env, Docker smoke, and ChatGPT config to the exact ordered 44-tool catalog", () => {
    const expected = [...PILOT_TOOL_NAMES];
    const productionTools = lineValue(productionEnvExample, "GREENHOUSE_RECRUITER_ALLOWED_TOOLS").split(",");
    const dockerTools = dockerSmokeScript.match(/GREENHOUSE_RECRUITER_ALLOWED_TOOLS: "([^"]+)"/)?.[1]?.split(",");

    assert.equal(expected.length, 44);
    assert.deepEqual(productionTools, expected);
    assert.deepEqual(dockerTools, expected);
    assert.deepEqual(chatGptExample.allowed_tools, expected);
    for (const example of distributionExamples) {
      assert.deepEqual(example.toolNames, expected);
      assert.equal(example.ok, false);
      assert.equal(example.status, "not_ready");
      assert.equal(example.evidenceState, "example_only");
      assert.equal(example.checks, undefined);
      assert.match(example.versionUrl, /\/version$/);
      assert.match(example.expectedCommit, /^[0-9a-f]{40}$/);
      assert.equal(example.observedCommit, example.expectedCommit);
      assert.equal(example.expectedChecks.find((check: { name?: string }) => check.name === "readyz_unauthorized_denied")?.status, "pass");
      assert.equal(example.expectedChecks.find((check: { name?: string }) => check.name === "version_commit")?.status, "pass");
      assert.equal(example.expectedChecks.find((check: { name?: string }) => check.name === "exact_tool_catalog")?.status, "pass");
      assert.equal(example.expectedChecks.find((check: { name?: string }) => check.name === "read_only_tool_annotations")?.status, "pass");
    }
  });
});

function lineValue(source: string, name: string): string {
  const match = source.match(new RegExp(`^${name}=(.+)$`, "m"));
  assert.ok(match?.[1], `${name} must have a value`);
  return match[1];
}
