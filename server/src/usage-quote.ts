import { endpointBilling, estimateEndpoint } from "@apicity/cost";
import type { CostHints, EndpointEstimate } from "@apicity/cost";
import type { HarCallEstimate } from "@apicity/har";

export interface UsageQuote {
  estimateUsd: number | null;
  estimateSource: string | null;
  estimateRateAsOf: string | null;
  capture?: HarCallEstimate;
}

export function httpDotPath(pathname: string): string {
  return pathname.replace(/^\/+/u, "").replaceAll("/", ".");
}

function quoteMethod(provider: string, dotPath: string): string {
  if (endpointBilling(provider, "POST", dotPath).kind !== "unpriced") return "POST";
  if (endpointBilling(provider, "GET", dotPath).kind !== "unpriced") return "GET";
  return "POST";
}

function emptyQuote(): UsageQuote {
  return { estimateUsd: null, estimateSource: null, estimateRateAsOf: null };
}

function quoted(estimate: EndpointEstimate): UsageQuote {
  if (estimate.status === "unavailable" || !Number.isFinite(estimate.usd) || estimate.usd < 0) return emptyQuote();
  return {
    estimateUsd: estimate.usd,
    estimateSource: estimate.source,
    estimateRateAsOf: estimate.rateAsOf,
    capture: {
      usd: estimate.usd,
      source: estimate.source,
      rateAsOf: estimate.rateAsOf,
      warnings: estimate.warnings,
      breakdown: estimate.breakdown,
      status: estimate.status,
    },
  };
}

export function usageQuote(input: {
  provider: string;
  method: string;
  dotPath: string;
  payload?: Record<string, unknown>;
  endpoint?: string;
  costHints?: CostHints;
}): UsageQuote {
  try {
    return quoted(estimateEndpoint({
      provider: input.provider,
      method: input.method,
      dotPath: input.dotPath,
      ...(input.payload ? { payload: input.payload } : {}),
      ...(input.endpoint ? { endpoint: input.endpoint } : {}),
      ...(input.costHints ? { costHints: input.costHints } : {}),
    }));
  } catch {
    return emptyQuote();
  }
}

export function quoteCaptureInput(provider: string, endpoint: string, input: unknown): HarCallEstimate | undefined {
  const payload = input !== null && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : undefined;
  const endpointId = typeof payload?.endpoint_id === "string" ? payload.endpoint_id : undefined;
  return usageQuote({
    provider,
    method: quoteMethod(provider, endpoint),
    dotPath: endpoint,
    ...(payload ? { payload } : {}),
    ...(endpointId ? { endpoint: endpointId } : {}),
  }).capture;
}
