import { describe, it, expect } from "vitest";
import {
  extractLastSettingsPerModel,
  extractLastUsedModel,
  buildModelOption,
  VIDEO_MODELS,
  getVideoToolSchema,
  validateVideoParams,
  applyVideoToolConstraints,
  buildVideoRoutingPrompt,
  IMAGE_SLOT_LIMITS,
  PARAM_SCHEMAS,
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

  it("extracts settings from a single kling30 log entry, stripping project_slug", () => {
    const log: ActionLogEntry[] = [
      {
        hash: "abc123",
        action: "tool-generate-kling30-video",
        payload: { project_slug: "my-proj", prompt: "sunset", mode: "pro", duration: "10" },
        date: "2026-03-08T00:00:00Z",
      },
    ];
    const result = extractLastSettingsPerModel(log);
    expect(result.get("generate_kling30_video")).toEqual({
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
    expect(result.get("generate_kling30_video")).toEqual({
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
        action: "tool-generate-seedance2-t2v-video",
        payload: { prompt: "seedance prompt", resolution: "720p" },
        date: "2026-03-08T00:00:00Z",
      },
    ];
    const result = extractLastSettingsPerModel(log);
    expect(result.size).toBe(2);
    expect(result.get("generate_kling30_video")).toEqual({ prompt: "kling prompt", duration: "8" });
    expect(result.get("generate_seedance2_t2v_video")).toEqual({ prompt: "seedance prompt", resolution: "720p" });
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
        payload: { project_slug: "default" },
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

  it("handles all 7 video model action names correctly", () => {
    const actionNames = [
      "tool-generate-kling30-video",
      "tool-generate-veo-video",
      "tool-extend-veo-video",
      "tool-generate-seedance2-t2v-video",
      "tool-generate-seedance2-frames-video",
      "tool-generate-seedance2-reference-video",
      "tool-generate-grok-imagine-video",
    ];
    const log: ActionLogEntry[] = actionNames.map((action, i) => ({
      hash: `h${i}`,
      action,
      payload: { prompt: `prompt-${i}` },
      date: "2026-03-08T00:00:00Z",
    }));
    const result = extractLastSettingsPerModel(log);
    expect(result.size).toBe(7);
    expect(result.has("generate_kling30_video")).toBe(true);
    expect(result.has("generate_veo_video")).toBe(true);
    expect(result.has("extend_veo_video")).toBe(true);
    expect(result.has("generate_seedance2_t2v_video")).toBe(true);
    expect(result.has("generate_seedance2_frames_video")).toBe(true);
    expect(result.has("generate_seedance2_reference_video")).toBe(true);
    expect(result.has("generate_grok_imagine_video")).toBe(true);
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
        payload: { project_slug: "test" },
        date: "2026-03-08T02:00:00Z",
      },
      {
        hash: "h2",
        action: "tool-generate-seedance2-t2v-video",
        payload: { prompt: "test" },
        date: "2026-03-08T01:00:00Z",
      },
    ];
    expect(extractLastUsedModel(log)).toBe("seedance2_t2v");
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
        action: "tool-generate-veo-video",
        payload: { prompt: "test" },
        date: "2026-03-08T01:00:00Z",
      },
    ];
    expect(extractLastUsedModel(log)).toBe("veo31");
  });
});

// ---------------------------------------------------------------------------
// buildModelOption — history integration
// ---------------------------------------------------------------------------

