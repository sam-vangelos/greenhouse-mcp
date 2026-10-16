import {
  isProjectableObject,
  normalizeNumberOrNull,
  normalizeStringOrNull,
  projectArray,
} from "./projection-shared.js";

export interface ProjectedOffer {
  id: number | null;
  application_id: number | null;
  status: string | null;
  start_date: string | null;
}

// The detail profile surfaces the offer's real v3 fields (timestamps + custom_fields).
// Structured compensation is NOT a v3 offer field — pay lives in the separate pay_inputs
// domain — so the earlier `compensation` (eight always-null pay keys) and `keyed_custom_fields`
// (not a v3 field) were dropped (#H) rather than fabricate pay data the offer doesn't carry.
// Org compensation, where recorded on the offer, lives in `custom_fields`.
export interface ProjectedOfferCompensation extends ProjectedOffer {
  created_at: string | null;
  updated_at: string | null;
  custom_fields: Record<string, unknown> | null;
}

export interface OfferProjectionOptions {
  detailProfile?: "operational" | "compensation";
}

export function projectOffer(raw: unknown): ProjectedOffer;
export function projectOffer(
  raw: unknown,
  options: OfferProjectionOptions & { detailProfile: "compensation" }
): ProjectedOfferCompensation;
export function projectOffer(
  raw: unknown,
  options?: OfferProjectionOptions
): ProjectedOffer | ProjectedOfferCompensation {
  const detailProfile = options?.detailProfile ?? "operational";

  if (!isProjectableObject(raw)) {
    const base: ProjectedOffer = {
      id: null,
      application_id: null,
      status: null,
      start_date: null,
    };
    if (detailProfile === "compensation") {
      return {
        ...base,
        created_at: null,
        updated_at: null,
        custom_fields: null,
      };
    }
    return base;
  }

  const base: ProjectedOffer = {
    id: normalizeNumberOrNull(raw.id),
    application_id: normalizeNumberOrNull(raw.application_id),
    status: normalizeStringOrNull(raw.status),
    // Harvest v3 names the offer start date `starts_on` (0130-get_v3-offers.md); `start_date`
    // is a legacy fallback. The projected output key stays `start_date`. The earlier code read
    // only `raw.start_date`, which v3 never emits, so the field was always null on v3 (#H).
    start_date: normalizeStringOrNull(raw.starts_on ?? raw.start_date),
  };

  if (detailProfile !== "compensation") {
    return base;
  }

  return {
    ...base,
    created_at: normalizeStringOrNull(raw.created_at),
    updated_at: normalizeStringOrNull(raw.updated_at),
    custom_fields: isProjectableObject(raw.custom_fields) ? raw.custom_fields : null,
  };
}

export function projectOffersArray(raw: unknown): ProjectedOffer[];
export function projectOffersArray(
  raw: unknown,
  options: OfferProjectionOptions & { detailProfile: "compensation" }
): ProjectedOfferCompensation[];
export function projectOffersArray(
  raw: unknown,
  options?: OfferProjectionOptions
): ProjectedOffer[] | ProjectedOfferCompensation[] {
  return projectArray(raw, (entry) => projectOffer(entry, options as any));
}
