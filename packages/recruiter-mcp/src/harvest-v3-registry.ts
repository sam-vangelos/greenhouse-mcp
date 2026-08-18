import { HARVEST_V3_ENDPOINT_DOC_FACTS } from "./harvest-v3-registry.generated.js";
import type {
  ScopeJoinDependency,
  ScopeTerminal as ExecutableScopeTerminal,
} from "../../scoped-core/src/index.js";

export type HarvestEndpointMethod = "GET";
export type HarvestScopeClass =
  | "job_scoped"
  | "application_backed"
  | "candidate_backed"
  | "interview_backed"
  | "scorecard_backed"
  | "join_backed"
  | "global_reference"
  | "admin_reference"
  | "sensitive_personal";
export type HarvestSensitivityClass =
  | "default_operational"
  | "role_gated"
  | "admin_diagnostic"
  | "compliance_sensitive";
export type ProjectionProfileName =
  | "default_operational"
  | "safe_reference"
  | "admin_diagnostic"
  | "compliance_limited"
  | "internal_permission";

export interface ParameterSpec {
  name: string;
  in: string;
  required: boolean;
  type: string;
  enumValues?: string[];
}

export interface FieldSpec {
  name: string;
  required: boolean;
  type: string;
}

/** The lower scoped-greenhouse package owns the executable authorization-policy contract. */
export type JoinDependency = ScopeJoinDependency;

export type ScopeTerminal = ExecutableScopeTerminal;

export type EndpointScopePolicy =
  | {
      kind: "direct";
      terminal: ScopeTerminal;
      redactToPermittedJobIds?: boolean;
    }
  | {
      kind: "join_backed";
      dependencies: JoinDependency[];
      terminal: ScopeTerminal;
      rowVisibility?: "public_only";
    };

export interface FieldAlias {
  canonical: string;
  alias: string;
  note: string;
}

export interface EndpointRegistryEntry {
  path: string;
  method: HarvestEndpointMethod;
  sourceDocPath: string;
  list: boolean;
  cursorPaginated: boolean;
  parameters: ParameterSpec[];
  responseFields: FieldSpec[];
  toolName?: string;
  scopeClass: HarvestScopeClass;
  sensitivityClass: HarvestSensitivityClass;
  defaultProjectionProfile: ProjectionProfileName;
  allowedProjectionProfiles: ProjectionProfileName[];
  joinDependencies: JoinDependency[];
  scopePolicy: EndpointScopePolicy | null;
  completenessRequirement: "all_pages" | "explicit_user_bound" | "single_record";
  knownAliases: FieldAlias[];
}

export interface HiddenModelParameter {
  name: string;
  reason: string;
}

