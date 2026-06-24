import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CostEstimate } from "@apicity/cost";
import { createTestClient } from "../test-client.js";
import { createFsForTest } from "../fs.js";
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
      // Grok-imagine video (resolution-tiered)
      ["generate_grok_imagine_video", { resolution: "480p", duration: 8 }],
      ["generate_grok_imagine_t2v_video", { resolution: "480p", duration: 6 }],
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

  it("uses the motion video's actual duration for kling-3.0/motion-control", async () => {
    // Regression: kling-3.0/motion-control bills per second of the *input
    // motion video* — there is no user-typed duration. The previous estimate
    // always charged the 5s default, so a 30s motion video showed the price
    // for 5s at /generate. Server now resolves the duration from metadata.
    const fs = createFsForTest(tempDir);
    const projectResult = await fs.createProject("est-proj");
    expect(projectResult.ok).toBe(true);

    const assetResult = await fs.createAsset("vid", "long-motion", "est-proj");
    expect(assetResult.ok).toBe(true);
    if (!assetResult.ok) return;
    const motionAssetId = assetResult.value.assetId;

    const ACTUAL_DURATION = 30;
    const writeMeta = await fs.writeMetadata(
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
});
