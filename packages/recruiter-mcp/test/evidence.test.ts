import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LIMITS } from "../src/limits.js";
import { createInMemoryRateLimiter } from "../src/rate-limit.js";
import { EVIDENCE_DOMAIN_CLASSIFICATIONS, EVIDENCE_TOOL_DEFINITIONS, EVIDENCE_TOOL_MAP, runEvidenceTool } from "../src/tools/evidence.js";
import { EVIDENCE_PROJECTOR_TOOL_NAMES } from "../src/tools/evidence-projection.js";
import { SCOPED_ENDPOINT_ADAPTERS_BY_EVIDENCE_TOOL } from "../src/tools/scoped-endpoint-adapters.js";
import { fakeScopedReader, scopedSuccess, testRuntime } from "./test-helpers.js";
import { nestedJobApplication, v3Offer } from "./fixtures-production-shapes.js";

describe("evidence tools", () => {
  it("projects job_id from the nested jobs:[{id}] production shape (production-shape lock — B2)", async () => {
    const scopedReader = fakeScopedReader((toolName) => {
      if (toolName === "list_applications") {
        return scopedSuccess(toolName, [nestedJobApplication({ id: 101 })]);
      }
      throw new Error(`unexpected tool ${toolName}`);
    });
    const { runtime } = testRuntime(scopedReader);
    const result = await runEvidenceTool(runtime, "search_my_applications", {});
    assert.equal(result.ok, true);
    const rows = result.ok ? (result.data as any[]) : [];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].job_id, 100, "projected application must carry job_id derived from the nested jobs:[{id}] shape");
  });

  it("projects v3 offers with start_date from starts_on and exposes compensation (denylist flip — offers)", async () => {
    const scopedReader = fakeScopedReader((toolName) => {
      if (toolName === "list_offers") return scopedSuccess(toolName, [v3Offer({ id: 9001, job_id: 1 })]);
      throw new Error(`unexpected tool ${toolName}`);
    });
    const { runtime } = testRuntime(scopedReader);
    const result = await runEvidenceTool(runtime, "search_my_offers", {});
    assert.equal(result.ok, true, "search_my_offers must be a registered evidence tool");
    const rows = result.ok ? (result.data as any[]) : [];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].start_date, "2026-07-01", "offer start_date must be projected from v3 starts_on (the reference projection reads start_date and returns null on v3)");
    // Rank 20: offer compensation (custom_fields) is operational analytics a recruiter is entitled
    // to on their own reqs — withholding it was a timidity defect, not a compliance drop.
    assert.equal(rows[0].custom_fields?.base_salary?.value, 200000, "offer compensation (custom_fields.base_salary) must surface on the recruiter projection");
  });

  it("maps recruiter evidence tools to scoped reads and strips model-supplied identity params", async () => {
    const scopedReader = fakeScopedReader((toolName) => scopedSuccess(toolName, [{ id: 1, job_id: 10 }]));
    const { runtime, auditSink } = testRuntime(scopedReader);

    const result = await runEvidenceTool(runtime, "search_my_applications", {
      status: "active",
      stage_ids: "11,12",
      stage_name: "Recruiter Screen",
      on_behalf_of_user_id: 999,
      actor_id: 999,
      email: "other.recruiter@example.com",
      work_email: "other.recruiter@example.com",
      user_email: "other.recruiter@example.com",
      recruiter_email: "other.recruiter@example.com",
      authenticated_email: "other.recruiter@example.com",
      subject: "email:other.recruiter@example.com",
      session_subject: "email:other.recruiter@example.com",
      sub: "email:other.recruiter@example.com",
      per_page: 500,
    });

    assert.equal(result.ok, true);
    assert.equal(scopedReader.calls.length, 1);
    assert.equal(scopedReader.calls[0]!.toolName, "list_applications");
    assert.deepStrictEqual(scopedReader.calls[0]!.params, { status: "active", stage_ids: "11,12", stage_name: "Recruiter Screen", per_page: 500 });
    assert.ok(scopedReader.calls[0]!.options?.signal instanceof AbortSignal);
    assert.equal(auditSink.events.length, 1);
    assert.equal(auditSink.events[0]!.tool, "search_my_applications");
    assert.equal(auditSink.events[0]!.actorGreenhouseUserId, 100);
    assert.equal(auditSink.events[0]!.effectiveGreenhouseUserId, 100);
    assert.equal(auditSink.events[0]!.permissionScopeKind, "jobs");
    assert.equal(auditSink.events[0]!.permittedJobCount, 2);
    assert.equal(auditSink.events[0]!.rowsReturned, 1);
  });

  it("returns explicit denial for tools outside the recruiter evidence catalog", async () => {
    const scopedReader = fakeScopedReader(() => {
      throw new Error("should not call scoped reader");
    });
    const { runtime, auditSink } = testRuntime(scopedReader);

    const result = await runEvidenceTool(runtime, "reject_application", { id: 1 });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.denial.code, "TOOL_NOT_AVAILABLE");
    assert.deepStrictEqual(scopedReader.calls, []);
    assert.equal(auditSink.events.length, 1);
    assert.equal(auditSink.events[0]!.tool, "reject_application");
    assert.equal(auditSink.events[0]!.denialCode, "TOOL_NOT_AVAILABLE");
    assert.equal(auditSink.events[0]!.rowsRead, null);
  });

  it("strips unsupported raw Greenhouse detail params from evidence reads", async () => {
    const scopedReader = fakeScopedReader((toolName) => scopedSuccess(toolName, [{ id: 1, job_id: 10 }]));
    const { runtime } = testRuntime(scopedReader);

    // NB: job_ids is intentionally NOT passed here — on search_my_candidates it is now a scope CARRIER
    // (R2 bridges candidate_backed tools), not unsupported junk; its handling is covered by the R2
    // bridge tests in evidence-read.test.ts. This test keeps its job: the raw detail params below must
    // be stripped before the scoped endpoint read.
    const result = await runEvidenceTool(runtime, "search_my_candidates", {
      detail_profile: "contact",
      include_attachment_urls: true,
      reason: "expanded profile export",
      include_private: true,
      fields: "private_notes,email_addresses",
      foo: "bar",
      per_page: 25,
    });

    assert.equal(result.ok, true);
    assert.equal(scopedReader.calls.length, 1);
    assert.equal(scopedReader.calls[0]!.toolName, "list_candidates");
    // per_page is a RESULT cap; the upstream sweep always runs at the read-all default page size.
    assert.deepStrictEqual(scopedReader.calls[0]!.params, { per_page: 500 });
    assert.ok(scopedReader.calls[0]!.options?.signal instanceof AbortSignal);
  });

  it("strips unsupported raw Greenhouse detail params from get evidence reads", async () => {
    const scopedReader = fakeScopedReader((toolName) => scopedSuccess(toolName, { id: 55, job_id: 10 }));
    const { runtime } = testRuntime(scopedReader);

    const result = await runEvidenceTool(runtime, "get_my_candidate", {
      id: 55,
      detail_profile: "contact",
      include_attachment_urls: true,
      reason: "expanded profile export",
      foo: "bar",
      per_page: 5,
    });

    assert.equal(result.ok, true);
    assert.equal(scopedReader.calls.length, 1);
    assert.equal(scopedReader.calls[0]!.toolName, "get_candidate");
    assert.deepStrictEqual(scopedReader.calls[0]!.params, { id: 55 });
    assert.ok(scopedReader.calls[0]!.options?.signal instanceof AbortSignal);
  });

  it("exposes operational + analytical fields under the denylist projection while dropping contact PII", async () => {
    const scopedReader = fakeScopedReader((toolName) => {
      if (toolName === "list_applications") {
        return scopedSuccess(toolName, [{
          id: 101,
          job_id: 10,
          candidate_id: 55,
          status: "active",
          current_stage: { id: 7, name: "Recruiter Screen", interviewer: { name: "Do Not Return" } },
          custom_fields: { business_unit: { name: "Business Unit", value: "Platform" } },
          answers: [{ question: "Why this role?", answer: "Excited about the mission." }],
          // candidate contact PII bleeding onto the application — must be stripped
          candidate: { id: 55, first_name: "Private", raw_profile: { source: "do not return" } },
          candidate_email: "candidate@example.com",
          candidate_name: "Private Candidate",
        }]);
      }
      if (toolName === "list_candidates") {
        return scopedSuccess(toolName, [{
          id: 55,
          company: "Acme Corp",
          title: "Staff Engineer",
          tags: ["referral", "priority"],
          last_activity_at: "2026-06-15T00:00:00.000Z",
          custom_fields: { desired_start: { name: "Desired Start", value: "Q3" } },
          resume: { filename: "resume.pdf", text: "Ten years of distributed systems." },
          attachments: [{ filename: "resume.pdf", type: "resume" }],
          application_ids: [101, 909090],
          first_name: "Private",
          last_name: "Candidate",
          email: "candidate@example.com",
          email_addresses: [{ value: "candidate@example.com" }],
          phone: "555-0100",
          addresses: [{ value: "123 Private St", type: "home" }],
          social_media_addresses: [{ value: "https://linkedin.com/in/candidate" }],
          website_addresses: [{ value: "https://portfolio.example.com" }],
          raw_profile: { source: "do not return" },
          applications: [
            { id: 101, job_id: 10, candidate_id: 55, status: "active", private_notes: "do not return" },
          ],
          created_at: "2026-06-01T00:00:00.000Z",
        }]);
      }
      if (toolName === "list_scorecards") {
        return scopedSuccess(toolName, [{
          id: 501,
          application_id: 101,
          interviewer_id: 77,
          status: "submitted",
          submitted_at: "2026-06-20T00:00:00.000Z",
          overall_recommendation: "yes",
          notes: "Strong system design.",
          public_notes: "Advance to onsite.",
          private_notes: "do not return",
        }]);
      }
      if (toolName === "list_notes") {
        return scopedSuccess(toolName, [
          { id: 701, application_id: 101, user_id: 77, visibility: "publicly_visible", subject: "Reference check", body: "Backchannel was glowing.", created_at: "2026-06-20T00:00:00.000Z" },
          { id: 702, application_id: 101, user_id: 77, visibility: "privately_visible", subject: "do not return", body: "do not return", created_at: "2026-06-21T00:00:00.000Z" },
        ]);
      }
      throw new Error(`unexpected tool ${toolName}`);
    });
    const { runtime } = testRuntime(scopedReader);

    const applications = await runEvidenceTool(runtime, "search_my_applications", {});
    const candidates = await runEvidenceTool(runtime, "search_my_candidates", {});
    const scorecards = await runEvidenceTool(runtime, "search_my_scorecards", {});
    const notes = await runEvidenceTool(runtime, "search_my_notes", {});

    assert.equal(applications.ok, true);
    assert.equal(candidates.ok, true);
    assert.equal(scorecards.ok, true);
    assert.equal(notes.ok, true);

    // Application: operational fields (custom_fields, answers) surface; current_stage is pruned to a
    // bare reference; the candidate PII embed and bleed fields are stripped.
    assert.deepStrictEqual(applications.ok && applications.data, [{
      id: 101,
      job_id: 10,
      candidate_id: 55,
      status: "active",
      current_stage: { id: 7, name: "Recruiter Screen" },
      custom_fields: { business_unit: { name: "Business Unit", value: "Platform" } },
      answers: [{ question: "Why this role?", answer: "Excited about the mission." }],
    }]);

    // Candidate: documented operational fields surface; undocumented inline resume/attachments fail
    // closed (attachment metadata has its own endpoint). Derived applications remain scoped.
    const candidate = (candidates.ok ? (candidates.data as any[])[0] : {}) as any;
    assert.equal(candidate.company, "Acme Corp");
    assert.equal(candidate.title, "Staff Engineer");
    assert.deepStrictEqual(candidate.tags, ["referral", "priority"]);
    assert.equal(candidate.last_activity_at, "2026-06-15T00:00:00.000Z");
    assert.deepStrictEqual(candidate.custom_fields, { desired_start: { name: "Desired Start", value: "Q3" } });
    assert.equal(candidate.resume, undefined);
    assert.equal(candidate.attachments, undefined);
    assert.deepStrictEqual(candidate.application_ids, [101]);
    assert.equal(candidate.first_name, undefined);
    assert.equal(candidate.last_name, undefined);
    assert.equal(candidate.email, undefined);
    assert.equal(candidate.phone, undefined);
    assert.equal(candidate.raw_profile, undefined);
    // T2.3 PII policy split: physical/mailing address is contact PII and drops...
    // (see also the Tier-3.4 exposure e2e below)
    assert.equal(candidate.addresses, undefined, "physical/mailing address is contact PII — must drop");
    // ...but professional-discovery URLs (LinkedIn, portfolio) pass through — a recruiter uses these
    // and already sees them in Greenhouse; dropping them would be timidity, not privacy.
    assert.deepStrictEqual(candidate.social_media_addresses, [{ value: "https://linkedin.com/in/candidate" }]);
    assert.deepStrictEqual(candidate.website_addresses, [{ value: "https://portfolio.example.com" }]);
    assert.equal((candidate.applications?.[0] ?? {}).private_notes, undefined);

    // Scorecard: interviewer feedback (notes/public_notes) surfaces (Rank 3); private_notes drops.
    const scorecard = (scorecards.ok ? (scorecards.data as any[])[0] : {}) as any;
    assert.equal(scorecard.notes, "Strong system design.");
    assert.equal(scorecard.public_notes, "Advance to onsite.");
    assert.equal(scorecard.overall_recommendation, undefined, "undocumented scorecard fields fail closed");
    assert.equal(scorecard.private_notes, undefined);

    // Notes: a public note keeps its body/subject (Rank 5); a privately_visible note drops them.
    const noteRows = (notes.ok ? (notes.data as any[]) : []) as any[];
    const publicNote = noteRows.find((n) => n.id === 701) ?? {};
    const privateNote = noteRows.find((n) => n.id === 702) ?? {};
    assert.equal(publicNote.body, "Backchannel was glowing.");
    assert.equal(publicNote.subject, "Reference check");
    assert.equal(privateNote.visibility, "privately_visible");
    assert.equal(privateNote.body, undefined, "privately_visible note body requires the 'see private notes' permission");
    assert.equal(privateNote.subject, undefined);

    // Projection metadata: PII drops are recorded with reason; no registered metric is blocked.
    assert.equal(applications.ok && applications.projection?.profile, "recruiter_default");
    assert.equal(applications.ok && applications.projection?.incompleteProjection, false);
    assert.deepStrictEqual(applications.ok && applications.projection?.requiredFieldOmissions, []);
    assert.ok(candidates.ok && candidates.projection?.omittedFields.some((field) => field.field === "email_addresses" && field.reason === "privacy"));
    assert.ok(scorecards.ok && scorecards.projection?.omittedFields.some((field) => field.field === "private_notes" && field.reason === "privacy"));

    // No contact PII anywhere in the projected payloads.
    const projectedData = {
      applications: applications.ok && applications.data,
      candidates: candidates.ok && candidates.data,
      scorecards: scorecards.ok && scorecards.data,
      notes: notes.ok && notes.data,
    };
    assert.doesNotMatch(JSON.stringify(projectedData), /candidate@example\.com|555-0100|Private|Candidate|do not return|Do Not Return|909090|909091/);
  });

  it("strips candidate PII bleeding through nested/denormalized embeds and fails closed on note visibility", async () => {
    const scopedReader = fakeScopedReader((toolName) => {
      if (toolName === "list_interviews") {
        return scopedSuccess(toolName, [{ id: 3, application_id: 5, job_id: 10, status: "scheduled", candidate: { id: 7, first_name: "Jane", last_name: "Doe", email: "jane@example.com" } }]);
      }
      if (toolName === "list_rejection_details") {
        return scopedSuccess(toolName, [{ id: 6, application_id: 5, rejection_reason_id: 9, candidate: { id: 7, first_name: "Jane", last_name: "Doe" } }]);
      }
      if (toolName === "list_applications") {
        return scopedSuccess(toolName, [{ jobs: [{ id: 100, name: "Senior Engineer" }], candidate_id: 7, status: "active", custom_fields: { referral: { first_name: "Robin", last_name: "Banks", note: "strong referral" } } }]);
      }
      if (toolName === "list_notes") {
        return scopedSuccess(toolName, [
          { id: 1, visibility: "privately_visible ", body: "TRAILING SPACE PRIVATE" },
          { id: 2, visibility: "PUBLICLY_VISIBLE", body: "MIXED CASE PUBLIC" },
          { id: 3, body: "NO VISIBILITY FIELD" },
          { id: 4, visibility: "admin_only_visible", body: "ADMIN VISIBLE" },
        ]);
      }
      throw new Error(`unexpected tool ${toolName}`);
    });
    const { runtime } = testRuntime(scopedReader);

    const interviews = await runEvidenceTool(runtime, "search_my_interviews", {});
    const rejectionDetails = await runEvidenceTool(runtime, "search_my_rejection_details", {});
    const applications = await runEvidenceTool(runtime, "search_my_applications", {});
    const notes = await runEvidenceTool(runtime, "search_my_notes", {});

    // Candidate first/last name and email never survive a nested or denormalized embed on ANY endpoint.
    const blob = JSON.stringify({
      interviews: interviews.ok && interviews.data,
      rejectionDetails: rejectionDetails.ok && rejectionDetails.data,
      applications: applications.ok && applications.data,
    });
    assert.doesNotMatch(blob, /Jane|Doe|jane@example\.com|Robin|Banks/, "candidate names must never bleed through a nested embed (Jane/Doe under `candidate`) nor a nested custom field (Robin/Banks)");

    // The denormalized candidate embed is dropped wholesale — locks the `candidate` global drop
    // independently of the first/last-name global drop.
    const interview = (interviews.ok ? (interviews.data as any[])[0] : {}) as any;
    assert.equal(interview.candidate, undefined, "the candidate embed is dropped wholesale");

    // The application keeps the derived scalar job_id but drops the denormalized jobs[] embed.
    const application = (applications.ok ? (applications.data as any[])[0] : {}) as any;
    assert.equal(application.job_id, 100, "job_id is derived from the nested jobs:[{id}] shape");
    assert.equal(application.jobs, undefined, "the denormalized jobs[] embed is dropped; job_id is canonical");
    // custom_fields still surface — only the candidate-name keys inside were stripped. Locks the
    // first/last-name global drop independently (the leak path is NOT under a `candidate` key).
    assert.equal(application.custom_fields?.referral?.note, "strong referral", "operational custom-field content survives even when nested candidate-name keys are stripped");

    // Note visibility gate fails closed: only clean publicly_visible / admin_only_visible bodies pass.
    const noteRows = (notes.ok ? (notes.data as any[]) : []) as any[];
    const byId = (id: number) => noteRows.find((n) => n.id === id) ?? {};
    assert.equal(byId(1).body, undefined, "privately_visible with trailing space must fail closed");
    assert.equal(byId(2).body, "MIXED CASE PUBLIC", "PUBLICLY_VISIBLE (case-insensitive) is visible to a Job Admin");
    assert.equal(byId(3).body, undefined, "absent visibility fails closed");
    assert.equal(byId(4).body, "ADMIN VISIBLE", "admin_only_visible is visible to a Job Admin");
  });

  it("preserves material default-profile fields and reports role-gated omissions", async () => {
    const scopedReader = fakeScopedReader((toolName) => {
      if (toolName === "list_applications") {
        return scopedSuccess(toolName, [{
          id: 101,
          job_id: 10,
          coordinator_id: "77",
          recruiter_id: 88,
          job_post_id: 99,
          prospect: true,
          needs_decision: false,
          location_address: "HQ",
          prospective_job_ids: [10, "11", "not-an-id"],
          custom_fields: [{ name: "business unit", value: "Private" }],
        }]);
      }
      if (toolName === "list_job_owners") {
        return scopedSuccess(toolName, [{ id: 201, job_id: 10, user_id: 77, type: "recruiter", responsible: true }]);
      }
      if (toolName === "list_openings") {
        return scopedSuccess(toolName, [{ id: 301, job_id: 10, target_start_on: "2026-07-15", sort_order: 3, custom_fields: [{ name: "plan", value: "x" }] }]);
      }
      if (toolName === "list_job_interviews") {
        return scopedSuccess(toolName, [{ id: 401, job_id: 10, sort_order: 2, require_scorecard: true, summary: "Panel overview", instructions: "private instructions" }]);
      }
      if (toolName === "list_interviews") {
        return scopedSuccess(toolName, [{ id: 501, application_id: 101, job_id: 10, scheduled_at: "2026-06-20T10:00:00.000Z", availability_received_at: "2026-06-19T10:00:00.000Z", location: "Zoom", all_day_start_on: "2026-06-20", all_day_end_on: "2026-06-20", video_conferencing_url: "https://meet.example/private" }]);
      }
      if (toolName === "list_scorecards") {
        return scopedSuccess(toolName, [{ id: 601, application_id: 101, interview_kit_id: 401, status: "submitted", notes: "role gated" }]);
      }
      if (toolName === "list_notes") {
        return scopedSuccess(toolName, [{ id: 701, application_id: 101, type: "availability_request", visibility: "publicly_visible", body: "role gated body" }]);
      }
      if (toolName === "list_tracking_links") {
        return scopedSuccess(toolName, [{ id: 801, job_id: 10, related_post_id: 901, related_post_type: "job_post", token: "secret-token" }]);
      }
      if (toolName === "list_offers") {
        return scopedSuccess(toolName, [{ id: 901, job_id: 10, starts_on: "2026-08-01", version: 2, custom_fields: [{ name: "comp", value: "private" }] }]);
      }
      if (toolName === "list_users") {
        return scopedSuccess(toolName, [{ id: 77, name: "Recruiter One", job_title: "Senior Recruiter", deactivated: false, department_ids: [3], office_ids: ["4"], primary_email: "recruiter@example.com" }]);
      }
      if (toolName === "list_sources") {
        return scopedSuccess(toolName, [{ id: 44, name: "LinkedIn", type: { id: 2, name: "Job Board", internal_only: true }, active: true }]);
      }
      if (toolName === "list_referrers") {
        return scopedSuccess(toolName, [{ id: 7, name: "Mr. Referrer", user_id: 88, created_at: "2026-01-01T00:00:00.000Z" }]);
      }
      throw new Error(`unexpected tool ${toolName}`);
    });
    const { runtime } = testRuntime(scopedReader);

    const applications = await runEvidenceTool(runtime, "search_my_applications", {});
    const owners = await runEvidenceTool(runtime, "search_my_job_owners", {});
    const openings = await runEvidenceTool(runtime, "search_my_openings", {});
    const jobInterviews = await runEvidenceTool(runtime, "search_my_job_interviews", {});
    const interviews = await runEvidenceTool(runtime, "search_my_interviews", {});
    const scorecards = await runEvidenceTool(runtime, "search_my_scorecards", {});
    const notes = await runEvidenceTool(runtime, "search_my_notes", {});
    const tracking = await runEvidenceTool(runtime, "search_my_tracking_links", {});
    const offers = await runEvidenceTool(runtime, "search_my_offers", {});
    const users = await runEvidenceTool(runtime, "search_my_users", {});
    const sources = await runEvidenceTool(runtime, "search_my_sources", {});
    const referrers = await runEvidenceTool(runtime, "search_my_referrers", {});

    assert.deepStrictEqual(applications.ok && applications.data, [{
      id: 101,
      job_id: 10,
      coordinator_id: 77,
      recruiter_id: 88,
      job_post_id: 99,
      prospect: true,
      needs_decision: false,
      location_address: "HQ",
      prospective_job_ids: [10, 11],
      custom_fields: [{ name: "business unit", value: "Private" }],
    }]);
    assert.deepStrictEqual(owners.ok && owners.data, [{ id: 201, job_id: 10, user_id: 77, type: "recruiter", responsible: true }]);
    assert.deepStrictEqual(openings.ok && openings.data, [{ id: 301, job_id: 10, target_start_on: "2026-07-15", sort_order: 3, custom_fields: [{ name: "plan", value: "x" }] }]);
    assert.deepStrictEqual(jobInterviews.ok && jobInterviews.data, [{ id: 401, job_id: 10, sort_order: 2, require_scorecard: true, summary: "Panel overview", instructions: "private instructions" }]);
    assert.deepStrictEqual(interviews.ok && interviews.data, [{ id: 501, application_id: 101, job_id: 10, scheduled_at: "2026-06-20T10:00:00.000Z", availability_received_at: "2026-06-19T10:00:00.000Z", location: "Zoom", all_day_start_on: "2026-06-20", all_day_end_on: "2026-06-20" }]);
    assert.deepStrictEqual(scorecards.ok && scorecards.data, [{ id: 601, application_id: 101, status: "submitted", interview_kit_id: 401, notes: "role gated" }]);
    assert.deepStrictEqual(notes.ok && notes.data, [{ id: 701, application_id: 101, type: "availability_request", visibility: "publicly_visible", body: "role gated body" }]);
    assert.deepStrictEqual(tracking.ok && tracking.data, [{ id: 801, job_id: 10, related_post_id: 901, related_post_type: "job_post" }]);
    assert.deepStrictEqual(offers.ok && offers.data, [{ id: 901, job_id: 10, starts_on: "2026-08-01", version: 2, custom_fields: [{ name: "comp", value: "private" }], start_date: "2026-08-01" }]);
    assert.deepStrictEqual(users.ok && users.data, [{ id: 77, name: "Recruiter One", job_title: "Senior Recruiter", deactivated: false, department_ids: [3], office_ids: [4] }]);
    // #10 + denylist flip: sources/referrers resolve ids to names. Source name + nested type survive,
    // and documented nested flags (type.internal_only) pass. Referrer user_id (the employee who
    // referred) surfaces so referrals can be attributed to a teammate; only contact PII is dropped.
    assert.deepStrictEqual(sources.ok && sources.data, [{ id: 44, name: "LinkedIn", type: { id: 2, name: "Job Board", internal_only: true } }]);
    assert.deepStrictEqual(referrers.ok && referrers.data, [{ id: 7, name: "Mr. Referrer", user_id: 88, created_at: "2026-01-01T00:00:00.000Z" }]);

    // Operational text/custom fields now project through, so they no longer appear as omissions, and
    // no registered metric is blocked.
    assert.equal(applications.ok && applications.projection?.incompleteProjection, false);
    assert.deepStrictEqual(applications.ok && applications.projection?.requiredFieldOmissions, []);
    // Only true PII remains recorded as omitted, with its reason.
    assert.ok(tracking.ok && tracking.projection?.omittedFields.some((field) => field.field === "token" && field.reason === "privacy"));
    assert.ok(users.ok && users.projection?.omittedFields.some((field) => field.field === "primary_email" && field.reason === "privacy"));
    // Regression locks: custom_fields / scorecard notes / referrer user_id are NOT omitted anymore.
    assert.ok(applications.ok && !applications.projection?.omittedFields.some((field) => field.field === "custom_fields"));
    assert.ok(scorecards.ok && !scorecards.projection?.omittedFields.some((field) => field.field === "notes"));
    assert.ok(referrers.ok && !referrers.projection?.omittedFields.some((field) => field.field === "user_id"));
  });

  it("documents domain classifications for every exposed evidence tool", () => {
    for (const toolName of Object.keys(EVIDENCE_DOMAIN_CLASSIFICATIONS)) {
      const classification = EVIDENCE_DOMAIN_CLASSIFICATIONS[toolName]!;
      const adapter = SCOPED_ENDPOINT_ADAPTERS_BY_EVIDENCE_TOOL.get(toolName);
      assert.ok(adapter, `missing scoped endpoint adapter for ${toolName}`);
      assert.equal(classification.domain_class, adapter.scopeClass);
      assert.ok([
        "job_scoped",
        "application_backed",
        "candidate_backed",
        "interview_backed",
        "scorecard_backed",
        "join_backed",
        "global_reference",
        "admin_reference",
        "sensitive_personal",
        "unsafe_unavailable",
      ].includes(classification.domain_class));
      assert.equal(typeof classification.bounding_rule, "string");
      assert.ok(classification.bounding_rule.length > 20);
    }
    assert.equal(EVIDENCE_DOMAIN_CLASSIFICATIONS.search_my_rejection_reasons.domain_class, "global_reference");
    assert.equal(EVIDENCE_DOMAIN_CLASSIFICATIONS.search_my_job_owners.domain_class, "job_scoped");
    assert.equal(EVIDENCE_DOMAIN_CLASSIFICATIONS.search_my_rejection_details.domain_class, "application_backed");
    assert.equal(EVIDENCE_DOMAIN_CLASSIFICATIONS.search_my_candidates.domain_class, "candidate_backed");
  });

  it("keeps every evidence tool mapped to an explicit projector", () => {
    const definitionNames = EVIDENCE_TOOL_DEFINITIONS.map((tool) => tool.name).sort();
    const mappedNames = [...EVIDENCE_TOOL_MAP.keys()].sort();

    assert.deepStrictEqual(mappedNames, definitionNames);
    assert.deepStrictEqual(EVIDENCE_PROJECTOR_TOOL_NAMES, mappedNames);
  });

  it("projects newly exposed scoped read domains without raw private fields", async () => {
    const scopedReader = fakeScopedReader((toolName) => {
      if (toolName === "list_job_owners") {
        return scopedSuccess(toolName, [{ id: 1, job_id: 10, user_id: 77, type: "recruiter", email: "owner@example.com" }]);
      }
      if (toolName === "list_openings") {
        return scopedSuccess(toolName, [{ id: 2, job_id: 10, application_id: 101, opening_id: "REQ-1", open: true, close_reason: "private" }]);
      }
      if (toolName === "list_job_interview_stages") {
        return scopedSuccess(toolName, [{ id: 3, job_id: 10, name: "Onsite", active: true, instructions: "private" }]);
      }
      if (toolName === "list_job_interviews") {
        return scopedSuccess(toolName, [{ id: 4, job_id: 10, job_interview_stage_id: 3, name: "Panel", scheduling_type: "needs_scheduling", instructions: "private" }]);
      }
      if (toolName === "list_interviews") {
        return scopedSuccess(toolName, [{ id: 5, application_id: 101, job_id: 10, job_interview_id: 4, organizer_id: 77, status: "scheduled", candidate_name: "Private Candidate" }]);
      }
      if (toolName === "list_rejection_details") {
        return scopedSuccess(toolName, [{ id: 6, application_id: 101, rejection_reason_id: 9, rejected_by_id: 77, rejected_at: "2026-06-20T00:00:00.000Z", candidate_feedback: "private" }]);
      }
      if (toolName === "list_rejection_reasons") {
        return scopedSuccess(toolName, [{ id: 9, name: "Skills mismatch", type: { id: 1, key: "we_rejected", email: "private@example.com" }, private_note: "private" }]);
      }
      if (toolName === "list_users") {
        return scopedSuccess(toolName, [{ id: 77, name: "Recruiter One", first_name: "Recruiter", last_name: "One", email: "recruiter@example.com", phone: "555-0100" }]);
      }
      if (toolName === "get_user") {
        return scopedSuccess(toolName, { id: 77, name: "Recruiter One", email: "recruiter@example.com" });
      }
      if (toolName === "list_tracking_links") {
        return scopedSuccess(toolName, [{ id: 8, job_id: 10, source_id: 11, referrer_id: 12, token: "secret-token", url: "https://tracking.example" }]);
      }
      throw new Error(`unexpected tool ${toolName}`);
    });
    const { runtime } = testRuntime(scopedReader);

    const results = {
      owners: await runEvidenceTool(runtime, "search_my_job_owners", {}),
      openings: await runEvidenceTool(runtime, "search_my_openings", {}),
      stages: await runEvidenceTool(runtime, "search_my_job_interview_stages", {}),
      jobInterviews: await runEvidenceTool(runtime, "search_my_job_interviews", {}),
      interviews: await runEvidenceTool(runtime, "search_my_interviews", {}),
      rejectionDetails: await runEvidenceTool(runtime, "search_my_rejection_details", {}),
      rejectionReasons: await runEvidenceTool(runtime, "search_my_rejection_reasons", {}),
      users: await runEvidenceTool(runtime, "search_my_users", {}),
      user: await runEvidenceTool(runtime, "get_my_user", { id: 77 }),
      tracking: await runEvidenceTool(runtime, "search_my_tracking_links", {}),
    };

    for (const result of Object.values(results)) assert.equal(result.ok, true);
    assert.deepStrictEqual(results.owners.ok && results.owners.data, [{ id: 1, job_id: 10, user_id: 77, type: "recruiter" }]);
    assert.deepStrictEqual(results.rejectionReasons.ok && results.rejectionReasons.data, [{ id: 9, name: "Skills mismatch", type: { id: 1, key: "we_rejected" } }]);
    assert.deepStrictEqual(results.users.ok && results.users.data, [{ id: 77, name: "Recruiter One", first_name: "Recruiter", last_name: "One" }]);
    assert.deepStrictEqual(results.user.ok && results.user.data, { id: 77, name: "Recruiter One" });
    assert.deepStrictEqual(results.tracking.ok && results.tracking.data, [{ id: 8, job_id: 10, source_id: 11, referrer_id: 12 }]);
    assert.ok(results.tracking.ok && results.tracking.projection?.omittedFields.some((field) => field.field === "token" && field.reason === "privacy"));
    const projectedData = Object.fromEntries(
      Object.entries(results).map(([key, result]) => [key, result.ok ? result.data : result])
    );
    // Only true PII must be absent. instructions / close_reason / candidate_feedback are operational
    // analytics that now project through, so they are NOT canaried here.
    assert.doesNotMatch(JSON.stringify(projectedData), /owner@example\.com|recruiter@example\.com|555-0100|secret-token|tracking\.example|Private Candidate|private@example\.com/i);
  });

  it("applies role-aware projection profiles: operator_site_admin restores work emails, hygiene holds (T3.3)", async () => {
    const userRow = { id: 900, name: "Ops Admin", primary_email: "admin@example.com", site_admin: true };
    const candidateRow = { id: 55, company: "Acme", email: "candidate@example.com", phone: "555-0100" };
    const operatorReader = fakeScopedReader((toolName) => {
      if (toolName === "list_users") return scopedSuccess(toolName, [userRow], null, { permissionScope: { kind: "operator", permittedJobCount: null } });
      if (toolName === "list_candidates") return scopedSuccess(toolName, [candidateRow], null, { permissionScope: { kind: "operator", permittedJobCount: null } });
      throw new Error(`unexpected tool ${toolName}`);
    });
    const recruiterReader = fakeScopedReader((toolName) => {
      if (toolName === "list_users") return scopedSuccess(toolName, [userRow]);
      throw new Error(`unexpected tool ${toolName}`);
    });

    const operatorUsers = await runEvidenceTool(testRuntime(operatorReader).runtime, "search_my_users", {});
    const operatorCandidates = await runEvidenceTool(testRuntime(operatorReader).runtime, "search_my_candidates", {});
    const recruiterUsers = await runEvidenceTool(testRuntime(recruiterReader).runtime, "search_my_users", {});

    // Operator/site-admin: colleagues' work emails restore (they administer the staff directory)...
    const opUser = (operatorUsers.ok ? (operatorUsers.data as any[])[0] : {}) as any;
    assert.equal(opUser.primary_email, "admin@example.com");
    assert.equal((operatorUsers.ok && (operatorUsers as any).projection?.profile), "operator_site_admin");
    // ...but candidate contact PII stays dropped on EVERY profile (LLM-context hygiene, not role).
    const opCandidate = (operatorCandidates.ok ? (operatorCandidates.data as any[])[0] : {}) as any;
    assert.equal(opCandidate.email, undefined, "candidate contact PII must drop even for operators");
    assert.equal(opCandidate.phone, undefined);
    assert.equal(opCandidate.company, "Acme");
    // Line recruiter: the default profile still drops colleagues' emails.
    const recUser = (recruiterUsers.ok ? (recruiterUsers.data as any[])[0] : {}) as any;
    assert.equal(recUser.primary_email, undefined);
    assert.equal((recruiterUsers.ok && (recruiterUsers as any).projection?.profile), "recruiter_default");
  });

  it("projects the Tier-3.4 exposure wave end-to-end (approvals, rubric, kits, prospects)", async () => {
    const scopedReader = fakeScopedReader((toolName) => {
      if (toolName === "list_approval_flows") {
        return scopedSuccess(toolName, [{ id: 71, job_id: 10, offer_id: null, approval_status: "pending", approval_type: "open_job", sequential: true, requested_by_id: 900, version: 1 }]);
      }
      if (toolName === "list_approvers") {
        return scopedSuccess(toolName, [{ id: 81, approver_group_id: 91, user_id: 901, status: "pending", request_sent_at: "2026-06-20T00:00:00.000Z", resolved_at: null, reminders_sent: 2, sort_order: 1, future_secret: "must fail closed" }]);
      }
      if (toolName === "list_scorecard_questions") {
        return scopedSuccess(toolName, [{ id: 61, interview_kit_id: 41, question: "System design depth?", answer_type: "text", required: true, active: true, sort_order: 1 }]);
      }
      if (toolName === "list_interview_kits") {
        return scopedSuccess(toolName, [{ id: 41, job_id: 10, job_interview_id: 55, exercises: null, anonymize_candidate: false, anonymize_resumes: false }]);
      }
      if (toolName === "list_prospect_details") {
        return scopedSuccess(toolName, [{ id: 51, application_id: 101, pool_id: 7, pool_stage_id: 2, prospect_owner_id: 900, department_id: 30, office_id: 3 }]);
      }
      throw new Error(`unexpected tool ${toolName}`);
    });
    const { runtime } = testRuntime(scopedReader);

    const flows = await runEvidenceTool(runtime, "search_my_approval_flows", {});
    const approvers = await runEvidenceTool(runtime, "search_my_approvers", {});
    const questions = await runEvidenceTool(runtime, "search_my_scorecard_questions", {});
    const kits = await runEvidenceTool(runtime, "search_my_interview_kits", {});
    const prospects = await runEvidenceTool(runtime, "search_my_prospect_details", {});

    for (const result of [flows, approvers, questions, kits, prospects]) {
      assert.equal(result.ok, true);
    }
    // Operational fields pass through the denylist projector untouched — the join keys the
    // descriptions advertise (approver_group_id, interview_kit_id, application_id) must survive.
    assert.deepStrictEqual(flows.ok && flows.data, [{ id: 71, job_id: 10, offer_id: null, approval_status: "pending", approval_type: "open_job", sequential: true, requested_by_id: 900, version: 1 }]);
    const approver = (approvers.ok ? (approvers.data as any[])[0] : {}) as any;
    assert.equal(approver.approver_group_id, 91);
    assert.equal(approver.reminders_sent, 2);
    assert.equal(approver.future_secret, undefined, "undocumented future fields fail closed");
    const question = (questions.ok ? (questions.data as any[])[0] : {}) as any;
    assert.equal(question.interview_kit_id, 41);
    assert.equal(question.question, "System design depth?");
    const prospect = (prospects.ok ? (prospects.data as any[])[0] : {}) as any;
    assert.equal(prospect.application_id, 101);
    assert.equal(prospect.pool_stage_id, 2);
  });

  it("projects newly exposed global-reference dictionaries end-to-end (departments/offices/close_reasons/custom_field_options)", async () => {
    const scopedReader = fakeScopedReader((toolName) => {
      // Each fixture injects an `email` field that is NOT part of the real v3 shape for that
      // endpoint. It is a PII canary: the global denylist projector must drop it on EVERY tool, so a
      // projector neutered to `return row` (skipping the PII guard) fails the deepStrictEqual below.
      // Without the canary these passthrough projectors would be input==output and the assertion
      // could not tell a real PII-guarding projector from a raw passthrough.
      if (toolName === "list_departments") {
        return scopedSuccess(toolName, [{ id: 30, name: "Engineering", parent_id: 5, external_id: "ENG", email: "dept@example.com" }]);
      }
      if (toolName === "list_offices") {
        return scopedSuccess(toolName, [{ id: 40, name: "NYC HQ", location: "New York, NY", parent_id: null, primary_in_house_contact_user_id: 77, email: "office@example.com" }]);
      }
      if (toolName === "list_close_reasons") {
        return scopedSuccess(toolName, [{ id: 50, name: "Filled internally", email: "reason@example.com" }]);
      }
      if (toolName === "list_custom_field_options") {
        return scopedSuccess(toolName, [{ id: 60, name: "Senior", custom_field_id: 7, active: true, sort_order: 2, email: "option@example.com" }]);
      }
      throw new Error(`unexpected tool ${toolName}`);
    });
    const { runtime } = testRuntime(scopedReader);

    const departments = await runEvidenceTool(runtime, "search_my_departments", {});
    const offices = await runEvidenceTool(runtime, "search_my_offices", {});
    const closeReasons = await runEvidenceTool(runtime, "search_my_close_reasons", {});
    const customFieldOptions = await runEvidenceTool(runtime, "search_my_custom_field_options", {});

    // ok === true locks the registry + scoped-reader binding: drop either and runEvidenceTool
    // returns a TOOL_NOT_AVAILABLE denial instead.
    for (const result of [departments, offices, closeReasons, customFieldOptions]) {
      assert.equal(result.ok, true);
    }
    // Exact projected shape locks each denylist projector: id + name + structural ids survive; the
    // injected email PII canary is dropped from every one (a neutered projector body fails here).
    assert.deepStrictEqual(departments.ok && departments.data, [{ id: 30, name: "Engineering", parent_id: 5, external_id: "ENG" }]);
    assert.deepStrictEqual(offices.ok && offices.data, [{ id: 40, name: "NYC HQ", location: "New York, NY", parent_id: null, primary_in_house_contact_user_id: 77 }]);
    assert.deepStrictEqual(closeReasons.ok && closeReasons.data, [{ id: 50, name: "Filled internally" }]);
    assert.deepStrictEqual(customFieldOptions.ok && customFieldOptions.data, [{ id: 60, name: "Senior", custom_field_id: 7, active: true, sort_order: 2 }]);
    assert.doesNotMatch(JSON.stringify([departments, offices, closeReasons, customFieldOptions]), /@example\.com/i);
  });

  it("projects attachment inventory metadata while withholding signed URLs and candidate PII", async () => {
    const scopedReader = fakeScopedReader((toolName) => {
      if (toolName === "list_attachments") {
        // first_name is injected to prove the global PII guard still runs on this exposed surface;
        // it is not a real /v3/attachments field.
        return scopedSuccess(toolName, [{ id: 1, application_id: 101, candidate_id: 55, created_at: "2026-07-19T12:00:00.000Z", updated_at: "2026-07-20T12:00:00.000Z", filename: "Jane_Resume.pdf", type: "resume", url: "https://files.example/resume.pdf", first_name: "Jane" }]);
      }
      throw new Error(`unexpected tool ${toolName}`);
    });
    const { runtime } = testRuntime(scopedReader);

    const attachments = await runEvidenceTool(runtime, "search_my_attachments", {});

    assert.equal(attachments.ok, true);
    // Exact data shape locks the projector: filename/type and id refs survive, while the signed URL
    // and injected first_name are withheld. read_my_resume alone consumes a fresh URL server-side.
    assert.deepStrictEqual(attachments.ok && attachments.data, [
      { id: 1, application_id: 101, candidate_id: 55, created_at: "2026-07-19T12:00:00.000Z", updated_at: "2026-07-20T12:00:00.000Z", filename: "Jane_Resume.pdf", type: "resume" },
    ]);
    // The dropped PII is disclosed by name in the omission manifest (honest), but its VALUE must not
    // appear in the projected payload itself.
    const payload = JSON.stringify(attachments.ok && attachments.data);
    assert.equal(payload.includes("first_name"), false);
    assert.equal(payload.includes("https://"), false);
  });

  it("exposes job accountability reads and gates job-note bodies on visibility (fail-closed)", async () => {
    const scopedReader = fakeScopedReader((toolName) => {
      // email is a PII canary on hiring-managers/posts (not a real field): the projector must drop it.
      if (toolName === "list_job_hiring_managers") {
        return scopedSuccess(toolName, [{ id: 1, job_id: 10, user_id: 77, email: "hm@example.com" }]);
      }
      if (toolName === "list_job_posts") {
        return scopedSuccess(toolName, [{ id: 2, job_id: 10, job_board_id: 3, title: "Senior Eng", content: "Join us", public_url: "https://boards.example/eng", live: true, email: "post@example.com" }]);
      }
      if (toolName === "list_job_notes") {
        return scopedSuccess(toolName, [
          { id: 3, job_id: 10, user_id: 77, visibility: "publicly_visible", body: "public body" },
          { id: 4, job_id: 10, user_id: 77, visibility: "admin_only_visible", body: "admin body" },
          { id: 5, job_id: 10, user_id: 77, visibility: "privately_visible", body: "private body" },
          { id: 6, job_id: 10, user_id: 77, body: "no-visibility body" },
        ]);
      }
      throw new Error(`unexpected tool ${toolName}`);
    });
    const { runtime } = testRuntime(scopedReader);

    const managers = await runEvidenceTool(runtime, "search_my_job_hiring_managers", {});
    const posts = await runEvidenceTool(runtime, "search_my_job_posts", {});
    const notes = await runEvidenceTool(runtime, "search_my_job_notes", {});

    for (const result of [managers, posts, notes]) assert.equal(result.ok, true);
    assert.deepStrictEqual(managers.ok && managers.data, [{ id: 1, job_id: 10, user_id: 77 }]);
    assert.deepStrictEqual(posts.ok && posts.data, [{ id: 2, job_id: 10, job_board_id: 3, title: "Senior Eng", content: "Join us", public_url: "https://boards.example/eng", live: true }]);
    // Body kept for publicly_visible + admin_only_visible; dropped (fail-closed) for privately_visible
    // and for an absent visibility value.
    const noteBodies = (notes.ok ? (notes.data as Array<Record<string, unknown>>) : []).map((note) => ({ id: note.id, body: note.body }));
    assert.deepStrictEqual(noteBodies, [
      { id: 3, body: "public body" },
      { id: 4, body: "admin body" },
      { id: 5, body: undefined },
      { id: 6, body: undefined },
    ]);
    // The withheld private body value must never reach the projected payload.
    assert.equal(JSON.stringify(notes.ok && notes.data).includes("private body"), false);
    assert.equal(JSON.stringify(notes.ok && notes.data).includes("no-visibility body"), false);
  });

  it("projects interview panel + rubric answers, keeping response_status and answer text but dropping interviewer email", async () => {
    const scopedReader = fakeScopedReader((toolName) => {
      if (toolName === "list_interviewers") {
        return scopedSuccess(toolName, [{ id: 1, interview_id: 11, scorecard_id: 21, user_id: 50, response_status: "to_be_submitted", email: "interviewer@example.com" }]);
      }
      if (toolName === "list_scorecard_question_answers") {
        return scopedSuccess(toolName, [{ id: 2, scorecard_id: 31, scorecard_question_id: 5, answer: "Strong on system design", boolean_value: true }]);
      }
      throw new Error(`unexpected tool ${toolName}`);
    });
    const { runtime } = testRuntime(scopedReader);

    const interviewers = await runEvidenceTool(runtime, "search_my_interviewers", {});
    const answers = await runEvidenceTool(runtime, "search_my_scorecard_question_answers", {});

    assert.equal(interviewers.ok, true);
    assert.equal(answers.ok, true);
    // Interviewer email (a teammate address) is dropped by the global PII guard; response_status and
    // the panel/scorecard id refs are the operative analytics and pass.
    assert.deepStrictEqual(interviewers.ok && interviewers.data, [
      { id: 1, interview_id: 11, scorecard_id: 21, user_id: 50, response_status: "to_be_submitted" },
    ]);
    assert.equal(JSON.stringify(interviewers.ok && interviewers.data).includes("interviewer@example.com"), false);
    // The rubric answer text and boolean are the analytical signal and pass through.
    assert.deepStrictEqual(answers.ok && answers.data, [
      { id: 2, scorecard_id: 31, scorecard_question_id: 5, answer: "Strong on system design", boolean_value: true },
    ]);
  });

  it("projects candidate education/employment history, keeping the custom_field_option_id refs that decode the values", async () => {
    const scopedReader = fakeScopedReader((toolName) => {
      // email is injected as a PII canary (not a real field on these endpoints): the projector must
      // drop it, so a body neutered to `return row` fails the deepStrictEqual.
      if (toolName === "list_candidate_educations") {
        return scopedSuccess(toolName, [{ id: 1, candidate_id: 501, degree_custom_field_option_id: 9, discipline_custom_field_option_id: 10, school_name_custom_field_option_id: 11, email: "cand@example.com" }]);
      }
      if (toolName === "list_candidate_employments") {
        return scopedSuccess(toolName, [{ id: 2, candidate_id: 501, company_name: "Acme", title: "Engineer", email: "cand@example.com" }]);
      }
      throw new Error(`unexpected tool ${toolName}`);
    });
    const { runtime } = testRuntime(scopedReader);

    const educations = await runEvidenceTool(runtime, "search_my_candidate_educations", {});
    const employments = await runEvidenceTool(runtime, "search_my_candidate_employments", {});

    assert.equal(educations.ok, true);
    assert.equal(employments.ok, true);
    assert.deepStrictEqual(educations.ok && educations.data, [
      { id: 1, candidate_id: 501, degree_custom_field_option_id: 9, discipline_custom_field_option_id: 10, school_name_custom_field_option_id: 11 },
    ]);
    assert.deepStrictEqual(employments.ok && employments.data, [
      { id: 2, candidate_id: 501, company_name: "Acme", title: "Engineer" },
    ]);
    assert.doesNotMatch(JSON.stringify([educations, employments]), /cand@example\.com/i);
  });

  it("projects the custom_fields and pay_inputs schema dictionaries end-to-end (definitions only)", async () => {
    const scopedReader = fakeScopedReader((toolName) => {
      // email is a PII canary (not a real field on these schema dicts): the projector must drop it.
      if (toolName === "list_custom_fields") {
        return scopedSuccess(toolName, [{ id: 7, name: "Seniority", name_key: "seniority", field_type: "single_select", value_type: "string", private: false, email: "cf@example.com" }]);
      }
      if (toolName === "list_pay_inputs") {
        return scopedSuccess(toolName, [{ id: 8, title: "Base Salary", blurb: "Annual base", linked_custom_field_id: 9, priority: 1, locked: false, email: "pay@example.com" }]);
      }
      throw new Error(`unexpected tool ${toolName}`);
    });
    const { runtime } = testRuntime(scopedReader);

    const customFields = await runEvidenceTool(runtime, "search_my_custom_fields", {});
    const payInputs = await runEvidenceTool(runtime, "search_my_pay_inputs", {});

    assert.equal(customFields.ok, true);
    assert.equal(payInputs.ok, true);
    assert.deepStrictEqual(customFields.ok && customFields.data, [
      { id: 7, name: "Seniority", name_key: "seniority", field_type: "single_select", value_type: "string", private: false },
    ]);
    assert.deepStrictEqual(payInputs.ok && payInputs.data, [
      { id: 8, title: "Base Salary", blurb: "Annual base", linked_custom_field_id: 9, priority: 1, locked: false },
    ]);
    assert.doesNotMatch(JSON.stringify([customFields, payInputs]), /@example\.com/i);
  });

  it("strips identity-like params from global-reference evidence reads", async () => {
    const scopedReader = fakeScopedReader((toolName) => scopedSuccess(toolName, []));
    const { runtime } = testRuntime(scopedReader);

    await runEvidenceTool(runtime, "search_my_users", {
      ids: "77",
      email: "someone@example.com",
      user_id: 77,
      actAsUser: 900,
      per_page: 50,
    });

    assert.equal(scopedReader.calls.length, 1);
    assert.equal(scopedReader.calls[0]!.toolName, "list_users");
    assert.deepStrictEqual(scopedReader.calls[0]!.params, { ids: "77", per_page: 500 });
    assert.ok(scopedReader.calls[0]!.options?.signal instanceof AbortSignal);
  });

  it("normalizes evidence identifier fields and drops unsafe projected scalars", async () => {
    const scopedReader = fakeScopedReader((toolName) => {
      if (toolName === "list_applications") {
        return scopedSuccess(toolName, [{
          id: "00101",
          job_id: "10",
          candidate_id: "9007199254740993",
          stage_id: "0",
          stage_name: " Recruiter Screen",
          source_id: Number.POSITIVE_INFINITY,
          referrer_id: "not-an-id",
          credited_to_id: "77",
          current_stage_id: "007",
          current_stage: { id: "007", name: "Recruiter Screen", unsafe_nested: "drop" },
          status: "active",
          last_activity_at: "2026-06-20T00:00:00.000Z",
          created_at: "x".repeat(100_010),
        }]);
      }
      if (toolName === "list_candidates") {
        return scopedSuccess(toolName, [{
          id: "55",
          created_at: "2026-06-01T00:00:00.000Z",
          applications: [
            { id: "0101", job_id: "10", candidate_id: "55", status: "active" },
            { id: "0", job_id: "10", candidate_id: "55", status: "active" },
          ],
          application_ids: [101, 999999],
        }]);
      }
      throw new Error(`unexpected tool ${toolName}`);
    });
    const { runtime } = testRuntime(scopedReader);

    const applications = await runEvidenceTool(runtime, "search_my_applications", {});
    const candidates = await runEvidenceTool(runtime, "search_my_candidates", {});

    assert.equal(applications.ok, true);
    assert.equal(candidates.ok, true);
    const application = (applications.ok ? (applications.data as any[])[0] : {}) as any;
    assert.equal(application.id, 101, "string id 00101 normalizes to 101");
    assert.equal(application.job_id, 10);
    assert.equal(application.status, "active");
    assert.equal(application.current_stage_id, undefined, "undocumented ids fail closed");
    assert.equal(application.credited_to_id, undefined);
    assert.equal(application.last_activity_at, "2026-06-20T00:00:00.000Z");
    // Edge whitespace is trimmed, not dropped — the prior rule dropped any padded string wholesale,
    // which also gutted any note ending in a newline.
    assert.equal(application.stage_name, "Recruiter Screen");
    // current_stage is pruned to {id,name}; the unsafe nested field never survives.
    assert.deepStrictEqual(application.current_stage, { id: 7, name: "Recruiter Screen" });
    // Unsafe ids drop: candidate_id (> MAX_SAFE_INTEGER), stage_id ("0"), source_id (Infinity),
    // referrer_id ("not-an-id").
    assert.equal(application.candidate_id, undefined);
    assert.equal(application.stage_id, undefined);
    assert.equal(application.source_id, undefined);
    assert.equal(application.referrer_id, undefined);
    // A string longer than the 100k bound is truncated, not dropped — a long note must survive.
    assert.equal(typeof application.created_at, "string");
    assert.equal(application.created_at.length, 100_000, "strings over the 100k bound truncate to it");
    assert.deepStrictEqual(candidates.ok && candidates.data, [{
      id: 55,
      created_at: "2026-06-01T00:00:00.000Z",
      application_ids: [101],
      applications: [{
        id: 101,
        job_id: 10,
        candidate_id: 55,
        status: "active",
      }, {
        job_id: 10,
        candidate_id: 55,
        status: "active",
      }],
    }]);
    // Genuine safety canaries remain: the unsafe int id, the non-numeric referrer, the pruned nested
    // field, and the re-derived application_ids that must never leak the raw 999999.
    assert.doesNotMatch(JSON.stringify({ applications, candidates }), /9007199254740993|not-an-id|unsafe_nested|999999/);
  });

  it("passes trusted operator preview through runtime options, not tool params", async () => {
    const scopedReader = fakeScopedReader((toolName) => scopedSuccess(toolName, []));
    const { runtime, auditSink } = testRuntime(scopedReader, { trustedActAsUser: 321 });

    await runEvidenceTool(runtime, "search_my_jobs", { actAsUser: 999 });

    assert.equal(scopedReader.calls[0]!.options?.actAsUser, 321);
    assert.ok(scopedReader.calls[0]!.options?.signal instanceof AbortSignal);
    assert.deepStrictEqual(scopedReader.calls[0]!.params, { per_page: 500 });
    assert.equal(auditSink.events[0]!.operator, true);
    assert.equal(auditSink.events[0]!.actAsUser, 321);
  });

  it("audits operator unscoped passthrough separately from job-scoped reads", async () => {
    const scopedReader = fakeScopedReader((toolName) => scopedSuccess(toolName, [], null, {
      actorId: 900,
      effectiveActorId: 900,
      scoped: false,
      permissionScope: { kind: "operator", permittedJobCount: null },
    }));
    const { runtime, auditSink } = testRuntime(scopedReader);

    const result = await runEvidenceTool(runtime, "search_my_jobs", {});

    assert.equal(result.ok, true);
    assert.equal(auditSink.events[0]!.operator, true);
    assert.equal(auditSink.events[0]!.permissionScopeKind, "all");
    assert.equal(auditSink.events[0]!.permittedJobCount, null);
  });

  it("honors kill switches before calling the scoped reader", async () => {
    const scopedReader = fakeScopedReader(() => scopedSuccess("list_jobs", []));
    const { runtime, auditSink } = testRuntime(scopedReader, {
      toolConfig: {
        serverDisabled: false,
        disabledTools: new Set(["search_my_jobs"]),
        evidenceToolsEnabled: true,
        analyticalToolsEnabled: true,
        claudeDesktopEnabled: true,
        chatgptDesktopEnabled: true,
        operatorUnscopedEnabled: true,
      },
    });

    const result = await runEvidenceTool(runtime, "search_my_jobs", {});

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.denial.code, "TOOL_DISABLED");
    assert.equal(scopedReader.calls.length, 0);
    assert.equal(auditSink.events[0]!.denialCode, "TOOL_DISABLED");
  });

  it("audits raw rows read separately from rows returned after scoped filtering", async () => {
    const scopedReader = fakeScopedReader((toolName) => scopedSuccess(toolName, [{ id: 1, job_id: 10 }], null, {
      rowCounts: { raw: 3, returned: 1 },
    }));
    const { runtime, auditSink } = testRuntime(scopedReader);

    const result = await runEvidenceTool(runtime, "search_my_applications", {});

    assert.equal(result.ok, true);
    assert.equal(auditSink.events[0]!.rowsRead, 3);
    assert.equal(auditSink.events[0]!.rowsReturned, 1);
  });

  it("fails closed without returning evidence data when audit logging is unavailable", async () => {
    const scopedReader = fakeScopedReader((toolName) => scopedSuccess(toolName, [{ id: 1, job_id: 10 }]));
    const { runtime } = testRuntime(scopedReader, {
      auditSink: {
        emit() {
          throw new Error("disk full at /secret/audit.jsonl with token=shh");
        },
      },
    });

    const result = await runEvidenceTool(runtime, "search_my_applications", {});

    assert.equal(scopedReader.calls.length, 0, "a failed start audit denies before reading Greenhouse");
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.denial.code, "AUDIT_UNAVAILABLE");
    assert.doesNotMatch(JSON.stringify(result), /job_id|token=shh|secret\/audit/);
  });


  it("times out slow scoped evidence reads before returning data", async () => {
    const scopedReader = fakeScopedReader(() => new Promise(() => {}));
    const { runtime, auditSink } = testRuntime(scopedReader, {
      limits: { ...DEFAULT_LIMITS, maxToolDurationMs: 1 },
    });

    const result = await runEvidenceTool(runtime, "search_my_jobs", {});

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.denial.code, "TOOL_TIMEOUT");
    assert.equal(scopedReader.calls.length, 1);
    assert.equal(auditSink.events[0]!.denialCode, "TOOL_TIMEOUT");
    assert.equal(auditSink.events[0]!.rowsRead, null);
  });

  it("rate-limits excessive evidence calls before reading Greenhouse", async () => {
    const scopedReader = fakeScopedReader((toolName) => scopedSuccess(toolName, []));
    const { runtime, auditSink } = testRuntime(scopedReader, {
      rateLimiter: createInMemoryRateLimiter({
        windowMs: 60_000,
        maxCallsPerWindow: 1,
        maxAnalysisCallsPerWindow: 1,
      }),
    });

    const first = await runEvidenceTool(runtime, "search_my_jobs", {});
    const second = await runEvidenceTool(runtime, "search_my_jobs", {});

    assert.equal(first.ok, true);
    assert.equal(second.ok, false);
    assert.equal(second.ok === false && second.denial.code, "RATE_LIMITED");
    assert.equal(scopedReader.calls.length, 1);
    assert.equal(auditSink.events[1]!.denialCode, "RATE_LIMITED");
    assert.equal(auditSink.events[1]!.rowsRead, null);
  });
});