const EVIDENCE_TOOL_ENDPOINT_PAIRS = [
  ["search_my_jobs", "/v3/jobs"],
  ["get_my_job", "/v3/jobs"],
  ["search_my_job_owners", "/v3/job_owners"],
  ["search_my_openings", "/v3/openings"],
  ["search_my_job_interview_stages", "/v3/job_interview_stages"],
  ["search_my_job_interviews", "/v3/job_interviews"],
  ["search_my_interviews", "/v3/interviews"],
  ["search_my_application_stages", "/v3/application_stages"],
  ["search_my_applications", "/v3/applications"],
  ["get_my_application", "/v3/applications"],
  ["search_my_candidates", "/v3/candidates"],
  ["get_my_candidate", "/v3/candidates"],
  ["search_my_scorecards", "/v3/scorecards"],
  ["search_my_rejection_details", "/v3/rejection_details"],
  ["search_my_rejection_reasons", "/v3/rejection_reasons"],
  ["search_my_users", "/v3/users"],
  ["get_my_user", "/v3/users"],
  ["search_my_sources", "/v3/sources"],
  ["search_my_referrers", "/v3/referrers"],
  ["search_my_notes", "/v3/notes"],
  ["search_my_tracking_links", "/v3/tracking_links"],
  ["search_my_offers", "/v3/offers"],
  ["search_my_departments", "/v3/departments"],
  ["search_my_offices", "/v3/offices"],
  ["search_my_close_reasons", "/v3/close_reasons"],
  ["search_my_custom_field_options", "/v3/custom_field_options"],
  ["search_my_attachments", "/v3/attachments"],
  ["search_my_job_hiring_managers", "/v3/job_hiring_managers"],
  ["search_my_job_notes", "/v3/job_notes"],
  ["search_my_job_posts", "/v3/job_posts"],
  ["search_my_interviewers", "/v3/interviewers"],
  ["search_my_scorecard_question_answers", "/v3/scorecard_question_answers"],
  ["search_my_candidate_educations", "/v3/candidate_educations"],
  ["search_my_candidate_employments", "/v3/candidate_employments"],
  ["search_my_custom_fields", "/v3/custom_fields"],
  ["search_my_pay_inputs", "/v3/pay_inputs"],
  ["search_my_approval_flows", "/v3/approval_flows"],
  ["search_my_approvers", "/v3/approvers"],
  ["search_my_approver_groups", "/v3/approver_groups"],
  ["search_my_scorecard_questions", "/v3/scorecard_questions"],
  ["search_my_scorecard_question_options", "/v3/scorecard_question_options"],
  ["search_my_scorecard_question_answer_options", "/v3/scorecard_question_answer_options"],
  ["search_my_interview_kits", "/v3/interview_kits"],
  ["search_my_default_interviewers", "/v3/default_interviewers"],
  ["search_my_job_post_locations", "/v3/job_post_locations"],
  ["search_my_pay_input_ranges", "/v3/pay_input_ranges"],
  ["search_my_interviewer_tags", "/v3/interviewer_tags"],
  ["search_my_candidate_tags", "/v3/candidate_tags"],
  ["search_my_prospect_pools", "/v3/prospect_pools"],
  ["search_my_prospect_pool_stages", "/v3/prospect_pool_stages"],
  ["search_my_prospect_details", "/v3/prospect_details"],
  ["search_my_job_boards", "/v3/job_boards"],
  ["search_my_custom_field_departments", "/v3/custom_field_departments"],
  ["search_my_custom_field_offices", "/v3/custom_field_offices"],
] as const;

export const HARVEST_V3_EVIDENCE_TOOL_ENDPOINTS: ReadonlyMap<string, string> = new Map(EVIDENCE_TOOL_ENDPOINT_PAIRS);

const PRIMARY_TOOL_BY_ENDPOINT = new Map<string, string>();
for (const [toolName, endpointPath] of EVIDENCE_TOOL_ENDPOINT_PAIRS) {
  if (!PRIMARY_TOOL_BY_ENDPOINT.has(endpointPath) || toolName.startsWith("search_")) {
    PRIMARY_TOOL_BY_ENDPOINT.set(endpointPath, toolName);
  }
}

const JOB_SCOPED_ENDPOINTS = new Set([
  "/v3/applications",
  "/v3/approval_flows",
  "/v3/candidate_attribute_types",
  "/v3/focus_candidate_attributes",
  "/v3/interview_kits",
  "/v3/interviews",
  "/v3/job_board_custom_locations",
  "/v3/job_candidate_attributes",
  "/v3/job_hiring_managers",
  "/v3/job_interview_stages",
  "/v3/job_interviews",
  "/v3/job_notes",
  "/v3/job_owners",
  "/v3/job_post_searchable_locations",
  "/v3/job_posts",
  "/v3/jobs",
  "/v3/offers",
  "/v3/openings",
  "/v3/prospect_pools",
  "/v3/tracking_links",
]);

const APPLICATION_BACKED_ENDPOINTS = new Set([
  "/v3/application_stages",
  "/v3/attachments",
  "/v3/demographic_answers",
  "/v3/eeoc",
  "/v3/notes",
  "/v3/prospect_details",
  "/v3/rejection_details",
  "/v3/scorecards",
]);

const CANDIDATE_BACKED_ENDPOINTS = new Set([
  "/v3/applied_candidate_tags",
  "/v3/candidate_educations",
  "/v3/candidate_employments",
  "/v3/candidates",
]);

const INTERVIEW_BACKED_ENDPOINTS = new Set([
  "/v3/interviewers",
]);

const SCORECARD_BACKED_ENDPOINTS = new Set([
  "/v3/scorecard_candidate_attributes",
  "/v3/scorecard_question_answers",
  "/v3/scorecard_question_candidate_attributes",
]);

