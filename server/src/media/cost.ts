import { computeEstimate, type CostEstimate, type CostHints, type EstimateRequest } from "@apicity/cost";
import { buildWireRequest, type WireRequestInput } from "./request.js";
import type { ResolvedModel } from "./types.js";

export type GenerationEstimate =
  | { ok: true; estimate: CostEstimate; request: Record<string, unknown> }
  | { ok: false; error: string };

function costProvider(model: ResolvedModel): EstimateRequest["provider"] {
  return model.provider;
}

function costPayload(model: ResolvedModel, request: Record<string, unknown>, input: Record<string, unknown>): Record<string, unknown> {
  return model.provider === "fal" ? input : request;
}

function planHints(model: ResolvedModel): CostHints {
  const plan = process.env.GOOGLE_FLOW_PLAN_TIER?.trim();
  return model.provider === "googleflow" && plan ? { googleFlowPlan: plan } : {};
}

function numeric(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function durationHint(input: Record<string, unknown>): CostHints {
  const seconds = numeric(input.duration) ?? numeric(input.duration_seconds)
    ?? (numeric(input.music_length_ms) !== undefined ? numeric(input.music_length_ms)! / 1000 : undefined);
  return seconds !== undefined && seconds > 0 ? { durationSeconds: seconds } : {};
}

function combinedHints(model: ResolvedModel, input: Record<string, unknown>, hints: CostHints): CostHints {
  const combined = { ...planHints(model), ...durationHint(input), ...hints };
  return combined.durationSeconds === undefined && combined.inputDurationSeconds !== undefined
    ? { ...combined, durationSeconds: combined.inputDurationSeconds }
    : combined;
}

export function estimateWireRequest(
  model: ResolvedModel,
  request: Record<string, unknown>,
  input: Record<string, unknown>,
  hints: CostHints = {},
): CostEstimate {
  return computeEstimate({
    provider: costProvider(model),
    payload: costPayload(model, request, input),
    endpoint: model.apiId,
    costHints: combinedHints(model, input, hints),
  });
}

export function estimateGeneration(
  model: ResolvedModel,
  call: WireRequestInput,
  hints: CostHints = {},
): GenerationEstimate {
  const built = buildWireRequest(model, call);
  if (!built.ok) return built;
  try {
    return { ok: true, estimate: estimateWireRequest(model, built.request, built.input, hints), request: built.request };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
