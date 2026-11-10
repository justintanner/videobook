import type { GraphicsEditError } from "./edits.js";

type GraphicsServiceErrorCode = "conflict" | "invalid" | "not_found" | "not_ready" | "stale_source";

type GraphicsErrorDetails = {
  revision?: string;
  edit?: Omit<GraphicsEditError, "message">;
  issues?: string[];
  layer_id?: string;
  template_id?: string;
};

export class GraphicsServiceError extends Error {
  readonly code: GraphicsServiceErrorCode;
  readonly details: GraphicsErrorDetails;

  constructor(code: GraphicsServiceErrorCode, message: string, details: GraphicsErrorDetails = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}