const JOIN_BACKED_ENDPOINTS = new Set([
  "/v3/approver_groups",
  "/v3/approvers",
  "/v3/default_interviewers",
  "/v3/job_post_locations",
  "/v3/pay_input_ranges",
  "/v3/prospect_pool_stages",
  "/v3/scorecard_question_answer_options",
  "/v3/scorecard_question_options",
  "/v3/scorecard_questions",
]);

// Endpoint semantics and policy execution are related but not identical:
// application_stages remains application_backed for model/schema behavior, yet
// uses the generic ordered join resolver to avoid a per-row authorization N+1.
const EXECUTABLE_JOIN_POLICY_ENDPOINTS = new Set([
  ...JOIN_BACKED_ENDPOINTS,
  "/v3/application_stages",
]);

const GLOBAL_REFERENCE_ENDPOINTS = new Set([
  "/v3/candidate_tags",
  "/v3/close_reasons",
  "/v3/custom_field_departments",
  "/v3/custom_field_offices",
  "/v3/custom_field_options",
  "/v3/custom_fields",
  "/v3/departments",
  "/v3/email_templates",
  "/v3/interviewer_tags",
  "/v3/job_boards",
  "/v3/offices",
  "/v3/pay_inputs",
  "/v3/referrers",
  "/v3/rejection_reasons",
  "/v3/rejection_reasons/{id}",
  "/v3/sources",
  "/v3/users",
]);

const ADMIN_REFERENCE_ENDPOINTS = new Set([
  "/v3/blocked_spam_sources",
  "/v3/bulk_requests",
  "/v3/bulk_requests/{bulk_action_uuid}",
  "/v3/future_job_permissions",
  "/v3/user_job_permissions",
  "/v3/user_roles",
]);

const SENSITIVE_PERSONAL_ENDPOINTS = new Set([
  "/v3/user_emails",
]);

const ROLE_GATED_ENDPOINTS = new Set([
  "/v3/approval_flows",
  "/v3/approver_groups",
  "/v3/approvers",
  "/v3/attachments",
  "/v3/candidate_educations",
  "/v3/candidate_employments",
  "/v3/candidates",
  "/v3/custom_field_departments",
  "/v3/custom_field_offices",
  "/v3/custom_field_options",
  "/v3/custom_fields",
  "/v3/email_templates",
  "/v3/job_notes",
  "/v3/notes",
  "/v3/offers",
  "/v3/pay_input_ranges",
  "/v3/pay_inputs",
  "/v3/prospect_details",
  "/v3/prospect_pool_stages",
  "/v3/prospect_pools",
  "/v3/scorecard_candidate_attributes",
  "/v3/scorecard_question_answer_options",
  "/v3/scorecard_question_answers",
  "/v3/scorecard_question_candidate_attributes",
  "/v3/scorecard_question_options",
  "/v3/scorecard_questions",
  "/v3/scorecards",
  "/v3/user_emails",
  "/v3/users",
]);

const COMPLIANCE_SENSITIVE_ENDPOINTS = new Set([
  "/v3/demographic_answer_options",
  "/v3/demographic_answers",
  "/v3/demographic_question_sets",
  "/v3/demographic_questions",
  "/v3/eeoc",
]);

const ADMIN_DIAGNOSTIC_ENDPOINTS = new Set([
  ...ADMIN_REFERENCE_ENDPOINTS,
  "/v3/blocked_spam_sources",
]);

const GLOBAL_HIDDEN_MODEL_PARAMS: Record<string, string> = {
  fields: "Projection fields are governed by registry projection profiles, not model-supplied raw field selectors.",
};

