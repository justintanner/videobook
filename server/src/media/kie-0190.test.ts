import { describe, expect, it } from "vitest";
import { GrokVideo15PreviewRequestSchema, Seedance25RequestSchema } from "@apicity/kie/zod";
import { LIGHTNING_VIDEO_GENERATE_AUDIO } from "../lightning-defaults.js";
import { resolveModel } from "./descriptor.js";
import { buildWireRequest, type WireRequestInput } from "./request.js";
import { estimateGeneration } from "./cost.js";

const image = "https://example.com/image.png";
const second = "https://example.com/second.png";
const video = "https://example.com/video.mp4";
const audio = "https://example.com/voice.mp3";

function option(model: string, name: string) {
  return resolveModel(model).options.find((candidate) => candidate.name === name);
}

describe("kie 0.19.0 schema defaults", () => {
  it("keeps Seedance 2.5 audio on when a request omits generate_audio, although apicity now defaults it off", () => {
    expect(Seedance25RequestSchema.parse({ model: "bytedance/seedance-2-5", input: { prompt: "x" } }).input.generate_audio).toBe(false);
    expect(LIGHTNING_VIDEO_GENERATE_AUDIO).toBe(true);
    expect(option("kie:bytedance/seedance-2-5", "generate_audio")).toMatchObject({ valueType: "boolean", defaultValue: true });
    const model = resolveModel("kie:bytedance/seedance-2-5");
    for (const call of [
      {},
      { refUrls: { first_frame: [image] } },
      { refUrls: { image: [image], video: [video], audio: [audio] } },
      { refUrls: { video: [video] }, mode: "v2v" },
    ] satisfies Omit<WireRequestInput, "prompt">[]) {
      expect(buildWireRequest(model, { prompt: "x", ...call })).toMatchObject({ ok: true, request: { input: { generate_audio: true } } });
    }
    expect(buildWireRequest(model, { prompt: "x", options: { generate_audio: false } }))
      .toMatchObject({ ok: true, request: { input: { generate_audio: false } } });
  });

  it("sends KIE's documented nsfw_checker default, false, for the Grok Imagine 1.5 preview unless a request turns the filter on", () => {
    expect(GrokVideo15PreviewRequestSchema.parse({ model: "grok-imagine-video-1-5-preview", input: { image_urls: [image] } }).input.nsfw_checker).toBe(false);
    expect(option("kie:grok-imagine-video-1-5-preview", "nsfw_checker")).toMatchObject({ valueType: "boolean", defaultValue: false });
    const model = resolveModel("kie:grok-imagine-video-1-5-preview");
    expect(buildWireRequest(model, { prompt: "x", refUrls: { image: [image] } }))
      .toMatchObject({ ok: true, request: { input: { nsfw_checker: false } } });
    expect(buildWireRequest(model, { prompt: "x", refUrls: { image: [image] }, options: { nsfw_checker: true } }))
      .toMatchObject({ ok: true, request: { input: { nsfw_checker: true } } });
  });
});

describe("kie 0.19.0 Grok Imagine 1.5 preview 1080p tier", () => {
  it("defaults to 1080p and needs 480p or 720p for more than one image", () => {
    const model = resolveModel("kie:grok-imagine-video-1-5-preview");
    expect(option("kie:grok-imagine-video-1-5-preview", "resolution")).toMatchObject({ enumValues: ["480p", "720p", "1080p"], defaultValue: "1080p" });
    expect(buildWireRequest(model, { prompt: "x", refUrls: { image: [image], first_frame: [second] } }))
      .toMatchObject({ ok: true, request: { input: { image_urls: [image], first_frame_url: second, resolution: "1080p" } } });
    expect(buildWireRequest(model, { prompt: "x", refUrls: { image: [image, second] } }))
      .toMatchObject({ ok: false, error: expect.stringContaining("accepts exactly 1 image_url at 1080p") });
    expect(buildWireRequest(model, { prompt: "x", refUrls: { image: [image, second] }, options: { resolution: "720p" } }))
      .toMatchObject({ ok: true, request: { input: { image_urls: [image, second], resolution: "720p" } } });
  });

  it("prices 1080p from the @apicity/cost rate", async () => {
    const result = await estimateGeneration(resolveModel("kie:grok-imagine-video-1-5-preview"), { prompt: "x", refUrls: { image: [image] }, options: { duration: 5 } });
    expect(result).toMatchObject({ ok: true, estimate: { warnings: [] } });
    if (result.ok) expect(result.estimate.usd).toBeCloseTo(5 * 0.04);
  });
});
