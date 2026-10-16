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

  it.each(MODEL_ENTRIES.map((entry) => [entry.id]))("%s has a cost estimate path", (id) => {
    const model = resolveModel(id);
    const mode = model.modes[0]!;
    const result = estimateGeneration(model, {
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

  it("wraps url objects and numbered fields", () => {
    const xai = buildWireRequest(resolveModel("xai:grok-imagine-video"), {
      prompt: "move",
      refUrls: { first_frame: ["https://example.com/a.png"] },
    });
    expect(xai).toMatchObject({ ok: true, request: { model: "grok-imagine-video", image: { url: "https://example.com/a.png" } } });
    const flow = buildWireRequest(resolveModel("googleflow:veo-3.1-fast"), {
      prompt: "move",
      refUrls: { image: ["media-1", "media-2"] },
    });
    expect(flow).toMatchObject({ ok: true, request: { model: "veo-3.1-fast", referenceImage_1: "media-1", referenceImage_2: "media-2" } });
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
