import { afterEach, describe, expect, it } from "vitest";
import { isFalDynamicPricingEndpoint, type FalEstimator } from "@apicity/cost";
import { MODEL_ENTRIES } from "./catalog.js";
import { resolveModel } from "./descriptor.js";
import { estimateFalRequest, estimateGeneration, installFalDynamicEstimator, lowerBoundWarnings } from "./cost.js";
import type { MediaRefs, ModeSpec, ResolvedModel } from "./types.js";

const HISTORICAL_USD = 0.17;

const DYNAMIC_MODELS = [
  "fal:google/nano-banana-2.1",
  "fal:google/nano-banana-2.1/edit",
  "fal:fal-ai/flux-2-flex",
  "fal:fal-ai/kandinsky6-pro/text-to-video",
  "fal:fal-ai/kandinsky6-pro/image-to-video",
  "fal:fal-ai/kandinsky6-lite/text-to-video",
  "fal:fal-ai/kandinsky6-lite/image-to-video",
  "fal:fal-ai/kandinsky6-vsr",
  "fal:fal-ai/kandinsky6-vsr/lite",
  "fal:mirelo-ai/sfx2.0/video-to-video",
  "fal:bytedance/seedance-2.5/us/image-to-video",
  "fal:minimax/h3-max/reframe-video",
  "fal:openai/gpt-image-2.6/sunburst/text-to-image",
  "fal:openai/gpt-image-2.6/flare/edit",
  "fal:google/gemini-omni-flash/v1.2/text-to-video",
  "fal:google/gemini-omni-flash/v1.2/extend",
  "fal:google/gemini-omni-flash/v1.2/upscale",
] as const;

const FORMULA_GAPS = [
  "fal:bytedance/seedance-2.0/us/reference-to-video",
  "fal:bytedance/seedance-2.0/mini/reference-to-video",
  "fal:bytedance/seedance-2.5/draft/complete",
] as const;

const PER_SECOND_FLOORS = new Set([
  "fal:minimax/h3-max/extend-video",
  "fal:minimax/h3-max/insert-video",
  "fal:minimax/h3-max/reference-to-video",
  "fal:minimax/h3-max-turbo/reference-to-video",
]);

function sampleRefs(model: ResolvedModel, mode: ModeSpec): MediaRefs {
  const refs: MediaRefs = {};
  for (const slot of model.slots) {
    if (!mode.roles.includes(slot.role)) continue;
    const count = Math.max(slot.min, 1);
    refs[slot.role] = Array.from({ length: count }, (_, index) => `https://example.com/${slot.role}${index}.png`);
  }
  if (mode.id === "i2v") delete refs.image;
  return refs;
}

function requiredOptions(model: ResolvedModel): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  for (const option of model.options) {
    if (!option.required) continue;
    options[option.name] = option.enumValues[0]
      ?? (option.valueType === "number" || option.valueType === "integer" ? option.minimum ?? 1 : "value");
  }
  if (model.id.startsWith("fal:minimax/h3/") && model.id.endsWith("/lora")) {
    options.loras = [{ path: "https://example.com/style.safetensors" }];
  }
  if (model.id === "fal:minimax/h3-max/insert-video") {
    options.start_time = 2;
    options.resume_time = 5;
  }
  return options;
}

function historicalEstimator(calls: unknown[]): FalEstimator {
  return async (request) => {
    calls.push(request);
    return { total_cost: HISTORICAL_USD, currency: "USD" };
  };
}

