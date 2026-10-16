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
const productionEnvCheckExample = JSON.parse(readFileSync("examples/rollout-evidence/production-env-check.example.json", "utf8"));

describe("hosted deployment artifacts", () => {
  it("keeps static boundary guards in the package verify path", () => {
    assert.match(packageJson.scripts.guard, /node scripts\/verify-package\.mjs/);
    assert.match(packageJson.scripts.guard, /node scripts\/check-harvest-v3-registry\.mjs/);
    assert.match(packageJson.scripts.verify, /npm run guard/);
    // The old per-package `verify:rollout` walked a former parent monorepo by relative path and
    // does not exist in this workspace; the root `npm run verify` covers every package instead.
    assert.equal(packageJson.scripts["verify:rollout"], undefined);
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
    // Both dists the recruiter runtime imports must be proven present at build time, not discovered
    // missing by the container self-check as a module-resolution error.
    assert.match(dockerfile, /test -f packages\/control-plane\/dist\/client-readonly\.js/);
    assert.match(dockerfile, /test -f packages\/action-mcp\/dist\/index\.js/);
    assert.match(dockerfile, /COPY --from=build \/app\/packages packages/);
    assert.match(dockerfile, /greenhouse-recruiter-mcp-http\.mjs/);
    assert.match(dockerfile, /RUN node packages\/recruiter-mcp\/bin\/greenhouse-recruiter-container-self-check\.mjs/);
  });

  it("runs as the non-root node user with healthcheck and no embedded secrets", () => {
    assert.match(dockerfile, /USER node/);
    assert.match(dockerfile, /EXPOSE 8080/);
    assert.match(dockerfile, /HEALTHCHECK/);
    // Cloud Run injects PORT and expects the container to listen on it. The image default and the
    // healthcheck must both honor PORT ahead of the recruiter-specific fallback.
    assert.match(dockerfile, /GREENHOUSE_RECRUITER_MCP_PORT=8080/);
    assert.match(dockerfile, /process\.env\.PORT \|\| process\.env\.GREENHOUSE_RECRUITER_MCP_PORT/);
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
      assert.doesNotMatch(line, /control-plane\/dist\/index\.js|greenhouse-ops-control-plane/,
        "the recruiter image must not launch the control plane");
    }
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
    assert.match(dockerSmokeScript, /Number\.isInteger\(parsed\?\.catalogToolCount\)/);
    assert.match(dockerSmokeScript, /hiddenToolCount !== 0/);
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
      "GREENHOUSE_RECRUITER_DISABLE_TOOLS",
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

  it("documents the write-plane and OAuth sign-in env families and the PORT precedence", () => {
    for (const required of [
      // Write plane (GREENHOUSE_ACTION_*). Dormant by default: both switches ship false.
      "GREENHOUSE_ACTION_SERVICE_ENABLED",
      "GREENHOUSE_ACTION_WRITES_ENABLED",
      "GREENHOUSE_ACTION_SIGNING_SECRET",
      "GREENHOUSE_ACTION_SUPABASE_URL",
      "GREENHOUSE_ACTION_SUPABASE_KEY",
      "GREENHOUSE_ACTION_CLIENT_ID",
      "GREENHOUSE_ACTION_CLIENT_SECRET",
      "GREENHOUSE_ACTION_CAPABILITIES",
      // OAuth sign-in layer (GREENHOUSE_RECRUITER_OAUTH_*). Additive, all-or-nothing family.
      "GREENHOUSE_RECRUITER_OAUTH_SIGNING_SECRET",
      "GREENHOUSE_RECRUITER_OAUTH_ISSUER",
      "GREENHOUSE_RECRUITER_OAUTH_RESOURCE_URL",
      "GREENHOUSE_RECRUITER_OAUTH_GOOGLE_CLIENT_ID",
      "GREENHOUSE_RECRUITER_OAUTH_GOOGLE_CLIENT_SECRET",
      "GREENHOUSE_RECRUITER_OAUTH_STATIC_CLIENT_ID",
      "GREENHOUSE_RECRUITER_OAUTH_STATIC_CLIENT_REDIRECT_URIS",
      "GREENHOUSE_RECRUITER_OAUTH_SUPABASE_URL",
      "GREENHOUSE_RECRUITER_OAUTH_SUPABASE_KEY",
      "GREENHOUSE_RECRUITER_OAUTH_SUPABASE_TABLE",
      "GREENHOUSE_RECRUITER_OAUTH_LOOKUP_TIMEOUT_MS",
    ]) {
      assert.match(productionEnvExample, new RegExp(`^${required}=`, "m"), `${required} must be documented`);
    }
    // The write-plane switches must ship dormant so a copied template never writes to Greenhouse.
    assert.match(productionEnvExample, /^GREENHOUSE_ACTION_SERVICE_ENABLED=false$/m);
    assert.match(productionEnvExample, /^GREENHOUSE_ACTION_WRITES_ENABLED=false$/m);
    // The OAuth secret must not be shared with the legacy session secret; the template must not seed
    // the family with junk that would flip readiness to a half-configured failure.
    assert.doesNotMatch(productionEnvExample, /^GREENHOUSE_RECRUITER_OAUTH_SIGNING_SECRET=\S/m);
    // PORT precedence is called out for Cloud Run operators.
    assert.match(productionEnvExample, /Cloud Run/);
    assert.match(productionEnvExample, /^GREENHOUSE_RECRUITER_SHUTDOWN_GRACE_MS=/m);
  });

  it("documents the GCS audit backend family dormant so a copied template keeps the file sink", () => {
    for (const required of [
      "GREENHOUSE_RECRUITER_AUDIT_BACKEND",
      "GREENHOUSE_RECRUITER_AUDIT_GCS_BUCKET",
      "GREENHOUSE_RECRUITER_AUDIT_GCS_PREFIX",
    ]) {
      assert.match(productionEnvExample, new RegExp(`^${required}=`, "m"), `${required} must be documented`);
    }
    // The family ships EMPTY: an empty backend means the historical jsonl_file default, so a copied
    // template never silently switches audit sinks.
    assert.match(productionEnvExample, /^GREENHOUSE_RECRUITER_AUDIT_BACKEND=$/m);
    assert.match(productionEnvExample, /^GREENHOUSE_RECRUITER_AUDIT_GCS_BUCKET=$/m);
    // The template names the Cloud Run constraint the backend exists for and the fail-closed rule.
    assert.match(productionEnvExample, /gcs_object/);
    assert.match(productionEnvExample, /cannot append/i);
    assert.match(productionEnvExample, /fails closed/i);
  });

  it("locks production env, Docker smoke, and ChatGPT config to the exact ordered mounted catalog", () => {
    const expected = [...PILOT_TOOL_NAMES];

    // R2a deleted the allowlist. The env template and the Docker smoke env must not resurrect it, and
    // the template has to say the deploy step out loud so the live Cloud Run service is cleaned up.
    assert.equal(/^GREENHOUSE_RECRUITER_ALLOWED_TOOLS=/m.test(productionEnvExample), false);
    assert.equal(/GREENHOUSE_RECRUITER_ALLOWED_TOOLS:/.test(dockerSmokeScript), false);
    assert.match(productionEnvExample, /DEPLOY STEP: delete GREENHOUSE_RECRUITER_ALLOWED_TOOLS from the Cloud Run service/);
    assert.match(productionEnvExample, /^GREENHOUSE_RECRUITER_DISABLE_TOOLS=$/m);

    // The smoke script no longer carries a catalog-size literal at all: the container's self-check
    // asserts the exact ordered catalog inside the image, which is stronger than a count and cannot
    // be forgotten in a second file. What the script must still check is that the self-check ran and
    // hid nothing.
    assert.equal(
      /EXPECTED_CATALOG_TOOL_COUNT/.test(dockerSmokeScript),
      false,
      "the catalog-size literal is retired; the container self-check owns exactness"
    );
    assert.match(dockerSmokeScript, /parsed\?\.hiddenToolCount !== 0/, "nothing is hidden any more");
    assert.match(dockerSmokeScript, /Number\.isInteger\(parsed\?\.catalogToolCount\)/, "the self-check's answer is still shape-checked");

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

describe("committed example evidence counts", () => {
  /**
   * Fold 2: three examples said "catalog exactly matched 81 unique approved tools" while their own
   * toolNames arrays carried 82 — the count-bearing SUMMARY was never compared to anything, so it
   * went stale the moment a reader was bound. Every number a committed example states about the
   * catalog is now derived from the artifact next to it.
   */
  it("states a catalog count equal to the catalog the example actually lists", () => {
    for (const example of distributionExamples) {
      const summary = String(
        example.expectedChecks.find((check: { name?: string }) => check.name === "exact_tool_catalog")?.summary ?? ""
      );
      const stated = Number(summary.match(/\b(\d+)\b/)?.[1]);
      assert.equal(
        stated,
        example.toolNames.length,
        `example summary says ${stated} tools, its own catalog lists ${example.toolNames.length}`
      );
      assert.equal(stated, PILOT_TOOL_NAMES.length, "and the catalog it lists is the one this build mounts");
    }
  });

  it("states the shipping catalog size in the production env-check example", () => {
    const summary = String(
      productionEnvCheckExample.expectedChecks.find((check: { name?: string }) => check.name === "tool_catalog")?.summary ?? ""
    );
    assert.equal(Number(summary.match(/(\d+)-tool/)?.[1]), PILOT_TOOL_NAMES.length);
  });
});

function lineValue(source: string, name: string): string {
  const match = source.match(new RegExp(`^${name}=(.+)$`, "m"));
  assert.ok(match?.[1], `${name} must have a value`);
  return match[1];
}
