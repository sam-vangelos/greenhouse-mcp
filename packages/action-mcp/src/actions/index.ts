import { applicationAssignmentAction } from "./application-assignment.js";
import { applicationAttributionAction } from "./application-attribution.js";
import { applicationRejectionAction } from "./application-rejection.js";
import { applicationStageMoveAction } from "./application-stage-move.js";
import { applicationUnrejectAction } from "./application-unreject.js";
import { candidateNoteCreateAction } from "./candidate-note-create.js";
import { candidateRecordUpdateAction } from "./candidate-record-update.js";
import { jobNoteChangeAction } from "./job-note-change.js";
import { jobOwnerAction } from "./job-owner.js";
import { offerCreateAction } from "./offer-create.js";
import { offerUpdateAction } from "./offer-update.js";
import type { ActionKind } from "../types.js";
import type { ActionDefinition } from "./types.js";

export const ACTION_DEFINITIONS: readonly ActionDefinition[] = [
  applicationAssignmentAction,
  jobOwnerAction,
  applicationStageMoveAction,
  applicationRejectionAction,
  applicationUnrejectAction,
  candidateNoteCreateAction,
  jobNoteChangeAction,
  applicationAttributionAction,
  candidateRecordUpdateAction,
  offerCreateAction,
  offerUpdateAction,
];

const byKind = new Map<ActionKind, ActionDefinition>();
const toolNames = new Set<string>();
for (const definition of ACTION_DEFINITIONS) {
  if (byKind.has(definition.kind)) throw new Error(`Duplicate Greenhouse action kind: ${definition.kind}`);
  if (toolNames.has(definition.previewTool) || toolNames.has(definition.applyTool) || definition.previewTool === definition.applyTool) {
    throw new Error(`Duplicate Greenhouse action tool for ${definition.kind}.`);
  }
  byKind.set(definition.kind, definition);
  toolNames.add(definition.previewTool);
  toolNames.add(definition.applyTool);
}

export function actionDefinition(kind: ActionKind): ActionDefinition {
  const definition = byKind.get(kind);
  if (!definition) throw new Error(`Unsupported Greenhouse action kind: ${kind}`);
  return definition;
}

export type { ActionContext, ActionDefinition } from "./types.js";
