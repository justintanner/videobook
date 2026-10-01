import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Client } from "@modelcontextprotocol/client";
import type { CostEstimate } from "@apicity/cost";
import { createTestClient } from "../test-client.js";
import { createEngineForTest } from "../engine.js";
import { queue } from "../queue.js";

type TextContent = Array<{ type: string; text: string }>;

interface EstimatePayload {
  estimate: CostEstimate;
  per_call: Array<{ tool_name: string; estimate: CostEstimate }>;
}

function parse(result: { content: unknown }): EstimatePayload {
  const content = result.content as TextContent;
  return JSON.parse(content[0].text) as EstimatePayload;
}

describe("estimate_cost tool", () => {
  let client: Client;
  let tempDir: string;

  beforeAll(async () => {
    await queue.start();
  });

  afterAll(async () => {
    await queue.stop();
  });

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-estimate-cost-test-"));
    client = await createTestClient(tempDir);
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("returns a $0 estimate with a warning for an unmapped tool name", async () => {
    const result = await client.callTool({
      name: "estimate_cost",
      arguments: {
        calls: [{ tool_name: "this_tool_does_not_exist", input: {} }],
      },
    });
    const payload = parse(result);
    expect(payload.estimate.usd).toBe(0);
    expect(payload.estimate.warnings.join(" ")).toContain("no cost adapter registered");
  });

  it("estimates a kie per-second video tool from its duration field", async () => {
    const result = await client.callTool({
      name: "estimate_cost",
      arguments: {
        calls: [{
          tool_name: "generate_seedance2_video",
          input: { prompt: "test", duration: 5 },
        }],
      },
    });
    const payload = parse(result);
    expect(payload.estimate.source).toBe("per-unit-table");
    expect(payload.estimate.usd).toBeGreaterThan(0);
    expect(payload.estimate.breakdown.unit).toBe("seconds");
    expect(payload.estimate.breakdown.units).toBe(5);
  });

  it("uses Apicity duration defaults in Kie cost adapters", async () => {
    const result = await client.callTool({
      name: "estimate_cost",
      arguments: {
        calls: [
          { tool_name: "generate_seedance2_mini_video", input: {} },
          { tool_name: "generate_grok_imagine_video", input: {} },
        ],
      },
    });
    const payload = parse(result);
    expect(payload.per_call[0].estimate.breakdown.units).toBe(5);
    expect(payload.per_call[1].estimate.breakdown.units).toBe(6);
  });

  it("estimates a heuristic-token text tool (openai rewrite_prompt)", async () => {
    const result = await client.callTool({
      name: "estimate_cost",
      arguments: {
        calls: [{
          tool_name: "rewrite_prompt",
          input: { prompt: "x".repeat(400) },
        }],
      },
    });
    const payload = parse(result);
    expect(payload.estimate.source).toBe("tokens-heuristic+table");
    expect(payload.estimate.breakdown.inputTokens).toBe(100);
  });

  it("prices every kie tool wired into cost-adapters with a >0 estimate", async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      // Seedance 2 Mini (resolution-tiered per-second; priced by @apicity/cost@0.6.1)
      ["generate_seedance2_mini_video", { resolution: "720p", duration: "5" }],
      ["generate_seedance25_video", { resolution: "720p", duration: "5" }],
      ["generate_kie_kling_3_0_omni_text_to_video", { resolution: "720p", duration: 5 }],
      ["generate_kie_kling_3_0_omni_image_to_video", { resolution: "1080p", duration: 5, audio: true }],
      ["generate_kie_kling_3_0_omni_reference_to_video", { resolution: "720p", duration: 5, video_refs: ["@vid-ref"] }],
      ["generate_kie_kling_3_0_omni_transformation", { resolution: "720p", duration: 5 }],
      ["generate_gemini_omni_video", { resolution: "720p", duration: "6" }],
      // Wan 3.0 omni (resolution-tiered per second, UPPERCASE tiers)
      ["generate_kie_wan_3_0_video", { resolution: "720P", duration: 5 }],
      ["generate_kie_wan_3_0_prime_video", { resolution: "1080P", duration: 10 }],
      // Grok-imagine video (resolution-tiered)
      ["generate_grok_imagine_video", { resolution: "480p", duration: 8 }],
      ["generate_grok_imagine_t2v_video", { resolution: "480p", duration: 6 }],
      ["extend_grok_imagine_video", { resolution: "720p", extend_times: "10" }],
      // HappyHorse video (resolution-tiered)
      ["generate_happyhorse_t2v_video", { resolution: "1080p", duration: "5" }],
      ["generate_happyhorse_i2v_video", { resolution: "720p", duration: "5" }],
      ["generate_happyhorse_ref_video", { resolution: "1080p", duration: "5" }],
      ["generate_happyhorse_videoedit_video", {}],
      // Per-image (tiered + flat)
      ["generate_nano_banana_image", { resolution: "2K" }],
      ["generate_qwen2_image_edit", {}],
      ["generate_kie_qwen_3_0_edit_image", { image_refs: ["@a", "@b", "@c"] }],
      ["generate_seedream_text_image", {}],
      ["generate_seedream_image", {}],
      ["generate_grok_imagine_text_image", { enable_pro: true }],
      ["generate_grok_imagine_image", {}],
    ];
    for (const [tool_name, input] of cases) {
      const result = await client.callTool({
        name: "estimate_cost",
        arguments: { calls: [{ tool_name, input }] },
      });
      const payload = parse(result);
      expect(payload.estimate.warnings, `${tool_name} warnings`).toEqual([]);
      expect(payload.estimate.source, `${tool_name} source`).toBe("per-unit-table");
      expect(payload.estimate.usd, `${tool_name} usd`).toBeGreaterThan(0);
    }
  }, 60_000);

  it.each(["flare", "sunburst"])("prices GPT Image 2.5 %s in text and reference modes", async (variant) => {
    for (const image_refs of [[], ["@reference"]]) {
      const result = await client.callTool({
        name: "estimate_cost",
        arguments: {
          calls: [undefined, "1K", "2K", "4K"].map((resolution) => ({
            tool_name: `generate_kie_gpt_image_2_5_${variant}_image`,
            input: { image_refs, ...(resolution ? { resolution } : {}) },
          })),
        },
      });
      const payload = parse(result);
      expect(payload.per_call.map((call) => call.estimate.usd)).toEqual([0.03, 0.03, 0.05, 0.08]);
      expect(payload.estimate.warnings).toEqual([]);
    }
  });

  it("includes every reference video's duration in current Kie video pricing", async () => {
    const engine = createEngineForTest(tempDir);
    const videoRefs: string[] = [];
    for (const duration of [3, 7]) {
      const asset = await engine.artifacts.create("video", `reference-${duration}`);
      if (!asset.ok) throw new Error(asset.error.message);
      await engine.metadata.artifacts.write(asset.value.artifactId, "original", { duration });
      videoRefs.push(`@${asset.value.artifactId}`);
    }
    const result = await client.callTool({
      name: "estimate_cost",
      arguments: {
        calls: [
          { tool_name: "generate_kie_seedance_2_5_video", input: { resolution: "1080p" } },
          { tool_name: "generate_kie_wan_3_0_video", input: { resolution: "720P" } },
        ].map((call) => ({
          ...call,
          input: { ...call.input, book_id: engine.book.get().bookId, duration: 5, video_refs: videoRefs },
        })),
      },
    });
    const payload = parse(result);
    expect(payload.estimate.warnings).toEqual([]);
    expect(payload.per_call.map((call) => call.estimate.breakdown.units)).toEqual([15, 15]);
    expect(payload.per_call[0].estimate.usd).toBeCloseTo(15 * 0.3425);
    expect(payload.per_call[1].estimate.usd).toBeCloseTo(15 * 0.08);
  });

  it("reports unavailable reference-video pricing when source duration is unknown", async () => {
    const result = await client.callTool({
      name: "estimate_cost",
      arguments: {
        calls: [{
          tool_name: "generate_kie_seedance_2_5_video",
          input: { duration: 5, video_refs: ["https://example.test/source.mp4"] },
        }],
      },
    });
    const payload = parse(result);
    expect(payload.estimate.usd).toBe(0);
    expect(payload.estimate.warnings.join(" ")).toContain("inputDurationSeconds");
  });

  it("prices kie Wan 3.0 tiers and estimates intelligent duration at the 5s default", async () => {
    const result = await client.callTool({
      name: "estimate_cost",
      arguments: {
        calls: [
          { tool_name: "generate_kie_wan_3_0_video", input: { resolution: "720P", duration: 5 } },
          { tool_name: "generate_kie_wan_3_0_prime_video", input: { duration: -1 } },
        ],
      },
    });
    const payload = parse(result);
    expect(payload.per_call[0].estimate.source).toBe("per-unit-table");
    expect(payload.per_call[0].estimate.warnings).toEqual([]);
    expect(payload.per_call[0].estimate.usd).toBeCloseTo(0.4);
    expect(payload.per_call[1].estimate.source).toBe("per-unit-table");
    expect(payload.per_call[1].estimate.warnings).toEqual([]);
    expect(payload.per_call[1].estimate.usd).toBeCloseTo(1.26);
    expect(payload.per_call[1].estimate.breakdown.units).toBe(5);
  });

  it("prices Seedance 2.5 1080p audio and treats automatic duration as 5s", async () => {
    const result = await client.callTool({
      name: "estimate_cost",
      arguments: {
        calls: [
          {
            tool_name: "generate_kie_seedance_2_5_video",
            input: { resolution: "1080p", duration: "5", generate_audio: true },
          },
          {
            tool_name: "generate_kie_seedance_2_5_video",
            input: { resolution: "1080p", duration: "-1" },
          },
        ],
      },
    });
    const payload = parse(result);
    expect(payload.per_call[0].estimate.source).toBe("per-unit-table");
    expect(payload.per_call[0].estimate.warnings).toEqual([]);
    expect(payload.per_call[0].estimate.usd).toBeCloseTo(2.85);
    expect(payload.per_call[1].estimate.warnings).toEqual([]);
    expect(payload.per_call[1].estimate.usd).toBeCloseTo(2.85);
    expect(payload.per_call[1].estimate.breakdown.units).toBe(5);
  });

  it("fails closed for grok-imagine/upscale when source/target resolutions are absent", async () => {
    const result = await client.callTool({
      name: "estimate_cost",
      arguments: { calls: [{ tool_name: "upscale_grok_imagine_video", input: {} }] },
    });
    const payload = parse(result);
    expect(payload.estimate.usd).toBe(0);
    expect(payload.estimate.warnings.join(" ")).toContain(
      "source/target resolutions are not present",
    );
  });

  it("prices ElevenLabs text-to-speech from the Apicity character rate", async () => {
    const result = await client.callTool({
      name: "estimate_cost",
      arguments: {
        calls: [{
          tool_name: "generate_elevenlabs_t2a",
          input: { model_id: "eleven_multilingual_v2", text: "x".repeat(100) },
        }],
      },
    });
    const payload = parse(result);
    expect(payload.estimate.warnings).toEqual([]);
    expect(payload.estimate.breakdown.unit).toBe("characters");
    expect(payload.estimate.usd).toBeCloseTo(0.012, 6);
  });

  it("quotes xAI media rates when _provider selects xai", async () => {
    const result = await client.callTool({
      name: "estimate_cost",
      arguments: {
        calls: [{
          tool_name: "generate_grok_imagine_text_image",
          input: { prompt: "a lighthouse", _provider: "xai" },
        }],
      },
    });
    const payload = parse(result);
    expect(payload.estimate.warnings).toEqual([]);
    expect(payload.estimate.usd).toBeCloseTo(0.02, 6);
  });

  it("uses Gemini Omni's requested text-to-video duration tier", async () => {
    const result = await client.callTool({
      name: "estimate_cost",
      arguments: {
        calls: [{
          tool_name: "generate_gemini_omni_video",
          input: { duration: "6", resolution: "720p" },
        }],
      },
    });
    const payload = parse(result);
    expect(payload.estimate.warnings).toEqual([]);
    // 0.8.8 repriced t2v: 720p and 1080p share one column (84 credits for 6s).
    expect(payload.estimate.usd).toBeCloseTo(0.42, 6);
  });

  it("prices Gemini Omni video-to-video via the fixed v2v selector", async () => {
    const result = await client.callTool({
      name: "estimate_cost",
      arguments: {
        calls: [{
          tool_name: "generate_gemini_omni_video",
          input: { duration: "6", video_ref: "@vid-source" },
        }],
      },
    });
    const payload = parse(result);
    expect(payload.estimate.warnings).toEqual([]);
    // 0.8.8 restructured v2v: flat per video by resolution (duration ignored
    // upstream); the schema-default 720p tier is 168 credits.
    expect(payload.estimate.usd).toBeCloseTo(0.84, 6);
  });

  it("prices fal nano-banana-2 image generation", async () => {
    const result = await client.callTool({
      name: "estimate_cost",
      arguments: {
        calls: [{
          tool_name: "generate_nano_banana_2_fal",
          input: { prompt: "a cat", resolution: "1K", num_images: 1 },
        }],
      },
    });
    const payload = parse(result);
    expect(payload.estimate.warnings).toEqual([]);
    expect(payload.estimate.usd).toBeCloseTo(0.08, 6);
  });

  it("prices edit_image_subjects through the chosen model's shadowed adapter", async () => {
    const seedream = await client.callTool({
      name: "estimate_cost",
      arguments: {
        calls: [{ tool_name: "edit_image_subjects", input: {} }],
      },
    });
    const seedreamPayload = parse(seedream);
    expect(seedreamPayload.estimate.warnings).toEqual([]);
    expect(seedreamPayload.estimate.usd).toBeGreaterThan(0);

    const gptImage2 = await client.callTool({
      name: "estimate_cost",
      arguments: {
        calls: [{
          tool_name: "edit_image_subjects",
          input: { model: "gpt-image-2-image-to-image" },
        }],
      },
    });
    const gptPayload = parse(gptImage2);
    expect(gptPayload.estimate.warnings).toEqual([]);
    expect(gptPayload.estimate.usd).toBeGreaterThan(0);

    const falEdit = await client.callTool({
      name: "estimate_cost",
      arguments: {
        calls: [{
          tool_name: "edit_image_subjects",
          input: { model: "fal-ai/nano-banana-pro/edit" },
        }],
      },
    });
    const falPayload = parse(falEdit);
    expect(falPayload.estimate.warnings).toEqual([]);
    expect(falPayload.estimate.usd).toBeGreaterThan(0);

    const unpriced = await client.callTool({
      name: "estimate_cost",
      arguments: {
        calls: [{
          tool_name: "edit_image_subjects",
          input: { model: "alibaba/qwen-image-3/edit" },
        }],
      },
    });
    const unpricedPayload = parse(unpriced);
    expect(unpricedPayload.estimate.warnings).toContainEqual(
      expect.stringContaining("no cost adapter"),
    );
    expect(unpricedPayload.estimate.usd).toBe(0);
  });

  it("uses the motion video's actual duration for kling-3.0/motion-control", async () => {
    // Regression: kling-3.0/motion-control bills per second of the *input
    // motion video* — there is no user-typed duration. The previous estimate
    // always charged the 5s default, so a 30s motion video showed the price
    // for 5s at /generate. Server now resolves the duration from metadata.
    const fs = createEngineForTest(tempDir);

    const assetResult = await fs.artifacts.create("vid", "long-motion");
    expect(assetResult.ok).toBe(true);
    if (!assetResult.ok) return;
    const motionAssetId = assetResult.value.artifactId;

    const ACTUAL_DURATION = 30;
    const writeMeta = await fs.metadata.artifacts.write(motionAssetId, "original", { duration: ACTUAL_DURATION, width: 720, height: 1280 }
    );
    expect(writeMeta.ok).toBe(true);

    const fiveSecond = await client.callTool({
      name: "estimate_cost",
      arguments: {
        calls: [{
          tool_name: "generate_kling30_motion_control_video",
          input: { mode: "1080p", motion_video_refs: [motionAssetId] },
        }],
      },
    });
    const fiveSecondPayload = parse(fiveSecond);
    expect(fiveSecondPayload.estimate.breakdown.units).toBe(5);

    const enriched = await client.callTool({
      name: "estimate_cost",
      arguments: {
        calls: [{
          tool_name: "generate_kling30_motion_control_video",
          input: {
            mode: "1080p",
            motion_video_refs: [motionAssetId],
            book_id: fs.book.get().bookId,
          },
        }],
      },
    });
    const enrichedPayload = parse(enriched);
    expect(enrichedPayload.estimate.breakdown.units).toBe(ACTUAL_DURATION);
    expect(enrichedPayload.estimate.usd).toBeCloseTo(
      fiveSecondPayload.estimate.usd * (ACTUAL_DURATION / 5),
      4,
    );
  });

  it("enriches motion-control duration when motion slug has a leading @", async () => {
    const fs = createEngineForTest(tempDir);

    const assetResult = await fs.artifacts.create("vid", "at-motion");
    expect(assetResult.ok).toBe(true);
    if (!assetResult.ok) return;
    const motionAssetId = assetResult.value.artifactId;

    const ACTUAL_DURATION = 24;
    const writeMeta = await fs.metadata.artifacts.write(motionAssetId, "original", { duration: ACTUAL_DURATION, width: 720, height: 1280 }
    );
    expect(writeMeta.ok).toBe(true);

    const result = await client.callTool({
      name: "estimate_cost",
      arguments: {
        calls: [{
          tool_name: "generate_kling30_motion_control_video",
          input: {
            mode: "1080p",
            motion_video_refs: [`@${motionAssetId}`],
            book_id: fs.book.get().bookId,
          },
        }],
      },
    });
    const payload = parse(result);
    expect(payload.estimate.breakdown.units).toBe(ACTUAL_DURATION);
  });

  it("uses the source video's actual duration for happyhorse/video-edit", async () => {
    const fs = createEngineForTest(tempDir);

    const assetResult = await fs.artifacts.create("vid", "long-source");
    expect(assetResult.ok).toBe(true);
    if (!assetResult.ok) return;
    const sourceAssetId = assetResult.value.artifactId;

    const ACTUAL_DURATION = 30;
    const writeMeta = await fs.metadata.artifacts.write(sourceAssetId, "original", { duration: ACTUAL_DURATION, width: 1920, height: 1080 }
    );
    expect(writeMeta.ok).toBe(true);

    const fallback = await client.callTool({
      name: "estimate_cost",
      arguments: {
        calls: [{
          tool_name: "generate_happyhorse_videoedit_video",
          input: { resolution: "1080p", video_ref: sourceAssetId },
        }],
      },
    });
    const fallbackPayload = parse(fallback);
    expect(fallbackPayload.estimate.breakdown.units).toBe(10);

    const enriched = await client.callTool({
      name: "estimate_cost",
      arguments: {
        calls: [{
          tool_name: "generate_happyhorse_videoedit_video",
          input: {
            resolution: "1080p",
            video_ref: `@${sourceAssetId}`,
            book_id: fs.book.get().bookId,
          },
        }],
      },
    });
    const enrichedPayload = parse(enriched);
    expect(enrichedPayload.estimate.breakdown.units).toBe(ACTUAL_DURATION * 2);
    expect(enrichedPayload.estimate.usd).toBeCloseTo(
      fallbackPayload.estimate.usd * (ACTUAL_DURATION / 5),
      4,
    );
  });

  it("bills input and output for the 5s happyhorse/video-edit fallback when source has no duration metadata", async () => {
    const fs = createEngineForTest(tempDir);

    const assetResult = await fs.artifacts.create("vid", "legacy-source");
    expect(assetResult.ok).toBe(true);
    if (!assetResult.ok) return;

    const result = await client.callTool({
      name: "estimate_cost",
      arguments: {
        calls: [{
          tool_name: "generate_happyhorse_videoedit_video",
          input: {
            resolution: "1080p",
            video_ref: assetResult.value.artifactId,
            book_id: fs.book.get().bookId,
          },
        }],
      },
    });
    const payload = parse(result);
    expect(payload.estimate.breakdown.units).toBe(10);
    expect(payload.estimate.warnings).toEqual([]);
  });

  it("uses the source video's stored resolution for Grok extension pricing", async () => {
    const fs = createEngineForTest(tempDir);

    const assetResult = await fs.artifacts.create("vid", "grok-source");
    expect(assetResult.ok).toBe(true);
    if (!assetResult.ok) return;

    const writeMeta = await fs.metadata.artifacts.write(assetResult.value.artifactId, "generation-payload", { model: "grok-imagine/image-to-video", input: { resolution: "720p" } }
    );
    expect(writeMeta.ok).toBe(true);

    const result = await client.callTool({
      name: "estimate_cost",
      arguments: {
        calls: [{
          tool_name: "extend_grok_imagine_video",
          input: {
            book_id: fs.book.get().bookId,
            video_ref: `@${assetResult.value.artifactId}`,
            extend_times: "10",
          },
        }],
      },
    });
    const payload = parse(result);
    expect(payload.estimate.warnings).toEqual([]);
    // 0.8.8 repriced extend: 10 extra seconds at 720p is $0.225.
    expect(payload.estimate.usd).toBeCloseTo(0.225, 6);
  });

  it("sums multiple calls into one summed estimate", async () => {
    const result = await client.callTool({
      name: "estimate_cost",
      arguments: {
        calls: [
          { tool_name: "generate_seedance2_video", input: { duration: 5 } },
          { tool_name: "generate_kling30_video", input: { duration: 5 } },
        ],
      },
    });
    const payload = parse(result);
    expect(payload.per_call).toHaveLength(2);
    const sum = payload.per_call.reduce((acc, r) => acc + r.estimate.usd, 0);
    expect(payload.estimate.usd).toBeCloseTo(sum, 6);
    expect(payload.estimate.usd).toBeGreaterThan(0);
  });

  it("prices Google Flow omni via Gemini API list rates (not credits×$/cr)", async () => {
    const prev = process.env.GOOGLE_FLOW_PLAN_TIER;
    process.env.GOOGLE_FLOW_PLAN_TIER = "ultra99";
    try {
      const result = await client.callTool({
        name: "estimate_cost",
        arguments: {
          calls: [{
            tool_name: "generate_google_omni_video",
            input: { prompt: "test", duration: "10" },
          }],
        },
      });
      const payload = parse(result);
      expect(payload.estimate.warnings.join(" ")).not.toContain("no cost adapter");
      expect(payload.estimate.source).toBe("per-unit-table");
      // Official API: $0.10/s × 10s = $1.00 (not amortized 30 × $0.01 = $0.30)
      expect(payload.estimate.usd).toBeCloseTo(1.0, 6);
      const credits = (payload.estimate.breakdown as { credits?: number }).credits;
      expect(credits).toBe(30);
    } finally {
      if (prev === undefined) delete process.env.GOOGLE_FLOW_PLAN_TIER;
      else process.env.GOOGLE_FLOW_PLAN_TIER = prev;
    }
  });

  it("prices Google Flow veo fast and free lite-lp via API rates", async () => {
    const prev = process.env.GOOGLE_FLOW_PLAN_TIER;
    process.env.GOOGLE_FLOW_PLAN_TIER = "ultra99";
    try {
      const fast = await client.callTool({
        name: "estimate_cost",
        arguments: {
          calls: [{
            tool_name: "generate_veo31_fast_video",
            input: { prompt: "x", duration: "8" },
          }],
        },
      });
      // $0.10/s × 8s = $0.80
      expect(parse(fast).estimate.usd).toBeCloseTo(0.8, 6);

      const free = await client.callTool({
        name: "estimate_cost",
        arguments: {
          calls: [{
            tool_name: "generate_veo31_lite_low_priority_video",
            input: { prompt: "x" },
          }],
        },
      });
      const freePayload = parse(free);
      expect(freePayload.estimate.usd).toBe(0);
      expect(freePayload.estimate.warnings.join(" ")).not.toContain("no cost adapter");
    } finally {
      if (prev === undefined) delete process.env.GOOGLE_FLOW_PLAN_TIER;
      else process.env.GOOGLE_FLOW_PLAN_TIER = prev;
    }
  });

  it("prices every fal tool wired into cost-adapters with a >0 estimate", async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      // Images
      ["generate_fal_nano_banana_text_to_image", {}],
      ["generate_fal_nano_banana_edit_image", {}],
      ["generate_fal_nano_banana_2_text_to_image", { resolution: "1K" }],
      ["generate_fal_nano_banana_2_edit_image", { resolution: "1K" }],
      ["generate_fal_nano_banana_pro_text_to_image", { resolution: "2K" }],
      ["generate_fal_nano_banana_pro_edit_image", { resolution: "2K" }],
      ["generate_fal_seedream_v5_lite_text_to_image", {}],
      ["generate_fal_seedream_v5_lite_edit_image", {}],
      ["generate_fal_grok_imagine_text_to_image", {}],
      ["generate_fal_grok_imagine_edit_image", {}],
      ["generate_fal_qwen_2_0_text_to_image", {}],
      // qwen edit has no documented image_size default — pass one explicitly.
      ["generate_fal_qwen_2_0_edit_image", { image_size: "landscape_4_3" }],
      // Video (per second)
      ["generate_fal_seedance_2_0_text_to_video", { duration: "5" }],
      ["generate_fal_seedance_2_0_image_to_video", { duration: "5" }],
      ["generate_fal_seedance_2_0_reference_to_video", { duration: "5", video_refs: ["@vid-ref"] }],
      ["generate_fal_seedance_2_0_fast_text_to_video", { duration: "5" }],
      ["generate_fal_seedance_2_0_fast_image_to_video", { duration: "5" }],
      ["generate_fal_seedance_2_0_fast_reference_to_video", { duration: "5", video_refs: ["@vid-ref"] }],
      ["generate_fal_grok_imagine_video_image_to_video", { duration: 6 }],
      ["generate_fal_grok_imagine_video_reference_to_video", { duration: 8 }],
      ["extend_fal_grok_imagine_video", { duration: 6 }],
      ["generate_fal_kling_video_v3_pro_text_to_video", {}],
      ["generate_fal_kling_video_v3_pro_image_to_video", {}],
      ["generate_fal_kling_video_v3_standard_text_to_video", { duration: "10" }],
      ["generate_fal_kling_video_v3_standard_image_to_video", { duration: "10", generate_audio: false }],
      ["generate_fal_wan_3_0_prime_text_to_video", { duration: 5 }],
      ["generate_fal_wan_3_0_prime_image_to_video", { duration: 8, resolution: "720p" }],
      ["generate_fal_wan_3_0_prime_reference_to_video", { duration: 10 }],
    ];
    for (const [tool_name, input] of cases) {
      const result = await client.callTool({
        name: "estimate_cost",
        arguments: { calls: [{ tool_name, input }] },
      });
      const payload = parse(result);
      expect(payload.estimate.warnings, `${tool_name} warnings`).toEqual([]);
      expect(payload.estimate.usd, `${tool_name} usd`).toBeGreaterThan(0);
    }
  }, 60_000);

  it("prices fal Wan 3.0 Prime at $0.05 per output second", async () => {
    const result = await client.callTool({
      name: "estimate_cost",
      arguments: {
        calls: [
          { tool_name: "generate_fal_wan_3_0_prime_text_to_video", input: { duration: 5 } },
        ],
      },
    });
    const payload = parse(result);
    expect(payload.estimate.source).toBe("per-unit-table");
    expect(payload.estimate.warnings).toEqual([]);
    expect(payload.estimate.usd).toBeCloseTo(0.25);
  });

  it("returns a $0 estimate for endpoints with no cost adapter (dynamic-pricing fal, unpriced kie Qwen 2.1)", async () => {
    const result = await client.callTool({
      name: "estimate_cost",
      arguments: {
        calls: [
          { tool_name: "generate_fal_wan_3_0_text_to_video", input: { duration: 5 } },
          { tool_name: "generate_fal_qwen_3_0_edit_image", input: {} },
          { tool_name: "generate_kie_qwen_2_1_text_to_image", input: {} },
          { tool_name: "generate_kie_qwen_2_1_edit_image", input: { image_refs: ["@a"] } },
        ],
      },
    });
    const payload = parse(result);
    expect(payload.per_call).toHaveLength(4);
    for (const call of payload.per_call) {
      expect(call.estimate.usd, call.tool_name).toBe(0);
      expect(call.estimate.warnings.join(" "), call.tool_name).toContain("no cost adapter registered");
    }
  });

  it("prices canonical generation names across providers", async () => {
    const result = await client.callTool({
      name: "estimate_cost",
      arguments: {
        calls: [
          { tool_name: "generate_kie_seedance_2_0_video", input: { duration: 5 } },
          { tool_name: "generate_fal_nano_banana_text_to_image", input: { num_images: 1 } },
          { tool_name: "generate_alibaba_qwen_2_0_text_to_image", input: {} },
          { tool_name: "generate_xai_grok_imagine_reference_to_video", input: { duration: 6 } },
          { tool_name: "generate_google_flow_veo_3_1_fast_video", input: { duration: 8 } },
        ],
      },
    });
    const payload = parse(result);
    expect(payload.per_call).toHaveLength(5);
    for (const call of payload.per_call) {
      expect(call.estimate.warnings.join(" "), call.tool_name).not.toContain("no cost adapter");
      expect(call.estimate.usd, call.tool_name).toBeGreaterThan(0);
    }
  });
});
