import {
  HARVEST_V3_ENDPOINT_REGISTRY,
  HARVEST_V3_EVIDENCE_TOOL_ENDPOINTS,
  type EndpointRegistryEntry,
  type HarvestScopeClass,
  type HarvestSensitivityClass,
  type JoinDependency,
  type ProjectionProfileName,
} from "../harvest-v3-registry.js";
import type { ExecutableScopePolicy } from "../../../scoped-core/src/index.js";

export type EndpointExposure = "model_evidence" | "internal_permission" | "not_exposed";

export interface EvidenceToolBinding {
  toolName: string;
  scopedToolName: string;
}

export interface ScopedEndpointAdapter {
  endpointPath: string;
  endpoint: EndpointRegistryEntry;
  scopeClass: HarvestScopeClass;
  sensitivityClass: HarvestSensitivityClass;
  defaultProjectionProfile: ProjectionProfileName;
  allowedProjectionProfiles: ProjectionProfileName[];
  joinDependencies: JoinDependency[];
  scopePolicy: ExecutableScopePolicy | null;
  boundingRule: string;
  exposure: EndpointExposure;
  evidenceTools: EvidenceToolBinding[];
  nonExposureReason: string | null;
}

export interface EvidenceEndpointAdapter extends ScopedEndpointAdapter {
  evidenceToolName: string;
  scopedToolName: string;
}

const EVIDENCE_TOOL_SCOPED_TOOL_ENTRIES = [
  ["search_my_jobs", "list_jobs"],
  ["get_my_job", "get_job"],
  ["search_my_job_owners", "list_job_owners"],
  ["search_my_openings", "list_openings"],
  ["search_my_job_interview_stages", "list_job_interview_stages"],
  ["search_my_job_interviews", "list_job_interviews"],
  ["search_my_interviews", "list_interviews"],
  ["search_my_application_stages", "list_application_stages"],
  ["search_my_applications", "list_applications"],
  ["get_my_application", "get_application"],
  ["search_my_candidates", "list_candidates"],
  ["get_my_candidate", "get_candidate"],
  ["search_my_scorecards", "list_scorecards"],
  ["search_my_rejection_details", "list_rejection_details"],
  ["search_my_rejection_reasons", "list_rejection_reasons"],
  ["search_my_users", "list_users"],
  ["get_my_user", "get_user"],
  ["search_my_sources", "list_sources"],
  ["search_my_referrers", "list_referrers"],
  ["search_my_notes", "list_notes"],
  ["search_my_tracking_links", "list_tracking_links"],
  ["search_my_offers", "list_offers"],
  ["search_my_departments", "list_departments"],
  ["search_my_offices", "list_offices"],
  ["search_my_close_reasons", "list_close_reasons"],
  ["search_my_custom_field_options", "list_custom_field_options"],
  ["search_my_attachments", "list_attachments"],
  ["search_my_job_hiring_managers", "list_job_hiring_managers"],
  ["search_my_job_notes", "list_job_notes"],
  ["search_my_job_posts", "list_job_posts"],
  ["search_my_interviewers", "list_interviewers"],
  ["search_my_scorecard_question_answers", "list_scorecard_question_answers"],
  ["search_my_candidate_educations", "list_candidate_educations"],
  ["search_my_candidate_employments", "list_candidate_employments"],
  ["search_my_custom_fields", "list_custom_fields"],
  ["search_my_pay_inputs", "list_pay_inputs"],
  ["search_my_approval_flows", "list_approval_flows"],
  ["search_my_approvers", "list_approvers"],
  ["search_my_approver_groups", "list_approver_groups"],
  ["search_my_scorecard_questions", "list_scorecard_questions"],
  ["search_my_scorecard_question_options", "list_scorecard_question_options"],
  ["search_my_scorecard_question_answer_options", "list_scorecard_question_answer_options"],
  ["search_my_interview_kits", "list_interview_kits"],
  ["search_my_default_interviewers", "list_default_interviewers"],
  ["search_my_job_post_locations", "list_job_post_locations"],
  ["search_my_pay_input_ranges", "list_pay_input_ranges"],
  ["search_my_interviewer_tags", "list_interviewer_tags"],
  ["search_my_candidate_tags", "list_candidate_tags"],
  ["search_my_prospect_pools", "list_prospect_pools"],
  ["search_my_prospect_pool_stages", "list_prospect_pool_stages"],
  ["search_my_prospect_details", "list_prospect_details"],
  ["search_my_job_boards", "list_job_boards"],
  ["search_my_custom_field_departments", "list_custom_field_departments"],
  ["search_my_custom_field_offices", "list_custom_field_offices"],
] as const;

export const EVIDENCE_TOOL_SCOPED_TOOL_NAMES: ReadonlyMap<string, string> = new Map(
  EVIDENCE_TOOL_SCOPED_TOOL_ENTRIES
);

for (const toolName of HARVEST_V3_EVIDENCE_TOOL_ENDPOINTS.keys()) {
  if (!EVIDENCE_TOOL_SCOPED_TOOL_NAMES.has(toolName)) {
    throw new Error(`Evidence tool ${toolName} has an endpoint mapping but no scoped-reader binding.`);
  }
}

