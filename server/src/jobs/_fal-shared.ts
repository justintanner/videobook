import { FalError } from "@apicity/fal";

export function falErrorDetail(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const raw = (body as Record<string, unknown>).detail;
  return typeof raw === "string" ? raw : Array.isArray(raw) ? raw.slice(0, 8).flatMap((item: unknown) => {
    if (!item || typeof item !== "object") return [];
    const { loc, msg } = item as Record<string, unknown>;
    if (typeof msg !== "string") return [];
    const path = Array.isArray(loc) ? loc.filter((part) => typeof part === "string" || typeof part === "number")
      .filter((part) => part !== "body").join(".") : "";
    return [path ? `${path}: ${msg}` : msg];
  }).join("; ") : "";
}

export function describeFalError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (!(cause instanceof FalError)) return message;
  const detail = falErrorDetail(cause.body);
  if (detail.length === 0 || message.includes(detail)) return message;
  return `${message}: ${detail.slice(0, 2000)}`;
}
