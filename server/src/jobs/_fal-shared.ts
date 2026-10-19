import { FalError } from "@apicity/fal";

export function describeFalError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (!(cause instanceof FalError)) return message;
  if (!cause.body || typeof cause.body !== "object") return message;
  const raw = (cause.body as Record<string, unknown>).detail;
  const detail = typeof raw === "string" ? raw : Array.isArray(raw) ? raw.slice(0, 8).flatMap((item: unknown) => {
    if (!item || typeof item !== "object") return [];
    const { loc, msg } = item as Record<string, unknown>;
    if (typeof msg !== "string") return [];
    const path = Array.isArray(loc) ? loc.filter((part) => typeof part === "string" || typeof part === "number")
      .filter((part) => part !== "body").join(".") : "";
    return [path ? `${path}: ${msg}` : msg];
  }).join("; ") : "";
  if (detail.length === 0 || message.includes(detail)) return message;
  return `${message}: ${detail.slice(0, 2000)}`;
}
