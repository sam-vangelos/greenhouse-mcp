import { startStdioRecruiterMcp } from "./stdio.js";

export { createRecruiterMcpServer } from "./server.js";
export { startStdioRecruiterMcp } from "./stdio.js";
export { handleRemoteMcpRequest, validateRemoteAuthorization } from "./remote.js";
export { runRecruiterReadinessProbe, runRecruiterReadinessProbeFromEnv } from "./probe.js";
export { runScopeLeakageSample, runScopeLeakageSampleFromEnv } from "./leakage-sample.js";
export { runRemoteDistributionValidation, runRemoteDistributionValidationFromEnv } from "./distribution-validation.js";
export { runRolloutGate, runRolloutGateFromEnv } from "./rollout-gate.js";
export { buildRolloutEvidenceBundle, startRolloutEvidenceBundleCli } from "./evidence-bundle.js";
export { runRolloutEvidenceInit, startRolloutEvidenceInitCli } from "./rollout-evidence-init.js";
export { runAuditReview, runAuditReviewFromEnv } from "./audit-review.js";
export {
  generateDesktopConfig,
  generateDesktopConfigBatchFromIssuedSessions,
  generateDesktopConfigBatchFromIssuedSessionsFile,
  generateDesktopConfigFromEnv,
  writeDesktopConfigBatchFiles,
} from "./desktop-config.js";
export {
  buildDesktopDeliveryEvidenceFromManifestFile,
  writeDesktopDeliveryEvidenceFile,
  startDesktopDeliveryEvidenceCli,
} from "./desktop-delivery.js";
export {
  buildDesktopUserTestEvidenceFromManifests,
  writeDesktopUserTestEvidenceFile,
  startDesktopUserTestEvidenceCli,
} from "./desktop-user-test.js";
export { runIdentityResolutionCheck, runIdentityResolutionCheckFromEnv } from "./identity-check.js";
export {
  issueDirectoryVerifiedEmailSessionBatch,
  issueDirectoryVerifiedEmailSessionToken,
  issueVerifiedEmailSessionToken,
  normalizeWorkEmail,
  parseEmailList,
  writeIssuedEmailSessionBatchFiles,
} from "./email-session.js";

if (import.meta.url === `file://${process.argv[1]}`) {
  startStdioRecruiterMcp().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[greenhouse-recruiter-mcp] startup failed: ${message}`);
    process.exit(1);
  });
}
export { buildIdentityBootstrapPlan, applyIdentityBootstrapPlan, startIdentityBootstrapCli } from "./identity-bootstrap.js";
export {
  buildIdentityReconciliationPlan,
  applyIdentityReconciliationPlan,
  fetchResolvedDirectoryRows,
  startIdentityReconciliationCli,
} from "./identity-reconciliation.js";
export { recordSessionRevocation, recordSessionRevocationFromEnv, startSessionRevocationCli } from "./session-revocation.js";
