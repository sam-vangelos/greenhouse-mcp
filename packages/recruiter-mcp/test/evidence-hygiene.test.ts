import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  containsTokenOrConfigPayload,
  isForbiddenEvidencePayloadKey,
  looksLikeSensitiveEvidenceString,
} from "../src/evidence-hygiene.js";

describe("evidence payload hygiene", () => {
  it("allows token-free rollout metadata fields needed for manifests and reports", () => {
    assert.equal(containsTokenOrConfigPayload({
      ok: true,
      containsTokens: false,
      configFilesContainTokens: true,
      sessionFilesContainTokens: true,
      tokenId: "issued-token-id",
      sessionTokenId: "issued-token-id",
      warning: "Token-free report; do not paste durable tokens or config payloads here.",
    }), false);
    assert.equal(isForbiddenEvidencePayloadKey("tokenId"), false);
    assert.equal(isForbiddenEvidencePayloadKey("sessionTokenIdAfterRestart"), false);
  });

  it("rejects alternate token/config keys and credential-shaped strings", () => {
    const payloads = [
      { authToken: "durable-user-token" },
      { rawConfig: { mcpServers: { greenhouse: {} } } },
      { nested: { desktopConfigPayload: { authorization: "durable-user-token" } } },
      { note: "proxy leaked Authorization: Bearer durable-session-token-value" },
      { note: "GREENHOUSE_RECRUITER_SESSION_TOKEN=durable-session-token-value" },
      { note: "sk-testcredentialvalue" },
      { note: "ghp_testcredentialvalue" },
    ];

    for (const payload of payloads) {
      assert.equal(containsTokenOrConfigPayload(payload), true);
    }
    assert.equal(looksLikeSensitiveEvidenceString("Bearer durable-session-token-value"), true);
  });
});
