import { describe, expect, expectTypeOf, it } from "vitest";
import type { CostHints } from "@apicity/cost";
import { MachGenGenerateRequestSchema } from "@apicity/machgen/zod";
import type { OpenAiResponseCompactResponse, OpenAiResponseOutputItem, OpenAiTranscribeResponse } from "@apicity/openai";
import { OpenAiResponseRequestSchema } from "@apicity/openai/zod";
import { createWaveSpeed } from "@apicity/wavespeed";
import type { XaiResponseOutputItem } from "@apicity/xai";
import { firstResponseText, intelligenceRequest } from "../openai-intelligence.js";
import { responseRefusal } from "../provider-refusal.js";
import { estimateGeneration, installFalDynamicEstimator } from "./cost.js";
import { resolveModel } from "./descriptor.js";
import { applyPromptDialect } from "./prompt-dialects.js";
import { modelListing } from "./listing.js";
import { buildWireRequest, type WireRequestInput } from "./request.js";
import type { MediaRefs } from "./types.js";
import { wavespeedMethod } from "./wavespeed.js";

const image = "https://example.test/still.png";
const last = "https://example.test/end.png";
const video = "https://example.test/clip.mp4";
const audio = "https://example.test/audio.wav";
const frames = { first_frame: [image], last_frame: [last] };
const references = { image: [image], video: [video], audio: [audio] };
const prompt = "A kite lifts off";
const falFlash = "fal:bytedance/seedance-2.5/flash";
const waveFlash = "bytedance/seedance-2.5-flash";
const machFlash = "machgen:Seedance-2.5-Flash";

async function quote(id: string, call: WireRequestInput, hints: CostHints = {}) {
  const result = await estimateGeneration(resolveModel(id), { prompt, ...call }, hints);
  if (!result.ok) throw new Error(result.error);
  return result;
}

function option(id: string, name: string) {
  return modelListing(resolveModel(id)).options.find((field) => field.name === name);
}

