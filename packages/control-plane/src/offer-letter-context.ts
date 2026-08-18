import {
  isProjectableObject,
  normalizeNumberOrNull,
  normalizeStringOrNull,
} from "./projection-shared.js";

export interface OfferLetterApplicationAnswer {
  question: string | null;
  answer: string | null;
}

export interface OfferLetterApplication {
  id: number | null;
  candidate_id: number | null;
  job_id: number | null;
  status: string | null;
  stage_id: number | null;
  stage_name: string | null;
  last_activity_at: string | null;
  answers: OfferLetterApplicationAnswer[];
}

export interface OfferLetterAttachment {
  filename: string | null;
  type: string | null;
  created_at: string | null;
  url: string | null;
}

export interface OfferLetterCandidate {
  id: number | null;
  first_name: string | null;
  last_name: string | null;
  full_name: string | null;
  primary_email: string | null;
  primary_phone: string | null;
  linkedin_url: string | null;
  location: string | null;
}

export interface OfferLetterOffer {
  id: number | null;
  application_id: number | null;
  job_id: number | null;
  status: string | null;
  // Projected from the v3 offer's `starts_on` (0130); the output key stays `start_date`.
  start_date: string | null;
  created_at: string | null;
  updated_at: string | null;
  // Where the org records offer compensation on the offer, per the v3 contract (0130). The
  // earlier `keyed_custom_fields` + structured `compensation` were v3-absent fabrications (#H twin).
  custom_fields: Record<string, unknown> | null;
}

export interface OfferLetterNote {
  id: number | null;
  type: string | null;
  visibility: string | null;
  user_id: number | null;
  created_at: string | null;
  application_id: number | null;
  candidate_id: number | null;
  subject: string | null;
  body: string | null;
}

export interface OfferLetterScorecardQuestion {
  question: string | null;
  answer: string | null;
  note: string | null;
  value: string | null;
}

export interface OfferLetterScorecardAttribute {
  name: string | null;
  rating: number | null;
  note: string | null;
}

export interface OfferLetterScorecard {
  id: number | null;
  application_id: number | null;
  interviewer_id: number | null;
  submitter_id: number | null;
  status: string | null;
  submitted_at: string | null;
  overall_rating: string | null;
  questions: OfferLetterScorecardQuestion[];
  attributes: OfferLetterScorecardAttribute[];
}

export interface OfferLetterContext {
  application: OfferLetterApplication | null;
  candidate: OfferLetterCandidate | null;
  attachments: OfferLetterAttachment[];
  primary_offer: OfferLetterOffer | null;
  offers: OfferLetterOffer[];
  notes: OfferLetterNote[];
  scorecards: OfferLetterScorecard[];
}

export interface BuildOfferLetterContextInput {
  application: unknown;
  candidate: unknown;
  offers?: unknown;
  notes?: unknown;
  scorecards?: unknown;
  includeAttachmentUrls?: boolean;
  preferredOfferId?: number | null;
}

function sortByPrimaryFlag<T extends Record<string, unknown>>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const aPrimary = a.primary === true ? 1 : 0;
    const bPrimary = b.primary === true ? 1 : 0;
    return bPrimary - aPrimary;
  });
}

function firstStringField(
  items: unknown,
  valueKey = "value"
): string | null {
  if (!Array.isArray(items)) {
    return null;
  }
  for (const item of sortByPrimaryFlag(items.filter(isProjectableObject))) {
    const value = normalizeStringOrNull(item[valueKey]);
    if (value) {
      return value;
    }
  }
  return null;
}

function deriveLinkedInUrl(items: unknown): string | null {
  if (!Array.isArray(items)) {
    return null;
  }

  let fallback: string | null = null;
  for (const item of sortByPrimaryFlag(items.filter(isProjectableObject))) {
    const value = normalizeStringOrNull(item.value);
    if (!value) {
      continue;
    }
    if (fallback === null) {
      fallback = value;
    }
    if (value.toLowerCase().includes("linkedin.com")) {
      return value;
    }
  }
  return fallback;
}

function deriveLocation(addresses: unknown): string | null {
  if (!Array.isArray(addresses)) {
    return null;
  }
  for (const entry of sortByPrimaryFlag(addresses.filter(isProjectableObject))) {
    const inlineValue = normalizeStringOrNull(entry.value);
    if (inlineValue) {
      return inlineValue;
    }
    const parts = [
      normalizeStringOrNull(entry.address_1),
      normalizeStringOrNull(entry.address_2),
      normalizeStringOrNull(entry.city),
      normalizeStringOrNull(entry.state),
      normalizeStringOrNull(entry.postal_code),
      normalizeStringOrNull(entry.country),
    ].filter((part): part is string => typeof part === "string" && part.length > 0);
    if (parts.length > 0) {
      return parts.join(", ");
    }
  }
  return null;
}

