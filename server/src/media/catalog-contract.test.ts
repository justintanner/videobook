import { previewGeneration } from "./preview.js";
import { seedanceEditFailure } from "./seedance-edit.js";
import { describe, expect, it } from "vitest";
import { createKie } from "@apicity/kie";
import { MODEL_ENTRIES } from "./catalog.js";
import { resolveModel, UnknownModelError } from "./descriptor.js";
import { buildWireRequest } from "./request.js";
import { estimateGeneration } from "./cost.js";
import { applyPromptDialect } from "./prompt-dialects.js";
import { OPERATIONS_BY_MEDIA, type MediaRefs, type ModeSpec, type Operation, type ResolvedModel } from "./types.js";

const SAMPLE_OPTIONS: Record<string, Record<string, unknown>> = {
  "fal:minimax/h3-max/insert-video": { start_time: 2, resume_time: 5 },
  "kie:grok-imagine/extend": { task_id: "task-1", extend_at: 1, extend_times: "6" },
  "kie:grok-imagine/upscale": { task_id: "task-1" },
  "elevenlabs:text-to-speech": { voice_id: "voice-1" },
};

const SAMPLE_REFS: Record<string, MediaRefs> = {
  "kie:grok-imagine/image-to-video": { image: ["https://example.com/image0.png"] },
};

function sampleRefs(model: ResolvedModel, mode: ModeSpec): MediaRefs {
  const preset = SAMPLE_REFS[model.id];
  if (preset) return preset;
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
  return { ...options, ...SAMPLE_OPTIONS[model.id] };
}

const KIE_MEDIA_TYPES = createKie({ apiKey: "" }).modelInputSchemas as Record<string, { type: string } | undefined>;