const PATH_HIDDEN_MODEL_PARAMS: Record<string, Record<string, string>> = {
  "/v3/candidates": {
    email: "Candidate email is contact PII and is not exposed on the default recruiter evidence surface.",
    private: "Private-candidate visibility is a role gate, not a default model filter.",
    custom_field_option_id: "Candidate custom-field filtering is deferred to role-aware projection profiles.",
  },
  // custom_field_option_id is exposed as a FILTER on openings, rejection_details, and users (Rank 23):
  // it lets a recruiter narrow those reads to a custom-field value, which the recruiter's own
  // Greenhouse entitlement already permits — the former "role-aware projection decision" reason cited
  // no external constraint. It stays hidden on /v3/offers (offer custom fields are compensation-
  // sensitive) and /v3/candidates (candidate-attribute filtering is a separate, more sensitive call).
  "/v3/offers": {
    custom_field_option_id: "Offer custom fields can include compensation-sensitive facts and require a role profile.",
  },
  "/v3/tracking_links": {
    token: "Tracking-link tokens are intentionally omitted from default recruiter evidence.",
  },
  "/v3/users": {
    primary_email: "User email is contact data and is hidden from the default user reference profile.",
    show_service_accounts: "Service-account enumeration is an admin diagnostic control.",
  },
  "/v3/user_emails": {
    email: "User email inventory is sensitive personal data and is not exposed by default.",
    verification_token_sent_at: "Email verification timing is sensitive account metadata.",
  },
};

export const HARVEST_V3_ENDPOINT_REGISTRY: EndpointRegistryEntry[] = HARVEST_V3_ENDPOINT_DOC_FACTS.map((fact) => {
  const scopeClass = scopeClassForPath(fact.path);
  const sensitivityClass = sensitivityClassForPath(fact.path);
  const joinDependencies = joinDependenciesForPath(fact.path, scopeClass);
  return {
    path: fact.path,
    method: "GET",
    sourceDocPath: fact.sourceDocPath,
    list: fact.list,
    cursorPaginated: fact.cursorPaginated,
    parameters: fact.parameters.map((param) => ({
      name: param.name,
      in: param.in,
      required: param.required,
      type: param.type,
      ...("enumValues" in param ? { enumValues: [...param.enumValues] } : {}),
    })),
    responseFields: fact.responseFields.map((field) => ({
      name: field.name,
      required: field.required,
      type: field.type,
    })),
    ...(PRIMARY_TOOL_BY_ENDPOINT.has(fact.path) ? { toolName: PRIMARY_TOOL_BY_ENDPOINT.get(fact.path) } : {}),
    scopeClass,
    sensitivityClass,
    defaultProjectionProfile: defaultProjectionProfile(sensitivityClass, fact.path),
    allowedProjectionProfiles: allowedProjectionProfiles(sensitivityClass, fact.path),
    joinDependencies,
    scopePolicy: scopePolicyForPath(fact.path, joinDependencies),
    completenessRequirement: fact.list ? "all_pages" : "single_record",
    knownAliases: knownAliasesForPath(fact.path),
  };
});

export const HARVEST_V3_ENDPOINT_REGISTRY_BY_PATH: ReadonlyMap<string, EndpointRegistryEntry> = new Map(
  HARVEST_V3_ENDPOINT_REGISTRY.map((entry) => [entry.path, entry])
);

validateHarvestScopePolicies(HARVEST_V3_ENDPOINT_REGISTRY);

export function getHarvestEndpointByPath(path: string): EndpointRegistryEntry | undefined {
  return HARVEST_V3_ENDPOINT_REGISTRY_BY_PATH.get(path);
}

export function getHarvestEndpointForEvidenceTool(toolName: string): EndpointRegistryEntry | undefined {
  const path = HARVEST_V3_EVIDENCE_TOOL_ENDPOINTS.get(toolName);
  return path ? getHarvestEndpointByPath(path) : undefined;
}

export function getModelExposedParametersForEndpoint(path: string): ParameterSpec[] {
  const entry = requireEndpoint(path);
  const hidden = hiddenModelParameterMap(path);
  return entry.parameters.filter((param) => !hidden.has(param.name));
}

export function getHiddenModelParametersForEndpoint(path: string): HiddenModelParameter[] {
  return [...hiddenModelParameterMap(path)].map(([name, reason]) => ({ name, reason }));
}

export function getModelParamNamesForEvidenceTool(toolName: string): ReadonlySet<string> {
  if (toolName.startsWith("get_")) {
    return new Set(["id"]);
  }
  const entry = getHarvestEndpointForEvidenceTool(toolName);
  if (!entry) return new Set();
  return new Set(getModelExposedParametersForEndpoint(entry.path).map((param) => param.name));
}

