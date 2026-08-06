import { describe, expect, it } from "vitest";
import { computeEstimate } from "@apicity/cost";
import {
  estimateMiniMaxH3ToolCost,
  estimateMiniMaxH3WireCost,
  isMiniMaxH3CostTool,
  MINIMAX_H3_CEILING_USD_PER_SECOND,
} from "./minimax-h3-cost.js";

const WIRE_MODELS = [
  "minimax-h3/text-to-video",
  "minimax-h3/image-to-video",
  "minimax-h3/reference-to-video",
] as const;

describe("MiniMax H3 local cost ceiling", () => {
  it("prices each wire model per second by resolution tier", () => {
    for (const model of WIRE_MODELS) {
      expect(estimateMiniMaxH3WireCost({
        model,
        input: { prompt: "a kitten", duration: 15, resolution: "768P" },
      })?.usd, model).toBeCloseTo(15 * 0.18, 10);
      expect(estimateMiniMaxH3WireCost({
        model,
        input: { prompt: "a kitten", duration: 6, resolution: "2K" },
      })?.usd, model).toBeCloseTo(6 * 0.26, 10);
    }
  });

  it("bounds an omitted resolution at the pricier tier", () => {
    // Upstream documents 2K as the default and the builder omits the field
    // when the caller leaves it unset, so the ceiling must not fall back to
    // the cheaper tier and under-bound the call.
    const estimate = estimateMiniMaxH3WireCost({
      model: "minimax-h3/reference-to-video",
      input: { prompt: "a kitten", duration: 10 },
    });
    expect(estimate?.usd).toBeCloseTo(10 * MINIMAX_H3_CEILING_USD_PER_SECOND["2K"], 10);
  });

  it("carries no warnings, so the paygate reads it as bounded", () => {
    expect(estimateMiniMaxH3WireCost({
      model: "minimax-h3/text-to-video",
      input: { prompt: "a kitten", duration: 6, resolution: "2K" },
    })?.warnings).toEqual([]);
  });

  it("declines payloads it must not price", () => {
    // Another kie model is @apicity/cost's business, and a MiniMax payload with
    // no usable duration has no bound at all — both must fail closed rather
    // than mint against a zero estimate.
    expect(estimateMiniMaxH3WireCost({
      model: "happyhorse-1-1/text-to-video",
      input: { prompt: "a horse", duration: 5, resolution: "1080p" },
    })).toBeNull();
    expect(estimateMiniMaxH3WireCost({
      model: "minimax-h3/text-to-video",
      input: { prompt: "a kitten", resolution: "2K" },
    })).toBeNull();
    expect(estimateMiniMaxH3WireCost({
      model: "minimax-h3/text-to-video",
      input: { prompt: "a kitten", duration: 0, resolution: "2K" },
    })).toBeNull();
  });

  it("stands down as soon as @apicity/cost prices minimax-h3", () => {
    // The guard that keeps this module from outliving its gap: the paygate
    // consults it only when computeEstimate warns. If this assertion fails,
    // the package has shipped rates and this whole module should be deleted
    // (docs/apicity-gaps.md §35).
    for (const model of WIRE_MODELS) {
      const upstream = computeEstimate({
        provider: "kie",
        payload: { model, input: { prompt: "a kitten", duration: 6, resolution: "2K" } },
      });
      expect(upstream.warnings, model).not.toEqual([]);
    }
  });

  it("estimates from tool args with the ceiling disclosed", () => {
    const estimate = estimateMiniMaxH3ToolCost(
      "generate_kie_minimax_h3_reference_to_video",
      { prompt: "a kitten", duration: "15", resolution: "768P" },
    );
    expect(estimate?.usd).toBeCloseTo(15 * 0.18, 10);
    expect(estimate?.warnings.join(" ")).toContain("ceiling table");
    // estimate_cost callers mark an estimate missing when a warning matches
    // these; the ceiling note must not trip that (notebook-run-plan.ts).
    expect(estimate?.warnings.join(" ")).not.toMatch(
      /not found|unavailable|no cost adapter|unknown/i,
    );
    expect(isMiniMaxH3CostTool("generate_kie_minimax_h3_text_to_video")).toBe(true);
    expect(isMiniMaxH3CostTool("generate_kie_happyhorse_1_1_text_to_video")).toBe(false);
    expect(estimateMiniMaxH3ToolCost(
      "generate_kie_happyhorse_1_1_text_to_video",
      { prompt: "a horse", duration: "5" },
    )).toBeNull();
  });
});
