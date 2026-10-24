import { createFal } from "../usage-providers.js";
import {
  computeEstimate,
  createFalEstimateCache,
  resolveFalDynamicEstimate,
  type CostEstimate,
  type CostHints,
  type EstimateRequest,
  type FalEstimateCache,
  type FalEstimator,
} from "@apicity/cost";
import { buildWireRequest, type WireRequestInput } from "./request.js";
import type { ResolvedModel } from "./types.js";

export type GenerationEstimate =
  | { ok: true; estimate: CostEstimate; request: Record<string, unknown> }
  | { ok: false; error: string };

const FAL_ESTIMATE_TTL_MS = 5 * 60 * 1000;

let falEstimateCache: FalEstimateCache = createFalEstimateCache({
  ttlMs: FAL_ESTIMATE_TTL_MS,
  maxEntries: 128,
});
let estimatorOverrideActive = false;
let estimatorOverride: FalEstimator | null = null;
let liveEstimatorKey: string | undefined;
let liveEstimator: FalEstimator | undefined;

function freshFalEstimateCache(): FalEstimateCache {
  return createFalEstimateCache({ ttlMs: FAL_ESTIMATE_TTL_MS, maxEntries: 128 });
}

export function installFalDynamicEstimator(estimator: FalEstimator | null): () => void {
  const previous = {
    active: estimatorOverrideActive,
    estimator: estimatorOverride,
    cache: falEstimateCache,
  };
  estimatorOverrideActive = true;
  estimatorOverride = estimator;
  falEstimateCache = freshFalEstimateCache();
  return () => {
    estimatorOverrideActive = previous.active;
    estimatorOverride = previous.estimator;
    falEstimateCache = previous.cache;
  };
}

function falAdminKey(): string | undefined {
  const value = process.env.FAL_ADMIN_API_KEY?.trim();
  return value ? value : undefined;
}

function falPricingEstimator(apiKey: string): FalEstimator {
  const estimate = createFal({ apiKey }).v1.models.pricing.estimate;
  return (request) => estimate(request);
}

function currentFalEstimator(): FalEstimator | null {
  if (estimatorOverrideActive) return estimatorOverride;
  const apiKey = falAdminKey();
  if (!apiKey) return null;
  if (liveEstimator && liveEstimatorKey === apiKey) return liveEstimator;
  liveEstimatorKey = apiKey;
  liveEstimator = falPricingEstimator(apiKey);
  return liveEstimator;
}

export async function estimateFalRequest(
  endpoint: string,
  payload: Record<string, unknown>,
  hints?: CostHints,
): Promise<CostEstimate> {
  const estimator = currentFalEstimator();
  if (!estimator) {
    return computeEstimate({
      provider: "fal",
      payload,
      endpoint,
      ...(hints ? { costHints: hints } : {}),
    });
  }
  return resolveFalDynamicEstimate(endpoint, payload, estimator, {
    ...(hints ? { hints } : {}),
    // Queue polls omit x-fal-billable-units, so this is one historical call.
    callQuantity: 1,
    cache: falEstimateCache,
  });
}

function costProvider(model: ResolvedModel): EstimateRequest["provider"] {
  return model.provider;
}

function costPayload(model: ResolvedModel, request: Record<string, unknown>, input: Record<string, unknown>): Record<string, unknown> {
  return model.provider === "fal" ? input : request;
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

export function generationCostHints(input: Record<string, unknown>, hints: CostHints): CostHints {
  const combined = { ...durationHint(input), ...hints };
  return combined.durationSeconds === undefined && combined.inputDurationSeconds !== undefined
    ? { ...combined, durationSeconds: combined.inputDurationSeconds }
    : combined;
}

async function estimateWireRequest(
  model: ResolvedModel,
  request: Record<string, unknown>,
  input: Record<string, unknown>,
  hints: CostHints = {},
): Promise<CostEstimate> {
  const payload = costPayload(model, request, input);
  const costHints = generationCostHints(input, hints);
  if (model.provider === "fal") return estimateFalRequest(model.apiId, payload, costHints);
  return computeEstimate({
    provider: costProvider(model),
    payload,
    endpoint: model.apiId,
    costHints,
  });
}

export async function estimateGeneration(
  model: ResolvedModel,
  call: WireRequestInput,
  hints: CostHints = {},
): Promise<GenerationEstimate> {
  const built = buildWireRequest(model, call);
  if (!built.ok) return built;
  try {
    return {
      ok: true,
      estimate: await estimateWireRequest(model, built.request, built.input, hints),
      request: built.request,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