function hiddenModelParameterMap(path: string): Map<string, string> {
  return new Map([
    ...Object.entries(GLOBAL_HIDDEN_MODEL_PARAMS),
    ...Object.entries(PATH_HIDDEN_MODEL_PARAMS[path] ?? {}),
  ]);
}

function requireEndpoint(path: string): EndpointRegistryEntry {
  const entry = getHarvestEndpointByPath(path);
  if (!entry) {
    throw new Error(`Harvest v3 endpoint is missing from the registry: ${path}`);
  }
  return entry;
}

export function validateHarvestScopePolicies(
  entries: readonly EndpointRegistryEntry[]
): void {
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  for (const entry of entries) {
    const policy = entry.scopePolicy;
    if (EXECUTABLE_JOIN_POLICY_ENDPOINTS.has(entry.path) && (!policy || policy.kind !== "join_backed")) {
      throw new Error(`${entry.path}: join_backed endpoint is missing an executable join policy.`);
    }
    if (!policy) continue;

    if (policy.kind === "direct") {
      assertField(entry, policy.terminal.field, "terminal field");
      assertFilter(entry, policy.terminal.filter, "terminal filter");
      assertJobTerminal(entry.path, policy.terminal);
      assertTerminalCompatibility(entry, policy.terminal);
      continue;
    }

    if (policy.dependencies.length === 0) {
      throw new Error(`${entry.path}: join-backed policy has no dependencies.`);
    }
    let current = entry;
    const visited = new Set([entry.path]);
    for (const dependency of policy.dependencies) {
      assertField(current, dependency.field, "join source field");
      assertFilter(current, dependency.sourceFilter, "join source filter");
      const target = byPath.get(dependency.targetEndpoint);
      if (!target) {
        throw new Error(`${entry.path}: join target is not registered: ${dependency.targetEndpoint}`);
      }
      if (visited.has(target.path)) {
        throw new Error(`${entry.path}: scope join graph contains a cycle at ${target.path}.`);
      }
      visited.add(target.path);
      assertField(target, dependency.targetField, "join target field");
      assertFilter(target, dependency.targetFilter, "join target filter");
      current = target;
    }
    assertField(current, policy.terminal.field, "terminal field");
    assertFilter(current, policy.terminal.filter, "terminal filter");
    assertJobTerminal(entry.path, policy.terminal);
    assertTerminalCompatibility(current, policy.terminal);
  }
}

function assertField(entry: EndpointRegistryEntry, field: string, label: string): void {
  if (!entry.responseFields.some((candidate) => candidate.name === field)) {
    throw new Error(`${entry.path}: ${label} is not documented: ${field}`);
  }
}

function assertFilter(entry: EndpointRegistryEntry, filter: string, label: string): void {
  if (!entry.parameters.some((candidate) => candidate.name === filter)) {
    throw new Error(`${entry.path}: ${label} is not documented: ${filter}`);
  }
}

function assertJobTerminal(path: string, terminal: ScopeTerminal): void {
  if (terminal.field !== "job_id" && terminal.field !== "job_ids") {
    throw new Error(`${path}: scope policy does not terminate at job ids.`);
  }
}

function assertTerminalCompatibility(entry: EndpointRegistryEntry, terminal: ScopeTerminal): void {
  const compatibility = terminal.compatibility;
  if (!compatibility) return;
  if (terminal.multiple || compatibility.kind !== "single_nested_id") {
    throw new Error(`${entry.path}: terminal compatibility must resolve one nested id.`);
  }
  const alias = `${compatibility.field}[].${compatibility.idField}`;
  if (!entry.knownAliases.some((candidate) => candidate.canonical === terminal.field && candidate.alias === alias)) {
    throw new Error(`${entry.path}: terminal compatibility is not declared as a known alias: ${alias}`);
  }
}

