import type { CostEstimate } from "@apicity/cost";
import { getCanonicalName } from "./generation-registry.js";

// Local Google Flow cost estimates — @apicity/cost@0.8.0 has googleflow
// credit×Pro rates, but Videocity badges use official Gemini Developer API
// list rates (720p), not credits × subscription $/credit (docs/apicity-gaps.md
// §15, product choice A). Flow plan credits remain secondary metadata.
//
// API rates: https://ai.google.dev/gemini-api/docs/pricing
// Flow credits: https://support.google.com/flow/answer/16526234
// useapi comparison: https://useapi.net/docs/api-google-flow-v1

type GoogleFlowPlanTier = "plus" | "pro" | "ultra99" | "ultra199";

const GOOGLE_FLOW_RATE_AS_OF = "2026-07-10";

/** Official Gemini API video output rates (USD per second @ 720p). */
const API_USD_PER_SECOND = {
  omni: 0.1,
  veoQuality: 0.4,
  veoFast: 0.1,
  veoLite: 0.05,
} as const;

/** Official Gemini API Nano Banana Pro (1K/2K image). */
const API_NANO_BANANA_PRO_USD = 0.134;

const TIER_USD_PER_CREDIT: Record<GoogleFlowPlanTier, number> = {
  plus: 0.04,
  pro: 0.02,
  ultra99: 0.01,
  ultra199: 0.008,
};

const TIER_LABEL: Record<GoogleFlowPlanTier, string> = {
  plus: "Plus",
  pro: "Pro",
  ultra99: "Ultra $99",
  ultra199: "Ultra $199",
};

const DEFAULT_TIER: GoogleFlowPlanTier = "ultra99";
const DEFAULT_VIDEO_DURATION = 8;
const OMNI_DEFAULT_DURATION = 8;
const OMNI_V2V_CREDITS = 40;

const OMNI_DURATION_CREDITS: Record<number, number> = {
  4: 15,
  6: 20,
  8: 25,
  10: 30,
};

function isUltra(tier: GoogleFlowPlanTier): boolean {
  return tier === "ultra99" || tier === "ultra199";
}

export function resolveGoogleFlowPlanTier(
  envValue: string | undefined = process.env.GOOGLE_FLOW_PLAN_TIER,
): GoogleFlowPlanTier {
  const raw = (envValue ?? "").trim().toLowerCase();
  if (raw === "plus" || raw === "pro" || raw === "ultra99" || raw === "ultra199") {
    return raw;
  }
  return DEFAULT_TIER;
}

