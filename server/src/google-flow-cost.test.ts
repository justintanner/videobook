import { describe, it, expect, afterEach } from "vitest";
import {
  estimateGoogleFlowCost,
  isGoogleFlowCostTool,
  resolveGoogleFlowPlanTier,
  type GoogleFlowCostBreakdown,
} from "./google-flow-cost.js";

const originalTier = process.env.GOOGLE_FLOW_PLAN_TIER;

afterEach(() => {
  if (originalTier === undefined) delete process.env.GOOGLE_FLOW_PLAN_TIER;
  else process.env.GOOGLE_FLOW_PLAN_TIER = originalTier;
});

function creditsOf(estimate: NonNullable<ReturnType<typeof estimateGoogleFlowCost>>): number {
  return (estimate.breakdown as GoogleFlowCostBreakdown).credits;
}

describe("resolveGoogleFlowPlanTier", () => {
  it("defaults to ultra99", () => {
    expect(resolveGoogleFlowPlanTier(undefined)).toBe("ultra99");
    expect(resolveGoogleFlowPlanTier("")).toBe("ultra99");
    expect(resolveGoogleFlowPlanTier("nope")).toBe("ultra99");
  });

  it("accepts known tiers case-insensitively", () => {
    expect(resolveGoogleFlowPlanTier("pro")).toBe("pro");
    expect(resolveGoogleFlowPlanTier("PLUS")).toBe("plus");
    expect(resolveGoogleFlowPlanTier(" ultra199 ")).toBe("ultra199");
  });
});

describe("isGoogleFlowCostTool", () => {
  it("recognizes Flow tools only", () => {
    expect(isGoogleFlowCostTool("generate_google_omni_video")).toBe(true);
    expect(isGoogleFlowCostTool("generate_veo31_fast_video")).toBe(true);
    expect(isGoogleFlowCostTool("generate_seedance2_video")).toBe(false);
    expect(isGoogleFlowCostTool("generate_gemini_omni_video")).toBe(false);
  });
});