describe("fal dynamic cost", () => {
  const restores: Array<() => void> = [];

  afterEach(() => {
    for (const restore of restores.splice(0)) restore();
    delete process.env.FAL_ADMIN_API_KEY;
  });

  function install(estimator: FalEstimator | null): void {
    restores.push(installFalDynamicEstimator(estimator));
  }

  it("prices each dynamic fal catalog endpoint with one historical call, or its per-second floor with none, and never calls fal for a static endpoint", async () => {
    const calls: unknown[] = [];
    install(historicalEstimator(calls));
    const seen = new Set<string>();
    for (const entry of MODEL_ENTRIES) {
      if (!entry.id.startsWith("fal:")) continue;
      const model = resolveModel(entry.id);
      const mode = model.modes[0]!;
      const before = calls.length;
      const result = await estimateGeneration(model, {
        prompt: model.promptField ? "a red fox in snow" : undefined,
        refUrls: sampleRefs(model, mode),
        options: requiredOptions(model),
        mode: mode.id,
      });
      expect(result.ok, result.ok ? entry.id : `${entry.id}: ${result.error}`).toBe(true);
      if (!result.ok) continue;
      const dynamic = isFalDynamicPricingEndpoint(model.apiId);
      const added = calls.slice(before);
      if (PER_SECOND_FLOORS.has(entry.id)) {
        expect(dynamic, entry.id).toBe(true);
        expect(added, entry.id).toEqual([]);
        expect(result.estimate.usd, entry.id).toBeGreaterThan(0);
        expect(lowerBoundWarnings(result.estimate.warnings), entry.id).toBe(true);
      } else if (dynamic) {
        expect(added, entry.id).toEqual([{
          estimate_type: "historical_api_price",
          endpoints: { [model.apiId]: { call_quantity: 1 } },
        }]);
        expect(result.estimate.usd, entry.id).toBe(HISTORICAL_USD);
        expect(result.estimate.warnings.join(" "), entry.id).toContain("historical average per call");
        expect(result.estimate.warnings.join(" "), entry.id).toContain("ignores this request's payload");
      } else {
        expect(added, entry.id).toEqual([]);
      }
      seen.add(entry.id);
    }
    for (const id of DYNAMIC_MODELS) {
      expect(seen.has(id), id).toBe(true);
      expect(isFalDynamicPricingEndpoint(resolveModel(id).apiId), id).toBe(true);
    }
    for (const id of FORMULA_GAPS) {
      expect(seen.has(id), id).toBe(true);
      expect(isFalDynamicPricingEndpoint(resolveModel(id).apiId), id).toBe(false);
    }
    for (const id of PER_SECOND_FLOORS) expect(seen.has(id), id).toBe(true);
  });

  it("quotes a 2K H3 Max Extend as the requested seconds at the card rate, a lower bound, with the estimator or without, and never asks fal", async () => {
    const calls: unknown[] = [];
    const model = resolveModel("fal:minimax/h3-max/extend-video");
    const extend = (duration: number) => estimateGeneration(model, {
      prompt: "keep walking",
      refUrls: { video: ["https://example.com/clip.mp4"] },
      options: { duration, resolution: "2K" },
    });
    for (const estimator of [historicalEstimator(calls), null]) {
      install(estimator);
      for (const [duration, usd] of [[5, 1.6], [15, 4.8]] as const) {
        const result = await extend(duration);
        expect(result.ok).toBe(true);
        if (!result.ok) continue;
        expect(result.estimate.usd).toBeCloseTo(usd, 6);
        expect(result.estimate.breakdown).toEqual({ units: duration, unit: "seconds", perUnitUsd: 0.32 });
        expect(result.estimate.warnings).toEqual([
          "fal 'minimax/h3-max/extend-video': prices the requested seconds only; reference tokens beyond the included 4,096 ($0.02 per 1,000) are not counted, so this estimate is a lower bound",
        ]);
        expect(lowerBoundWarnings(result.estimate.warnings)).toBe(true);
      }
      restores.pop()?.();
    }
    expect(calls).toEqual([]);
  });

  it("prices a call fal billed 0 units at 0 USD through the library, without asking fal or needing the admin key", async () => {
    const calls: unknown[] = [];
    for (const estimator of [historicalEstimator(calls), null]) {
      install(estimator);
      const nothing = await estimateFalRequest("minimax/h3-max/extend-video", {}, undefined, 0);
      expect(nothing).toMatchObject({ usd: 0, source: "free", warnings: [] });
      expect(nothing.zeroReason).toContain("reported no billed units");
      restores.pop()?.();
    }
    expect(calls).toEqual([]);
  });

  it("reuses one historical answer for a repeated dynamic endpoint", async () => {
    const calls: unknown[] = [];
    install(historicalEstimator(calls));
    const model = resolveModel("fal:fal-ai/flux-2-flex");
    const first = await estimateGeneration(model, { prompt: "a fox" });
    const second = await estimateGeneration(model, { prompt: "a different fox" });
    expect(calls).toHaveLength(1);
    expect(first.ok && second.ok && first.estimate.usd === HISTORICAL_USD && second.estimate.usd === HISTORICAL_USD).toBe(true);
  });

  it("keeps the local zero when the key is missing, the estimator is withheld, or the pricing answer cannot be used", async () => {
    const model = resolveModel("fal:fal-ai/flux-2-flex");
    const missing = await estimateGeneration(model, { prompt: "a fox" });
    expect(missing.ok && missing.estimate.usd === 0).toBe(true);
    if (missing.ok) expect(missing.estimate.warnings.join(" ")).toContain("no local rate");

    install(null);
    process.env.FAL_ADMIN_API_KEY = "unused-admin-key";
    const withheld = await estimateGeneration(model, { prompt: "a fox" });
    expect(withheld.ok && withheld.estimate.usd === 0).toBe(true);

    restores.pop()?.();
    install(async () => {
      throw new Error("pricing down");
    });
    const failed = await estimateGeneration(model, { prompt: "a fox" });
    expect(failed.ok).toBe(true);
    if (failed.ok) {
      expect(failed.estimate.usd).toBe(0);
      expect(failed.estimate.warnings.join(" ")).toContain("pricing estimate failed");
      expect(failed.estimate.warnings.join(" ")).toContain("pricing down");
    }

    restores.pop()?.();
    install(async () => ({ total_cost: Number.NaN, currency: "USD" }));
    const malformed = await estimateGeneration(model, { prompt: "a fox" });
    expect(malformed.ok && malformed.estimate.usd === 0).toBe(true);
    if (malformed.ok) expect(malformed.estimate.warnings.join(" ")).toContain("no usable total_cost");
  });

  it("prices a static Seedance request from the local formula and leaves the two formula gaps unpriced", async () => {
    const calls: unknown[] = [];
    install(historicalEstimator(calls));
    const priced = await estimateGeneration(resolveModel("fal:bytedance/seedance-2.0/us/text-to-video"), {
      prompt: "a fox",
      options: { duration: "5", aspect_ratio: "16:9", resolution: "720p" },
    });
    const reference = await estimateGeneration(resolveModel("fal:bytedance/seedance-2.0/us/reference-to-video"), {
      prompt: "a fox",
      mode: "r2v",
      refUrls: { image: ["https://example.com/image0.png"] },
      options: { duration: "5", aspect_ratio: "16:9", resolution: "720p" },
    });
    const draft = await estimateGeneration(resolveModel("fal:bytedance/seedance-2.5/draft/complete"), {
      options: { draft_id: "draft-1" },
    });
    expect(calls).toEqual([]);
    expect(priced.ok).toBe(true);
    if (priced.ok) {
      expect(priced.estimate.usd).toBeGreaterThan(0);
      expect(priced.estimate.warnings).toEqual([]);
    }
    expect(reference.ok && draft.ok).toBe(true);
    if (reference.ok) {
      expect(reference.estimate.usd).toBe(0);
      expect(reference.estimate.warnings.join(" ")).toContain("video_urls");
    }
    if (draft.ok) {
      expect(draft.estimate.usd).toBe(0);
      expect(draft.estimate.warnings.join(" ")).toMatch(/aspect ratio|duration/);
    }
  });
});
