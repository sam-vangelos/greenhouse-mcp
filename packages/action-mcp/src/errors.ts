export interface ActionDeniedDiagnostic {
  sourceErrorName: string;
  upstreamStatus?: number | null;
  upstreamRequestId?: string | null;
}

export class ActionDeniedError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly diagnostic?: ActionDeniedDiagnostic
  ) {
    super(message);
    this.name = "ActionDeniedError";
  }
}
