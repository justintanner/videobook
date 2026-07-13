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
        action: "tool-generate-seedance2-video",
        payload: { prompt: "seedance prompt", resolution: "720p" },
        date: "2026-03-08T00:00:00Z",
      },
    ];
    const result = extractLastSettingsPerModel(log);
    expect(result.size).toBe(2);
    expect(result.get("generate_kling30_video")).toEqual({ prompt: "kling prompt", duration: "8" });
    expect(result.get("generate_seedance2_video")).toEqual({ prompt: "seedance prompt", resolution: "720p" });
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
    expect(result.has("generate_kling30_video")).toBe(true);
    expect(result.has("generate_seedance2_video")).toBe(true);
    expect(result.has("generate_seedance2_fast_video")).toBe(true);
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
        action: "tool-generate-seedance2-video",
        payload: { prompt: "test" },
        date: "2026-03-08T01:00:00Z",
      },
    ];
    expect(extractLastUsedModel(log)).toBe("seedance2");
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
  const seedance = VIDEO_MODELS.seedance2;

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
    const option = buildModelOption("seedance2", seedance, {}, [], history);
    // Should not have kling's prompt or mode
    expect(option.prefilled_values.prompt).toBeUndefined();
    // mode is not in seedance2's params at all, so it shouldn't appear
    expect(option.prefilled_values).not.toHaveProperty("mode");
  });

  it("history params filtered by model's allowedParams", () => {
    const history: ActionLogEntry[] = [
      {
        hash: "h1",
        action: "tool-generate-seedance2-video",
        payload: { prompt: "test", resolution: "720p", sound: true },
        date: "2026-03-08T00:00:00Z",
      },
    ];
    const option = buildModelOption("seedance2", seedance, {}, [], history);
    expect(option.prefilled_values.prompt).toBe("test");
    expect(option.prefilled_values.resolution).toBe("720p");
    // sound is not in seedance2's allowed params
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
    expect(schema!.properties.mode.enum).toEqual(["std", "pro", "4K"]);
    expect(schema!.properties.duration.enum).toHaveLength(13); // "3" through "15"
    expect(schema!.properties.aspect_ratio.enum).toEqual(["16:9", "9:16", "1:1"]);
    expect(schema!.properties.sound).toBeDefined();
  });

  it("seedance2 (full): duration default comes from Apicity, full resolution range, all input slots exposed", () => {
    const schema = getVideoToolSchema("generate_seedance2_video");
    expect(schema).not.toBeNull();
    expect(schema!.required).toContain("prompt");
    expect(schema!.required).not.toContain("aspect_ratio");
    expect(schema!.required).not.toContain("duration");
    expect(schema!.required).not.toContain("first_frame_slug");
    expect(schema!.required).not.toContain("last_frame_slug");
    expect(schema!.required).not.toContain("image_slugs");
    expect(schema!.properties.aspect_ratio.enum).toEqual(["1:1", "4:3", "3:4", "16:9", "9:16", "21:9", "adaptive"]);
    expect(schema!.properties.resolution.enum).toEqual(["480p", "720p", "1080p"]);
    expect(schema!.properties.duration.enum).toEqual(["4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15"]);
    expect(schema!.properties.first_frame_slug).toBeDefined();
    expect(schema!.properties.last_frame_slug).toBeDefined();
    expect(schema!.properties.image_slugs).toBeDefined();
    expect(schema!.properties.video_slugs).toBeDefined();
    expect(schema!.properties.audio_slugs).toBeDefined();
    expect(schema!.properties.nsfw_checker).toBeDefined();
    expect(schema!.defaults.duration).toBe("5");
    expect(schema!.defaults.nsfw_checker).toBe(false);
    expect(schema!.properties.model).toBeUndefined();
    expect(schema!.properties.prompt.minLength).toBe(3);
    expect(schema!.properties.prompt.maxLength).toBe(20000);
  });

  it("seedance2 fast: same input shape but resolution capped at 720p", () => {
    const schema = getVideoToolSchema("generate_seedance2_fast_video");
    expect(schema).not.toBeNull();
    expect(schema!.properties.resolution.enum).toEqual(["480p", "720p"]);
    expect(schema!.properties.first_frame_slug).toBeDefined();
    expect(schema!.properties.image_slugs).toBeDefined();
    expect(schema!.properties.model).toBeUndefined();
  });

  it("grok_imagine: uses Kie Grok Imagine Video 1.5 defaults", () => {
    const schema = getVideoToolSchema("generate_grok_imagine_video");
    expect(schema).not.toBeNull();
    expect(schema!.required).toContain("image_slugs");
    expect(schema!.required).not.toContain("prompt");
    expect(schema!.properties.mode.enum).toEqual(["fun", "normal"]);
    expect(schema!.properties.duration.type).toBe("integer");
    expect(schema!.properties.duration.minimum).toBe(6);
    expect(schema!.properties.duration.maximum).toBe(30);
    expect(schema!.properties.resolution.enum).toEqual(["480p", "720p"]);
    expect(schema!.properties.aspect_ratio.enum).toEqual(["2:3", "3:2", "1:1", "16:9", "9:16"]);
    expect(schema!.properties.image_slugs.minItems).toBe(1);
    expect(schema!.properties.image_slugs.maxItems).toBe(7);
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

  it("does not invent Kling 3.0 defaults when Apicity has none", () => {
    const schema = getVideoToolSchema("generate_kling30_video");
    expect(schema!.defaults).toEqual({});
    expect(schema!.required).toEqual(expect.arrayContaining(["prompt", "mode", "duration", "sound", "multi_shots"]));
  });

  it("gemini_omni: prompt+duration required, Apicity-derived enums and resolution default", () => {
    const schema = getVideoToolSchema("generate_gemini_omni_video");
    expect(schema).not.toBeNull();
    expect(schema!.required).toEqual(expect.arrayContaining(["prompt", "duration"]));
    expect(schema!.required).not.toContain("video_slug");
    expect(schema!.required).not.toContain("image_slugs");
    expect(schema!.properties.duration.enum).toEqual(["4", "6", "8", "10"]);
    expect(schema!.properties.aspect_ratio.enum).toEqual(["16:9", "9:16"]);
    expect(schema!.properties.resolution.enum).toEqual(["720p", "1080p", "4k"]);
    expect(schema!.properties.seed.type).toBe("integer");
    expect(schema!.properties.image_slugs.maxItems).toBe(7);
    expect(schema!.defaults).toEqual({ resolution: "720p" });
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
      sound: true,
      multi_shots: false,
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

  it("kling30: warns when multi-shot with >1 image", () => {
    const result = validateVideoParams("generate_kling30_video", {
      prompt: "test",
      image_slugs: ["@img-a", "@img-b"],
      multi_prompt: [{ prompt: "s1", duration: 5 }],
    });
    expect(result.warnings.some((w) => w.includes("multi-shot mode allows max 1"))).toBe(true);
  });

  it("seedance2 (full): text-only with aspect_ratio + duration is valid", () => {
    const result = validateVideoParams("generate_seedance2_video", {
      prompt: "test",
      aspect_ratio: "16:9",
      duration: "8",
    });
    expect(result.valid).toBe(true);
    expect(result.missing_required).toEqual([]);
  });

  it("seedance2 fast: 1080p resolution produces warning", () => {
    const result = validateVideoParams("generate_seedance2_fast_video", {
      prompt: "test",
      aspect_ratio: "16:9",
      duration: "8",
      resolution: "1080p",
    });
    expect(result.warnings.some((w) => w.includes("Fast caps at 720p"))).toBe(true);
  });

  it("seedance2 (full): 1080p resolution is accepted without warning", () => {
    const result = validateVideoParams("generate_seedance2_video", {
      prompt: "test",
      first_frame_slug: "@img-a",
      aspect_ratio: "16:9",
      duration: "8",
      resolution: "1080p",
    });
    expect(result.warnings.some((w) => w.includes("1080p"))).toBe(false);
  });

  it("derives image_slots from Apicity Zod", () => {
    const klingResult = validateVideoParams("generate_kling30_video", { prompt: "test" });
    expect(klingResult.image_slots).toEqual({ min: 0, max: null });

    const grokResult = validateVideoParams("generate_grok_imagine_video", { image_slugs: ["@img-a"] });
    expect(grokResult.image_slots).toEqual({ min: 1, max: 7 });
    const tooManyGrokImages = validateVideoParams("generate_grok_imagine_video", { image_slugs: ["@img-a", "@img-b", "@img-c", "@img-d", "@img-e", "@img-f", "@img-g", "@img-h"] });
    expect(tooManyGrokImages.warnings).toContain("Grok Imagine 1.5 supports up to 7 reference images (got 8)");
  });

  it("tools without image-array fields return null image_slots", () => {
    const extendResult = validateVideoParams("extend_wan27_video", {
      prompt: "test",
      video_slug: "@vid-a",
    });
    expect(extendResult.image_slots).toBeNull();
  });

  it("multi_prompt_slots: 5 for kling30, null for others", () => {
    const klingResult = validateVideoParams("generate_kling30_video", { prompt: "test" });
    expect(klingResult.multi_prompt_slots).toBe(5);

    const grokResult = validateVideoParams("generate_grok_imagine_video", { prompt: "test" });
    expect(grokResult.multi_prompt_slots).toBeNull();
  });

  it("gemini_omni: valid prompt + duration with no references passes", () => {
    const result = validateVideoParams("generate_gemini_omni_video", { prompt: "a sunset", duration: "6" });
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it("gemini_omni: missing prompt/duration is flagged", () => {
    const result = validateVideoParams("generate_gemini_omni_video", {});
    expect(result.valid).toBe(false);
    expect(result.missing_required).toEqual(expect.arrayContaining(["prompt", "duration"]));
  });

  it("gemini_omni: warns when a reference clip has bad timing", () => {
    const result = validateVideoParams("generate_gemini_omni_video", {
      prompt: "a sunset", duration: "6", video_slug: "@vid-motion", video_clip_start: 2, video_clip_ends: 2,
    });
    expect(result.warnings.some((w) => w.includes("video_clip_ends"))).toBe(true);
  });

  it("gemini_omni: warns when clip timecodes are set without a video_slug", () => {
    const result = validateVideoParams("generate_gemini_omni_video", {
      prompt: "a sunset", duration: "6", video_clip_start: 1, video_clip_ends: 5,
    });
    expect(result.warnings.some((w) => w.includes("require a video_slug"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// applyVideoToolConstraints
// ---------------------------------------------------------------------------

describe("applyVideoToolConstraints", () => {
  it("is a no-op for tools without cross-field rewriting", () => {
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
  it("defaults video generation to Google Flow Gemini Omni Video", () => {
    expect(DEFAULT_VIDEO_MODEL_KEY).toBe("gemini_omni");
    expect(VIDEO_MODELS[DEFAULT_VIDEO_MODEL_KEY].tool_name).toBe("generate_gemini_omni_video");
  });

  it("returns a non-empty string", () => {
    const prompt = buildVideoRoutingPrompt();
    expect(prompt.length).toBeGreaterThan(0);
  });

  it("mentions all video tool names", () => {
    const prompt = buildVideoRoutingPrompt();
    expect(prompt).toContain("generate_kling30_video");
    expect(prompt).toContain("generate_seedance2_video");
    expect(prompt).toContain("generate_seedance2_fast_video");
    expect(prompt).toContain("generate_grok_imagine_video");
  });

  it("includes routing preferences", () => {
    const prompt = buildVideoRoutingPrompt();
    expect(prompt).toContain("ROUTING PREFERENCES");
    expect(prompt).toContain("PREFER generate_gemini_omni_video");
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
    expect(IMAGE_FIELD_SCHEMAS).toHaveProperty("generate_kling30_video");
    expect(IMAGE_FIELD_SCHEMAS).toHaveProperty("generate_seedance2_video");
    expect(IMAGE_FIELD_SCHEMAS).toHaveProperty("generate_seedance2_fast_video");
    expect(IMAGE_FIELD_SCHEMAS).toHaveProperty("generate_grok_imagine_video");
    expect(IMAGE_FIELD_SCHEMAS).toHaveProperty("generate_wan27_r2v_video");
  });

  it("omits tools that take no image-array field (extend, text-to-video)", () => {
    expect(IMAGE_FIELD_SCHEMAS).not.toHaveProperty("extend_grok_imagine_video");
    expect(IMAGE_FIELD_SCHEMAS).not.toHaveProperty("generate_wan27_i2v_video");
  });
});

describe("PARAM_SCHEMAS", () => {
  it("prompt param has type string", () => {
    expect(PARAM_SCHEMAS.prompt.type).toBe("string");
  });

  it("image_slugs param has type array", () => {
    expect(PARAM_SCHEMAS.image_slugs.type).toBe("array");
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

  it("extend_wan27 prefills video_slug from video assets", () => {
    const resolvedAssets = [
      { tag: "@vid-clip", asset_id: "vid-clip", asset_type: "video", file_path: "/path/clip.mp4", asset_dir: "/path" },
    ];
    const option = buildModelOption("wan27_extend", VIDEO_MODELS.wan27_extend, {}, resolvedAssets);
    expect(option.prefilled_values.video_slug).toBe("@vid-clip");
  });

  it("gemini_omni prefills video_slug from a prompt-referenced video (both providers)", () => {
    const resolvedAssets = [
      { tag: "@vid-clip", asset_id: "vid-clip", asset_type: "video", file_path: "/path/clip.mp4", asset_dir: "/path" },
    ];
    const kie = buildModelOption("gemini_omni", VIDEO_MODELS.gemini_omni, {}, resolvedAssets, undefined, "kie");
    expect(kie.prefilled_values.video_slug).toBe("@vid-clip");
    const google = buildModelOption("gemini_omni", VIDEO_MODELS.gemini_omni, {}, resolvedAssets, undefined, "google");
    expect(google.prefilled_values.video_slug).toBe("@vid-clip");
  });

  it("gemini_omni leaves video_slug unset with no prompt-referenced video", () => {
    const option = buildModelOption("gemini_omni", VIDEO_MODELS.gemini_omni, {}, [], undefined, "google");
    expect(option.prefilled_values.video_slug).toBeUndefined();
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
        for (const p of mode.params) expect(props.has(p), `${toolName}/${mode.key} param ${p}`).toBe(true);
        for (const p of mode.required ?? []) {
          expect(props.has(p), `${toolName}/${mode.key} required ${p}`).toBe(true);
        }
        for (const slot of mode.asset_slots ?? []) {
          expect(props.has(slot.param), `${toolName}/${mode.key} slot ${slot.param}`).toBe(true);
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
    expect(edit.required).toEqual(["video_slug"]);
    expect(edit.param_overrides?.voice_refs?.maxItems).toBe(3);
    const imageSlot = edit.asset_slots?.find((s) => s.param === "image_slugs");
    expect(imageSlot?.max).toBe(5);

    const kie = buildModelOption("gemini_omni", VIDEO_MODELS.gemini_omni, {}, [], undefined, "kie");
    expect(kie.modes).toBeNull();
  });

  it("non-moded models carry no modes", () => {
    const kling = buildModelOption("kling30", VIDEO_MODELS.kling30, {}, []);
    expect(kling.modes).toBeNull();
  });

  it("seedance2 mini ships text + refs modes", () => {
    const option = buildModelOption("seedance2_mini", VIDEO_MODELS.seedance2_mini, {}, []);
    expect(option.modes).not.toBeNull();
    expect(option.modes!.default_mode).toBe("text");
    expect(option.modes!.modes.map((m) => m.key)).toEqual(["text", "refs"]);
    const refs = option.modes!.modes.find((m) => m.key === "refs")!;
    expect(refs.params).toEqual(["image_slugs", "video_slugs", "audio_slugs"]);
    expect(refs.asset_slots?.map((s) => s.param)).toEqual(["image_slugs", "video_slugs", "audio_slugs"]);
    expect(refs.asset_slots?.find((s) => s.param === "video_slugs")?.max).toBe(3);
    expect(refs.asset_slots?.find((s) => s.param === "audio_slugs")?.max).toBe(3);
  });

  it("seedance2 full/fast ship text + frames + refs (audio/frames exclusive)", () => {
    for (const key of ["seedance2", "seedance2_fast"] as const) {
      const option = buildModelOption(key, VIDEO_MODELS[key], {}, []);
      expect(option.modes, key).not.toBeNull();
      expect(option.modes!.modes.map((m) => m.key)).toEqual(["text", "frames", "refs"]);
      const frames = option.modes!.modes.find((m) => m.key === "frames")!;
      expect(frames.params).toEqual(["first_frame_slug", "last_frame_slug"]);
      expect(frames.asset_slots?.some((s) => s.param === "audio_slugs")).toBe(false);
      const refs = option.modes!.modes.find((m) => m.key === "refs")!;
      expect(refs.params).toContain("audio_slugs");
      expect(refs.params).not.toContain("first_frame_slug");
    }
  });

  it("coerces numeric duration to string for kling30", () => {
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

// ---------------------------------------------------------------------------
// Google Flow models (Veo 3.1 + gemini_omni google provider)
// ---------------------------------------------------------------------------

describe("google flow video models", () => {
  it("veo31 fast: hand-typed enums, duration default 8, ref slots capped at 3", () => {
    const schema = getVideoToolSchema("generate_veo31_fast_video");
    expect(schema).not.toBeNull();
    expect(schema!.required).toContain("prompt");
    expect(schema!.properties.aspect_ratio.enum).toEqual(["16:9", "9:16", "1:1", "4:3", "3:4"]);
    expect(schema!.properties.duration.enum).toEqual(["4", "6", "8"]);
    expect(schema!.defaults).toEqual({ duration: "8" });
    expect(schema!.properties.image_slugs.maxItems).toBe(3);

    const validation = validateVideoParams("generate_veo31_fast_video", { prompt: "a sunset" });
    expect(validation.image_slots).toEqual({ min: 0, max: 3 });
  });

  it("veo31 quality: no image_slugs or duration params, image_slots null", () => {
    const schema = getVideoToolSchema("generate_veo31_video");
    expect(schema).not.toBeNull();
    expect(schema!.properties.image_slugs).toBeUndefined();
    expect(schema!.properties.duration).toBeUndefined();
    expect(schema!.properties.first_frame_slug).toBeDefined();
    expect(schema!.properties.last_frame_slug).toBeDefined();

    const validation = validateVideoParams("generate_veo31_video", { prompt: "a sunset" });
    expect(validation.valid).toBe(true);
    expect(validation.image_slots).toBeNull();
  });

  it("veo31: warns on last frame without first frame and refs with start frame", () => {
    const lastOnly = validateVideoParams("generate_veo31_fast_video", { prompt: "x", last_frame_slug: "@img-end" });
    expect(lastOnly.warnings.some((w) => w.includes("requires first_frame_slug"))).toBe(true);

    const refsWithFrame = validateVideoParams("generate_veo31_fast_video", {
      prompt: "x", first_frame_slug: "@img-start", image_slugs: ["@img-a"],
    });
    expect(refsWithFrame.warnings.some((w) => w.includes("pick one mode"))).toBe(true);

    const tooManyRefs = validateVideoParams("generate_veo31_lite_video", {
      prompt: "x", image_slugs: ["@img-a", "@img-b", "@img-c", "@img-d"],
    });
    expect(tooManyRefs.warnings.some((w) => w.includes("up to 3 reference images"))).toBe(true);

    // The quality tier does not expose image_slugs, so auto-populated context
    // images must not raise a ref warning.
    const qualityRefs = validateVideoParams("generate_veo31_video", { prompt: "x", image_slugs: ["@img-a"] });
    expect(qualityRefs.warnings.some((w) => w.includes("reference images"))).toBe(false);
  });

  it("veo31 lite-low-priority: same ref slots as lite, distinct tool", () => {
    const schema = getVideoToolSchema("generate_veo31_lite_low_priority_video");
    expect(schema).toBeDefined();
    expect(schema!.properties.image_slugs).toBeDefined();
    expect(schema!.properties.image_slugs.maxItems).toBe(3);
    expect(schema!.properties.duration.enum).toEqual(["4", "6", "8"]);
    const validation = validateVideoParams("generate_veo31_lite_low_priority_video", { prompt: "a sunset" });
    expect(validation.valid).toBe(true);
    expect(VIDEO_MODELS.veo31_lite_low_priority.tool_name).toBe("generate_veo31_lite_low_priority_video");
  });

  it("veo31 models route through the google provider only", () => {
    for (const key of ["veo31", "veo31_fast", "veo31_lite", "veo31_lite_low_priority"]) {
      const info = VIDEO_MODELS[key];
      expect(info.providers).toHaveLength(1);
      expect(info.providers[0].key).toBe("google");
      expect(info.providers[0].envKey).toBe("GOOGLE_FLOW_API_KEY");
    }
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
      expect(option.tool_name).toBe("generate_google_omni_video");
      expect(option.schema!.properties.first_frame_slug).toBeDefined();
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
    const schema = getVideoToolSchema("generate_google_omni_video");
    expect(schema).not.toBeNull();
    expect(schema!.required).toContain("prompt");
    expect(schema!.required).not.toContain("duration");
    expect(schema!.properties.first_frame_slug).toBeDefined();
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
    const schema = getVideoToolSchema("generate_gemini_omni_video");
    expect(schema).not.toBeNull();
    expect(schema!.properties.voice_refs).toBeUndefined();
    expect(schema!.properties.character_refs).toBeUndefined();
  });

  it("google omni validates I2V/R2V/V2V mode constraints", () => {
    const valid = validateVideoParams("generate_google_omni_video", { prompt: "x", video_slug: "@vid-a" });
    expect(valid.valid).toBe(true);
    expect(valid.warnings).toHaveLength(0);

    const firstWithRefs = validateVideoParams("generate_google_omni_video", {
      prompt: "x", first_frame_slug: "@img-start", image_slugs: ["@img-a"],
    });
    expect(firstWithRefs.warnings.some((w) => w.includes("first_frame_slug cannot be combined with image_slugs"))).toBe(true);

    const firstWithVideo = validateVideoParams("generate_google_omni_video", {
      prompt: "x", first_frame_slug: "@img-start", video_slug: "@vid-a",
    });
    expect(firstWithVideo.warnings.some((w) => w.includes("first_frame_slug cannot be combined with video_slug"))).toBe(true);

    const tooManyV2vRefs = validateVideoParams("generate_google_omni_video", {
      prompt: "x",
      video_slug: "@vid-a",
      image_slugs: ["@img-a", "@img-b", "@img-c", "@img-d", "@img-e", "@img-f"],
    });
    expect(tooManyV2vRefs.warnings.some((w) => w.includes("up to 5 reference images"))).toBe(true);

    const badClip = validateVideoParams("generate_google_omni_video", {
      prompt: "x", video_slug: "@vid-a", video_clip_start: 2, video_clip_ends: 12,
    });
    expect(badClip.warnings.some((w) => w.includes("<= 10s"))).toBe(true);
  });

  it("google omni validates voice_refs / character_refs budgets", () => {
    const tooManyVoices = validateVideoParams("generate_google_omni_video", {
      prompt: "x", voice_refs: ["v1", "v2", "v3", "v4", "v5", "v6"],
    });
    expect(tooManyVoices.warnings.some((w) => w.includes("up to 5 voice refs"))).toBe(true);

    const voicesWithClip = validateVideoParams("generate_google_omni_video", {
      prompt: "x", video_slug: "@vid-a", voice_refs: ["v1", "v2", "v3", "v4"],
    });
    expect(voicesWithClip.warnings.some((w) => w.includes("up to 3 voice refs alongside the clip"))).toBe(true);

    const tooManyChars = validateVideoParams("generate_google_omni_video", {
      prompt: "x", character_refs: ["c1", "c2", "c3", "c4"],
    });
    expect(tooManyChars.warnings.some((w) => w.includes("up to 3 character refs"))).toBe(true);

    const firstWithChars = validateVideoParams("generate_google_omni_video", {
      prompt: "x", first_frame_slug: "@img-start", character_refs: ["c1"],
    });
    expect(firstWithChars.warnings.some((w) => w.includes("first_frame_slug cannot be combined with character_refs"))).toBe(true);

    const budgetBust = validateVideoParams("generate_google_omni_video", {
      prompt: "x", image_slugs: ["@img-a", "@img-b", "@img-c", "@img-d"], character_refs: ["c1", "c2", "c3", "c4"],
    });
    expect(budgetBust.warnings.some((w) => w.includes("reference budget exceeded"))).toBe(true);
  });

  it("google omni history aliases back to the shared model with google selected", () => {
    const history: ActionLogEntry[] = [{
      hash: "abc123",
      action: "tool-generate-google-omni-video",
      payload: { project_slug: "p", _provider: "google", prompt: "old", first_frame_slug: "@img-start" },
      date: "2026-07-07T00:00:00Z",
    }];

    expect(extractLastSettingsPerModel(history).get("generate_gemini_omni_video")).toMatchObject({
      _provider: "google",
      first_frame_slug: "@img-start",
    });
    expect(extractLastUsedModel(history)).toBe("gemini_omni");

    const option = buildModelOption("gemini_omni", VIDEO_MODELS.gemini_omni, {}, [], history);
    expect(option.selected_provider).toBe("google");
    expect(option.tool_name).toBe("generate_google_omni_video");
    expect(option.prefilled_values.first_frame_slug).toBe("@img-start");
  });

  it("gemini_omni keeps the kie tool when kie is selected", () => {
    const option = buildModelOption("gemini_omni", VIDEO_MODELS.gemini_omni, { prompt: "x" }, [], undefined, "kie");
    expect(option.tool_name).toBe("generate_gemini_omni_video");
  });

  it("surfaces the PROMINENT_PEOPLE advisory when omni+google carries character_refs", () => {
    const history: ActionLogEntry[] = [{
      hash: "abc456",
      action: "tool-generate-google-omni-video",
      payload: { project_slug: "p", _provider: "google", prompt: "cast", character_refs: ["character:abc"] },
      date: "2026-07-08T00:00:00Z",
    }];
    const option = buildModelOption("gemini_omni", VIDEO_MODELS.gemini_omni, {}, [], history, "google");
    expect(option.tool_name).toBe("generate_google_omni_video");
    expect(option.validation.warnings.some((w) => w.includes("PROMINENT_PEOPLE safety filter"))).toBe(true);
  });
});