describe("buildModelOption history integration", () => {
  const kling = VIDEO_MODELS.kling30;
  const seedance = VIDEO_MODELS.seedance2_t2v;

  it("history params fill in as defaults when router params are empty", () => {
    const history: ActionLogEntry[] = [
      {
        hash: "h1",
        action: "tool-generate-kling30-video",
        payload: { prompt: "old prompt", mode: "pro", duration: "12" },
        date: "2026-03-08T00:00:00Z",
      },
    ];
    const option = buildModelOption("kling30", kling, {}, [], history);
    expect(option.prefilled_values.prompt).toBe("old prompt");
    expect(option.prefilled_values.mode).toBe("pro");
    expect(option.prefilled_values.duration).toBe("12");
  });

  it("router params take precedence over history params", () => {
    const history: ActionLogEntry[] = [
      {
        hash: "h1",
        action: "tool-generate-kling30-video",
        payload: { prompt: "old prompt", mode: "pro", duration: "12" },
        date: "2026-03-08T00:00:00Z",
      },
    ];
    const routerParams = { mode: "std", duration: "5" };
    const option = buildModelOption("kling30", kling, routerParams, [], history);
    // History overrides router params (last-used settings persist)
    expect(option.prefilled_values.mode).toBe("pro");
    expect(option.prefilled_values.duration).toBe("12");
    // History fills in where router didn't specify
    expect(option.prefilled_values.prompt).toBe("old prompt");
  });

  it("history for model X does not leak into model Y", () => {
    const history: ActionLogEntry[] = [
      {
        hash: "h1",
        action: "tool-generate-kling30-video",
        payload: { prompt: "kling prompt", mode: "pro" },
        date: "2026-03-08T00:00:00Z",
      },
    ];
    const option = buildModelOption("seedance2_t2v", seedance, {}, [], history);
    // Should not have kling's prompt or mode
    expect(option.prefilled_values.prompt).toBeUndefined();
    // mode is not in seedance2_t2v's params at all, so it shouldn't appear
    expect(option.prefilled_values).not.toHaveProperty("mode");
  });

  it("history params filtered by model's allowedParams", () => {
    const history: ActionLogEntry[] = [
      {
        hash: "h1",
        action: "tool-generate-seedance2-t2v-video",
        payload: { prompt: "test", resolution: "720p", sound: true },
        date: "2026-03-08T00:00:00Z",
      },
    ];
    const option = buildModelOption("seedance2_t2v", seedance, {}, [], history);
    expect(option.prefilled_values.prompt).toBe("test");
    expect(option.prefilled_values.resolution).toBe("720p");
    // sound is not in seedance2_t2v's allowed params
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

  it("kling30: prompt required, correct mode/duration/aspect_ratio enums", () => {
    const schema = getVideoToolSchema("generate_kling30_video");
    expect(schema).not.toBeNull();
    expect(schema!.required).toContain("prompt");
    expect(schema!.properties.mode.enum).toEqual(["std", "pro"]);
    expect(schema!.properties.duration.enum).toHaveLength(13); // "3" through "15"
    expect(schema!.properties.aspect_ratio.enum).toEqual(["16:9", "9:16", "1:1"]);
    expect(schema!.properties.sound).toBeDefined();
  });

  it("veo: prompt required, model enum, aspect_ratio enum", () => {
    const schema = getVideoToolSchema("generate_veo_video");
    expect(schema).not.toBeNull();
    expect(schema!.required).toContain("prompt");
    expect(schema!.properties.model.enum).toEqual(["veo3_fast", "veo3"]);
    expect(schema!.properties.aspect_ratio.enum).toEqual(["16:9", "9:16", "Auto"]);
    expect(schema!.properties.generation_type.enum).toEqual([
      "TEXT_2_VIDEO",
      "FIRST_AND_LAST_FRAMES_2_VIDEO",
      "REFERENCE_2_VIDEO",
    ]);
  });

  it("extend_veo: video_slug required, prompt not required for grok_imagine", () => {
    const schema = getVideoToolSchema("extend_veo_video");
    expect(schema).not.toBeNull();
    expect(schema!.required).toContain("video_slug");
    expect(schema!.properties.model.enum).toEqual(["fast", "quality"]);
    expect(schema!.properties.model.default).toBe("fast");
  });

  it("seedance2 t2v: aspect_ratio and duration required, correct enums", () => {
    const schema = getVideoToolSchema("generate_seedance2_t2v_video");
    expect(schema).not.toBeNull();
    expect(schema!.required).toContain("prompt");
    expect(schema!.required).toContain("aspect_ratio");
    expect(schema!.required).toContain("duration");
    expect(schema!.properties.aspect_ratio.enum).toEqual(["1:1", "4:3", "3:4", "16:9", "9:16", "21:9", "adaptive"]);
    expect(schema!.properties.resolution.enum).toEqual(["480p", "720p"]);
    expect(schema!.properties.duration.enum).toEqual(["4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15"]);
    expect(schema!.properties.prompt.minLength).toBe(3);
    expect(schema!.properties.prompt.maxLength).toBe(2500);
  });

  it("seedance2 frames: exposes first_frame_slug and last_frame_slug", () => {
    const schema = getVideoToolSchema("generate_seedance2_frames_video");
    expect(schema).not.toBeNull();
    expect(schema!.properties.first_frame_slug).toBeDefined();
    expect(schema!.properties.last_frame_slug).toBeDefined();
    expect(schema!.properties.aspect_ratio.enum).toContain("adaptive");
    expect(schema!.properties.resolution.enum).toEqual(["480p", "720p"]);
  });

  it("seedance2 reference: exposes image/video/audio slugs", () => {
    const schema = getVideoToolSchema("generate_seedance2_reference_video");
    expect(schema).not.toBeNull();
    expect(schema!.properties.image_slugs).toBeDefined();
    expect(schema!.properties.video_slugs).toBeDefined();
    expect(schema!.properties.audio_slugs).toBeDefined();
    expect(schema!.properties.video_slugs.type).toBe("array");
    expect(schema!.properties.audio_slugs.type).toBe("array");
  });

  it("grok_imagine: image_slugs required, prompt not required", () => {
    const schema = getVideoToolSchema("generate_grok_imagine_video");
    expect(schema).not.toBeNull();
    expect(schema!.required).toContain("image_slugs");
    expect(schema!.required).not.toContain("prompt");
    expect(schema!.properties.mode.enum).toEqual(["fun", "normal", "spicy"]);
    expect(schema!.properties.duration.type).toBe("integer");
    expect(schema!.properties.duration.enum).toBeUndefined();
    expect(schema!.properties.duration.minimum).toBe(6);
    expect(schema!.properties.duration.maximum).toBe(30);
    expect(schema!.properties.resolution.enum).toEqual(["480p", "720p"]);
    expect(schema!.properties.nsfw_checker).toBeDefined();
    expect(schema!.properties.nsfw_checker.type).toBe("boolean");
  });

  it("includes defaults from model definition", () => {
    const schema = getVideoToolSchema("generate_kling30_video");
    expect(schema!.defaults).toEqual(VIDEO_MODELS.kling30.defaults);
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

  it("valid kling30 params pass", () => {
    const result = validateVideoParams("generate_kling30_video", {
      prompt: "a sunset",
      mode: "std",
      duration: "8",
      aspect_ratio: "16:9",
    });
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it("kling30: missing prompt is flagged", () => {
    const result = validateVideoParams("generate_kling30_video", {
      mode: "std",
    });
    expect(result.valid).toBe(false);
    expect(result.missing_required).toContain("prompt");
  });

  it("kling30: warns on invalid enum value", () => {
    const result = validateVideoParams("generate_kling30_video", {
      prompt: "test",
      mode: "ultra",
    });
    expect(result.warnings.some((w) => w.includes("mode") && w.includes("ultra"))).toBe(true);
  });

  it("kling30: warns when too many images", () => {
    const result = validateVideoParams("generate_kling30_video", {
      prompt: "test",
      image_slugs: ["@img-a", "@img-b", "@img-c"],
    });
    expect(result.warnings.some((w) => w.includes("only supports 0-2 images"))).toBe(true);
  });

  it("kling30: warns when multi-shot with >1 image", () => {
    const result = validateVideoParams("generate_kling30_video", {
      prompt: "test",
      image_slugs: ["@img-a", "@img-b"],
      multi_prompt: [{ prompt: "s1", duration: 5 }],
    });
    expect(result.warnings.some((w) => w.includes("multi-shot mode allows max 1"))).toBe(true);
  });

  it("veo: REFERENCE_2_VIDEO warns about model restriction", () => {
    const result = validateVideoParams("generate_veo_video", {
      prompt: "test",
      generation_type: "REFERENCE_2_VIDEO",
      model: "veo3",
    });
    expect(result.warnings.some((w) => w.includes("REFERENCE_2_VIDEO") && w.includes("veo3_fast"))).toBe(true);
  });

  it("veo: REFERENCE_2_VIDEO warns about aspect_ratio restriction", () => {
    const result = validateVideoParams("generate_veo_video", {
      prompt: "test",
      generation_type: "REFERENCE_2_VIDEO",
      aspect_ratio: "Auto",
    });
    expect(result.warnings.some((w) => w.includes("16:9 or 9:16"))).toBe(true);
  });

  it("veo: auto-infers generation_type from image count", () => {
    // 0 images => TEXT_2_VIDEO (no warnings about model)
    const result = validateVideoParams("generate_veo_video", {
      prompt: "test",
      model: "veo3",
    });
    expect(result.warnings.some((w) => w.includes("REFERENCE_2_VIDEO"))).toBe(false);
  });

  it("grok_imagine: warns when no images", () => {
    const result = validateVideoParams("generate_grok_imagine_video", {
      image_slugs: [],
    });
    expect(result.warnings.some((w) => w.includes("requires at least one reference image"))).toBe(true);
  });

  it("grok_imagine: warns when >1 image", () => {
    const result = validateVideoParams("generate_grok_imagine_video", {
      image_slugs: ["@img-a", "@img-b"],
    });
    expect(result.warnings.some((w) => w.includes("only supports 1 reference image"))).toBe(true);
  });

  it("seedance2 frames: warns when neither frame slug is set", () => {
    const result = validateVideoParams("generate_seedance2_frames_video", {
      prompt: "test",
      aspect_ratio: "16:9",
      duration: "8",
    });
    expect(result.warnings.some((w) => w.includes("first_frame_slug or last_frame_slug"))).toBe(true);
  });

  it("seedance2 reference: warns when no references and when limits exceeded", () => {
    const noRefs = validateVideoParams("generate_seedance2_reference_video", {
      prompt: "test",
      aspect_ratio: "16:9",
      duration: "8",
    });
    expect(noRefs.warnings.some((w) => w.includes("requires at least one reference"))).toBe(true);

    const tooManyVideos = validateVideoParams("generate_seedance2_reference_video", {
      prompt: "test",
      aspect_ratio: "16:9",
      duration: "8",
      image_slugs: ["@img-a"],
      video_slugs: ["@vid-a", "@vid-b", "@vid-c", "@vid-d"],
    });
    expect(tooManyVideos.warnings.some((w) => w.includes("supports 0-3 videos"))).toBe(true);

    const tooManyImages = validateVideoParams("generate_seedance2_reference_video", {
      prompt: "test",
      aspect_ratio: "16:9",
      duration: "8",
      image_slugs: Array.from({ length: 10 }, (_, i) => `@img-${i}`),
    });
    expect(tooManyImages.warnings.some((w) => w.includes("supports 1-9 images"))).toBe(true);
  });

  it("returns correct image_slots per tool", () => {
    const klingResult = validateVideoParams("generate_kling30_video", { prompt: "test" });
    expect(klingResult.image_slots).toEqual({ min: 0, max: 2 });

    const grokResult = validateVideoParams("generate_grok_imagine_video", { image_slugs: ["@img-a"] });
    expect(grokResult.image_slots).toEqual({ min: 1, max: 1 });
  });

  it("veo: image_slots depend on generation_type", () => {
    const textResult = validateVideoParams("generate_veo_video", {
      prompt: "test",
      generation_type: "TEXT_2_VIDEO",
    });
    expect(textResult.image_slots).toEqual({ min: 0, max: 0 });

    const refResult = validateVideoParams("generate_veo_video", {
      prompt: "test",
      generation_type: "REFERENCE_2_VIDEO",
    });
    expect(refResult.image_slots).toEqual({ min: 1, max: 3 });
  });

  it("multi_prompt_slots: 5 for kling30, null for others", () => {
    const klingResult = validateVideoParams("generate_kling30_video", { prompt: "test" });
    expect(klingResult.multi_prompt_slots).toBe(5);

    const veoResult = validateVideoParams("generate_veo_video", { prompt: "test" });
    expect(veoResult.multi_prompt_slots).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// applyVideoToolConstraints
// ---------------------------------------------------------------------------

describe("applyVideoToolConstraints", () => {
  it("constrains veo REFERENCE_2_VIDEO model to veo3_fast", () => {
    const schema = getVideoToolSchema("generate_veo_video")!;
    const params: Record<string, unknown> = {
      prompt: "test",
      generation_type: "REFERENCE_2_VIDEO",
      model: "veo3",
      aspect_ratio: "16:9",
    };
    applyVideoToolConstraints("generate_veo_video", schema, params);
    expect(params.model).toBe("veo3_fast");
    expect(schema.properties.model.enum).toEqual(["veo3_fast"]);
  });

  it("constrains veo REFERENCE_2_VIDEO aspect_ratio to 16:9 or 9:16", () => {
    const schema = getVideoToolSchema("generate_veo_video")!;
    const params: Record<string, unknown> = {
      prompt: "test",
      generation_type: "REFERENCE_2_VIDEO",
      model: "veo3",
      aspect_ratio: "Auto",
    };
    applyVideoToolConstraints("generate_veo_video", schema, params);
    expect(params.aspect_ratio).toBe("16:9");
    expect(schema.properties.aspect_ratio.enum).toEqual(["16:9", "9:16"]);
  });

  it("preserves valid aspect_ratio for REFERENCE_2_VIDEO", () => {
    const schema = getVideoToolSchema("generate_veo_video")!;
    const params: Record<string, unknown> = {
      prompt: "test",
      generation_type: "REFERENCE_2_VIDEO",
      model: "veo3",
      aspect_ratio: "9:16",
    };
    applyVideoToolConstraints("generate_veo_video", schema, params);
    expect(params.aspect_ratio).toBe("9:16");
  });

  it("auto-infers REFERENCE_2_VIDEO from 1 image", () => {
    const schema = getVideoToolSchema("generate_veo_video")!;
    const params: Record<string, unknown> = {
      prompt: "test",
      image_slugs: ["@img-a"],
      model: "veo3",
      aspect_ratio: "Auto",
    };
    applyVideoToolConstraints("generate_veo_video", schema, params);
    // With 1 image, effective gen type is REFERENCE_2_VIDEO
    expect(params.model).toBe("veo3_fast");
    expect(params.aspect_ratio).toBe("16:9");
  });

  it("does nothing for TEXT_2_VIDEO", () => {
    const schema = getVideoToolSchema("generate_veo_video")!;
    const params: Record<string, unknown> = {
      prompt: "test",
      generation_type: "TEXT_2_VIDEO",
      model: "veo3",
      aspect_ratio: "Auto",
    };
    applyVideoToolConstraints("generate_veo_video", schema, params);
    // No constraints applied
    expect(params.model).toBe("veo3");
    expect(params.aspect_ratio).toBe("Auto");
  });

  it("does nothing for non-veo tools", () => {
    const schema = getVideoToolSchema("generate_kling30_video")!;
    const params: Record<string, unknown> = {
      prompt: "test",
      mode: "std",
    };
    applyVideoToolConstraints("generate_kling30_video", schema, params);
    expect(params.mode).toBe("std");
  });
});

// ---------------------------------------------------------------------------
// buildVideoRoutingPrompt
// ---------------------------------------------------------------------------

describe("buildVideoRoutingPrompt", () => {
  it("returns a non-empty string", () => {
    const prompt = buildVideoRoutingPrompt();
    expect(prompt.length).toBeGreaterThan(0);
  });

  it("mentions all video tool names", () => {
    const prompt = buildVideoRoutingPrompt();
    expect(prompt).toContain("generate_kling30_video");
    expect(prompt).toContain("generate_veo_video");
    expect(prompt).toContain("extend_veo_video");
    expect(prompt).toContain("generate_seedance2_t2v_video");
    expect(prompt).toContain("generate_seedance2_frames_video");
    expect(prompt).toContain("generate_seedance2_reference_video");
    expect(prompt).toContain("generate_grok_imagine_video");
  });

  it("includes routing preferences", () => {
    const prompt = buildVideoRoutingPrompt();
    expect(prompt).toContain("ROUTING PREFERENCES");
    expect(prompt).toContain("PREFER generate_kling30_video");
  });

  it("includes JSON response format instruction", () => {
    const prompt = buildVideoRoutingPrompt();
    expect(prompt).toContain("JSON only");
  });
});

// ---------------------------------------------------------------------------
// IMAGE_SLOT_LIMITS & PARAM_SCHEMAS exports
// ---------------------------------------------------------------------------

describe("IMAGE_SLOT_LIMITS", () => {
  it("has entries for all video tools", () => {
    expect(IMAGE_SLOT_LIMITS).toHaveProperty("generate_kling30_video");
    expect(IMAGE_SLOT_LIMITS).toHaveProperty("generate_veo_video");
    expect(IMAGE_SLOT_LIMITS).toHaveProperty("extend_veo_video");
    expect(IMAGE_SLOT_LIMITS).toHaveProperty("generate_seedance2_t2v_video");
    expect(IMAGE_SLOT_LIMITS).toHaveProperty("generate_seedance2_frames_video");
    expect(IMAGE_SLOT_LIMITS).toHaveProperty("generate_seedance2_reference_video");
    expect(IMAGE_SLOT_LIMITS).toHaveProperty("generate_grok_imagine_video");
  });

  it("extend_veo_video has 0/0 slots (no images)", () => {
    expect(IMAGE_SLOT_LIMITS.extend_veo_video).toEqual({ min: 0, max: 0 });
  });

  it("grok_imagine requires exactly 1 image", () => {
    expect(IMAGE_SLOT_LIMITS.generate_grok_imagine_video).toEqual({ min: 1, max: 1 });
  });

  it("seedance2 reference supports up to 9 images", () => {
    expect(IMAGE_SLOT_LIMITS.generate_seedance2_reference_video).toEqual({ min: 0, max: 9 });
  });
});

describe("PARAM_SCHEMAS", () => {
  it("prompt param has type string", () => {
    expect(PARAM_SCHEMAS.prompt.type).toBe("string");
  });

  it("image_slugs param has type array", () => {
    expect(PARAM_SCHEMAS.image_slugs.type).toBe("array");
  });

  it("seeds param has integer type with min/max", () => {
    expect(PARAM_SCHEMAS.seeds.type).toBe("integer");
    expect(PARAM_SCHEMAS.seeds.minimum).toBe(10000);
    expect(PARAM_SCHEMAS.seeds.maximum).toBe(99999);
  });
});

// ---------------------------------------------------------------------------
// buildModelOption — resolved assets & coercion
// ---------------------------------------------------------------------------

describe("buildModelOption resolved assets and coercion", () => {
  it("fills image_slugs from resolved image assets", () => {
    const resolvedAssets = [
      { tag: "@img-sunset", asset_id: "img-sunset", asset_type: "image", file_path: "/some/path.png", asset_dir: "/some" },
    ];
    const option = buildModelOption("kling30", VIDEO_MODELS.kling30, {}, resolvedAssets);
    expect(option.prefilled_values.image_slugs).toEqual(["@img-sunset"]);
  });

  it("skips image assets without file_path", () => {
    const resolvedAssets = [
      { tag: "@img-sunset", asset_id: "img-sunset", asset_type: "image", file_path: null, asset_dir: "/some" },
    ];
    const option = buildModelOption("kling30", VIDEO_MODELS.kling30, {}, resolvedAssets);
    expect(option.prefilled_values.image_slugs).toEqual([]);
  });

  it("extend_veo prefills video_slug from video assets", () => {
    const resolvedAssets = [
      { tag: "@vid-clip", asset_id: "vid-clip", asset_type: "video", file_path: "/path/clip.mp4", asset_dir: "/path" },
    ];
    const option = buildModelOption("veo31_extend", VIDEO_MODELS.veo31_extend, {}, resolvedAssets);
    expect(option.prefilled_values.video_slug).toBe("@vid-clip");
  });

  it("coerces numeric duration to string for kling30", () => {
    const option = buildModelOption("kling30", VIDEO_MODELS.kling30, { duration: 8 }, []);
    expect(option.prefilled_values.duration).toBe("8");
  });

  it("initializes kling30 element defaults", () => {
    const option = buildModelOption("kling30", VIDEO_MODELS.kling30, {}, []);
    expect(option.prefilled_values.element1_slugs).toEqual([]);
    expect(option.prefilled_values.element1_name).toBe("");
    expect(option.prefilled_values.element1_desc).toBe("");
    expect(option.prefilled_values.multi_prompt).toEqual([]);
    expect(option.prefilled_values.multi_shots).toBe(false);
  });

  it("returns valid ModelOption structure", () => {
    const option = buildModelOption("kling30", VIDEO_MODELS.kling30, { prompt: "test" }, []);
    expect(option.key).toBe("kling30");
    expect(option.label).toBe("Kling 3.0");
    expect(option.tool_name).toBe("generate_kling30_video");
    expect(option.schema).not.toBeNull();
    expect(option.validation).toBeDefined();
    expect(typeof option.validation.valid).toBe("boolean");
  });
});