describe("estimateGoogleFlowCost — official API USD", () => {
  it("returns null for non-Flow tools", () => {
    expect(estimateGoogleFlowCost("generate_seedance2_video", {})).toBeNull();
  });

  it("omni 10s → $1.00 API (30 Flow credits secondary)", () => {
    const e = estimateGoogleFlowCost(
      "generate_google_omni_video",
      { duration: "10" },
      { tier: "ultra99" },
    );
    expect(e).not.toBeNull();
    expect(e!.usd).toBeCloseTo(1.0, 6);
    expect(e!.breakdown.units).toBe(10);
    expect(e!.breakdown.unit).toBe("seconds");
    expect(e!.breakdown.perUnitUsd).toBe(0.1);
    expect(creditsOf(e!)).toBe(30);
    expect(e!.source).toBe("per-unit-table");
    expect(e!.warnings.some((w) => w.includes("Flow credits used: 30"))).toBe(true);
    expect(e!.warnings.some((w) => w.includes("$0.10/s"))).toBe(true);
  });

  it("omni defaults to 8s → $0.80 API (25 credits)", () => {
    const e = estimateGoogleFlowCost("generate_google_omni_video", {}, { tier: "ultra99" });
    expect(e!.usd).toBeCloseTo(0.8, 6);
    expect(creditsOf(e!)).toBe(25);
  });

  it("omni V2V is 40 credits; USD from clip window when present", () => {
    const e = estimateGoogleFlowCost(
      "generate_google_omni_video",
      { duration: "4", video_slug: "@vid-clip", video_clip_start: 0, video_clip_ends: 6 },
      { tier: "ultra99" },
    );
    expect(creditsOf(e!)).toBe(40);
    expect(e!.usd).toBeCloseTo(0.6, 6);
    expect(e!.breakdown.units).toBe(6);
  });

  it("omni V2V without clip window uses duration/default for USD", () => {
    const e = estimateGoogleFlowCost(
      "generate_google_omni_video",
      { video_slug: "@vid-clip" },
      { tier: "ultra99" },
    );
    expect(creditsOf(e!)).toBe(40);
    expect(e!.usd).toBeCloseTo(0.8, 6);
  });

  it("omni duration ladder — API $0.10/s, credits by duration", () => {
    const tier = "ultra99" as const;
    const cases: Array<[number, number, number]> = [
      [4, 0.4, 15],
      [6, 0.6, 20],
      [8, 0.8, 25],
      [10, 1.0, 30],
    ];
    for (const [duration, usd, credits] of cases) {
      const e = estimateGoogleFlowCost("generate_google_omni_video", { duration }, { tier })!;
      expect(e.usd).toBeCloseTo(usd, 6);
      expect(creditsOf(e)).toBe(credits);
    }
  });

  it("veo fast: $0.10/s API; Ultra 10 cr / Pro 20 cr", () => {
    const ultra = estimateGoogleFlowCost(
      "generate_veo31_fast_video",
      { duration: 8 },
      { tier: "ultra99" },
    )!;
    expect(ultra.usd).toBeCloseTo(0.8, 6);
    expect(creditsOf(ultra)).toBe(10);

    const pro = estimateGoogleFlowCost(
      "generate_veo31_fast_video",
      { duration: 8 },
      { tier: "pro" },
    )!;
    expect(pro.usd).toBeCloseTo(0.8, 6);
    expect(creditsOf(pro)).toBe(20);
  });

  it("veo lite: $0.05/s API; Ultra 5 cr", () => {
    const e = estimateGoogleFlowCost(
      "generate_veo31_lite_video",
      { duration: 8 },
      { tier: "ultra99" },
    )!;
    expect(e.usd).toBeCloseTo(0.4, 6);
    expect(creditsOf(e)).toBe(5);
  });

  it("veo quality: $0.40/s → $3.20 for 8s; 100 credits", () => {
    const e = estimateGoogleFlowCost("generate_veo31_video", { duration: 8 }, { tier: "ultra99" })!;
    expect(e.usd).toBeCloseTo(3.2, 6);
    expect(creditsOf(e)).toBe(100);
  });

  it("lite low-priority is free ($0 API, 0 credits)", () => {
    const e = estimateGoogleFlowCost(
      "generate_veo31_lite_low_priority_video",
      {},
      { tier: "ultra99" },
    )!;
    expect(e.usd).toBe(0);
    expect(creditsOf(e)).toBe(0);
    expect(e.warnings.some((w) => w.includes("no cost adapter"))).toBe(false);
  });

  it("nano banana pro google uses API image rate ($0.134)", () => {
    const e = estimateGoogleFlowCost("generate_nano_banana_pro_google", {}, { tier: "ultra99" })!;
    expect(e.usd).toBeCloseTo(0.134, 6);
    expect(e.breakdown.unit).toBe("images");
    expect(creditsOf(e)).toBe(0);
  });

  it("plan tier does not change badge USD (only credits)", () => {
    const a = estimateGoogleFlowCost(
      "generate_google_omni_video",
      { duration: "8" },
      { tier: "ultra99" },
    )!;
    const b = estimateGoogleFlowCost(
      "generate_google_omni_video",
      { duration: "8" },
      { tier: "plus" },
    )!;
    expect(a.usd).toBeCloseTo(b.usd, 6);
    expect(creditsOf(a)).toBe(creditsOf(b));
  });

  it("keeps API USD and Flow credits separate in breakdown", () => {
    const e = estimateGoogleFlowCost(
      "generate_google_omni_video",
      { duration: "8" },
      { tier: "ultra99" },
    )!;
    const b = e.breakdown as GoogleFlowCostBreakdown;
    expect(b.credits).toBe(25);
    expect(b.units).toBe(8);
    expect(b.unit).toBe("seconds");
    expect(e.usd).toBeCloseTo(0.8, 6);
    expect(e.usd).not.toBe(b.credits);
    // Amortized would have been 25 * 0.01 = 0.25 — badge must not use that.
    expect(e.usd).not.toBeCloseTo(0.25, 6);
  });
});