function scopeClassForPath(path: string): HarvestScopeClass {
  if (JOB_SCOPED_ENDPOINTS.has(path)) return "job_scoped";
  if (APPLICATION_BACKED_ENDPOINTS.has(path)) return "application_backed";
  if (CANDIDATE_BACKED_ENDPOINTS.has(path)) return "candidate_backed";
  if (INTERVIEW_BACKED_ENDPOINTS.has(path)) return "interview_backed";
  if (SCORECARD_BACKED_ENDPOINTS.has(path)) return "scorecard_backed";
  if (JOIN_BACKED_ENDPOINTS.has(path)) return "join_backed";
  if (GLOBAL_REFERENCE_ENDPOINTS.has(path)) return "global_reference";
  if (ADMIN_REFERENCE_ENDPOINTS.has(path)) return "admin_reference";
  if (SENSITIVE_PERSONAL_ENDPOINTS.has(path)) return "sensitive_personal";
  if (COMPLIANCE_SENSITIVE_ENDPOINTS.has(path)) return "sensitive_personal";
  throw new Error(`Harvest v3 endpoint has no scope classification: ${path}`);
}

function sensitivityClassForPath(path: string): HarvestSensitivityClass {
  if (COMPLIANCE_SENSITIVE_ENDPOINTS.has(path)) return "compliance_sensitive";
  if (ADMIN_DIAGNOSTIC_ENDPOINTS.has(path)) return "admin_diagnostic";
  if (ROLE_GATED_ENDPOINTS.has(path)) return "role_gated";
  return "default_operational";
}

function defaultProjectionProfile(sensitivityClass: HarvestSensitivityClass, path: string): ProjectionProfileName {
  if (path === "/v3/user_job_permissions") return "internal_permission";
  if (sensitivityClass === "admin_diagnostic") return "admin_diagnostic";
  if (sensitivityClass === "compliance_sensitive") return "compliance_limited";
  if (sensitivityClass === "role_gated") return "safe_reference";
  return "default_operational";
}

// Advisory classification metadata only. The live recruiter projection applies one fixed
// per-tool allowlist (recruiter_default); there is NO profile-selection argument that restores
// a fuller view, so this list must not advertise a profile the projection cannot produce.
// Dropped fields are disclosed per-call in `projection.omittedFields` with a reason (#9). The
// former `role_gated_detail` entry implied a role-gated restore tier that nothing consumes and
// was removed so a future reader does not mistake it for a live restore path.
function allowedProjectionProfiles(sensitivityClass: HarvestSensitivityClass, path: string): ProjectionProfileName[] {
  if (path === "/v3/user_job_permissions") return ["internal_permission", "admin_diagnostic"];
  if (sensitivityClass === "admin_diagnostic") return ["admin_diagnostic"];
  if (sensitivityClass === "compliance_sensitive") return ["compliance_limited"];
  if (sensitivityClass === "role_gated") return ["safe_reference"];
  return ["default_operational"];
}

function joinDependenciesForPath(path: string, scopeClass: HarvestScopeClass): JoinDependency[] {
  if (path === "/v3/application_stages" || path === "/v3/rejection_details" || path === "/v3/scorecards" || path === "/v3/prospect_details") {
    return [scopeJoin("application_id", "application_ids", "/v3/applications")];
  }
  if (path === "/v3/notes" || path === "/v3/attachments") {
    return [
      scopeJoin("application_id", "application_ids", "/v3/applications"),
      scopeJoin("candidate_id", "candidate_ids", "/v3/applications", "candidate_id", "candidate_ids"),
    ];
  }
  if (path === "/v3/interviewers") {
    return [scopeJoin("interview_id", "interview_ids", "/v3/interviews")];
  }
  if (path === "/v3/scorecard_question_answers") {
    return [scopeJoin("scorecard_id", "scorecard_ids", "/v3/scorecards")];
  }
  if (path === "/v3/approvers") {
    return [
      scopeJoin("approver_group_id", "approver_group_ids", "/v3/approver_groups"),
      scopeJoin("approval_flow_id", "approval_flow_ids", "/v3/approval_flows"),
    ];
  }
  if (path === "/v3/approver_groups") {
    return [scopeJoin("approval_flow_id", "approval_flow_ids", "/v3/approval_flows")];
  }
  if (path === "/v3/scorecard_questions" || path === "/v3/default_interviewers") {
    return [scopeJoin("interview_kit_id", "interview_kit_ids", "/v3/interview_kits")];
  }
  if (path === "/v3/scorecard_question_options") {
    return [
      scopeJoin("scorecard_question_id", "scorecard_question_ids", "/v3/scorecard_questions"),
      scopeJoin("interview_kit_id", "interview_kit_ids", "/v3/interview_kits"),
    ];
  }
  if (path === "/v3/scorecard_question_answer_options") {
    return [
      scopeJoin("scorecard_question_answer_id", "scorecard_question_answer_ids", "/v3/scorecard_question_answers"),
      scopeJoin("scorecard_id", "scorecard_ids", "/v3/scorecards"),
      scopeJoin("application_id", "application_ids", "/v3/applications"),
    ];
  }
  if (path === "/v3/job_post_locations" || path === "/v3/pay_input_ranges") {
    return [scopeJoin("job_post_id", "job_post_ids", "/v3/job_posts")];
  }
  if (path === "/v3/prospect_pool_stages") {
    return [scopeJoin("prospect_pool_id", "prospect_pool_ids", "/v3/prospect_pools")];
  }
  if (scopeClass === "candidate_backed") {
    return [scopeJoin("candidate_id", "candidate_ids", "/v3/applications", "candidate_id", "candidate_ids")];
  }
  return [];
}

