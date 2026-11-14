import { MODEL_DISPLAY } from "@apicity/cost";
import type { Engine } from "videobook-engine";
import { recordFalRefusal } from "./jobs/_fal-shared.js";

type Refusal = { message: string; failCode: string; categories: string[] };
type ResponseProvider = "openai" | "xai";

export class ProviderRefusalError extends Error {
  readonly status = 200;
  readonly refusal: Refusal;

  constructor(refusal: Refusal) {
    super(refusal.message);
    this.name = "ProviderRefusalError";
    this.refusal = refusal;
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function responseRefusal(provider: ResponseProvider, response: unknown, fallbackModel?: string): ProviderRefusalError | null {
  const body = record(response);
  if (body.error || (typeof body.status === "string" && body.status !== "completed")) return null;
  const reasons: string[] = [];
  if (Array.isArray(body.output)) {
    for (const item of body.output) {
      const message = record(item);
      if (message.type !== "message" || !Array.isArray(message.content)) continue;
      for (const part of message.content) {
        const content = record(part);
        if (content.type === "refusal") reasons.push(typeof content.refusal === "string" ? content.refusal.trim() : "");
      }
    }
  }
  if (Array.isArray(body.choices)) {
    for (const choice of body.choices) {
      const message = record(record(choice).message);
      if (typeof message.refusal === "string" && message.refusal.trim()) reasons.push(message.refusal.trim());
    }
  }
  if (reasons.length === 0) return null;
  const model = typeof body.model === "string" ? body.model : fallbackModel;
  const titles = MODEL_DISPLAY[provider] as Record<string, string>;
  const label = model ? titles[model] ?? model : "The model";
  const reason = [...new Set(reasons.filter(Boolean))].join(" ") || "the model declined to provide a response";
  return new ProviderRefusalError({
    message: `${label} refused this request: ${reason}${/[.!?]$/u.test(reason) ? "" : "."} Sending the same request again will most likely be refused again. Change the prompt or the input, or use another model.`,
    failCode: "content_policy_violation",
    categories: [],
  });
}

export function withResponseRefusals<T extends object>(provider: ResponseProvider, method: T): T {
  return new Proxy(method, {
    async apply(target, receiver, args: unknown[]) {
      const response: unknown = await Reflect.apply(target as (...values: unknown[]) => unknown, receiver, args);
      if (typeof args[0] !== "object" || args[0] === null) return response;
      const model = record(args[0]).model;
      const refusal = responseRefusal(provider, response, typeof model === "string" ? model : undefined);
      if (refusal) throw refusal;
      return response;
    },
  });
}

export function providerRefusal(cause: unknown): Refusal | null {
  if (cause instanceof ProviderRefusalError) return cause.refusal;
  return cause instanceof Error && cause.cause ? providerRefusal(cause.cause) : null;
}

export async function recordProviderRefusal(engine: Engine, artifactId: string, cause: unknown, model?: string): Promise<{ message: string; failCode: string } | null> {
  const refusal = providerRefusal(cause);
  if (!refusal) return recordFalRefusal(engine, artifactId, cause, model);
  const written = await engine.metadata.artifacts.write(artifactId, "provider-refusal", refusal);
  if (!written.ok) throw new Error(written.error.message);
  return { message: refusal.message, failCode: refusal.failCode };
}
