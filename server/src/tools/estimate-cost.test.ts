import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Client } from "@modelcontextprotocol/client";
import type { CostEstimate } from "@apicity/cost";
import type { Engine } from "videobook-engine";
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
  return JSON.parse(content[0]!.text) as EstimatePayload;
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

  async function estimate(calls: Array<{ tool_name: string; input: Record<string, unknown> }>): Promise<EstimatePayload> {
    return parse(await client.callTool({ name: "estimate_cost", arguments: { calls } }));
  }

  async function videoWithDuration(engine: Engine, duration: number): Promise<string> {
    const asset = await engine.artifacts.create("video", `reference-${duration}`);
    if (!asset.ok) throw new Error(asset.error.message);
    await engine.metadata.artifacts.write(asset.value.artifactId, "original", { duration });
    return `@${asset.value.artifactId}`;
  }

  it("returns a $0 estimate with a warning for an unmapped tool or unknown model", async () => {
    const payload = await estimate([
      { tool_name: "this_tool_does_not_exist", input: {} },
      { tool_name: "generate_video", input: { model: "kie:not-a-model", prompt: "x" } },
    ]);
    expect(payload.estimate.usd).toBe(0);
    expect(payload.per_call[0]!.estimate.warnings.join(" ")).toContain("no cost adapter registered");
    expect(payload.per_call[1]!.estimate.warnings.join(" ")).toContain("unknown model");
  });

  it("validates edit source duration and bills source-length output", async () => {
    const engine = createEngineForTest(tempDir);
    for (const duration of [3.99, 4, 8, 30, 30.01]) {
      const source = await videoWithDuration(engine, duration);
      const payload = await estimate([{ tool_name: "generate_video", input: {
        model: "kie:bytedance/seedance-2-5", prompt: "edit", mode: "v2v", refs: { video: [source] },
        options: { duration: 13, aspect_ratio: "9:16" },
      } }]);
      if (duration >= 4 && duration <= 30) {
        expect(payload.estimate.warnings).toEqual([]);
        expect(payload.estimate.breakdown.units).toBe(duration * 2);
      } else {
        expect(payload.estimate.warnings.join(" ")).toContain("between 4 and 30 seconds");
      }
    }
    const unknown = await estimate([{ tool_name: "generate_video", input: {
      model: "kie:bytedance/seedance-2-5", prompt: "edit", mode: "v2v", refs: { video: ["https://example.test/source.mp4"] },
    } }]);
    expect(unknown.estimate.warnings.join(" ")).toContain("known duration");
  });

  it("prices a per-second video model from its duration option", async () => {
    const five = await estimate([{ tool_name: "generate_video", input: { model: "kie:bytedance/seedance-2-5", prompt: "x", options: { duration: 5, resolution: "720p" } } }]);
    const ten = await estimate([{ tool_name: "generate_video", input: { model: "kie:bytedance/seedance-2-5", prompt: "x", options: { duration: 10, resolution: "720p" } } }]);
    expect(five.estimate.warnings).toEqual([]);
    expect(five.estimate.breakdown.units).toBe(5);
    expect(ten.estimate.usd).toBeCloseTo(five.estimate.usd * 2, 6);
  });

  it("uses catalog defaults when options are omitted", async () => {
    const payload = await estimate([{ tool_name: "generate_video", input: { model: "kie:bytedance/seedance-2-5", prompt: "x" } }]);
    expect(payload.estimate.breakdown.units).toBe(13);
    expect(payload.estimate.usd).toBeGreaterThan(0);
  });

  it("includes every reference video's duration in reference pricing", async () => {
    const engine = createEngineForTest(tempDir);
    const refs = [await videoWithDuration(engine, 3), await videoWithDuration(engine, 7)];
    const payload = await estimate([{
      tool_name: "generate_video",
      input: {
        book_id: engine.book.get().bookId,
        model: "kie:bytedance/seedance-2-5",
        prompt: "x",
        mode: "r2v",
        refs: { video: refs },
        options: { duration: 5, resolution: "1080p" },
      },
    }]);
    expect(payload.estimate.warnings).toEqual([]);
    expect(payload.estimate.breakdown.units).toBe(15);
  });

  it("reports unavailable reference-video pricing when the source duration is unknown", async () => {
    const payload = await estimate([{
      tool_name: "generate_video",
      input: { model: "kie:bytedance/seedance-2-5", prompt: "x", mode: "r2v", refs: { video: ["https://example.test/source.mp4"] }, options: { duration: 5 } },
    }]);
    expect(payload.estimate.usd).toBe(0);
    expect(payload.estimate.warnings.join(" ")).toContain("inputDurationSeconds");
  });

  it("bills an input-length model from its source video's duration", async () => {
    const engine = createEngineForTest(tempDir);
    const motion = await videoWithDuration(engine, 30);
    const image = await engine.artifacts.create("img", "character");
    if (!image.ok) throw new Error(image.error.message);
    const payload = await estimate([{
      tool_name: "generate_video",
      input: {
        book_id: engine.book.get().bookId,
        model: "kie:kling-3.0/motion-control",
        prompt: "dance",
        refs: { image: [image.value.artifactId], video: [motion] },
      },
    }]);
    expect(payload.estimate.breakdown.units).toBe(30);
    expect(payload.estimate.usd).toBeGreaterThan(0);
  });

  it("prices image models on kie and fal", async () => {
    const payload = await estimate([
      { tool_name: "generate_image", input: { model: "kie:nano-banana-2-1", prompt: "a cat" } },
      { tool_name: "generate_image", input: { model: "fal:fal-ai/nano-banana-2", prompt: "a cat" } },
    ]);
    for (const call of payload.per_call) {
      expect(call.estimate.usd).toBeGreaterThan(0);
      expect(call.estimate.warnings).toEqual([]);
    }
    expect(payload.estimate.usd).toBeCloseTo(payload.per_call[0]!.estimate.usd + payload.per_call[1]!.estimate.usd, 6);
  });

  it("prices speech by character count", async () => {
    const short = await estimate([{ tool_name: "generate_audio", input: { model: "kie:elevenlabs/text-to-speech-turbo-2-5", prompt: "x".repeat(1000) } }]);
    const long = await estimate([{ tool_name: "generate_audio", input: { model: "kie:elevenlabs/text-to-speech-turbo-2-5", prompt: "x".repeat(2000) } }]);
    expect(short.estimate.usd).toBeGreaterThan(0);
    expect(long.estimate.usd).toBeCloseTo(short.estimate.usd * 2, 6);
  });

  it("reports missing rewrite token counts and prices image subject edits", async () => {
    const payload = await estimate([
      { tool_name: "rewrite_prompt", input: { prompt: "x".repeat(400) } },
      { tool_name: "edit_image_subjects", input: { model: "nano-banana-2-1", image_refs: ["a", "b"] } },
      { tool_name: "edit_image_subjects", input: { model: "sharp/layer-composite", operation: "remove" } },
    ]);
    expect(payload.per_call[0]!.estimate.source).toBe("declared-tokens+table");
    expect(payload.per_call[0]!.estimate.breakdown.inputTokens).toBeUndefined();
    expect(payload.per_call[0]!.estimate.usd).toBe(0);
    expect(payload.per_call[0]!.estimate.warnings.join(" ")).toContain("costHints.inputTokens");
    expect(payload.per_call[1]!.estimate.usd).toBeGreaterThan(0);
    expect(payload.per_call[2]!.estimate.usd).toBe(0);
  });

  it("returns the model's validation error for invalid options", async () => {
    const payload = await estimate([{ tool_name: "generate_video", input: { model: "kie:bytedance/seedance-2-5", prompt: "x", options: { duration: 999 } } }]);
    expect(payload.estimate.usd).toBe(0);
    expect(payload.estimate.warnings.join(" ")).toContain("Duration");
  });
});