function scopeJoin(
  field: string,
  sourceFilter: string,
  targetEndpoint: string,
  targetField = "id",
  targetFilter = "ids"
): JoinDependency {
  return { field, sourceFilter, targetEndpoint, targetField, targetFilter, purpose: "scope" };
}

function scopePolicyForPath(
  path: string,
  dependencies: JoinDependency[]
): EndpointScopePolicy | null {
  if (path === "/v3/prospect_pools") {
    return {
      kind: "direct",
      terminal: scopeTerminalForEndpoint(path),
      redactToPermittedJobIds: true,
    };
  }
  if (path === "/v3/applications") {
    return {
      kind: "direct",
      terminal: scopeTerminalForEndpoint(path),
    };
  }
  // application_stages is semantically application-backed, but its existing
  // row-by-row fallback resolves each application_id with a separate upstream
  // request. Opt this endpoint into the same executable policy graph used by
  // the reference joins so the generic resolver can dedupe and batch those
  // parents without changing the endpoint's public scope classification.
  //
  // Do not infer this for every endpoint with dependencies: notes/attachments
  // have alternative application/candidate paths, not one ordered chain.
  if (!EXECUTABLE_JOIN_POLICY_ENDPOINTS.has(path)) return null;
  const terminalEndpoint = dependencies[dependencies.length - 1]?.targetEndpoint ?? path;
  return {
    kind: "join_backed",
    dependencies,
    terminal: scopeTerminalForEndpoint(terminalEndpoint),
    ...(path === "/v3/application_stages" ? { rowVisibility: "public_only" as const } : {}),
  };
}

function scopeTerminalForEndpoint(path: string): ScopeTerminal {
  if (path === "/v3/prospect_pools") {
    return { field: "job_ids", filter: "job_ids", multiple: true };
  }
  if (path === "/v3/applications") {
    return {
      field: "job_id",
      filter: "job_ids",
      compatibility: { kind: "single_nested_id", field: "jobs", idField: "id" },
    };
  }
  return { field: "job_id", filter: "job_ids" };
}

function knownAliasesForPath(path: string): FieldAlias[] {
  if (path === "/v3/applications") {
    return [
      { canonical: "job_id", alias: "jobs[].id", note: "Observed production v3 compatibility shape; authorization accepts exactly one unambiguous nested job id." },
      { canonical: "created_at", alias: "applied_at", note: "Harvest v3 uses created_at where older surfaces often said applied_at." },
      { canonical: "stage_id", alias: "current_stage_id", note: "The v3 application row carries stage_id for the current application stage snapshot." },
    ];
  }
  if (path === "/v3/offers") {
    return [{ canonical: "starts_on", alias: "start_date", note: "Preserve the v3 starts_on field; start_date is a legacy/display alias." }];
  }
  if (path === "/v3/openings") {
    return [{ canonical: "target_start_on", alias: "target_start_date", note: "Preserve the v3 target_start_on field name." }];
  }
  if (path === "/v3/users") {
    return [
      { canonical: "job_title", alias: "title", note: "Harvest v3 user rows expose job_title, not title." },
      { canonical: "deactivated", alias: "disabled", note: "Harvest v3 user rows expose deactivated, not disabled." },
    ];
  }
  return [];
}