describe("media catalog contract", () => {
  it("declares only operations of each model's own media", () => {
    for (const entry of MODEL_ENTRIES) {
      const allowed: readonly Operation[] = OPERATIONS_BY_MEDIA[entry.media];
      expect(entry.operations.filter((operation) => !allowed.includes(operation)), entry.id).toEqual([]);
    }
  });

  it("has unique model ids", () => {
    const ids = MODEL_ENTRIES.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(MODEL_ENTRIES.map((entry) => [entry.id]))("%s resolves against apicity", (id) => {
    const model = resolveModel(id);
    expect(model.title.length).toBeGreaterThan(0);
    for (const mode of model.modes) {
      for (const role of mode.roles) {
        expect(model.slots.map((slot) => slot.role)).toContain(role);
      }
    }
    const kieType = model.provider === "kie" ? KIE_MEDIA_TYPES[model.apiId]?.type : undefined;
    if (kieType) expect(kieType).toBe(model.media);
  });

  it.each(MODEL_ENTRIES.map((entry) => [entry.id]))("%s builds a valid request for every mode", (id) => {
    const model = resolveModel(id);
    for (const mode of model.modes) {
      const built = buildWireRequest(model, {
        prompt: model.promptField ? "a red fox in snow" : undefined,
        refUrls: sampleRefs(model, mode),
        options: requiredOptions(model),
        mode: mode.id,
      });
      expect(built, `${id} mode ${mode.id}`).toMatchObject({ ok: true });
    }
  });

  it.each(MODEL_ENTRIES.map((entry) => [entry.id]))("%s has a cost estimate path", async (id) => {
    const model = resolveModel(id);
    const mode = model.modes[0]!;
    const result = await estimateGeneration(model, {
      prompt: model.promptField ? "a red fox in snow" : undefined,
      refUrls: sampleRefs(model, mode),
      options: requiredOptions(model),
      mode: mode.id,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.estimate.usd).toBeGreaterThanOrEqual(0);
  });
});

describe("media request building", () => {
  it("fills catalog and apicity defaults for a minimal seedance request", () => {
    const built = buildWireRequest(resolveModel("kie:bytedance/seedance-2-5"), { prompt: "a cat" });
    expect(built).toMatchObject({
      ok: true,
      request: {
        model: "bytedance/seedance-2-5",
        input: { prompt: "a cat", resolution: "1080p", aspect_ratio: "16:9", duration: 13, generate_audio: true, return_last_frame: false },
      },
    });
  });

  it("forces adaptive aspect ratio when seedance gets a frame", () => {
    const built = buildWireRequest(resolveModel("kie:bytedance/seedance-2-5"), {
      prompt: "a cat",
      refUrls: { first_frame: ["https://example.com/a.png"] },
      options: { aspect_ratio: "16:9" },
      mode: "i2v",
    });
    expect(built).toMatchObject({ ok: true, request: { input: { first_frame_url: "https://example.com/a.png", aspect_ratio: "adaptive" } } });
  });

  it("writes nested prompts and aliased options", () => {
    const built = buildWireRequest(resolveModel("kie:google/gemini-3-8-flash-tts"), {
      prompt: "Hello there",
      options: { voice: "Kore", style: "warm" },
    });
    expect(built).toMatchObject({
      ok: true,
      request: {
        input: {
          speakers: [{ speaker_id: "Speaker 1", voice_name: "Kore" }],
          dialogue_turns: [{ speaker_id: "Speaker 1", text: "Hello there", style: "warm" }],
        },
      },
    });
  });

  it("spreads one role over several provider fields", () => {
    const built = buildWireRequest(resolveModel("fal:bria/fibo-edit-1.5/product-holding"), {
      prompt: "hold it",
      refUrls: { image: ["https://example.com/person.png", "https://example.com/p1.png", "https://example.com/p2.png"] },
    });
    expect(built).toMatchObject({
      ok: true,
      request: {
        instruction: "hold it",
        person_image_url: "https://example.com/person.png",
        product_image_urls: ["https://example.com/p1.png", "https://example.com/p2.png"],
      },
    });
  });

  it("wraps reference URLs in provider objects", () => {
    const xai = buildWireRequest(resolveModel("xai:grok-imagine-video"), {
      prompt: "move",
      refUrls: { first_frame: ["https://example.com/a.png"] },
    });
    expect(xai).toMatchObject({ ok: true, request: { model: "grok-imagine-video", image: { url: "https://example.com/a.png" } } });
  });

  it("rejects refs, options and prompts the model cannot take", () => {
    const seedance = resolveModel("kie:bytedance/seedance-2-5");
    expect(buildWireRequest(seedance, { prompt: "x", options: { colour: "red" } })).toMatchObject({ ok: false, error: expect.stringContaining("options.colour") });
    expect(buildWireRequest(seedance, { prompt: "x", options: { first_frame_url: "u" } })).toMatchObject({ ok: false, error: expect.stringContaining("refs") });
    expect(buildWireRequest(seedance, { prompt: "x", options: { duration: 999 } })).toMatchObject({ ok: false, error: expect.stringContaining("Duration:") });
    const nano = resolveModel("kie:nano-banana-2-1");
    expect(buildWireRequest(nano, { prompt: "x", refUrls: { video: ["u"] } })).toMatchObject({ ok: false, error: expect.stringContaining("video") });
    expect(buildWireRequest(nano, { prompt: "x", refUrls: { image: Array.from({ length: 11 }, () => "u") } })).toMatchObject({ ok: false, error: expect.stringContaining("at most 10") });
    expect(buildWireRequest(nano, {})).toMatchObject({ ok: false, error: expect.stringContaining("requires a prompt") });
  });

  it("sets the Seedance US task from the chosen mode", () => {
    const model = resolveModel("fal:bytedance/seedance-2.5/us/reference-to-video");
    const video = { video: ["https://example.com/clip.mp4"] };
    expect(buildWireRequest(model, { prompt: "x", refUrls: video })).toMatchObject({ ok: true, request: { task: "reference" } });
    expect(buildWireRequest(model, { prompt: "x", refUrls: video, mode: "v2v" })).toMatchObject({ ok: true, request: { task: "editing" } });
    expect(buildWireRequest(model, { prompt: "x", refUrls: video, mode: "extend" })).toMatchObject({ ok: true, request: { task: "extension" } });
    expect(buildWireRequest(model, { prompt: "x", refUrls: { image: ["https://example.com/a.png"] }, mode: "v2v" }))
      .toMatchObject({ ok: false, error: expect.stringContaining("needs one of: video") });
  });

  it("sends start images as first frames and keeps catalog request defaults", () => {
    expect(buildWireRequest(resolveModel("fal:bytedance/seedance-2.0/us/image-to-video"), {
      prompt: "x",
      refUrls: { first_frame: ["https://example.com/a.png"], last_frame: ["https://example.com/b.png"] },
    })).toMatchObject({ ok: true, request: { image_url: "https://example.com/a.png", end_image_url: "https://example.com/b.png" } });
    expect(buildWireRequest(resolveModel("fal:mirelo-ai/sfx2.0/video-to-video"), {
      prompt: "rain on a tin roof",
      refUrls: { video: ["https://example.com/clip.mp4"] },
    })).toMatchObject({ ok: true, request: { text_prompt: "rain on a tin roof", num_samples: 1 } });
    expect(buildWireRequest(resolveModel("fal:pixverse/music-video/vibemv"), {
      refUrls: { audio: ["https://example.com/song.mp3"], image: ["https://example.com/hero.png", "https://example.com/style.png"] },
      options: { style: "Custom" },
    })).toMatchObject({ ok: true, request: { image_url: "https://example.com/hero.png", style_image_url: "https://example.com/style.png" } });
  });

  it("requires a source image for Bria guided background removal", () => {
    const model = resolveModel("fal:bria/guided-remove-background");
    expect(buildWireRequest(model, {})).toMatchObject({ ok: false, error: expect.stringContaining("requires at least 1 image ref") });
    expect(buildWireRequest(model, { refUrls: { image: ["https://example.com/a.png"] } }))
      .toMatchObject({ ok: true, request: { image_url: "https://example.com/a.png" } });
  });

  it("coerces numeric option strings", () => {
    const built = buildWireRequest(resolveModel("kie:bytedance/seedance-2-5"), { prompt: "x", options: { duration: "13" } });
    expect(built).toMatchObject({ ok: true, request: { input: { duration: 13 } } });
  });

  it("names unknown models", () => {
    expect(() => resolveModel("kie:not-a-model")).toThrow(UnknownModelError);
    expect(() => resolveModel("generate_kie_seedance_2_5_video")).toThrow(/list_generation_models/);
  });
});

describe("prompt dialects", () => {
  const image = "0198c2a0-0000-7000-8000-000000000001";
  const frame = "0198c2a0-0000-7000-8000-000000000002";

  it("expands slot tokens before the model dialect", () => {
    const refs: MediaRefs = { image: [image], first_frame: [frame] };
    expect(applyPromptDialect("seedance", "@firstframe walks to @image1", refs)).toBe("walks to @Image1");
    expect(applyPromptDialect("natural", `put @${image} here`, { image: [image] })).toBe("put reference image 1 here");
    expect(applyPromptDialect("brackets", "@image1 dances", { image: [image] })).toBe("[Image 1] dances");
  });
});

describe("Seedance 2.5 edit mode", () => {
  const model = resolveModel("kie:bytedance/seedance-2-5");
  const refs = { video: ["https://example.test/source.mp4"], image: ["https://example.test/owner.png"] };

  it("overrides stale settings consistently in previews and wire requests", () => {
    const options = { duration: 13, aspect_ratio: "9:16", resolution: "720p" };
    const built = buildWireRequest(model, { prompt: "Animate the owner", mode: "v2v", refUrls: refs, options });
    expect(built).toMatchObject({ ok: true, input: { duration: -1, aspect_ratio: "adaptive", resolution: "720p" } });
    const preview = previewGeneration({ model: model.id, prompt: "Animate the owner", mode: "v2v", refs, options });
    expect(preview.ok && preview.preview.payload).toEqual(built.ok && built.request);
    expect(buildWireRequest(model, { prompt: "x", mode: "r2v", refUrls: refs, options }))
      .toMatchObject({ ok: true, input: options });
    expect(buildWireRequest(model, { prompt: "x", refUrls: refs, options }))
      .toMatchObject({ ok: true, input: options });
  });

  it("requires one source and leaves Wan modes unchanged", () => {
    expect(buildWireRequest(model, { prompt: "x", mode: "v2v" }).ok).toBe(false);
    expect(buildWireRequest(model, { prompt: "x", mode: "v2v", refUrls: { video: [...refs.video, ...refs.video] } }).ok).toBe(false);
    expect(resolveModel("kie:wan/3-0-video").modes.map((mode) => mode.id)).toEqual(["t2v", "i2v", "r2v"]);
  });

  it("prices source-length output and input instead of the lightning default", async () => {
    const estimate = await estimateGeneration(model, { prompt: "x", mode: "v2v", refUrls: refs }, { inputDurationSeconds: 8 });
    expect(estimate).toMatchObject({ ok: true, estimate: { breakdown: { units: 16 }, warnings: [] } });
  });

  it("makes provider-classified editing failures actionable without rewriting unrelated failures", () => {
    const message = "Seedance identified your task as video editing; ratio must be adaptive; duration must be -1";
    expect(seedanceEditFailure(model.id, message)).toContain("Select Edit video (mode v2v)");
    expect(seedanceEditFailure(model.id, "Unavailable")).toBe("Unavailable");
    expect(seedanceEditFailure("kie:wan/3-0-video", message)).toBe(message);
  });
});

describe("FLUX 3 Klein", () => {
  for (const suffix of ["text-to-image", "edit-image"]) {
    const id = `kie:flux-3/klein-${suffix}`;
    const refUrls = suffix === "edit-image" ? { image: ["https://example.com/source.png"] } : {};

    it(`${id} exposes defaults and validates dimensions and image counts`, () => {
      const model = resolveModel(id);
      expect(model.entry.hidden).not.toBe(true);
      expect(model.title).toContain("FLUX 3 Klein");
      expect(buildWireRequest(model, { prompt: "a fox", refUrls })).toMatchObject({
        ok: true,
        input: { resolution: "1K", aspect_ratio: suffix === "edit-image" ? "auto" : "1:1", num_images: 1, output_format: "png" },
      });
      for (const options of [{ width: 512 }, { width: 128, height: 512 }, { num_images: 5 }]) {
        expect(buildWireRequest(model, { prompt: "a fox", refUrls, options }).ok).toBe(false);
      }
      expect(buildWireRequest(model, { prompt: "a fox", refUrls, options: { width: 1024, height: 768 } }).ok).toBe(true);
      if (suffix === "edit-image") {
        expect(buildWireRequest(model, { prompt: "a fox" }).ok).toBe(false);
        expect(buildWireRequest(model, { prompt: "a fox", refUrls: { image: Array<string>(11).fill("https://example.com/source.png") } }).ok).toBe(false);
      }
    });

    it.each([["1K", 0.008], ["2K", 0.0125], ["4K", 0.0325]] as const)(`${id} prices %s per output image`, async (resolution, usd) => {
      const result = await estimateGeneration(resolveModel(id), { prompt: "a fox", refUrls, options: { resolution, num_images: 4 } });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.estimate.usd).toBeCloseTo(usd * 4);
        expect(result.estimate.warnings).toEqual([]);
      }
    });
  }
});