function projectApplicationAnswers(raw: unknown): OfferLetterApplicationAnswer[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const answers: OfferLetterApplicationAnswer[] = [];
  for (const entry of raw) {
    if (!isProjectableObject(entry)) {
      continue;
    }
    answers.push({
      question: normalizeStringOrNull(entry.question),
      answer: normalizeStringOrNull(entry.answer),
    });
  }
  return answers;
}

function projectApplication(raw: unknown): OfferLetterApplication | null {
  if (!isProjectableObject(raw)) {
    return null;
  }
  const currentStage = isProjectableObject(raw.current_stage) ? raw.current_stage : null;
  return {
    id: normalizeNumberOrNull(raw.id),
    candidate_id:
      normalizeNumberOrNull(raw.candidate_id) ??
      (isProjectableObject(raw.candidate) ? normalizeNumberOrNull(raw.candidate.id) : null),
    job_id:
      normalizeNumberOrNull(raw.job_id) ??
      (isProjectableObject(raw.job) ? normalizeNumberOrNull(raw.job.id) : null),
    status: normalizeStringOrNull(raw.status),
    stage_id:
      normalizeNumberOrNull(raw.stage_id) ??
      (currentStage ? normalizeNumberOrNull(currentStage.id) : null),
    stage_name:
      normalizeStringOrNull(raw.stage_name) ??
      (currentStage ? normalizeStringOrNull(currentStage.name) : null),
    last_activity_at: normalizeStringOrNull(raw.last_activity_at),
    answers: projectApplicationAnswers(raw.answers),
  };
}

function projectAttachments(
  raw: unknown,
  includeAttachmentUrls: boolean
): OfferLetterAttachment[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const attachments: OfferLetterAttachment[] = [];
  for (const entry of raw) {
    if (!isProjectableObject(entry)) {
      continue;
    }
    attachments.push({
      filename: normalizeStringOrNull(entry.filename),
      type: normalizeStringOrNull(entry.type),
      created_at: normalizeStringOrNull(entry.created_at),
      url: includeAttachmentUrls ? normalizeStringOrNull(entry.url) : null,
    });
  }
  return attachments;
}

function projectCandidate(
  raw: unknown,
  includeAttachmentUrls: boolean
): { candidate: OfferLetterCandidate | null; attachments: OfferLetterAttachment[] } {
  if (!isProjectableObject(raw)) {
    return {
      candidate: null,
      attachments: [],
    };
  }

  const firstName = normalizeStringOrNull(raw.first_name);
  const lastName = normalizeStringOrNull(raw.last_name);
  const fullName =
    [firstName, lastName].filter((part): part is string => typeof part === "string" && part.length > 0)
      .join(" ")
      .trim() || normalizeStringOrNull(raw.name);

  return {
    candidate: {
      id: normalizeNumberOrNull(raw.id),
      first_name: firstName,
      last_name: lastName,
      full_name: fullName,
      primary_email:
        firstStringField(raw.email_addresses) ??
        normalizeStringOrNull(raw.email),
      primary_phone: firstStringField(raw.phone_numbers),
      linkedin_url: deriveLinkedInUrl(raw.social_media_addresses),
      location: deriveLocation(raw.addresses),
    },
    attachments: projectAttachments(raw.attachments, includeAttachmentUrls),
  };
}

function projectOffer(raw: unknown): OfferLetterOffer {
  if (!isProjectableObject(raw)) {
    return {
      id: null,
      application_id: null,
      job_id: null,
      status: null,
      start_date: null,
      created_at: null,
      updated_at: null,
      custom_fields: null,
    };
  }

  return {
    id: normalizeNumberOrNull(raw.id),
    application_id: normalizeNumberOrNull(raw.application_id),
    job_id:
      normalizeNumberOrNull(raw.job_id) ??
      (isProjectableObject(raw.job) ? normalizeNumberOrNull(raw.job.id) : null),
    status: normalizeStringOrNull(raw.status),
    // Harvest v3 names the offer start date `starts_on` (0130); `start_date` is a legacy
    // fallback. The earlier code read only `raw.start_date`, which v3 never emits, so the start
    // date was always null on v3. The two prior fabrications are dropped (#H twin): structured
    // `compensation` synthesized from eight pay keys absent from the v3 offer (pay lives in the
    // separate pay_inputs domain), and `keyed_custom_fields` (not a v3 field). Org comp, where
    // recorded on the offer, lives in `custom_fields`.
    start_date: normalizeStringOrNull(raw.starts_on ?? raw.start_date),
    created_at: normalizeStringOrNull(raw.created_at),
    updated_at: normalizeStringOrNull(raw.updated_at),
    custom_fields: isProjectableObject(raw.custom_fields) ? raw.custom_fields : null,
  };
}

function statusRank(status: string | null): number {
  switch (status) {
    case "created":
      return 0;
    case "accepted":
      return 1;
    case "rejected":
      return 2;
    case "deprecated":
      return 3;
    default:
      return 4;
  }
}

