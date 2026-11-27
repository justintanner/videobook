import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CostHints } from "@apicity/cost";
import type { ZodType } from "zod";
import { zodUnionEnumOptions } from "../zod-slots.js";
import { estimateFalRequest, estimateGeneration, installFalDynamicEstimator } from "./cost.js";
import { resolveModel } from "./descriptor.js";
import { modelListing } from "./listing.js";
import { buildWireRequest, type WireRequestInput } from "./request.js";
import type { MediaRefs } from "./types.js";

const image = "https://example.test/still.png";
const video = "https://example.test/clip.mp4";
const prompt = "A kite lifts off";
const frame = { first_frame: [image] };
const reference = { image: [image] };

async function quote(id: string, call: WireRequestInput = {}, hints: CostHints = {}) {
  const result = await estimateGeneration(resolveModel(id), { prompt, ...call }, hints);
  if (!result.ok) throw new Error(result.error);
  return result;
}

function option(id: string, name: string) {
  return modelListing(resolveModel(id)).options.find((field) => field.name === name);
}

function build(id: string, options: Record<string, unknown> = {}, refUrls: MediaRefs = {}) {
  const model = resolveModel(id);
  return buildWireRequest(model, { ...(model.promptField ? { prompt } : {}), refUrls, options });
}

describe("apicity 0.31.2", () => {
  let restore: () => void = () => undefined;
  beforeAll(() => {
    restore = installFalDynamicEstimator(null);
  });
  afterAll(() => restore());

  const keep1080p: [string, MediaRefs, Record<string, unknown>][] = [
    ["fal:bytedance/seedance-2.5/text-to-video", {}, {}],
    ["fal:bytedance/seedance-2.5/image-to-video", frame, {}],
    ["fal:bytedance/seedance-2.5/reference-to-video", reference, {}],
    ["fal:bytedance/seedance-2.5/us/text-to-video", {}, {}],
    ["fal:bytedance/seedance-2.5/us/image-to-video", frame, {}],
    ["fal:bytedance/seedance-2.5/us/reference-to-video", reference, {}],
    ["fal:bytedance/seedance-2.5/draft/complete", {}, { draft_id: "draft-1" }],
    ["fal:bytedance/seedance-2.5/us/draft/complete", {}, { draft_id: "draft-1" }],
    ["fal:kling/v4/text-to-video", {}, {}],
    ["fal:kling/v4/image-to-video", frame, {}],
    ["fal:kling/v4/reference-to-video", reference, {}],
    ["fal:kling/v4/video-to-video/edit", { video: [video] }, {}],
  ];

  it.each(keep1080p)("offers 4k on %s and keeps the 1080p default", (id, refUrls, options) => {
    expect(option(id, "resolution")).toMatchObject({ enumValues: expect.arrayContaining(["1080p", "4k"]), defaultValue: "1080p" });
    expect(build(id, options, refUrls)).toMatchObject({ ok: true, request: { resolution: "1080p" } });
    expect(build(id, { ...options, resolution: "4k" }, refUrls)).toMatchObject({ ok: true, request: { resolution: "4k" } });
  });

  it.each(["fal:bytedance/seedance-2.5/text-to-video", "fal:bytedance/seedance-2.5/us/text-to-video"])("prices a 12-second %s at 1080p by default and at 4k when chosen", async (id) => {
    const standard = await quote(id);
    expect(standard.request).toMatchObject({ resolution: "1080p", duration: "12" });
    expect(standard.estimate.usd).toBeCloseTo(13.70105361, 9);
    expect(standard.estimate.warnings).toEqual([]);
    const uhd = await quote(id, { options: { resolution: "4k" } });
    expect(uhd.estimate.usd).toBeCloseTo(22.08, 9);
    expect(uhd.estimate.warnings.join(" ")).toContain("approximate 4K price of $1.840 per output second");
  });

  it("prices Kling 4 at 1080p by default, at 4k and with HDR", async () => {
    const id = "fal:kling/v4/text-to-video";
    expect(option(id, "hdr")).toMatchObject({ valueType: "boolean" });
    expect(option(id, "hdr")).not.toHaveProperty("defaultValue");
    const cases: [Record<string, unknown>, number][] = [
      [{}, 2.82], [{ resolution: "4k" }, 6.588], [{ hdr: true }, 3.384], [{ resolution: "4k", hdr: true }, 7.524],
    ];
    for (const [options, usd] of cases) {
      const { request, estimate } = await quote(id, { options });
      expect(request).toMatchObject({ duration: 12, resolution: "1080p", ...options });
      expect(estimate.usd).toBeCloseTo(usd, 9);
      expect(estimate.warnings).toEqual([]);
    }
    expect((await quote(id)).request).not.toHaveProperty("hdr");
  });

  it("prices a Kling 4 video edit from the source length without asking fal", async () => {
    const calls: unknown[] = [];
    const swap = installFalDynamicEstimator(async (request) => {
      calls.push(request);
      return { total_cost: 0.17, currency: "USD" };
    });
    try {
      const cases: [Record<string, unknown>, number][] = [[{}, 3.384], [{ resolution: "4k" }, 7.896], [{ resolution: "4k", hdr: true }, 8.832]];
      for (const [options, usd] of cases) {
        const { estimate } = await quote("fal:kling/v4/video-to-video/edit", { refUrls: { video: [video] }, options }, { inputDurationSeconds: 12 });
        expect(estimate.usd).toBeCloseTo(usd, 9);
        expect(estimate.warnings).toEqual([]);
      }
      expect(calls).toEqual([]);
    } finally {
      swap();
    }
  });

  it.each(keep1080p.filter(([id]) => id.startsWith("fal:kling/v4/")))("refuses HDR at 720p on %s", (id, refUrls) => {
    expect(build(id, { resolution: "720p" }, refUrls).ok).toBe(true);
    expect(build(id, { resolution: "720p", hdr: true }, refUrls)).toMatchObject({ ok: false, error: expect.stringContaining("HDR needs 1080p or 4k") });
    expect(build(id, { resolution: "4k", hdr: true }, refUrls)).toMatchObject({ ok: true, request: { resolution: "4k", hdr: true } });
  });

  it.each(["fal:bytedance/seedance-2.5/reference-to-video", "fal:bytedance/seedance-2.5/us/reference-to-video"])("does not offer the unpriced auto task on %s", async (id) => {
    expect(option(id, "task")?.enumValues).toEqual(["reference", "editing", "extension"]);
    expect(build(id, { task: "auto" }, reference)).toMatchObject({ ok: false, error: expect.stringContaining("Task") });
    const unpriced = await estimateFalRequest(resolveModel(id).apiId, { prompt, task: "auto", image_urls: [image], resolution: "720p", duration: "12", aspect_ratio: "16:9" });
    expect(unpriced.warnings.join(" ")).toContain("task 'auto' is not priced");
  });

  it.each<[string, MediaRefs]>([["text-to-image", {}], ["edit", reference]])("takes up to 15 images per Seedream 5 Lite %s generation and prices the upper bound", async (suffix, refUrls) => {
    const id = `fal:fal-ai/bytedance/seedream/v5/lite/${suffix}`;
    expect(option(id, "max_images")?.maximum).toBe(15);
    const { estimate } = await quote(id, { refUrls, options: { num_images: 2, max_images: 15 } });
    expect(estimate.usd).toBeCloseTo(30 * 0.035, 9);
    expect(estimate.warnings.join(" ")).toContain("this estimate assumes 30, an upper bound");
    expect(build(id, { max_images: 16 }, refUrls).ok).toBe(false);
    const single = await quote(id, { refUrls });
    expect(single.estimate.usd).toBeCloseTo(0.035, 9);
    expect(single.estimate.warnings).toEqual([]);
  });

  it("accepts 2,000-character prompts for fal Wan 2.7 image edit", () => {
    const model = resolveModel("fal:fal-ai/wan/v2.7/edit");
    const full = "a".repeat(2_000);
    expect(buildWireRequest(model, { prompt: full, refUrls: reference })).toMatchObject({ ok: true, request: { prompt: full } });
    expect(buildWireRequest(model, { prompt: full + "b", refUrls: reference }).ok).toBe(false);
  });

  const choices: [string, string, string[], MediaRefs][] = [
    ["fal:xai/grok-imagine-image", "aspect_ratio", ["auto"], {}],
    ["fal:xai/grok-imagine-video/v1.5/text-to-video", "aspect_ratio", ["21:9", "5:2"], {}],
    ["fal:xai/grok-imagine-video/v1.5/lite/text-to-video", "aspect_ratio", ["21:9", "5:2"], {}],
    ["fal:xai/grok-imagine-video/v1.5/reference-to-video", "aspect_ratio", ["21:9", "5:2"], reference],
    ["fal:fal-ai/kling-video/v3/pro/image-to-video", "shot_type", ["intelligent"], frame],
    ["fal:fal-ai/nano-banana-pro", "aspect_ratio", ["4:1", "1:4", "8:1", "1:8"], {}],
    ["fal:fal-ai/nano-banana-pro/edit", "aspect_ratio", ["4:1", "1:4", "8:1", "1:8"], reference],
    ["fal:kling/v4/text-to-video", "aspect_ratio", ["4:3", "3:4"], {}],
    ["fal:kling/v4/reference-to-video", "aspect_ratio", ["4:3", "3:4"], reference],
    ["fal:blackforestlabs/flux-3/text-to-image", "resolution", ["1.5k"], {}],
    ["fal:blackforestlabs/flux-3/edit-image", "resolution", ["1.5k"], reference],
    ["kie:seedream/5-5-text-to-image", "size", ["3K"], {}],
    ["kie:seedream/5-5-image-to-image", "size", ["3K"], reference],
  ];

  it.each(choices)("offers %s %s %j", (id, name, values, refUrls) => {
    expect(option(id, name)?.enumValues).toEqual(expect.arrayContaining(values));
    for (const value of values) expect(build(id, { [name]: value }, refUrls)).toMatchObject({ ok: true, input: { [name]: value } });
  });

  it.each<[string, MediaRefs, string]>([
    ["fal:bytedance/seedream/v5/flash/text-to-image", {}, "auto_1.5K"],
    ["fal:bytedance/seedream/v5/flash/edit", reference, "auto_1.5K"],
    ["fal:ideogram/v4.5", {}, "auto"],
    ["fal:ideogram/v4.5/edit", reference, "provider_auto"],
  ])("offers the %s image size %s", (id, refUrls, size) => {
    expect(zodUnionEnumOptions(resolveModel(id).wire.input.shape.image_size as ZodType)).toContain(size);
    expect(build(id, { image_size: size }, refUrls)).toMatchObject({ ok: true, request: { image_size: size } });
  });

  it("keeps the default image tiers at or below 2K", () => {
    expect(option("fal:blackforestlabs/flux-3/text-to-image", "resolution")?.defaultValue).toBe("2k");
    expect(option("kie:seedream/5-5-text-to-image", "size")?.defaultValue).toBe("2K");
    expect(option("kie:seedream/5-5-image-to-image", "size")?.defaultValue).toBe("2K");
    expect(option("kie:seedream/5-5-layer-decomposition", "size")?.enumValues).not.toContain("3K");
    expect(option("fal:xai/grok-imagine-image", "aspect_ratio")?.defaultValue).toBe("9:16");
  });

  it.each<[string, MediaRefs]>([["fal:blackforestlabs/flux-3/text-to-image", {}], ["fal:blackforestlabs/flux-3/edit-image", reference]])("prices %s at 1.5k", async (id, refUrls) => {
    const { estimate } = await quote(id, { refUrls, options: { resolution: "1.5k" } });
    expect(estimate.usd).toBeCloseTo(0.07, 9);
    expect(estimate.warnings).toEqual([]);
  });

  it("estimates high-quality Ideogram 4.5 generation at $0.10 and edits at $0.22", async () => {
    const generation = await quote("fal:ideogram/v4.5");
    expect(generation.request).toMatchObject({ quality: "high" });
    expect(generation.estimate.usd).toBeCloseTo(0.1, 9);
    const edit = await quote("fal:ideogram/v4.5/edit", { refUrls: reference });
    expect(edit.request).toMatchObject({ quality: "high" });
    expect(edit.estimate.usd).toBeCloseTo(0.22, 9);
  });

  it("prices KIE Seedream 5.5 at 3K and needs a fixed aspect ratio for a 3K edit", async () => {
    const generation = await quote("kie:seedream/5-5-text-to-image", { options: { size: "3K" } });
    expect(generation.estimate.usd).toBeCloseTo(0.071, 9);
    const edit = await quote("kie:seedream/5-5-image-to-image", { refUrls: { image: [image, image] }, options: { size: "3K" } });
    expect(edit.request).toMatchObject({ input: { size: "3K", aspect_ratio: "9:16" } });
    expect(edit.estimate.usd).toBeCloseTo(0.071 + 2 * 0.0072, 9);
    expect(build("kie:seedream/5-5-image-to-image", { size: "3K", aspect_ratio: "auto" }, reference))
      .toMatchObject({ ok: false, error: expect.stringContaining("3K requires a fixed aspect_ratio") });
  });
});
