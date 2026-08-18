import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildOfferLetterContext,
  selectPrimaryOffer,
  type OfferLetterOffer,
} from "../src/offer-letter-context.js";

const RAW_APPLICATION = Object.freeze({
  id: 55501,
  candidate_id: 70015,
  job_id: 333,
  status: "active",
  stage_id: 8801,
  stage_name: "Offer",
  current_stage_at: "2026-05-01T10:00:00Z",
  last_activity_at: "2026-05-08T09:00:00Z",
  answers: [
    { question: "Preferred location?", answer: "San Francisco, CA" },
    { question: "Authorized to work?", answer: "Yes" },
  ],
});

const RAW_CANDIDATE = Object.freeze({
  id: 70015,
  first_name: "Jane",
  last_name: "Doe",
  email_addresses: [
    { value: "jane.alt@example.com", primary: false },
    { value: "jane.doe@example.com", primary: true },
  ],
  phone_numbers: [{ value: "+15551234567", primary: true }],
  addresses: [{ city: "San Francisco", state: "CA", country: "US", primary: true }],
  social_media_addresses: [
    { value: "https://github.com/janedoe" },
    { value: "https://www.linkedin.com/in/janedoe", primary: true },
  ],
  attachments: [
    {
      filename: "jane-doe-resume.pdf",
      type: "resume",
      created_at: "2026-04-01T00:00:00Z",
      url: "https://signed.example.com/resume",
    },
  ],
});

const RAW_OFFERS = Object.freeze([
  {
    id: 9001,
    application_id: 55501,
    job_id: 333,
    status: "accepted",
    // v3 names the start date `starts_on`; 9002 below keeps legacy `start_date` to prove the fallback.
    starts_on: "2026-06-01",
    updated_at: "2026-05-08T08:00:00Z",
    custom_fields: { rsu_grant: "100000", bay_area_required: true },
    keyed_custom_fields: {
      ote_split: { value: "70/30" },
    },
    base_salary: 250000,
  },
  {
    id: 9002,
    application_id: 55501,
    job_id: 333,
    status: "created",
    start_date: "2026-06-15",
    updated_at: "2026-05-09T08:00:00Z",
    custom_fields: { rsu_grant: "125000" },
  },
]);

const RAW_NOTES = Object.freeze([
  {
    id: 1,
    type: "EMAIL",
    visibility: "publicly_visible",
    user_id: 42,
    created_at: "2026-05-07T12:00:00Z",
    application_id: 55501,
    candidate_id: 70015,
    subject: "Offer calibration",
    body: "Candidate is aligned on Bay Area hybrid schedule.",
  },
]);

const RAW_SCORECARDS = Object.freeze([
  {
    id: 8801,
    application_id: 55501,
    interviewer_id: 42,
    submitter_id: 43,
    status: "complete",
    submitted_at: "2026-05-06T12:34:56.789Z",
    overall_rating: "strong_yes",
    questions: [
      {
        question: "Leadership signal?",
        answer: "Clear staff-level ownership and scope shaping.",
        note: "Strong cross-functional partner.",
        value: "strong_yes",
      },
    ],
    attributes: [
      { name: "Communication", rating: 5, note: "Crisp and credible." },
    ],
  },
]);

describe("buildOfferLetterContext", () => {
  it("builds a deterministic offer-letter bundle from raw records", () => {
    const context = buildOfferLetterContext({
      application: RAW_APPLICATION,
      candidate: RAW_CANDIDATE,
      offers: RAW_OFFERS,
      notes: RAW_NOTES,
      scorecards: RAW_SCORECARDS,
      includeAttachmentUrls: false,
    });

    assert.equal(context.application?.id, 55501);
    assert.equal(context.application?.answers.length, 2);

    assert.equal(context.candidate?.full_name, "Jane Doe");
    assert.equal(context.candidate?.primary_email, "jane.doe@example.com");
    assert.equal(context.candidate?.primary_phone, "+15551234567");
    assert.equal(context.candidate?.linkedin_url, "https://www.linkedin.com/in/janedoe");
    assert.equal(context.candidate?.location, "San Francisco, CA, US");

    assert.equal(context.attachments.length, 1);
    assert.equal(context.attachments[0]?.filename, "jane-doe-resume.pdf");
    assert.equal(context.attachments[0]?.url, null);

    assert.equal(context.primary_offer?.id, 9002);
    assert.equal(context.offers.length, 2);
    assert.deepStrictEqual(context.offers[0]?.custom_fields, {
      rsu_grant: "100000",
      bay_area_required: true,
    });
    // start_date is projected from the v3 `starts_on` field (#H twin): offers[0] (9001) carries
    // starts_on, offers[1] (9002) carries only the legacy start_date — proving the `??` fallback.
    assert.equal(context.offers[0]?.start_date, "2026-06-01");
    assert.equal(context.offers[1]?.start_date, "2026-06-15");
    // The v3-absent fabrications are gone even though the raw offer carried them as input.
    assert.ok(!("keyed_custom_fields" in (context.offers[0] ?? {})));
    assert.ok(!("compensation" in (context.offers[0] ?? {})));
    assert.ok(!("current_stage_at" in (context.application ?? {})));

    assert.equal(context.notes[0]?.body, "Candidate is aligned on Bay Area hybrid schedule.");
    assert.equal(context.scorecards[0]?.questions[0]?.answer, "Clear staff-level ownership and scope shaping.");
    assert.equal(context.scorecards[0]?.attributes[0]?.note, "Crisp and credible.");
  });

  it("includes signed attachment urls only when explicitly requested", () => {
    const context = buildOfferLetterContext({
      application: RAW_APPLICATION,
      candidate: RAW_CANDIDATE,
      offers: RAW_OFFERS,
      includeAttachmentUrls: true,
    });

    assert.equal(context.attachments[0]?.url, "https://signed.example.com/resume");
  });

  it("honors a preferred offer id when one is explicitly requested", () => {
    const context = buildOfferLetterContext({
      application: RAW_APPLICATION,
      candidate: RAW_CANDIDATE,
      offers: RAW_OFFERS,
      preferredOfferId: 9001,
    });

    assert.equal(context.primary_offer?.id, 9001);
  });
});

describe("selectPrimaryOffer", () => {
  it("prefers created offers over accepted/rejected/deprecated ones by default", () => {
    const offers: OfferLetterOffer[] = [
      {
        id: 1,
        application_id: 10,
        job_id: 20,
        status: "accepted",
        start_date: null,
        created_at: null,
        updated_at: "2026-05-08T00:00:00Z",
        custom_fields: null,
      },
      {
        id: 2,
        application_id: 10,
        job_id: 20,
        status: "created",
        start_date: null,
        created_at: null,
        updated_at: "2026-05-01T00:00:00Z",
        custom_fields: null,
      },
    ];

    assert.equal(selectPrimaryOffer(offers)?.id, 2);
  });
});