function sortOffers(offers: OfferLetterOffer[]): OfferLetterOffer[] {
  return [...offers].sort((a, b) => {
    const statusDelta = statusRank(a.status) - statusRank(b.status);
    if (statusDelta !== 0) {
      return statusDelta;
    }

    const aUpdated = a.updated_at ? Date.parse(a.updated_at) : Number.NEGATIVE_INFINITY;
    const bUpdated = b.updated_at ? Date.parse(b.updated_at) : Number.NEGATIVE_INFINITY;
    const safeAUpdated = Number.isFinite(aUpdated) ? aUpdated : Number.NEGATIVE_INFINITY;
    const safeBUpdated = Number.isFinite(bUpdated) ? bUpdated : Number.NEGATIVE_INFINITY;
    if (safeBUpdated !== safeAUpdated) {
      return safeBUpdated - safeAUpdated;
    }

    const aCreated = a.created_at ? Date.parse(a.created_at) : Number.NEGATIVE_INFINITY;
    const bCreated = b.created_at ? Date.parse(b.created_at) : Number.NEGATIVE_INFINITY;
    const safeACreated = Number.isFinite(aCreated) ? aCreated : Number.NEGATIVE_INFINITY;
    const safeBCreated = Number.isFinite(bCreated) ? bCreated : Number.NEGATIVE_INFINITY;
    if (safeBCreated !== safeACreated) {
      return safeBCreated - safeACreated;
    }

    return (b.id ?? 0) - (a.id ?? 0);
  });
}

export function selectPrimaryOffer(
  offers: OfferLetterOffer[],
  preferredOfferId: number | null = null
): OfferLetterOffer | null {
  if (preferredOfferId !== null) {
    const preferred = offers.find((offer) => offer.id === preferredOfferId);
    if (preferred) {
      return preferred;
    }
  }
  const sorted = sortOffers(offers);
  return sorted[0] ?? null;
}

function projectOffers(raw: unknown): OfferLetterOffer[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.map(projectOffer);
}

function projectNotes(raw: unknown): OfferLetterNote[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const notes: OfferLetterNote[] = [];
  for (const entry of raw) {
    if (!isProjectableObject(entry)) {
      continue;
    }
    notes.push({
      id: normalizeNumberOrNull(entry.id),
      type: normalizeStringOrNull(entry.type),
      visibility: normalizeStringOrNull(entry.visibility),
      user_id: normalizeNumberOrNull(entry.user_id),
      created_at: normalizeStringOrNull(entry.created_at),
      application_id: normalizeNumberOrNull(entry.application_id),
      candidate_id: normalizeNumberOrNull(entry.candidate_id),
      subject: normalizeStringOrNull(entry.subject),
      body: normalizeStringOrNull(entry.body),
    });
  }
  return notes;
}

function projectScorecardQuestions(raw: unknown): OfferLetterScorecardQuestion[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const questions: OfferLetterScorecardQuestion[] = [];
  for (const entry of raw) {
    if (!isProjectableObject(entry)) {
      continue;
    }
    questions.push({
      question: normalizeStringOrNull(entry.question),
      answer: normalizeStringOrNull(entry.answer),
      note: normalizeStringOrNull(entry.note),
      value: normalizeStringOrNull(entry.value),
    });
  }
  return questions;
}

function projectScorecardAttributes(raw: unknown): OfferLetterScorecardAttribute[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const attributes: OfferLetterScorecardAttribute[] = [];
  for (const entry of raw) {
    if (!isProjectableObject(entry)) {
      continue;
    }
    attributes.push({
      name: normalizeStringOrNull(entry.name),
      rating: normalizeNumberOrNull(entry.rating),
      note: normalizeStringOrNull(entry.note),
    });
  }
  return attributes;
}

function projectScorecards(raw: unknown): OfferLetterScorecard[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const scorecards: OfferLetterScorecard[] = [];
  for (const entry of raw) {
    if (!isProjectableObject(entry)) {
      continue;
    }
    scorecards.push({
      id: normalizeNumberOrNull(entry.id),
      application_id: normalizeNumberOrNull(entry.application_id),
      interviewer_id: normalizeNumberOrNull(entry.interviewer_id),
      submitter_id: normalizeNumberOrNull(entry.submitter_id),
      status: normalizeStringOrNull(entry.status),
      submitted_at: normalizeStringOrNull(entry.submitted_at),
      overall_rating: normalizeStringOrNull(entry.overall_rating),
      questions: projectScorecardQuestions(entry.questions),
      attributes: projectScorecardAttributes(entry.attributes),
    });
  }
  return scorecards;
}

export function buildOfferLetterContext(
  input: BuildOfferLetterContextInput
): OfferLetterContext {
  const application = projectApplication(input.application);
  const candidateProjection = projectCandidate(
    input.candidate,
    input.includeAttachmentUrls === true
  );
  const offers = projectOffers(input.offers);
  return {
    application,
    candidate: candidateProjection.candidate,
    attachments: candidateProjection.attachments,
    primary_offer: selectPrimaryOffer(offers, input.preferredOfferId ?? null),
    offers,
    notes: projectNotes(input.notes),
    scorecards: projectScorecards(input.scorecards),
  };
}