function numField(input: Record<string, unknown>, key: string): number | undefined {
  const v = input[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function hasVideoRef(input: Record<string, unknown>): boolean {
  const ref = input.video_ref;
  return typeof ref === "string" && ref.trim() !== "";
}

/** Billable output duration in seconds for USD. */
function videoDurationSeconds(input: Record<string, unknown>, fallback: number): number {
  if (hasVideoRef(input)) {
    const start = numField(input, "video_clip_start");
    const ends = numField(input, "video_clip_ends");
    if (start !== undefined && ends !== undefined && ends > start) {
      return Math.min(10, ends - start);
    }
  }
  const d = numField(input, "duration");
  if (d !== undefined && d > 0) return d;
  return fallback;
}

function omniCredits(input: Record<string, unknown>): number {
  if (hasVideoRef(input)) return OMNI_V2V_CREDITS;
  const duration = numField(input, "duration") ?? OMNI_DEFAULT_DURATION;
  return OMNI_DURATION_CREDITS[duration] ?? OMNI_DURATION_CREDITS[OMNI_DEFAULT_DURATION];
}

function veoLiteCredits(tier: GoogleFlowPlanTier): number {
  return isUltra(tier) ? 5 : 10;
}

function veoFastCredits(tier: GoogleFlowPlanTier): number {
  return isUltra(tier) ? 10 : 20;
}

type ToolPricing = {
  credits: (input: Record<string, unknown>, tier: GoogleFlowPlanTier) => number;
  /** Official API USD for this call. */
  usd: (input: Record<string, unknown>) => { usd: number; units: number; unit: "seconds" | "images"; perUnitUsd: number; rateNote: string };
};

const TOOL_PRICING: Record<string, ToolPricing> = {
  generate_google_flow_omni_flash_video: {
    credits: (input) => omniCredits(input),
    usd: (input) => {
      const seconds = videoDurationSeconds(input, OMNI_DEFAULT_DURATION);
      const perUnitUsd = API_USD_PER_SECOND.omni;
      return {
        usd: seconds * perUnitUsd,
        units: seconds,
        unit: "seconds",
        perUnitUsd,
        rateNote: "Gemini API list rate ($0.10/s @ 720p Omni Flash)",
      };
    },
  },
  generate_google_flow_veo_3_1_quality_video: {
    credits: () => 100,
    usd: (input) => {
      const seconds = videoDurationSeconds(input, DEFAULT_VIDEO_DURATION);
      const perUnitUsd = API_USD_PER_SECOND.veoQuality;
      return {
        usd: seconds * perUnitUsd,
        units: seconds,
        unit: "seconds",
        perUnitUsd,
        rateNote: "Gemini API list rate ($0.40/s @ 720p Veo 3.1 Quality)",
      };
    },
  },
  generate_google_flow_veo_3_1_fast_video: {
    credits: (_input, tier) => veoFastCredits(tier),
    usd: (input) => {
      const seconds = videoDurationSeconds(input, DEFAULT_VIDEO_DURATION);
      const perUnitUsd = API_USD_PER_SECOND.veoFast;
      return {
        usd: seconds * perUnitUsd,
        units: seconds,
        unit: "seconds",
        perUnitUsd,
        rateNote: "Gemini API list rate ($0.10/s @ 720p Veo 3.1 Fast)",
      };
    },
  },
  generate_google_flow_veo_3_1_lite_video: {
    credits: (_input, tier) => veoLiteCredits(tier),
    usd: (input) => {
      const seconds = videoDurationSeconds(input, DEFAULT_VIDEO_DURATION);
      const perUnitUsd = API_USD_PER_SECOND.veoLite;
      return {
        usd: seconds * perUnitUsd,
        units: seconds,
        unit: "seconds",
        perUnitUsd,
        rateNote: "Gemini API list rate ($0.05/s @ 720p Veo 3.1 Lite)",
      };
    },
  },
  generate_google_flow_veo_3_1_lite_low_priority_video: {
    credits: () => 0,
    usd: () => ({
      usd: 0,
      units: 0,
      unit: "seconds",
      perUnitUsd: 0,
      rateNote: "Flow free lower-priority queue (no Gemini API list price)",
    }),
  },
  generate_google_flow_nano_banana_pro_image: {
    credits: () => 0,
    usd: () => ({
      usd: API_NANO_BANANA_PRO_USD,
      units: 1,
      unit: "images",
      perUnitUsd: API_NANO_BANANA_PRO_USD,
      rateNote: "Gemini API list rate ($0.134/image Nano Banana Pro 1K/2K)",
    }),
  },
};

export function isGoogleFlowCostTool(toolName: string): boolean {
  const pricingName = getCanonicalName(toolName);
  return Object.prototype.hasOwnProperty.call(TOOL_PRICING, pricingName);
}

/** Extended breakdown: API units for USD + Flow credits secondary. */
export type GoogleFlowCostBreakdown = CostEstimate["breakdown"] & {
  credits: number;
  usdPerCredit: number;
  planTier: GoogleFlowPlanTier;
};

interface GoogleFlowCostOptions {
  tier?: GoogleFlowPlanTier;
}

export function estimateGoogleFlowCost(
  toolName: string,
  input: Record<string, unknown>,
  options: GoogleFlowCostOptions = {},
): CostEstimate | null {
  const pricingName = getCanonicalName(toolName);
  const pricing = TOOL_PRICING[pricingName];
  if (!pricing) return null;

  const tier = options.tier ?? resolveGoogleFlowPlanTier();
  const credits = pricing.credits(input, tier);
  const { usd, units, unit, perUnitUsd, rateNote } = pricing.usd(input);
  const usdPerCredit = TIER_USD_PER_CREDIT[tier];
  const tierLabel = TIER_LABEL[tier];

  const breakdown: GoogleFlowCostBreakdown = {
    units,
    unit,
    perUnitUsd,
    credits,
    usdPerCredit,
    planTier: tier,
  };

  return {
    usd,
    currency: "USD",
    source: "per-unit-table",
    breakdown,
    rateAsOf: GOOGLE_FLOW_RATE_AS_OF,
    warnings: [
      `${rateNote}; Flow credits separate`,
      `Flow credits used: ${credits} (${tierLabel}; amortized ~$${usdPerCredit}/credit)`,
    ],
  };
}