export const SCOPED_ENDPOINT_ADAPTERS: readonly ScopedEndpointAdapter[] = HARVEST_V3_ENDPOINT_REGISTRY.map(
  (endpoint): ScopedEndpointAdapter => {
    const evidenceTools = evidenceToolsForEndpoint(endpoint.path);
    const exposure = exposureForEndpoint(endpoint, evidenceTools);
    return {
      endpointPath: endpoint.path,
      endpoint,
      scopeClass: endpoint.scopeClass,
      sensitivityClass: endpoint.sensitivityClass,
      defaultProjectionProfile: endpoint.defaultProjectionProfile,
      allowedProjectionProfiles: endpoint.allowedProjectionProfiles,
      joinDependencies: endpoint.joinDependencies,
      scopePolicy: endpoint.scopePolicy,
      boundingRule: boundingRuleForScopeClass(endpoint.scopeClass),
      exposure,
      evidenceTools,
      nonExposureReason: nonExposureReason(endpoint, exposure),
    };
  }
);

export const SCOPED_ENDPOINT_ADAPTERS_BY_PATH: ReadonlyMap<string, ScopedEndpointAdapter> = new Map(
  SCOPED_ENDPOINT_ADAPTERS.map((adapter) => [adapter.endpointPath, adapter])
);

export const SCOPED_ENDPOINT_ADAPTERS_BY_EVIDENCE_TOOL: ReadonlyMap<string, EvidenceEndpointAdapter> = new Map(
  SCOPED_ENDPOINT_ADAPTERS.flatMap((adapter) =>
    adapter.evidenceTools.map((tool): [string, EvidenceEndpointAdapter] => [
      tool.toolName,
      {
        ...adapter,
        evidenceToolName: tool.toolName,
        scopedToolName: tool.scopedToolName,
      },
    ])
  )
);

export const SCOPED_TOOL_SCOPE_POLICIES: ReadonlyMap<string, ExecutableScopePolicy> = new Map(
  SCOPED_ENDPOINT_ADAPTERS.flatMap((adapter) =>
    adapter.scopePolicy
      ? adapter.evidenceTools.map((tool): [string, ExecutableScopePolicy] => [
          tool.scopedToolName,
          adapter.scopePolicy!,
        ])
      : []
  )
);

export function getEvidenceEndpointAdapter(toolName: string): EvidenceEndpointAdapter | undefined {
  return SCOPED_ENDPOINT_ADAPTERS_BY_EVIDENCE_TOOL.get(toolName);
}

function evidenceToolsForEndpoint(endpointPath: string): EvidenceToolBinding[] {
  const bindings: EvidenceToolBinding[] = [];
  for (const [toolName, mappedPath] of HARVEST_V3_EVIDENCE_TOOL_ENDPOINTS) {
    if (mappedPath !== endpointPath) continue;
    const scopedToolName = EVIDENCE_TOOL_SCOPED_TOOL_NAMES.get(toolName);
    if (!scopedToolName) {
      throw new Error(`Evidence tool ${toolName} has no scoped-reader binding.`);
    }
    bindings.push({ toolName, scopedToolName });
  }
  return bindings.sort((left, right) => left.toolName.localeCompare(right.toolName));
}

function exposureForEndpoint(
  endpoint: EndpointRegistryEntry,
  evidenceTools: EvidenceToolBinding[]
): EndpointExposure {
  if (evidenceTools.length > 0) return "model_evidence";
  if (endpoint.path === "/v3/user_job_permissions") return "internal_permission";
  return "not_exposed";
}

function nonExposureReason(endpoint: EndpointRegistryEntry, exposure: EndpointExposure): string | null {
  if (exposure === "model_evidence") return null;
  if (exposure === "internal_permission") {
    return "Internal permission infrastructure used by the scoped reader; not exposed as a model-facing evidence tool.";
  }
  if (endpoint.scopeClass === "sensitive_personal" || endpoint.sensitivityClass === "compliance_sensitive") {
    return "Sensitive personal or compliance endpoint; default recruiter surface requires a role/purpose projection decision before exposure.";
  }
  if (endpoint.scopeClass === "admin_reference" || endpoint.sensitivityClass === "admin_diagnostic") {
    return "Admin or operational diagnostic endpoint; kept off the default recruiter evidence surface.";
  }
  if (endpoint.sensitivityClass === "role_gated") {
    return "Role-gated endpoint; kept off the default recruiter evidence surface until a named projection profile is implemented.";
  }
  return "Registry-covered read endpoint without a default model-facing evidence tool; available for future scoped facts or metrics.";
}

function boundingRuleForScopeClass(scopeClass: HarvestScopeClass): string {
  if (scopeClass === "job_scoped") {
    return "Rows must carry a permitted job_id or permitted endpoint parent job before projection.";
  }
  if (scopeClass === "application_backed") {
    return "Rows must carry or join through application_id to an application on a permitted job before projection.";
  }
  if (scopeClass === "candidate_backed") {
    return "Rows must join through candidate applications and retain only candidates with at least one permitted application.";
  }
  if (scopeClass === "interview_backed") {
    return "Rows must join through an interview to a permitted application or job before projection.";
  }
  if (scopeClass === "scorecard_backed") {
    return "Rows must join through a scorecard to a permitted application or job before projection.";
  }
  if (scopeClass === "join_backed") {
    return "Rows must follow the registered parent chain to permitted job ids before projection.";
  }
  if (scopeClass === "global_reference") {
    return "Reference rows are not job-filtered; they may be used only as safe projected dimensions for scoped facts.";
  }
  if (scopeClass === "admin_reference") {
    return "Admin reference rows are not exposed on the default recruiter surface except as internal permission infrastructure.";
  }
  return "Sensitive personal rows require an explicit role, purpose, and projection profile before model exposure.";
}
