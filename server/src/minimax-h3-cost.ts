import type { CostEstimate } from "@apicity/cost";
import type { MiniMaxH3Resolution } from "@apicity/kie";
import { getCanonicalName } from "./generation-registry.js";

// Local MiniMax H3 rates — @apicity/cost@0.8.6 knows nothing about the
// minimax-h3/* models @apicity/kie@0.8.6 ships, and mintKieOtp refuses to mint
// on any estimate warning, so without a local bound no MiniMax H3 task can be
// submitted at all (docs/apicity-gaps.md §35). Same shape of workaround as the
// local Gemini API table in google-flow-cost.ts (§15).
//
// These are CEILING rates, not Kie's published price. Kie bills video in
// credits per second (@apicity/cost records e.g. happyhorse-1-1 as "33
// credits/s ($0.165)") and does not publish a MiniMax H3 credit rate we can
// read without a console login, so this table takes the highest public rate
// found for the model — deliberately above Kie's likely price. The estimate is
// a spend BOUND: over-stating only makes the paygate more conservative, while
// under-stating is what would let it wave through a call that costs more than
// it thought. Displayed estimates read high until the real rate lands.
//
// Rate source: EmpirioLabs published MiniMax H3 pricing, retrieved 2026-08-06
// (https://empiriolabs.ai/models/minimax-h3). For comparison at that date:
// MiniMax list $0.08/$0.13, Atlas Cloud $0.10/$0.14.
//
// Delete this module when @apicity/cost prices minimax-h3/* — the paygate
// consults it only after computeEstimate fails, so the upstream table wins
// automatically the moment it ships.

export const MINIMAX_H3_RATE_AS_OF = "2026-08-06";

export const MINIMAX_H3_CEILING_USD_PER_SECOND: Record<MiniMaxH3Resolution, number> = {
  "768P": 0.18,
  "2K": 0.26,
};

/** Upstream documents 2K as the default when a request omits resolution; it is
 *  also the pricier tier, so it doubles as the conservative assumption. */
const DEFAULT_RESOLUTION: MiniMaxH3Resolution = "2K";

export const MINIMAX_H3_RATE_NOTE =
  "MiniMax H3 priced from videobook's local ceiling table"
  + " (docs/apicity-gaps.md §35); actual Kie charge is likely lower";

const MINIMAX_H3_WIRE_MODELS = new Set<string>([
  "minimax-h3/text-to-video",
  "minimax-h3/image-to-video",
  "minimax-h3/reference-to-video",
]);

const MINIMAX_H3_TOOLS = new Set<string>([
  "generate_kie_minimax_h3_text_to_video",
  "generate_kie_minimax_h3_image_to_video",
  "generate_kie_minimax_h3_reference_to_video",
]);

function seconds(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 0 ? value : undefined;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

function resolutionTier(value: unknown): MiniMaxH3Resolution {
  return value === "768P" || value === "2K" ? value : DEFAULT_RESOLUTION;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function estimate(
  durationSeconds: number,
  resolution: MiniMaxH3Resolution,
  warnings: string[],
): CostEstimate {
  const perUnitUsd = MINIMAX_H3_CEILING_USD_PER_SECOND[resolution];
  return {
    usd: durationSeconds * perUnitUsd,
    currency: "USD",
    source: "per-unit-table",
    breakdown: { units: durationSeconds, unit: "seconds", perUnitUsd },
    rateAsOf: MINIMAX_H3_RATE_AS_OF,
    warnings,
  };
}

/** Paygate bound for a MiniMax H3 wire payload, or null for any other model.
 *  Returns no warnings by design: mintKieOtp treats a warning as "unbounded"
 *  and refuses to mint, and this ceiling IS a bound. The caveat rides the
 *  module docs and MINIMAX_H3_RATE_NOTE rather than the estimate. A payload
 *  with no usable duration returns null so it fails closed at the paygate
 *  instead of minting against a zero estimate. */
export function estimateMiniMaxH3WireCost(
  payload: Record<string, unknown>,
): CostEstimate | null {
  const model = payload.model;
  if (typeof model !== "string" || !MINIMAX_H3_WIRE_MODELS.has(model)) return null;

  const input = asObject(payload.input) ?? {};
  const durationSeconds = seconds(input.duration) ?? seconds(payload.duration);
  if (durationSeconds === undefined) return null;

  return estimate(durationSeconds, resolutionTier(input.resolution), []);
}

export function isMiniMaxH3CostTool(toolName: string): boolean {
  return MINIMAX_H3_TOOLS.has(getCanonicalName(toolName));
}

/** Display estimate for estimate_cost, keyed off tool args rather than the
 *  wire payload. Unlike the paygate bound this carries the ceiling caveat, so
 *  the UI shows where the number came from. The note deliberately avoids the
 *  phrases callers scan for to mark an estimate missing ("not found",
 *  "unavailable", "unknown") — the estimate is real, just conservative. */
export function estimateMiniMaxH3ToolCost(
  toolName: string,
  input: Record<string, unknown>,
): CostEstimate | null {
  if (!isMiniMaxH3CostTool(toolName)) return null;

  const durationSeconds = seconds(input.duration);
  if (durationSeconds === undefined) return null;

  return estimate(durationSeconds, resolutionTier(input.resolution), [
    MINIMAX_H3_RATE_NOTE,
  ]);
}
