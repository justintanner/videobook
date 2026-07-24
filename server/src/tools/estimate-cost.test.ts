import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CostEstimate } from "@apicity/cost";
import { createTestClient } from "../test-client.js";
import { createEngineForTest } from "../fs.js";
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
    expect(payload.per_call[0].estimate.breakdown.units).toBe(15);
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
      // Wan 2.7 video (flat $0.10/s)
      ["generate_wan27_t2v_video", { duration: "5" }],
      ["generate_wan27_i2v_video", { duration: "5" }],
      ["generate_wan27_r2v_video", { duration: "5" }],
      ["generate_wan27_videoedit_video", {}],
      ["extend_wan27_video", { duration: "5" }],
      // Seedance 2 Mini (resolution-tiered per-second; priced by @apicity/cost@0.6.1)
      ["generate_seedance2_mini_video", { resolution: "720p", duration: "5" }],
      ["generate_gemini_omni_video", { resolution: "720p", duration: "6" }],
      // Grok-imagine video (resolution-tiered)
      ["generate_grok_imagine_video", { resolution: "480p", duration: 8 }],
      ["generate_grok_imagine_t2v_video", { resolution: "480p", duration: 6 }],
      ["extend_grok_imagine_video", { resolution: "720p", extend_times: "10" }],
      ["upscale_grok_imagine_video", {}],
      // HappyHorse video (resolution-tiered)
      ["generate_happyhorse_t2v_video", { resolution: "1080p", duration: "5" }],
      ["generate_happyhorse_i2v_video", { resolution: "720p", duration: "5" }],
      ["generate_happyhorse_ref_video", { resolution: "1080p", duration: "5" }],
      ["generate_happyhorse_videoedit_video", {}],
      // Per-image (tiered + flat)
      ["generate_nano_banana_image", { resolution: "2K" }],
      ["generate_wan27_image", { resolution: "2K" }],
      ["generate_wan27_image_pro", { resolution: "4K" }],
      ["generate_qwen2_image_edit", {}],
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
    expect(payload.estimate.usd).toBeCloseTo(0.4725, 6);
  });

  it("prices Gemini Omni video-to-video via the fixed v2v selector", async () => {
    const result = await client.callTool({
      name: "estimate_cost",
      arguments: {
        calls: [{
          tool_name: "generate_gemini_omni_video",
          input: { duration: "6", video_slug: "@vid-source" },
        }],
      },
    });
    const payload = parse(result);
    expect(payload.estimate.warnings).toEqual([]);
    expect(payload.estimate.usd).toBeCloseTo(1.26, 6);
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

  it("uses the motion video's actual duration for kling-3.0/motion-control", async () => {
    // Regression: kling-3.0/motion-control bills per second of the *input
    // motion video* — there is no user-typed duration. The previous estimate
    // always charged the 5s default, so a 30s motion video showed the price
    // for 5s at /generate. Server now resolves the duration from metadata.
    const fs = createEngineForTest(tempDir);
    const projectResult = await fs.projects.create("est-proj");
    expect(projectResult.ok).toBe(true);

    const assetResult = await fs.artifacts.create("vid", "long-motion", "est-proj");
    expect(assetResult.ok).toBe(true);
    if (!assetResult.ok) return;
    const motionAssetId = assetResult.value.slug;

    const ACTUAL_DURATION = 30;
    const writeMeta = await fs.metadata.artifacts.write(
      motionAssetId,
      "original",
      { duration: ACTUAL_DURATION, width: 720, height: 1280 },
      "est-proj",
    );
    expect(writeMeta.ok).toBe(true);

    const fiveSecond = await client.callTool({
      name: "estimate_cost",
      arguments: {
        calls: [{
          tool_name: "generate_kling30_motion_control_video",
          input: { mode: "1080p", motion_video_slugs: [motionAssetId] },
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
            motion_video_slugs: [motionAssetId],
            project_slug: "est-proj",
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
    const projectResult = await fs.projects.create("est-at-proj");
    expect(projectResult.ok).toBe(true);

    const assetResult = await fs.artifacts.create("vid", "at-motion", "est-at-proj");
    expect(assetResult.ok).toBe(true);
    if (!assetResult.ok) return;
    const motionAssetId = assetResult.value.slug;

    const ACTUAL_DURATION = 24;
    const writeMeta = await fs.metadata.artifacts.write(
      motionAssetId,
      "original",
      { duration: ACTUAL_DURATION, width: 720, height: 1280 },
      "est-at-proj",
    );
    expect(writeMeta.ok).toBe(true);

    const result = await client.callTool({
      name: "estimate_cost",
      arguments: {
        calls: [{
          tool_name: "generate_kling30_motion_control_video",
          input: {
            mode: "1080p",
            motion_video_slugs: [`@${motionAssetId}`],
            project_slug: "est-at-proj",
          },
        }],
      },
    });
    const payload = parse(result);
    expect(payload.estimate.breakdown.units).toBe(ACTUAL_DURATION);
  });

  it("uses the source video's actual duration for happyhorse/video-edit", async () => {
    // Regression: happyhorse/video-edit bills per second of the source video —
    // there is no user-typed duration. The previous estimate always charged
    // the 5s default, so a 30s source showed the price for 5s at /generate.
    // Server now resolves the duration from `original` metadata, mirroring the
    // cost hint the job handler forwards to the paygate.
    const fs = createEngineForTest(tempDir);
    const projectResult = await fs.projects.create("est-hh-proj");
    expect(projectResult.ok).toBe(true);

    const assetResult = await fs.artifacts.create("vid", "long-source", "est-hh-proj");
    expect(assetResult.ok).toBe(true);
    if (!assetResult.ok) return;
    const sourceAssetId = assetResult.value.slug;

    const ACTUAL_DURATION = 30;
    const writeMeta = await fs.metadata.artifacts.write(
      sourceAssetId,
      "original",
      { duration: ACTUAL_DURATION, width: 1920, height: 1080 },
      "est-hh-proj",
    );
    expect(writeMeta.ok).toBe(true);

    const fiveSecond = await client.callTool({
      name: "estimate_cost",
      arguments: {
        calls: [{
          tool_name: "generate_happyhorse_videoedit_video",
          input: { resolution: "1080p", video_slug: sourceAssetId },
        }],
      },
    });
    const fiveSecondPayload = parse(fiveSecond);
    expect(fiveSecondPayload.estimate.breakdown.units).toBe(5);

    const enriched = await client.callTool({
      name: "estimate_cost",
      arguments: {
        calls: [{
          tool_name: "generate_happyhorse_videoedit_video",
          input: {
            resolution: "1080p",
            video_slug: `@${sourceAssetId}`,
            project_slug: "est-hh-proj",
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

  it("falls back to the 5s happyhorse/video-edit default when source has no duration metadata", async () => {
    const fs = createEngineForTest(tempDir);
    const projectResult = await fs.projects.create("est-hh-fallback");
    expect(projectResult.ok).toBe(true);

    const assetResult = await fs.artifacts.create("vid", "legacy-source", "est-hh-fallback");
    expect(assetResult.ok).toBe(true);
    if (!assetResult.ok) return;

    const result = await client.callTool({
      name: "estimate_cost",
      arguments: {
        calls: [{
          tool_name: "generate_happyhorse_videoedit_video",
          input: {
            resolution: "1080p",
            video_slug: assetResult.value.slug,
            project_slug: "est-hh-fallback",
          },
        }],
      },
    });
    const payload = parse(result);
    expect(payload.estimate.breakdown.units).toBe(5);
    expect(payload.estimate.warnings).toEqual([]);
  });

  it("uses the source video's stored resolution for Grok extension pricing", async () => {
    const fs = createEngineForTest(tempDir);
    const projectResult = await fs.projects.create("grok-extend-estimate");
    expect(projectResult.ok).toBe(true);

    const assetResult = await fs.artifacts.create("vid", "grok-source", "grok-extend-estimate");
    expect(assetResult.ok).toBe(true);
    if (!assetResult.ok) return;

    const writeMeta = await fs.metadata.artifacts.write(
      assetResult.value.slug,
      "generation-payload",
      { model: "grok-imagine/image-to-video", input: { resolution: "720p" } },
      "grok-extend-estimate",
    );
    expect(writeMeta.ok).toBe(true);

    const result = await client.callTool({
      name: "estimate_cost",
      arguments: {
        calls: [{
          tool_name: "extend_grok_imagine_video",
          input: {
            project_slug: "grok-extend-estimate",
            video_slug: `@${assetResult.value.slug}`,
            extend_times: "10",
          },
        }],
      },
    });
    const payload = parse(result);
    expect(payload.estimate.warnings).toEqual([]);
    expect(payload.estimate.usd).toBeCloseTo(0.15, 6);
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
