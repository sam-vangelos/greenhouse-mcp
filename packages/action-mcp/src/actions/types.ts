import type { z } from "zod";
import type {
  ActionKind,
  ActionRecord,
  Clock,
  GreenhouseGateway,
  MutationPlan,
  MutationResponse,
  Observation,
  PreparedAction,
} from "../types.js";

export interface ActionContext {
  actorUserId: number;
  greenhouse: GreenhouseGateway;
  signingSecret: string;
  clock: Clock;
}

export interface ActionDefinition {
  kind: ActionKind;
  previewTool: string;
  applyTool: string;
  previewTitle: string;
  applyTitle: string;
  previewDescription: string;
  applyDescription: string;
  destructive: boolean;
  previewSchema: z.ZodTypeAny;
  applySchema: z.ZodTypeAny;
  catalogPreviewSchema?: z.ZodTypeAny;
  catalogApplySchema?: z.ZodTypeAny;
  getApproval(input: unknown): unknown;
  preparePreview(input: unknown, context: ActionContext): Promise<PreparedAction>;
  prepareApply(approval: unknown, context: ActionContext): Promise<PreparedAction>;
  mutation(approval: unknown, prepared: PreparedAction, context: ActionContext): Promise<MutationPlan>;
  observe(record: ActionRecord, context: ActionContext): Promise<Observation>;
  resultResourceId?(response: MutationResponse): number | null;
}