describe("apicity 0.31.1", () => {
  const waveCases: [string, MediaRefs, Record<string, unknown>, Record<string, unknown>, number][] = [
    ["microsoft/mai-image-2.7/text-to-image", {}, { resolution: "2k" }, { resolution: "2k" }, 0.14],
    ["microsoft/mai-image-2.7/edit", { image: [image, last] }, {}, { images: [image, last] }, 0.035 + 2 * 0.0082],
    ["microsoft/mai-image-2.7-flash/edit", { image: [image, last] }, {}, { images: [image, last] }, 0.0103 + 2 * 0.0026],
    [`${waveFlash}/image-to-video`, frames, { duration: 4, resolution: "480p" }, { image, last_image: last }, 4 * 0.12],
    [`${waveFlash}/reference-to-video`, references, { duration: 4, resolution: "480p" }, { reference_images: [image], reference_videos: [video], reference_audios: [audio] }, (4 + 3) * 0.075],
    ["skywork-ai/skyreels-v4/reference-to-video", { image: [image], video: [video] }, { duration: 4, resolution: "720p", mode: "std" }, { images: [image], ref_videos: [video] }, 4 * 0.25],
  ];

  it.each(waveCases)("wires and prices WaveSpeed %s", async (apiId, refUrls, options, fields, usd) => {
    const sdk = createWaveSpeed({ apiKey: "offline" });
    expect(wavespeedMethod(sdk, apiId)).toBeTypeOf("function");
    const { request, estimate } = await quote(`wavespeed:${apiId}`, { refUrls, options }, { inputDurationSeconds: 3 });
    expect(request).toMatchObject({ prompt, ...fields, ...options });
    expect(estimate.warnings).toEqual([]);
    expect(estimate.usd).toBeCloseTo(usd, 9);
  });

  it.each<[string, MediaRefs]>([
    [`${waveFlash}/image-to-video`, frames], [`${waveFlash}/reference-to-video`, references],
  ])("checks MOV resolution on %s before submitting", (apiId, refUrls) => {
    const model = resolveModel(`wavespeed:${apiId}`);
    for (const resolution of ["480p", "720p", "1080p", "4k"]) {
      expect(buildWireRequest(model, { prompt, refUrls, options: { output_format: "mov", resolution } }).ok)
        .toBe(["480p", "720p"].includes(resolution));
    }
  });

  it("numbers connected Seedance references using each provider's recorded prompt syntax", () => {
    const refs = { image: ["01890f1c-0000-7000-8000-000000000001"], video: ["01890f1c-0000-7000-8000-000000000002"] };
    const input = "Move @image1 like @video1";
    const fal = resolveModel(`${falFlash}/reference-to-video`);
    const wave = resolveModel(`wavespeed:${waveFlash}/reference-to-video`);
    expect(applyPromptDialect(fal.entry.dialect, input, refs)).toBe("Move @Image1 like @Video1");
    expect(applyPromptDialect(wave.entry.dialect, input, refs)).toBe("Move @Image 1 like @Video 1");
  });

  it("rejects fast mode with sound on SkyReels reference video", () => {
    expect(buildWireRequest(resolveModel("wavespeed:skywork-ai/skyreels-v4/reference-to-video"), {
      prompt, refUrls: { image: [image] }, options: { sound: true, mode: "fast" },
    })).toMatchObject({ ok: false, error: expect.stringContaining("fast mode") });
  });

  it("maps both fal Flash frame slots and reports adaptive token pricing", async () => {
    const restore = installFalDynamicEstimator(null);
    try {
      const { request, estimate } = await quote(`${falFlash}/image-to-video`, { refUrls: frames });
      expect(request).toMatchObject({ image_url: image, end_image_url: last, aspect_ratio: "auto" });
      expect(estimate.warnings.join(" ")).toContain("output size follows the input image");
    } finally {
      restore();
    }
  });

  it("maps fal Flash media references and prices an explicit output size", async () => {
    const id = `${falFlash}/reference-to-video`;
    const options = { duration: "5", resolution: "720p", aspect_ratio: "16:9" };
    const { estimate } = await quote(id, { refUrls: { image: [image] }, options });
    expect(estimate.usd).toBeCloseTo(1.5246, 9);
    expect(estimate.warnings).toEqual([]);
    expect(buildWireRequest(resolveModel(id), { prompt, refUrls: references, mode: "extend" }))
      .toMatchObject({ ok: true, request: { task: "extension", image_urls: [image], video_urls: [video], audio_urls: [audio] } });
  });

  it("uses the MachGen Flash task grid and recorded 480p frame price", async () => {
    const options = { resolution: "480p", duration: 4 };
    expect(option(machFlash, "resolution")?.enumValues).toEqual(["480p", "720p"]);
    const cases: [MediaRefs, Record<string, unknown>, number][] = [
      [{}, { task_type: "T2V" }, 4 * 0.067253],
      [frames, { task_type: "I2V", src_image_urls: [image, last], video_config: { aspect_ratio: "adaptive" } }, 0.269012],
      [references, { task_type: "R2V", src_image_urls: [image], src_video_urls: [video], src_audio_urls: [audio] }, 7 * 0.041312],
    ];
    for (const [refUrls, fields, usd] of cases) {
      const { request, estimate } = await quote(machFlash, { refUrls, options }, { inputDurationSeconds: 3 });
      expect(request).toMatchObject({ model: "Seedance-2.5-Flash", ...fields });
      expect(MachGenGenerateRequestSchema.safeParse(request).success).toBe(true);
      expect(estimate.warnings).toEqual([]);
      expect(estimate.usd).toBeCloseTo(usd, 9);
    }
    expect(option("machgen:Seedance-2.5", "resolution")?.enumValues).toContain("2160p");
  });

  const fluxModels: [string, MediaRefs][] = [
    ["text-to-video", {}], ["image-to-video", frames], ["keyframes-to-video", { image: [image, last] }],
  ];
  it.each(fluxModels)("offers and prices FLUX 3 Max 2K and 4K on %s", async (suffix, refUrls) => {
    const id = `fal:blackforestlabs/flux-3-max/${suffix}`;
    expect(option(id, "resolution")?.enumValues).toEqual(["720p", "1080p", "2K", "4K"]);
    for (const [resolution, rate] of [["2K", 0.26], ["4K", 0.52]] as const) {
      const { request, estimate } = await quote(id, { refUrls, options: { resolution, duration: 5 } });
      expect(request).toMatchObject({ resolution, duration: 5 });
      expect(estimate.usd).toBeCloseTo(5 * rate, 9);
      expect(estimate.warnings).toEqual([]);
    }
  });

  const videoModes: [string, MediaRefs][] = [
    ["text-to-video", {}], ["image-to-video", { first_frame: [image] }], ["reference-to-video", { image: [image] }],
  ];
  it.each(videoModes)("accepts and prices 30 seconds of HeyGen %s", async (suffix, refUrls) => {
    const id = `fal:heygen/heygen-video/${suffix}`;
    expect(option(id, "duration")?.maximum).toBe(30);
    const { request, estimate } = await quote(id, { refUrls, options: { duration: 30, resolution: "1080p" } });
    expect(request.duration).toBe(30);
    expect(estimate.usd).toBeCloseTo(30 * 0.06, 9);
    expect(buildWireRequest(resolveModel(id), { prompt, refUrls, options: { duration: 31 } }).ok).toBe(false);
  });

  it.each(videoModes)("accepts up to 20,000 characters for fal Wan 3.0 and Prime %s", (suffix, refUrls) => {
    for (const family of ["wan-3.0", "wan-3.0-prime"]) {
      const model = resolveModel(`fal:alibaba/${family}/${suffix}`);
      const full = "a".repeat(20_000);
      expect(buildWireRequest(model, { prompt: full, refUrls })).toMatchObject({ ok: true, request: { prompt: full } });
      expect(buildWireRequest(model, { prompt: full + "b", refUrls }).ok).toBe(false);
    }
  });

  it("passes reasoning input through and reads only assistant output text", () => {
    const item = { type: "reasoning", id: "rs_1", summary: [], status: "completed" } satisfies OpenAiResponseOutputItem & XaiResponseOutputItem;
    const request = intelligenceRequest({ input: [item] });
    expect(OpenAiResponseRequestSchema.parse(request).input).toEqual([item]);
    const output: OpenAiResponseOutputItem[] = [item, {
      type: "message", id: "msg_1", status: "completed", role: "assistant",
      content: [{ type: "output_text", text: "done", annotations: [] }],
    }];
    expect(firstResponseText({ id: "resp_1", object: "response", created_at: 1, status: "completed", model: request.model, output })).toBe("done");
    const compacted: OpenAiResponseCompactResponse["output"] = [{ type: "compaction", id: "cmp_1", encrypted_content: "opaque" }];
    expect(responseRefusal("openai", { output: compacted })).toBeNull();
    expect(responseRefusal("xai", { output: [item] })).toBeNull();
  });

  it("types detected transcription languages by code", () => {
    expectTypeOf<OpenAiTranscribeResponse["languages"]>().toEqualTypeOf<{ code: string }[] | undefined>();
  });
});
