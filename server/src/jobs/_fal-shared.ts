import { FalError } from "@apicity/fal";
import type { Engine } from "videobook-engine";
import { MODEL_DISPLAY } from "@apicity/cost";

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

export function falRefusalCategories(body: unknown): string[] | null {
  if (!body || typeof body !== "object" || !("detail" in body) || !Array.isArray(body.detail)) return null;
  const refusals = body.detail.filter((item: unknown): item is Record<string, unknown> =>
    !!item && typeof item === "object" && "type" in item && item.type === "content_policy_violation");
  if (refusals.length === 0) return null;
  return [...new Set(refusals.flatMap((item) => Array.isArray(item.categories)
    ? item.categories.filter((category: unknown): category is string => typeof category === "string") : []))];
}

export function falContentRefusal(cause: unknown, model?: string): { message: string; failCode: string; categories: string[] } | null {
  if (!(cause instanceof FalError)) {
    return cause instanceof Error && cause.cause ? falContentRefusal(cause.cause, model) : null;
  }
  const categories = falRefusalCategories(cause.body);
  if (!categories) return null;
  const titles = MODEL_DISPLAY.fal as Record<string, string>;
  const label = model ? titles[model.replace(/^fal:/u, "")] ?? model : "The model";
  return {
    failCode: "content_policy_violation",
    categories,
    message: `${label} refused this request: its content checker flagged it${categories.length ? ` (${categories.join(", ")})` : ""}. Sending the same request again will most likely be refused again. Change the prompt or the input, or use another model.`,
  };
}

export async function recordFalRefusal(engine: Engine, artifactId: string, cause: unknown, model?: string): Promise<{ message: string; failCode: string } | null> {
  const refusal = falContentRefusal(cause, model);
  if (!refusal) return null;
  const written = await engine.metadata.artifacts.write(artifactId, "provider-refusal", refusal);
  if (!written.ok) throw new Error(written.error.message);
  return { message: refusal.message, failCode: refusal.failCode };
}
