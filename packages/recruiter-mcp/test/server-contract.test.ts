import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { registerRecruiterTools, RECRUITER_READ_ONLY_TOOL_ANNOTATIONS, RECRUITER_TOOL_DEFINITIONS } from "../src/tools/register.js";
import { fakeScopedReader, scopedSuccess, testRuntime } from "./test-helpers.js";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

describe("recruiter MCP server contract", () => {
  it("registers only recruiter evidence and analysis tools, never write/admin tools", () => {
    const names = RECRUITER_TOOL_DEFINITIONS.map((tool) => tool.name);

    assert.deepStrictEqual(names, [
      "search_my_jobs",
      "get_my_job",
      "search_my_job_owners",
      "search_my_openings",
      "search_my_job_interview_stages",
      "search_my_job_interviews",
      "search_my_interviews",
      "search_my_application_stages",
      "search_my_applications",
      "get_my_application",
      "search_my_candidates",
      "get_my_candidate",
      "search_my_scorecards",
      "search_my_rejection_details",
      "search_my_rejection_reasons",
      "search_my_users",
      "get_my_user",
      "search_my_sources",
      "search_my_referrers",
      "search_my_notes",
      "search_my_tracking_links",
      "search_my_offers",
      "search_my_departments",
      "search_my_offices",
      "search_my_close_reasons",
      "search_my_custom_field_options",
      "search_my_attachments",
      "search_my_job_hiring_managers",
      "search_my_job_notes",
      "search_my_job_posts",
      "search_my_interviewers",
      "search_my_scorecard_question_answers",
      "search_my_candidate_educations",
      "search_my_candidate_employments",
      "search_my_custom_fields",
      "search_my_pay_inputs",
      "search_my_approval_flows",
      "search_my_approvers",
      "search_my_approver_groups",
      "search_my_scorecard_questions",
      "search_my_scorecard_question_options",
      "search_my_scorecard_question_answer_options",
      "search_my_interview_kits",
      "search_my_default_interviewers",
      "search_my_job_post_locations",
      "search_my_pay_input_ranges",
      "search_my_interviewer_tags",
      "search_my_candidate_tags",
      "search_my_prospect_pools",
      "search_my_prospect_pool_stages",
      "search_my_prospect_details",
      "search_my_job_boards",
      "search_my_custom_field_departments",
      "search_my_custom_field_offices",
      "resolve_job_scope",
      "confirm_job_scope",
      "get_job_scope",
      "get_recruiting_capabilities",
      "analyze_scorecard_accountability",
      "analyze_interview_feedback_drag",
      "analyze_stage_latency",
      "analyze_pipeline_quality",
      "analyze_source_quality",
      "analyze_rejection_reason_drift",
      "answer_my_recruiting_question",
      "read_my_resume",
    ]);
    assert.equal(names.some((name) => /^(reject_|move_|patch_|create_offer|add_|remove_|update_)/.test(name)), false);
  });

  it("registers tools through the supplied MCP server object", () => {
    const scopedReader = fakeScopedReader((toolName) => scopedSuccess(toolName, []));
    const { runtime } = testRuntime(scopedReader);
    const registered: string[] = [];
    const server = {
      tool(name: string) {
        registered.push(name);
      },
    };

    const returned = registerRecruiterTools(server as any, runtime);

    assert.deepStrictEqual(returned, registered);
    assert.ok(registered.includes("analyze_scorecard_accountability"));
    assert.ok(registered.includes("analyze_interview_feedback_drag"));
    assert.ok(registered.includes("analyze_stage_latency"));
    assert.ok(registered.includes("analyze_pipeline_quality"));
    assert.ok(registered.includes("analyze_source_quality"));
    assert.ok(registered.includes("answer_my_recruiting_question"));
    assert.ok(registered.includes("read_my_resume"));
    assert.ok(registered.includes("search_my_applications"));
  });

  it("exposes read_my_resume with only an exact attachment_id input", () => {
    const scopedReader = fakeScopedReader((toolName) => scopedSuccess(toolName, []));
    const { runtime } = testRuntime(scopedReader);
    const schemas = new Map<string, Record<string, unknown>>();
    registerRecruiterTools({
      tool(name: string, _description: string, paramsSchema: Record<string, unknown>) {
        schemas.set(name, paramsSchema);
      },
    } as any, runtime);

    assert.deepStrictEqual(Object.keys(schemas.get("read_my_resume") ?? {}), ["attachment_id"]);
  });

  it("exposes stage filters on recruiter evidence search schemas without identity params", () => {
    const scopedReader = fakeScopedReader((toolName) => scopedSuccess(toolName, []));
    const { runtime } = testRuntime(scopedReader);
    const schemas = new Map<string, Record<string, unknown>>();
    const server = {
      tool(name: string, _description: string, paramsSchema: Record<string, unknown>) {
        schemas.set(name, paramsSchema);
      },
    };

    registerRecruiterTools(server as any, runtime);

    const applicationSchema = schemas.get("search_my_applications");
    assert.ok(applicationSchema);
    assert.ok("stage_ids" in applicationSchema);
    assert.ok("stage_name" in applicationSchema);
    assert.ok("job_ids" in applicationSchema);
    assert.ok("status" in applicationSchema);
    assert.equal("actAsUser" in applicationSchema, false);
    assert.equal("on_behalf_of_user_id" in applicationSchema, false);
    assert.equal("greenhouse_user_id" in applicationSchema, false);
    assert.equal("email" in applicationSchema, false);
  });

  it("does not advertise unsupported resolver match modes", () => {
    const scopedReader = fakeScopedReader((toolName) => scopedSuccess(toolName, []));
    const { runtime } = testRuntime(scopedReader);
    const schemas = new Map<string, Record<string, unknown>>();
    const server = {
      tool(name: string, _description: string, paramsSchema: Record<string, unknown>) {
        schemas.set(name, paramsSchema);
      },
    };

    registerRecruiterTools(server as any, runtime);

    const resolveSchema = schemas.get("resolve_job_scope");
    assert.ok(resolveSchema);
    assert.equal("match_mode" in resolveSchema, false);
  });

  it("marks every recruiter MCP tool as read-only and non-destructive", () => {
    const scopedReader = fakeScopedReader((toolName) => scopedSuccess(toolName, []));
    const { runtime } = testRuntime(scopedReader);
    const annotations = new Map<string, Record<string, unknown>>();
    const server = {
      tool(name: string, _description: string, _paramsSchema: Record<string, unknown>, toolAnnotations: Record<string, unknown>) {
        annotations.set(name, toolAnnotations);
      },
    };

    const registered = registerRecruiterTools(server as any, runtime);

    assert.equal(registered.length, RECRUITER_TOOL_DEFINITIONS.length);
    for (const name of registered) {
      assert.deepStrictEqual(annotations.get(name), RECRUITER_READ_ONLY_TOOL_ANNOTATIONS);
    }
  });

  it("does not register analytical tools when analytics are disabled", () => {
    const scopedReader = fakeScopedReader((toolName) => scopedSuccess(toolName, []));
    const { runtime } = testRuntime(scopedReader, {
      toolConfig: {
        serverDisabled: false,
        disabledTools: new Set<string>(),
        evidenceToolsEnabled: true,
        analyticalToolsEnabled: false,
        claudeDesktopEnabled: true,
        chatgptDesktopEnabled: true,
        operatorUnscopedEnabled: true,
      },
    });
    const registered: string[] = [];

    registerRecruiterTools({ tool: (name: string) => registered.push(name) } as any, runtime);

    assert.equal(registered.includes("analyze_scorecard_accountability"), false);
    assert.equal(registered.includes("analyze_interview_feedback_drag"), false);
    assert.equal(registered.includes("analyze_stage_latency"), false);
    assert.equal(registered.includes("analyze_pipeline_quality"), false);
    assert.equal(registered.includes("analyze_source_quality"), false);
    assert.equal(registered.includes("answer_my_recruiting_question"), false);
    assert.ok(registered.includes("search_my_jobs"));
  });

  it("keeps raw Greenhouse client imports isolated to scoped-reader construction", () => {
    const offenders: string[] = [];
    for (const filePath of walk(join(packageRoot, "src"))) {
      const rel = relative(packageRoot, filePath);
      const source = readFileSync(filePath, "utf8");
      const importsRawClient = source.includes("dist/client.js") || /\bapi(Get|Post|Patch|Delete)\b/.test(source);
      if (importsRawClient && rel !== "src/scoped-reader.ts") {
        offenders.push(rel);
      }
    }

    assert.deepStrictEqual(offenders, []);
  });

  it("keeps write and admin tool names out of the recruiter package source", () => {
    const forbidden = /\b(reject_application|move_application_to_stage|create_offer_draft|apiPost|apiPatch|apiDelete|update_application_assignment)\b/;
    const offenders: string[] = [];
    for (const filePath of walk(join(packageRoot, "src"))) {
      const rel = relative(packageRoot, filePath);
      const source = readFileSync(filePath, "utf8");
      if (forbidden.test(source)) {
        offenders.push(rel);
      }
    }

    assert.deepStrictEqual(offenders, []);
  });
});

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      files.push(...walk(path));
    } else if (path.endsWith(".ts")) {
      files.push(path);
    }
  }
  return files;
}
