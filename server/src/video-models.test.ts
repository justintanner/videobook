import { describe, it, expect } from "vitest";
import {
  DEFAULT_VIDEO_MODEL_KEY,
  extractLastSettingsPerModel,
  extractLastUsedModel,
  buildModelOption,
  VIDEO_MODELS,
  getVideoToolSchema,
  validateVideoParams,
  applyVideoToolConstraints,
  buildVideoRoutingPrompt,
  IMAGE_FIELD_SCHEMAS,
  PARAM_SCHEMAS,
  VIDEO_TOOL_MODES,
} from "./video-models.js";
import type { ActionLogEntry } from "./video-models.js";

// ---------------------------------------------------------------------------
// extractLastSettingsPerModel
// ---------------------------------------------------------------------------

describe("extractLastSettingsPerModel", () => {
  it("returns empty map for empty log", () => {
    const result = extractLastSettingsPerModel([]);
    expect(result.size).toBe(0);
  });

  it("extracts settings from a single kling30 log entry, stripping book_id", () => {
    const log: ActionLogEntry[] = [
      {
        hash: "abc123",
        action: "tool-generate-kling30-video",
        payload: { book_id: "my-proj", prompt: "sunset", mode: "pro", duration: "10" },
        date: "2026-03-08T00:00:00Z",
      },
    ];
    const result = extractLastSettingsPerModel(log);
    expect(result.get("generate_kie_kling_3_0_video")).toEqual({
      prompt: "sunset",
      mode: "pro",
      duration: "10",
    });
  });

  it("uses first (newest) entry per model since git log is newest-first", () => {
    const log: ActionLogEntry[] = [
      {
        hash: "newer",
        action: "tool-generate-kling30-video",
        payload: { prompt: "newest prompt", mode: "std" },
        date: "2026-03-08T02:00:00Z",
      },
      {
        hash: "older",
        action: "tool-generate-kling30-video",
        payload: { prompt: "older prompt", mode: "pro" },
        date: "2026-03-08T01:00:00Z",
      },
    ];
    const result = extractLastSettingsPerModel(log);
    expect(result.get("generate_kie_kling_3_0_video")).toEqual({
      prompt: "newest prompt",
      mode: "std",
    });
  });

  it("handles multiple different models independently", () => {
    const log: ActionLogEntry[] = [
      {
        hash: "a1",
        action: "tool-generate-kling30-video",
        payload: { prompt: "kling prompt", duration: "8" },
        date: "2026-03-08T00:00:00Z",
      },
      {
        hash: "a2",
        action: "tool-generate-seedance2-video",
        payload: { prompt: "seedance prompt", resolution: "720p" },
        date: "2026-03-08T00:00:00Z",
      },
    ];
    const result = extractLastSettingsPerModel(log);
    expect(result.size).toBe(2);
    expect(result.get("generate_kie_kling_3_0_video")).toEqual({ prompt: "kling prompt", duration: "8" });
    expect(result.get("generate_kie_seedance_2_0_video")).toEqual({ prompt: "seedance prompt", resolution: "720p" });
  });

  it("ignores non-video-gen action entries", () => {
    const log: ActionLogEntry[] = [
      {
        hash: "s1",
        action: "tool-sleep",
        payload: { duration: 5000 },
        date: "2026-03-08T00:00:00Z",
      },
      {
        hash: "s2",
        action: "tool-asset-manifest",
        payload: { book_id: "default" },
        date: "2026-03-08T00:00:00Z",
      },
    ];
    const result = extractLastSettingsPerModel(log);
    expect(result.size).toBe(0);
  });

  it("skips entries with string payloads", () => {
    const log: ActionLogEntry[] = [
      {
        hash: "s1",
        action: "tool-generate-kling30-video",
        payload: "some string payload",
        date: "2026-03-08T00:00:00Z",
      },
    ];
    const result = extractLastSettingsPerModel(log);
    expect(result.size).toBe(0);
  });

  it("handles all video model action names correctly", () => {
    const actionNames = [
      "tool-generate-kling30-video",
      "tool-generate-seedance2-video",
      "tool-generate-seedance2-fast-video",
      "tool-generate-grok-imagine-video",
    ];
    const log: ActionLogEntry[] = actionNames.map((action, i) => ({
      hash: `h${i}`,
      action,
      payload: { prompt: `prompt-${i}` },
      date: "2026-03-08T00:00:00Z",
    }));
    const result = extractLastSettingsPerModel(log);
    expect(result.size).toBe(4);
    expect(result.has("generate_kie_kling_3_0_video")).toBe(true);
    expect(result.has("generate_kie_seedance_2_0_video")).toBe(true);
    expect(result.has("generate_kie_seedance_2_0_fast_video")).toBe(true);
    expect(result.has("generate_kie_grok_imagine_image_to_video")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// extractLastUsedModel
// ---------------------------------------------------------------------------

describe("extractLastUsedModel", () => {
  it("returns null for empty log", () => {
    expect(extractLastUsedModel([])).toBeNull();
  });

  it("returns the model key of the most recent video tool entry", () => {
    const log: ActionLogEntry[] = [
      {
        hash: "h1",
        action: "tool-generate-grok-imagine-video",
        payload: { prompt: "test" },
        date: "2026-03-08T02:00:00Z",
      },
      {
        hash: "h2",
        action: "tool-generate-kling30-video",
        payload: { prompt: "older" },
        date: "2026-03-08T01:00:00Z",
      },
    ];
    expect(extractLastUsedModel(log)).toBe("grok_imagine");
  });

  it("skips non-video tool entries", () => {
    const log: ActionLogEntry[] = [
      {
        hash: "h1",
        action: "tool-asset-manifest",
        payload: { book_id: "test" },
        date: "2026-03-08T02:00:00Z",
      },
      {
        hash: "h2",
        action: "tool-generate-seedance25-video",
        payload: { prompt: "test" },
        date: "2026-03-08T01:00:00Z",
      },
    ];
    expect(extractLastUsedModel(log)).toBe("seedance25");
  });

  it("skips entries with string payloads", () => {
    const log: ActionLogEntry[] = [
      {
        hash: "h1",
        action: "tool-generate-kling30-video",
        payload: "some string",
        date: "2026-03-08T02:00:00Z",
      },
      {
        hash: "h2",
        action: "tool-generate-grok-imagine-video",
        payload: { prompt: "test" },
        date: "2026-03-08T01:00:00Z",
      },
    ];
    expect(extractLastUsedModel(log)).toBe("grok_imagine");
  });
});

// ---------------------------------------------------------------------------
// buildModelOption — history integration
// ---------------------------------------------------------------------------

describe("buildModelOption history integration", () => {
  const kling = VIDEO_MODELS.kling30;
  const seedance = VIDEO_MODELS.seedance25;

  it("history params fill in as defaults when router params are empty", () => {
    const history: ActionLogEntry[] = [
      {
        hash: "h1",
        action: "tool-generate-kie-kling-3-0-omni-text-to-video",
        payload: { prompt: "old prompt", resolution: "1080p", duration: 12 },
        date: "2026-03-08T00:00:00Z",
      },
    ];
    const option = buildModelOption("kling30", kling, {}, [], history);
    expect(option.prefilled_values.prompt).toBe("old prompt");
    expect(option.prefilled_values.resolution).toBe("1080p");
    expect(option.prefilled_values.duration).toBe("12");
  });

  it("history for model X does not leak into model Y", () => {
    const history: ActionLogEntry[] = [
      {
        hash: "h1",
        action: "tool-generate-kie-kling-3-0-omni-text-to-video",
        payload: { prompt: "kling prompt", resolution: "4k" },
        date: "2026-03-08T00:00:00Z",
      },
    ];
    const option = buildModelOption("seedance25", seedance, {}, [], history);
    expect(option.prefilled_values.prompt).toBeUndefined();
    expect(option.prefilled_values).not.toHaveProperty("audio");
  });

  it("history params filtered by model's allowedParams", () => {
    const history: ActionLogEntry[] = [
      {
        hash: "h1",
        action: "tool-generate-seedance25-video",
        payload: { prompt: "test", resolution: "720p", sound: true },
        date: "2026-03-08T00:00:00Z",
      },
    ];
    const option = buildModelOption("seedance25", seedance, {}, [], history);
    expect(option.prefilled_values.prompt).toBe("test");
    expect(option.prefilled_values.resolution).toBe("720p");
    expect(option.prefilled_values).not.toHaveProperty("sound");
  });
});

// ---------------------------------------------------------------------------
// getVideoToolSchema
// ---------------------------------------------------------------------------

describe("getVideoToolSchema", () => {
  it("returns null for unknown tool", () => {
    expect(getVideoToolSchema("nonexistent_tool")).toBeNull();
  });

  it("kling omni text: prompt required, 720p/1080p/4k, duration 3-15", () => {
    const schema = getVideoToolSchema("generate_kie_kling_3_0_omni_text_to_video");
    expect(schema).not.toBeNull();
    expect(schema!.required).toContain("prompt");
    expect(schema!.properties.resolution.enum).toEqual(["720p", "1080p", "4k"]);
    expect(schema!.properties.audio).toBeDefined();
    expect(schema!.defaults.resolution).toBe("720p");
    expect(schema!.defaults.customize_multi_shots).toBe(false);
    expect(schema!.properties.image_refs).toBeUndefined();
  });

  it("kling omni image requires image_refs and rejects extra frames", () => {
    const schema = getVideoToolSchema("generate_kie_kling_3_0_omni_image_to_video");
    expect(schema).not.toBeNull();
    expect(schema!.required).toContain("image_refs");
    expect(schema!.properties.image_refs.minItems).toBe(1);
    expect(schema!.properties.image_refs.maxItems).toBe(2);
  });

  it("seedance 2.5 exposes every Apicity option and reference limit", () => {
    const schema = getVideoToolSchema("generate_kie_seedance_2_5_video");
    expect(schema).not.toBeNull();
    expect(schema!.required).not.toContain("prompt");
    expect(schema!.properties.prompt.maxLength).toBe(30000);
    expect(schema!.properties.image_refs.maxItems).toBe(30);
    expect(schema!.properties.video_refs.maxItems).toBe(10);
    expect(schema!.properties.audio_refs.maxItems).toBe(10);
    expect(schema!.properties.duration.enum).toEqual([
      "-1", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15",
      "16", "17", "18", "19", "20", "21", "22", "23", "24", "25", "26", "27", "28", "29", "30",
    ]);
    expect(schema!.properties.resolution.enum).toEqual(["480p", "720p", "1080p"]);
    expect(schema!.properties.aspect_ratio.enum).toEqual(["1:1", "4:3", "3:4", "16:9", "9:16", "21:9", "adaptive"]);
    expect(schema!.properties.output_format.enum).toEqual(["mp4", "mov"]);
    expect(schema!.properties.return_last_frame.type).toBe("boolean");
    expect(schema!.properties.generate_audio.type).toBe("boolean");
    expect(schema!.properties.web_search.type).toBe("boolean");
    expect(schema!.properties.nsfw_checker.type).toBe("boolean");
    expect(schema!.defaults).toMatchObject({
      return_last_frame: false,
      generate_audio: true,
      resolution: "720p",
      aspect_ratio: "adaptive",
      duration: "5",
      output_format: "mp4",
      nsfw_checker: false,
    });
  });

  it("kling omni transformation requires video_refs", () => {
    const schema = getVideoToolSchema("generate_kie_kling_3_0_omni_transformation");
    expect(schema).not.toBeNull();
    expect(schema!.required).toContain("video_refs");
    expect(schema!.properties.video_refs.maxItems).toBe(1);
  });

  it("grok_imagine: uses Kie Grok Imagine Video 1.5 defaults", () => {
    const schema = getVideoToolSchema("generate_kie_grok_imagine_image_to_video");
    expect(schema).not.toBeNull();
    expect(schema!.required).toContain("image_refs");
    expect(schema!.required).not.toContain("prompt");
    expect(schema!.properties.mode.enum).toEqual(["fun", "normal"]);
    expect(schema!.properties.duration.type).toBe("integer");
    expect(schema!.properties.duration.minimum).toBe(6);
    expect(schema!.properties.duration.maximum).toBe(30);
    expect(schema!.properties.resolution.enum).toEqual(["480p", "720p", "1080p"]);
    expect(schema!.properties.aspect_ratio.enum).toEqual(["2:3", "3:2", "1:1", "16:9", "9:16"]);
    expect(schema!.properties.image_refs.minItems).toBe(1);
    expect(schema!.properties.image_refs.maxItems).toBe(7);
    expect(schema!.properties.nsfw_checker).toBeDefined();
    expect(schema!.properties.nsfw_checker.type).toBe("boolean");
    expect(schema!.defaults).toEqual({
      mode: "normal",
      duration: 6,
      resolution: "480p",
      aspect_ratio: "16:9",
      nsfw_checker: false,
    });
  });

  it("grok text-to-video publishes bounded wire defaults", () => {
    const schema = getVideoToolSchema("generate_kie_grok_imagine_text_to_video");
    expect(schema).not.toBeNull();
    expect(schema!.defaults).toMatchObject({
      duration: 6,
      resolution: "480p",
    });
    expect(schema!.properties.duration.default).toBe(6);
    expect(schema!.properties.resolution.default).toBe("480p");
  });

  it("uses Apicity Kling Omni defaults without inventing extra ones", () => {
    const schema = getVideoToolSchema("generate_kie_kling_3_0_omni_text_to_video");
    expect(schema).not.toBeNull();
    expect(schema!.defaults.resolution).toBe("720p");
    expect(schema!.defaults.customize_multi_shots).toBe(false);
    expect(schema!.required).toContain("prompt");
    expect(schema!.required).not.toContain("audio");
  });

  it("gemini_omni: prompt+duration required, Apicity-derived enums and resolution default", () => {
    const schema = getVideoToolSchema("generate_kie_gemini_omni_video");
    expect(schema).not.toBeNull();
    expect(schema!.required).toEqual(expect.arrayContaining(["prompt", "duration"]));
    expect(schema!.required).not.toContain("video_ref");
    expect(schema!.required).not.toContain("image_refs");
    expect(schema!.properties.duration.enum).toEqual(["4", "6", "8", "10"]);
    expect(schema!.properties.aspect_ratio.enum).toEqual(["16:9", "9:16"]);
    expect(schema!.properties.resolution.enum).toEqual(["720p", "1080p", "4k"]);
    expect(schema!.properties.seed.type).toBe("integer");
    expect(schema!.properties.image_refs.maxItems).toBe(7);
    expect(schema!.defaults).toEqual({ resolution: "720p" });
  });

  it("derives xAI reference-video fields and the documented reference limit", () => {
    const schema = getVideoToolSchema("generate_grok_imagine_ref_video");
    expect(schema).not.toBeNull();
    expect(schema!.required).toContain("prompt");
    expect(schema!.properties.prompt.minLength).toBe(1);
    expect(schema!.properties.duration.enum).toEqual([
      "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15",
    ]);
    expect(schema!.properties.image_refs.maxItems).toBe(7);
  });

  it("derives Fal Grok reference and extension duration ranges", () => {
    const reference = getVideoToolSchema("generate_grok_imagine_r2v_fal_video");
    const extension = getVideoToolSchema("generate_grok_imagine_extend_fal_video");

    expect(reference!.properties.duration).toMatchObject({ type: "integer", minimum: 1, maximum: 10 });
    expect(extension!.properties.duration).toMatchObject({ type: "integer", minimum: 2, maximum: 10 });
  });

  it("uses Apicity's exported HappyHorse duration domain", () => {
    const happyHorse = getVideoToolSchema("generate_happyhorse_t2v_video");
    expect(happyHorse!.properties.duration.enum).toEqual([
      "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15",
    ]);
  });
});

// ---------------------------------------------------------------------------
// validateVideoParams
// ---------------------------------------------------------------------------

describe("validateVideoParams", () => {
  it("returns invalid for unknown tool", () => {
    const result = validateVideoParams("nonexistent_tool", {});
    expect(result.valid).toBe(false);
    expect(result.warnings).toContain("Unknown tool");
  });

  it("valid kling omni text params pass", () => {
    const result = validateVideoParams("generate_kie_kling_3_0_omni_text_to_video", {
      prompt: "a sunset",
      resolution: "720p",
      duration: "8",
      audio: true,
    });
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it("kling omni: missing prompt is flagged", () => {
    const result = validateVideoParams("generate_kie_kling_3_0_omni_text_to_video", {
      resolution: "720p",
    });
    expect(result.valid).toBe(false);
    expect(result.missing_required).toContain("prompt");
  });

  it("kling omni: warns on invalid resolution", () => {
    const result = validateVideoParams("generate_kie_kling_3_0_omni_text_to_video", {
      prompt: "test",
      resolution: "480p",
    });
    expect(result.warnings.some((w) => w.includes("resolution") && w.includes("480p"))).toBe(true);
  });

  it("kling omni image mode requires image_refs", () => {
    const result = validateVideoParams("generate_kie_kling_3_0_omni_image_to_video", {
      prompt: "test",
    });
    expect(result.valid).toBe(false);
    expect(result.missing_required).toContain("image_refs");
  });

  it("seedance 2.5 enforces frame scenarios and expanded reference limits", () => {
    const invalidFrames = validateVideoParams("generate_kie_seedance_2_5_video", {
      last_frame_ref: "@img-last",
      image_refs: ["@img-ref"],
    });
    expect(invalidFrames.warnings).toContain("Seedance 2.5 last_frame_ref requires first_frame_ref");
    expect(invalidFrames.warnings).toContain("Seedance 2.5 reference inputs cannot be combined with first/last frame");

    const validRefs = validateVideoParams("generate_kie_seedance_2_5_video", {
      image_refs: Array.from({ length: 30 }, (_, index) => `@img-${index}`),
      video_refs: Array.from({ length: 10 }, (_, index) => `@vid-${index}`),
      audio_refs: Array.from({ length: 10 }, (_, index) => `@aud-${index}`),
      duration: "30",
      output_format: "mov",
    });
    expect(validRefs.valid).toBe(true);
  });

  it("derives image_slots from Apicity Zod", () => {
    const klingResult = validateVideoParams("generate_kie_kling_3_0_omni_image_to_video", { prompt: "test", image_refs: ["@img-a"] });
    expect(klingResult.image_slots).toEqual({ min: 1, max: 2 });

    const grokResult = validateVideoParams("generate_kie_grok_imagine_image_to_video", { image_refs: ["@img-a"] });
    expect(grokResult.image_slots).toEqual({ min: 1, max: 7 });
    const tooManyGrokImages = validateVideoParams("generate_kie_grok_imagine_image_to_video", { image_refs: ["@img-a", "@img-b", "@img-c", "@img-d", "@img-e", "@img-f", "@img-g", "@img-h"] });
    expect(tooManyGrokImages.warnings).toContain("Grok Imagine 1.5 supports up to 7 reference images (got 8)");
    const invalid1080p = validateVideoParams("generate_kie_grok_imagine_image_to_video", {
      image_refs: ["@img-a", "@img-b"],
      resolution: "1080p",
    });
    expect(invalid1080p.warnings).toContain(
      "Grok Imagine image-to-video accepts exactly 1 image at 1080p (got 2); remove extra image inputs or choose 720p or 480p.",
    );
  });

  it("enforces xAI's cross-field duration cap only when references are present", () => {
    const withReference = validateVideoParams("generate_grok_imagine_ref_video", {
      prompt: "test",
      duration: "15",
      image_refs: ["@img-a"],
    });
    const withoutReference = validateVideoParams("generate_grok_imagine_ref_video", {
      prompt: "test",
      duration: "15",
    });
    expect(withReference.warnings).toContain("xAI reference-to-video supports at most 10 seconds when reference images are supplied");
    expect(withoutReference.warnings).not.toContain("xAI reference-to-video supports at most 10 seconds when reference images are supplied");
  });

  it("tools without image-array fields return null image_slots", () => {
    const extendResult = validateVideoParams("extend_kie_grok_imagine_video", {
      prompt: "test",
      video_ref: "@vid-a",
      extend_at: 2,
      extend_times: "6",
    });
    expect(extendResult.image_slots).toBeNull();
  });

  it("multi_prompt_slots: 6 for kling omni, null for others", () => {
    const klingResult = validateVideoParams("generate_kie_kling_3_0_omni_text_to_video", { prompt: "test" });
    expect(klingResult.multi_prompt_slots).toBe(6);

    const grokResult = validateVideoParams("generate_kie_grok_imagine_image_to_video", { prompt: "test" });
    expect(grokResult.multi_prompt_slots).toBeNull();
  });

  it("gemini_omni: valid prompt + duration with no references passes", () => {
    const result = validateVideoParams("generate_kie_gemini_omni_video", { prompt: "a sunset", duration: "6" });
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it("gemini_omni: missing prompt/duration is flagged", () => {
    const result = validateVideoParams("generate_kie_gemini_omni_video", {});
    expect(result.valid).toBe(false);
    expect(result.missing_required).toEqual(expect.arrayContaining(["prompt", "duration"]));
  });

  it("gemini_omni: warns when a reference clip has bad timing", () => {
    const result = validateVideoParams("generate_kie_gemini_omni_video", {
      prompt: "a sunset", duration: "6", video_ref: "@vid-motion", video_clip_start: 2, video_clip_ends: 2,
    });
    expect(result.warnings.some((w) => w.includes("video_clip_ends"))).toBe(true);
  });

  it("gemini_omni: warns when clip timecodes are set without a video_ref", () => {
    const result = validateVideoParams("generate_kie_gemini_omni_video", {
      prompt: "a sunset", duration: "6", video_clip_start: 1, video_clip_ends: 5,
    });
    expect(result.warnings.some((w) => w.includes("require a video_ref"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// applyVideoToolConstraints
// ---------------------------------------------------------------------------

describe("applyVideoToolConstraints", () => {
  it("is a no-op for tools without cross-field rewriting", () => {
    const schema = getVideoToolSchema("generate_kie_kling_3_0_omni_text_to_video")!;
    const params: Record<string, unknown> = {
      prompt: "test",
      resolution: "720p",
    };
    applyVideoToolConstraints("generate_kie_kling_3_0_omni_text_to_video", schema, params);
    expect(params.resolution).toBe("720p");
  });
});

// ---------------------------------------------------------------------------
// buildVideoRoutingPrompt
// ---------------------------------------------------------------------------

describe("buildVideoRoutingPrompt", () => {
  it("defaults video generation to Seedance 2.5", () => {
    expect(DEFAULT_VIDEO_MODEL_KEY).toBe("seedance25");
    expect(VIDEO_MODELS[DEFAULT_VIDEO_MODEL_KEY].tool_name).toBe("generate_kie_seedance_2_5_video");
  });

  it("returns a non-empty string", () => {
    const prompt = buildVideoRoutingPrompt();
    expect(prompt.length).toBeGreaterThan(0);
  });

  it("mentions all video tool names", () => {
    const prompt = buildVideoRoutingPrompt();
    for (const model of Object.values(VIDEO_MODELS)) {
      expect(prompt).toContain(model.tool_name);
    }
  });

  it("includes routing preferences", () => {
    const prompt = buildVideoRoutingPrompt();
    expect(prompt).toContain("ROUTING PREFERENCES");
    expect(prompt).toContain("PREFER generate_kie_seedance_2_5_video");
    expect(prompt).toContain("generate_kie_gemini_omni_video only when the user explicitly asks");
    expect(prompt).not.toContain("Gemini Omni — the DEFAULT model");
  });

  it("includes JSON response format instruction", () => {
    const prompt = buildVideoRoutingPrompt();
    expect(prompt).toContain("JSON only");
  });
});

// ---------------------------------------------------------------------------
// IMAGE_FIELD_SCHEMAS & PARAM_SCHEMAS exports
// ---------------------------------------------------------------------------

describe("IMAGE_FIELD_SCHEMAS", () => {
  it("maps tools with image-array inputs to their Apicity Zod schemas", () => {
    expect(IMAGE_FIELD_SCHEMAS).toHaveProperty("generate_kie_kling_3_0_omni_image_to_video");
    expect(IMAGE_FIELD_SCHEMAS).toHaveProperty("generate_kie_kling_3_0_motion_control");
    expect(IMAGE_FIELD_SCHEMAS).toHaveProperty("generate_kie_seedance_2_5_video");
    expect(IMAGE_FIELD_SCHEMAS).toHaveProperty("generate_kie_grok_imagine_image_to_video");
    expect(IMAGE_FIELD_SCHEMAS).toHaveProperty("generate_kie_happyhorse_1_1_reference_to_video");
  });

  it("omits tools that take no image-array field (extend, text-to-video)", () => {
    expect(IMAGE_FIELD_SCHEMAS).not.toHaveProperty("extend_kie_grok_imagine_video");
    expect(IMAGE_FIELD_SCHEMAS).not.toHaveProperty("generate_kie_happyhorse_1_1_text_to_video");
  });
});

describe("PARAM_SCHEMAS", () => {
  it("prompt param has type string", () => {
    expect(PARAM_SCHEMAS.prompt.type).toBe("string");
  });

  it("image_refs param has type array", () => {
    expect(PARAM_SCHEMAS.image_refs.type).toBe("array");
  });
});

// ---------------------------------------------------------------------------
// buildModelOption — resolved assets & coercion
// ---------------------------------------------------------------------------

describe("buildModelOption resolved assets and coercion", () => {
  it("fills image_refs from resolved image assets", () => {
    const resolvedAssets = [
      { tag: "@img-sunset", artifactId: "id-image", artifactSlug: "img-sunset", artifactType: "image" as const, filePath: "/some/path.png", workspacePath: "/some" },
    ];
    const option = buildModelOption("kling30", VIDEO_MODELS.kling30, {}, resolvedAssets);
    expect(option.prefilled_values.image_refs).toEqual(["@img-sunset"]);
  });

  it("skips image assets without file_path", () => {
    const resolvedAssets = [
      { tag: "@img-sunset", artifactId: "id-image", artifactSlug: "img-sunset", artifactType: "image" as const, filePath: null, workspacePath: "/some" },
    ];
    const option = buildModelOption("kling30", VIDEO_MODELS.kling30, {}, resolvedAssets);
    expect(option.prefilled_values.image_refs).toEqual([]);
  });

  it("extend_grok_imagine prefills video_ref from video assets", () => {
    const resolvedAssets = [
      { tag: "@vid-clip", artifactId: "id-video", artifactSlug: "vid-clip", artifactType: "video" as const, filePath: "/path/clip.mp4", workspacePath: "/path" },
    ];
    const option = buildModelOption("grok_imagine_extend", VIDEO_MODELS.grok_imagine_extend, {}, resolvedAssets);
    expect(option.prefilled_values.video_ref).toBe("@vid-clip");
  });

  it("gemini_omni prefills video_ref from a prompt-referenced video (both providers)", () => {
    const resolvedAssets = [
      { tag: "@vid-clip", artifactId: "id-video", artifactSlug: "vid-clip", artifactType: "video" as const, filePath: "/path/clip.mp4", workspacePath: "/path" },
    ];
    const kie = buildModelOption("gemini_omni", VIDEO_MODELS.gemini_omni, {}, resolvedAssets, undefined, "kie");
    expect(kie.prefilled_values.video_ref).toBe("@vid-clip");
    const google = buildModelOption("gemini_omni", VIDEO_MODELS.gemini_omni, {}, resolvedAssets, undefined, "google");
    expect(google.prefilled_values.video_ref).toBe("@vid-clip");
  });

  it("gemini_omni leaves video_ref unset with no prompt-referenced video", () => {
    const option = buildModelOption("gemini_omni", VIDEO_MODELS.gemini_omni, {}, [], undefined, "google");
    expect(option.prefilled_values.video_ref).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Generation modes contract
// ---------------------------------------------------------------------------

describe("VIDEO_TOOL_MODES contract", () => {
  it("every mode's params/slots/required are backed by the tool schema", () => {
    for (const [toolName, modes] of Object.entries(VIDEO_TOOL_MODES)) {
      const schema = getVideoToolSchema(toolName);
      expect(schema, toolName).not.toBeNull();
      const props = new Set(Object.keys(schema!.properties));
      // default_mode exists
      expect(modes.modes.some((m) => m.key === modes.default_mode)).toBe(true);
      for (const p of modes.shared_params) expect(props.has(p), `${toolName} shared ${p}`).toBe(true);
      for (const mode of modes.modes) {
        const modeSchema = getVideoToolSchema(mode.tool_name ?? toolName);
        expect(modeSchema, `${toolName}/${mode.key} tool`).not.toBeNull();
        const modeProps = new Set(Object.keys(modeSchema!.properties));
        for (const p of mode.params) expect(modeProps.has(p), `${toolName}/${mode.key} param ${p}`).toBe(true);
        for (const p of mode.required ?? []) {
          expect(modeProps.has(p), `${toolName}/${mode.key} required ${p}`).toBe(true);
        }
        for (const slot of mode.asset_slots ?? []) {
          expect(modeProps.has(slot.param), `${toolName}/${mode.key} slot ${slot.param}`).toBe(true);
          expect(mode.params.includes(slot.param), `${toolName}/${mode.key} slot ${slot.param} in params`).toBe(true);
        }
        for (const hidden of mode.hidden_shared_params ?? []) {
          expect(modes.shared_params.includes(hidden), `${toolName}/${mode.key} hides shared ${hidden}`).toBe(true);
        }
      }
    }
  });

  it("buildModelOption attaches omni modes only under the google provider", () => {
    const google = buildModelOption("gemini_omni", VIDEO_MODELS.gemini_omni, {}, [], undefined, "google");
    expect(google.modes).not.toBeNull();
    expect(google.modes!.modes.map((m) => m.key)).toEqual(["t2v", "i2v", "r2v", "edit"]);
    const edit = google.modes!.modes.find((m) => m.key === "edit")!;
    expect(edit.required).toEqual(["video_ref"]);
    expect(edit.param_overrides?.voice_refs?.maxItems).toBe(3);
    const imageSlot = edit.asset_slots?.find((s) => s.param === "image_refs");
    expect(imageSlot?.max).toBe(5);

    const kie = buildModelOption("gemini_omni", VIDEO_MODELS.gemini_omni, {}, [], undefined, "kie");
    expect(kie.modes).toBeNull();
  });

  it("exposes Kling 3.0 Motion Control as its own picker card", () => {
    const option = buildModelOption(
      "kling30_motion_control",
      VIDEO_MODELS.kling30_motion_control,
      {},
      [],
    );
    expect(option.label).toBe("Kling 3.0 Motion Control");
    expect(option.tool_name).toBe("generate_kie_kling_3_0_motion_control");
    expect(option.modes).toBeNull();
    expect(option.schema?.required).toEqual(
      expect.arrayContaining(["character_image_refs", "motion_video_refs"]),
    );
    expect(option.schema?.required).not.toContain("prompt");
  });

  it("kling omni ships four modes that switch canonical tools", () => {
    const option = buildModelOption("kling30", VIDEO_MODELS.kling30, {}, []);
    expect(option.modes).not.toBeNull();
    expect(option.modes!.default_mode).toBe("text");
    expect(option.modes!.modes.map((m) => m.key)).toEqual(["text", "image", "reference", "transformation"]);
    expect(option.modes!.modes.map((m) => m.tool_name)).toEqual([
      "generate_kie_kling_3_0_omni_text_to_video",
      "generate_kie_kling_3_0_omni_image_to_video",
      "generate_kie_kling_3_0_omni_reference_to_video",
      "generate_kie_kling_3_0_omni_transformation",
    ]);
    expect(option.tool_name).toBe("generate_kie_kling_3_0_omni_text_to_video");
  });

  it("seedance 2.5 ships all modes with expanded reference slots", () => {
    const option = buildModelOption("seedance25", VIDEO_MODELS.seedance25, {}, []);
    expect(option.modes).not.toBeNull();
    expect(option.modes!.modes.map((mode) => mode.key)).toEqual(["text", "frames", "refs"]);
    const refs = option.modes!.modes.find((mode) => mode.key === "refs")!;
    expect(refs.asset_slots).toEqual([
      { param: "image_refs", kind: "image", label: "Images", min: 0, max: 30 },
      { param: "video_refs", kind: "video", label: "Videos", min: 0, max: 10 },
      { param: "audio_refs", kind: "audio", label: "Audio", min: 0, max: 10 },
    ]);
    expect(option.schema?.properties).toHaveProperty("return_last_frame");
    expect(option.schema?.properties).toHaveProperty("output_format");
  });

  it("keeps integer duration for kling omni", () => {
    const option = buildModelOption("kling30", VIDEO_MODELS.kling30, { duration: 8 }, []);
    expect(option.prefilled_values.duration).toBe("8");
  });

  it("coerces string duration to integer for grok i2v", () => {
    const option = buildModelOption(
      "grok_imagine",
      VIDEO_MODELS.grok_imagine,
      { duration: "6" },
      [],
    );
    expect(option.prefilled_values.duration).toBe(6);
  });

  it("initializes kling omni multi-shot defaults", () => {
    const option = buildModelOption("kling30", VIDEO_MODELS.kling30, {}, []);
    expect(option.prefilled_values.multi_prompt).toEqual([]);
    expect(option.prefilled_values.customize_multi_shots).toBe(false);
  });

  it("returns valid ModelOption structure", () => {
    const option = buildModelOption("kling30", VIDEO_MODELS.kling30, { prompt: "test" }, []);
    expect(option.key).toBe("kling30");
    expect(option.label).toBe("Kling 3.0 Omni");
    expect(option.tool_name).toBe("generate_kie_kling_3_0_omni_text_to_video");
    expect(option.schema).not.toBeNull();
    expect(option.validation).toBeDefined();
    expect(typeof option.validation.valid).toBe("boolean");
  });
});

// ---------------------------------------------------------------------------
// Google Flow models (Veo 3.1 + gemini_omni google provider)
// ---------------------------------------------------------------------------

describe("google flow video models", () => {
  it("veo31 fast: hand-typed enums, duration default 8, ref slots capped at 3", () => {
    const schema = getVideoToolSchema("generate_google_flow_veo_3_1_fast_video");
    expect(schema).not.toBeNull();
    expect(schema!.required).toContain("prompt");
    expect(schema!.properties.aspect_ratio.enum).toEqual(["16:9", "9:16", "1:1", "4:3", "3:4"]);
    expect(schema!.properties.duration.enum).toEqual(["4", "6", "8"]);
    expect(schema!.defaults).toEqual({ duration: "8" });
    expect(schema!.properties.image_refs.maxItems).toBe(3);

    const validation = validateVideoParams("generate_google_flow_veo_3_1_fast_video", { prompt: "a sunset" });
    expect(validation.image_slots).toEqual({ min: 0, max: 3 });
  });

  it("veo31 quality: no image_refs or duration params, image_slots null", () => {
    const schema = getVideoToolSchema("generate_google_flow_veo_3_1_quality_video");
    expect(schema).not.toBeNull();
    expect(schema!.properties.image_refs).toBeUndefined();
    expect(schema!.properties.duration).toBeUndefined();
    expect(schema!.properties.first_frame_ref).toBeDefined();
    expect(schema!.properties.last_frame_ref).toBeDefined();

    const validation = validateVideoParams("generate_google_flow_veo_3_1_quality_video", { prompt: "a sunset" });
    expect(validation.valid).toBe(true);
    expect(validation.image_slots).toBeNull();
  });

  it("veo31: warns on last frame without first frame and refs with start frame", () => {
    const lastOnly = validateVideoParams("generate_google_flow_veo_3_1_fast_video", { prompt: "x", last_frame_ref: "@img-end" });
    expect(lastOnly.warnings.some((w) => w.includes("requires first_frame_ref"))).toBe(true);

    const refsWithFrame = validateVideoParams("generate_google_flow_veo_3_1_fast_video", {
      prompt: "x", first_frame_ref: "@img-start", image_refs: ["@img-a"],
    });
    expect(refsWithFrame.warnings.some((w) => w.includes("pick one mode"))).toBe(true);

    const tooManyRefs = validateVideoParams("generate_google_flow_veo_3_1_lite_video", {
      prompt: "x", image_refs: ["@img-a", "@img-b", "@img-c", "@img-d"],
    });
    expect(tooManyRefs.warnings.some((w) => w.includes("up to 3 reference images"))).toBe(true);

    // The quality tier does not expose image_refs, so auto-populated context
    // images must not raise a ref warning.
    const qualityRefs = validateVideoParams("generate_google_flow_veo_3_1_quality_video", { prompt: "x", image_refs: ["@img-a"] });
    expect(qualityRefs.warnings.some((w) => w.includes("reference images"))).toBe(false);
  });

  it("veo31 lite-low-priority: same ref slots as lite, distinct tool", () => {
    const schema = getVideoToolSchema("generate_google_flow_veo_3_1_lite_low_priority_video");
    expect(schema).toBeDefined();
    expect(schema!.properties.image_refs).toBeDefined();
    expect(schema!.properties.image_refs.maxItems).toBe(3);
    expect(schema!.properties.duration.enum).toEqual(["4", "6", "8"]);
    const validation = validateVideoParams("generate_google_flow_veo_3_1_lite_low_priority_video", { prompt: "a sunset" });
    expect(validation.valid).toBe(true);
    expect(VIDEO_MODELS.veo31_lite_low_priority.tool_name).toBe("generate_google_flow_veo_3_1_lite_low_priority_video");
  });

  it("veo31 models route through the google provider only", () => {
    for (const key of ["veo31", "veo31_fast", "veo31_lite", "veo31_lite_low_priority"]) {
      const info = VIDEO_MODELS[key];
      expect(info.providers).toHaveLength(1);
      expect(info.providers[0].key).toBe("google");
      expect(info.providers[0].envKey).toBe("GOOGLE_FLOW_API_KEY");
    }
  });

  it("grok reference routes through the xai provider", () => {
    expect(VIDEO_MODELS.grok_imagine_ref.tool_name).toBe("generate_xai_grok_imagine_video");
    expect(VIDEO_MODELS.grok_imagine_ref.providers.map((provider) => provider.key)).toEqual(["xai"]);
  });

  it("gemini_omni exposes google as a second provider and swaps the tool name", () => {
    const originalGoogle = process.env.GOOGLE_FLOW_API_KEY;
    const originalKie = process.env.KIE_API_KEY;
    process.env.GOOGLE_FLOW_API_KEY = "real-google-key";
    process.env.KIE_API_KEY = "real-kie-key";
    try {
      const option = buildModelOption("gemini_omni", VIDEO_MODELS.gemini_omni, { prompt: "x" }, [], undefined, "google");
      expect(option.providers.map((p) => p.key)).toEqual(expect.arrayContaining(["kie", "google"]));
      expect(option.selected_provider).toBe("google");
      expect(option.tool_name).toBe("generate_google_flow_omni_flash_video");
      expect(option.schema!.properties.first_frame_ref).toBeDefined();
      expect(option.schema!.properties.resolution).toBeUndefined();
      expect(option.schema!.properties.duration.enum).toEqual(["4", "6", "8", "10"]);
      expect(option.schema!.defaults.duration).toBe("8");
      expect(option.validation.image_slots).toEqual({ min: 0, max: 7 });
    } finally {
      if (originalGoogle === undefined) delete process.env.GOOGLE_FLOW_API_KEY;
      else process.env.GOOGLE_FLOW_API_KEY = originalGoogle;
      if (originalKie === undefined) delete process.env.KIE_API_KEY;
      else process.env.KIE_API_KEY = originalKie;
    }
  });

  it("google omni schema is provider-specific", () => {
    const schema = getVideoToolSchema("generate_google_flow_omni_flash_video");
    expect(schema).not.toBeNull();
    expect(schema!.required).toContain("prompt");
    expect(schema!.required).not.toContain("duration");
    expect(schema!.properties.first_frame_ref).toBeDefined();
    expect(schema!.properties.resolution).toBeUndefined();
    expect(schema!.properties.duration.enum).toEqual(["4", "6", "8", "10"]);
    expect(schema!.properties.duration.default).toBe("8");
    expect(schema!.properties.aspect_ratio.enum).toEqual(["16:9", "9:16"]);
    expect(schema!.properties.video_clip_start.maximum).toBe(10);
    expect(schema!.properties.video_clip_ends.maximum).toBe(10);
    expect(schema!.properties.voice_refs).toBeDefined();
    expect(schema!.properties.voice_refs.maxItems).toBe(5);
    expect(schema!.required).not.toContain("voice_refs");
    expect(schema!.properties.character_refs).toBeDefined();
    expect(schema!.properties.character_refs.maxItems).toBe(3);
    expect(schema!.required).not.toContain("character_refs");
  });

  it("the kie gemini_omni sibling schema does not expose voice/character refs", () => {
    const schema = getVideoToolSchema("generate_kie_gemini_omni_video");
    expect(schema).not.toBeNull();
    expect(schema!.properties.voice_refs).toBeUndefined();
    expect(schema!.properties.character_refs).toBeUndefined();
  });

  it("google omni validates I2V/R2V/V2V mode constraints", () => {
    const valid = validateVideoParams("generate_google_flow_omni_flash_video", { prompt: "x", video_ref: "@vid-a" });
    expect(valid.valid).toBe(true);
    expect(valid.warnings).toHaveLength(0);

    const firstWithRefs = validateVideoParams("generate_google_flow_omni_flash_video", {
      prompt: "x", first_frame_ref: "@img-start", image_refs: ["@img-a"],
    });
    expect(firstWithRefs.warnings.some((w) => w.includes("first_frame_ref cannot be combined with image_refs"))).toBe(true);

    const firstWithVideo = validateVideoParams("generate_google_flow_omni_flash_video", {
      prompt: "x", first_frame_ref: "@img-start", video_ref: "@vid-a",
    });
    expect(firstWithVideo.warnings.some((w) => w.includes("first_frame_ref cannot be combined with video_ref"))).toBe(true);

    const tooManyV2vRefs = validateVideoParams("generate_google_flow_omni_flash_video", {
      prompt: "x",
      video_ref: "@vid-a",
      image_refs: ["@img-a", "@img-b", "@img-c", "@img-d", "@img-e", "@img-f"],
    });
    expect(tooManyV2vRefs.warnings.some((w) => w.includes("up to 5 reference images"))).toBe(true);

    const badClip = validateVideoParams("generate_google_flow_omni_flash_video", {
      prompt: "x", video_ref: "@vid-a", video_clip_start: 2, video_clip_ends: 12,
    });
    expect(badClip.warnings.some((w) => w.includes("<= 10s"))).toBe(true);
  });

  it("google omni validates voice_refs / character_refs budgets", () => {
    const tooManyVoices = validateVideoParams("generate_google_flow_omni_flash_video", {
      prompt: "x", voice_refs: ["v1", "v2", "v3", "v4", "v5", "v6"],
    });
    expect(tooManyVoices.warnings.some((w) => w.includes("up to 5 voice refs"))).toBe(true);

    const voicesWithClip = validateVideoParams("generate_google_flow_omni_flash_video", {
      prompt: "x", video_ref: "@vid-a", voice_refs: ["v1", "v2", "v3", "v4"],
    });
    expect(voicesWithClip.warnings.some((w) => w.includes("up to 3 voice refs alongside the clip"))).toBe(true);

    const tooManyChars = validateVideoParams("generate_google_flow_omni_flash_video", {
      prompt: "x", character_refs: ["c1", "c2", "c3", "c4"],
    });
    expect(tooManyChars.warnings.some((w) => w.includes("up to 3 character refs"))).toBe(true);

    const firstWithChars = validateVideoParams("generate_google_flow_omni_flash_video", {
      prompt: "x", first_frame_ref: "@img-start", character_refs: ["c1"],
    });
    expect(firstWithChars.warnings.some((w) => w.includes("first_frame_ref cannot be combined with character_refs"))).toBe(true);

    const budgetBust = validateVideoParams("generate_google_flow_omni_flash_video", {
      prompt: "x", image_refs: ["@img-a", "@img-b", "@img-c", "@img-d"], character_refs: ["c1", "c2", "c3", "c4"],
    });
    expect(budgetBust.warnings.some((w) => w.includes("reference budget exceeded"))).toBe(true);
  });

  it("google omni history aliases back to the shared model with google selected", () => {
    const history: ActionLogEntry[] = [{
      hash: "abc123",
      action: "tool-generate-google-omni-video",
      payload: { book_id: "p", _provider: "google", prompt: "old", first_frame_ref: "@img-start" },
      date: "2026-07-07T00:00:00Z",
    }];

    expect(extractLastSettingsPerModel(history).get("generate_google_flow_omni_flash_video")).toMatchObject({
      _provider: "google",
      first_frame_ref: "@img-start",
    });
    expect(extractLastUsedModel(history)).toBe("gemini_omni");

    const option = buildModelOption("gemini_omni", VIDEO_MODELS.gemini_omni, {}, [], history);
    expect(option.selected_provider).toBe("google");
    expect(option.tool_name).toBe("generate_google_flow_omni_flash_video");
    expect(option.prefilled_values.first_frame_ref).toBe("@img-start");
  });

  it("gemini_omni keeps the kie tool when kie is selected", () => {
    const option = buildModelOption("gemini_omni", VIDEO_MODELS.gemini_omni, { prompt: "x" }, [], undefined, "kie");
    expect(option.tool_name).toBe("generate_kie_gemini_omni_video");
  });

  it("surfaces the PROMINENT_PEOPLE advisory when omni+google carries character_refs", () => {
    const history: ActionLogEntry[] = [{
      hash: "abc456",
      action: "tool-generate-google-omni-video",
      payload: { book_id: "p", _provider: "google", prompt: "cast", character_refs: ["character:abc"] },
      date: "2026-07-08T00:00:00Z",
    }];
    const option = buildModelOption("gemini_omni", VIDEO_MODELS.gemini_omni, {}, [], history, "google");
    expect(option.tool_name).toBe("generate_google_flow_omni_flash_video");
    expect(option.validation.warnings.some((w) => w.includes("PROMINENT_PEOPLE safety filter"))).toBe(true);
  });
});
