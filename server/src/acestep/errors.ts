type AceStepErrorKind =
  | "binary_missing"
  | "models_missing"
  | "spawn_failed"
  | "health_timeout"
  | "server_exited"
  | "unreachable"
  | "synth_timeout"
  | "synth_http_error"
  | "synth_failed"
  | "malformed_response";

export class AceStepError extends Error {
  readonly kind: AceStepErrorKind;

  constructor(kind: AceStepErrorKind, message: string) {
    super(message);
    this.name = "AceStepError";
    this.kind = kind;
  }
}
