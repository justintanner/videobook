import { describe, it, expect } from "vitest";
import {
  extractLastImageSettingsPerModel,
  extractLastUsedImageModel,
  buildImageModelOption,
  getImageToolSchema,
  validateImageParams,
  getImageModels,
} from "./image-models.js";
import type { ActionLogEntry } from "./image-models.js";

// ---------------------------------------------------------------------------
// extractLastImageSettingsPerModel
// ---------------------------------------------------------------------------

describe("extractLastImageSettingsPerModel", () => {
  it("returns empty map for empty log", () => {
    const result = extractLastImageSettingsPerModel([]);
    expect(result.size).toBe(0);
  });

  it("extracts settings from a single nano_banana log entry, stripping project_slug", () => {
    const log: ActionLogEntry[] = [
      {
        hash: "abc123",
        action: "tool-generate-nano-banana-image",
        payload: { project_slug: "my-proj", prompt: "sunset", aspect_ratio: "16:9", resolution: "2K" },
        date: "2026-03-08T00:00:00Z",
      },
    ];
    const result = extractLastImageSettingsPerModel(log);
    expect(result.get("generate_nano_banana_image")).toEqual({
      prompt: "sunset",
      aspect_ratio: "16:9",
      resolution: "2K",
    });
  });

  it("uses first (newest) entry per model since git log is newest-first", () => {
    const log: ActionLogEntry[] = [
      {
        hash: "newer",
        action: "tool-generate-nano-banana-image",
        payload: { prompt: "newest prompt", resolution: "4K" },
        date: "2026-03-08T02:00:00Z",
      },
      {
        hash: "older",
        action: "tool-generate-nano-banana-image",
        payload: { prompt: "older prompt", resolution: "1K" },
        date: "2026-03-08T01:00:00Z",
      },
    ];
    const result = extractLastImageSettingsPerModel(log);
    expect(result.get("generate_nano_banana_image")).toEqual({
      prompt: "newest prompt",
      resolution: "4K",
    });
  });

  it("handles multiple different models independently", () => {
    const log: ActionLogEntry[] = [
      {
        hash: "a1",
        action: "tool-generate-nano-banana-image",
        payload: { prompt: "banana prompt", resolution: "2K" },
        date: "2026-03-08T00:00:00Z",
      },
      {
        hash: "a2",
        action: "tool-generate-grok-imagine-image",
        payload: { prompt: "grok prompt" },
        date: "2026-03-08T00:00:00Z",
      },
    ];
    const result = extractLastImageSettingsPerModel(log);
    expect(result.size).toBe(2);
    expect(result.get("generate_nano_banana_image")).toEqual({ prompt: "banana prompt", resolution: "2K" });
    expect(result.get("generate_grok_imagine_image")).toEqual({ prompt: "grok prompt" });
  });

  it("ignores non-image-gen actions", () => {
    const log: ActionLogEntry[] = [
      {
        hash: "s1",
        action: "tool-sleep",
        payload: { duration: 5000 },
        date: "2026-03-08T00:00:00Z",
      },
      {
        hash: "s2",
        action: "tool-generate-kling30-video",
        payload: { prompt: "video prompt" },
        date: "2026-03-08T00:00:00Z",
      },
    ];
    const result = extractLastImageSettingsPerModel(log);
    expect(result.size).toBe(0);
  });

  it("skips entries with string payloads", () => {
    const log: ActionLogEntry[] = [
      {
        hash: "s1",
        action: "tool-generate-nano-banana-image",
        payload: "some string payload",
        date: "2026-03-08T00:00:00Z",
      },
    ];
    const result = extractLastImageSettingsPerModel(log);
    expect(result.size).toBe(0);
  });

  it("handles all 3 image model action names correctly", () => {
    const actionNames = [
      "tool-generate-nano-banana-image",
      "tool-generate-grok-imagine-image",
      "tool-generate-gpt-image",
    ];
    const log: ActionLogEntry[] = actionNames.map((action, i) => ({
      hash: `h${i}`,
      action,
      payload: { prompt: `prompt-${i}` },
      date: "2026-03-08T00:00:00Z",
    }));
    const result = extractLastImageSettingsPerModel(log);
    expect(result.size).toBe(3);
    expect(result.has("generate_nano_banana_image")).toBe(true);
    expect(result.has("generate_grok_imagine_image")).toBe(true);
    expect(result.has("generate_gpt_image")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// extractLastUsedImageModel
// ---------------------------------------------------------------------------

describe("extractLastUsedImageModel", () => {
  it("returns null for empty log", () => {
    expect(extractLastUsedImageModel([])).toBeNull();
  });

  it("returns the model key of the most recent image tool entry", () => {
    const log: ActionLogEntry[] = [
      {
        hash: "h1",
        action: "tool-generate-gpt-image",
        payload: { prompt: "test" },
        date: "2026-03-08T02:00:00Z",
      },
      {
        hash: "h2",
        action: "tool-generate-nano-banana-image",
        payload: { prompt: "older" },
        date: "2026-03-08T01:00:00Z",
      },
    ];
    expect(extractLastUsedImageModel(log)).toBe("gpt_image");
  });

  it("skips non-image tool entries", () => {
    const log: ActionLogEntry[] = [
      {
        hash: "h1",
        action: "tool-asset-manifest",
        payload: { project_slug: "test" },
        date: "2026-03-08T02:00:00Z",
      },
      {
        hash: "h2",
        action: "tool-generate-grok-imagine-image",
        payload: { prompt: "test" },
        date: "2026-03-08T01:00:00Z",
      },
    ];
    expect(extractLastUsedImageModel(log)).toBe("grok_imagine_image");
  });
});

// ---------------------------------------------------------------------------
// buildImageModelOption — history integration
// ---------------------------------------------------------------------------

describe("buildImageModelOption history integration", () => {
  const models = getImageModels();
  const nanoBanana = models.nano_banana;
  const gptImage = models.gpt_image;

  it("history params fill in as defaults when router params are empty", () => {
    const history: ActionLogEntry[] = [
      {
        hash: "h1",
        action: "tool-generate-nano-banana-image",
        payload: { prompt: "old prompt", resolution: "4K", aspect_ratio: "16:9" },
        date: "2026-03-08T00:00:00Z",
      },
    ];
    const option = buildImageModelOption("nano_banana", nanoBanana, {}, [], history);
    expect(option.prefilled_values.prompt).toBe("old prompt");
    expect(option.prefilled_values.resolution).toBe("4K");
    expect(option.prefilled_values.aspect_ratio).toBe("16:9");
  });

  it("baseParams override history (UI input takes precedence)", () => {
    const history: ActionLogEntry[] = [
      {
        hash: "h1",
        action: "tool-generate-nano-banana-image",
        payload: { prompt: "old prompt", resolution: "4K", aspect_ratio: "16:9" },
        date: "2026-03-08T00:00:00Z",
      },
    ];
    const routerParams = { resolution: "2K", aspect_ratio: "1:1" };
    const option = buildImageModelOption("nano_banana", nanoBanana, routerParams, [], history);
    expect(option.prefilled_values.resolution).toBe("2K");
    expect(option.prefilled_values.aspect_ratio).toBe("1:1");
    // prompt not in baseParams, so history value persists
    expect(option.prefilled_values.prompt).toBe("old prompt");
  });

  it("history for model X does not leak into model Y", () => {
    const history: ActionLogEntry[] = [
      {
        hash: "h1",
        action: "tool-generate-nano-banana-image",
        payload: { prompt: "banana prompt", resolution: "4K" },
        date: "2026-03-08T00:00:00Z",
      },
    ];
    const option = buildImageModelOption("gpt_image", gptImage, {}, [], history);
    expect(option.prefilled_values.prompt).toBeUndefined();
    expect(option.prefilled_values.resolution).toBe("1K");
  });

  it("history params filtered by model's allowedParams", () => {
    const history: ActionLogEntry[] = [
      {
        hash: "h1",
        action: "tool-generate-gpt-image",
        payload: { prompt: "test", aspect_ratio: "16:9", output_format: "png" },
        date: "2026-03-08T00:00:00Z",
      },
    ];
    const option = buildImageModelOption("gpt_image", gptImage, {}, [], history);
    expect(option.prefilled_values.prompt).toBe("test");
    expect(option.prefilled_values.aspect_ratio).toBe("16:9");
    // output_format is not in gpt_image's allowed params
    expect(option.prefilled_values).not.toHaveProperty("output_format");
  });
});

// ---------------------------------------------------------------------------
// getImageToolSchema
// ---------------------------------------------------------------------------

describe("getImageToolSchema", () => {
  it("nano_banana: correct enums, prompt required", () => {
    const schema = getImageToolSchema("generate_nano_banana_image");
    expect(schema).not.toBeNull();
    expect(schema!.required).toContain("prompt");
    expect(schema!.properties.aspect_ratio.enum).toEqual(["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9", "auto"]);
    expect(schema!.properties.resolution.enum).toEqual(["1K", "2K", "4K"]);
    expect(schema!.properties.output_format.enum).toEqual(["png", "jpg"]);
  });

  it("google nano_banana: only exposes params sent to Google Flow", () => {
    const schema = getImageToolSchema("generate_nano_banana_pro_google");
    expect(schema).not.toBeNull();
    expect(schema!.required).toEqual(["prompt"]);
    expect(Object.keys(schema!.properties)).toEqual(["prompt", "image_slugs", "character_refs", "aspect_ratio", "seed"]);
    expect(schema!.properties.aspect_ratio.enum).toEqual(["16:9", "4:3", "1:1", "3:4", "9:16", "auto"]);
    expect(schema!.properties).not.toHaveProperty("resolution");
    expect(schema!.properties).not.toHaveProperty("output_format");
  });

  it("grok_imagine_image: prompt NOT required, image_slugs required", () => {
    const schema = getImageToolSchema("generate_grok_imagine_image");
    expect(schema).not.toBeNull();
    expect(schema!.required).not.toContain("prompt");
    expect(schema!.required).toContain("image_slugs");
  });

  it("gpt_image: both prompt and image_slugs required, aspect_ratio + resolution enums", () => {
    const schema = getImageToolSchema("generate_gpt_image");
    expect(schema).not.toBeNull();
    expect(schema!.required).toContain("prompt");
    expect(schema!.required).toContain("image_slugs");
    expect(schema!.properties.aspect_ratio.enum).toEqual(["auto", "1:1", "5:4", "9:16", "21:9", "16:9", "4:3", "3:2", "4:5", "3:4", "2:3"]);
    expect(schema!.properties.resolution.enum).toEqual(["1K", "2K", "4K"]);
    expect(schema!.properties).not.toHaveProperty("quality");
  });

  it("gpt_image_text: prompt required, no image_slugs, aspect_ratio + resolution enums", () => {
    const schema = getImageToolSchema("generate_gpt_image_text");
    expect(schema).not.toBeNull();
    expect(schema!.required).toContain("prompt");
    expect(schema!.required).not.toContain("image_slugs");
    expect(schema!.properties.aspect_ratio.enum).toEqual(["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "9:16", "16:9", "2:1", "1:2", "3:1", "1:3", "21:9", "9:21"]);
    expect(schema!.properties.resolution.enum).toEqual(["1K", "2K", "4K"]);
  });
});

// ---------------------------------------------------------------------------
// validateImageParams
// ---------------------------------------------------------------------------

describe("validateImageParams", () => {
  it("valid nano_banana params pass", () => {
    const result = validateImageParams("generate_nano_banana_image", {
      prompt: "a sunset",
      aspect_ratio: "16:9",
      resolution: "2K",
    });
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it("grok warns when no images provided", () => {
    const result = validateImageParams("generate_grok_imagine_image", {
      image_slugs: [],
    });
    expect(result.warnings.some((w) => w.includes("requires at least"))).toBe(true);
  });

  it("grok warns when >1 image (Zod tuple caps at 1)", () => {
    const result = validateImageParams("generate_grok_imagine_image", {
      image_slugs: ["@img-a", "@img-b"],
    });
    expect(result.warnings.some((w) => w.includes("supports 1 images"))).toBe(true);
  });

  it("gpt warns when >16 images (Zod array capped at 16)", () => {
    const result = validateImageParams("generate_gpt_image", {
      prompt: "edit this",
      image_slugs: Array.from({ length: 17 }, (_, i) => `@img-${i}`),
    });
    expect(result.warnings.some((w) => w.includes("supports 1-16 images"))).toBe(true);
  });

  it("gpt warns when no images (Zod array requires at least 1)", () => {
    const result = validateImageParams("generate_gpt_image", {
      prompt: "edit this",
      image_slugs: [],
    });
    expect(result.warnings.some((w) => w.includes("requires at least 1"))).toBe(true);
  });

  it("qwen2 warns when no images provided", () => {
    const result = validateImageParams("generate_qwen2_image_edit", {
      prompt: "edit this",
      image_slugs: [],
    });
    expect(result.warnings.some((w) => w.includes("requires at least 1"))).toBe(true);
  });

  it("qwen2 warns when >1 image (single-image slot)", () => {
    const result = validateImageParams("generate_qwen2_image_edit", {
      prompt: "edit this",
      image_slugs: ["@img-a", "@img-b"],
    });
    expect(result.warnings.some((w) => w.includes("supports 1 images"))).toBe(true);
  });

  it("qwen2 accepts exactly 1 image", () => {
    const result = validateImageParams("generate_qwen2_image_edit", {
      prompt: "edit this",
      image_slugs: ["@img-a"],
    });
    expect(result.warnings.some((w) => w.toLowerCase().includes("images"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getImageModels — provider-driven registry
// ---------------------------------------------------------------------------

describe("getImageModels", () => {
  it("returns all 14 image models", () => {
    const models = getImageModels();
    expect(Object.keys(models)).toHaveLength(14);
    expect(models).toHaveProperty("nano_banana");
    expect(models).toHaveProperty("grok_imagine_image");
    expect(models).toHaveProperty("gpt_image");
    expect(models).toHaveProperty("gpt_image_text");
    expect(models).toHaveProperty("grok_imagine_text");
    expect(models).toHaveProperty("qwen2_image_edit");
    expect(models).toHaveProperty("seedream_text");
    expect(models).toHaveProperty("seedream_image");
    expect(models).toHaveProperty("wan27_image");
    expect(models).toHaveProperty("wan27_image_pro");
    expect(models).toHaveProperty("alibaba_image");
    expect(models).toHaveProperty("alibaba_image_pro");
    expect(models).toHaveProperty("alibaba_qwen_image");
    expect(models).toHaveProperty("alibaba_qwen_image_edit");
  });

  it("params come from Kie schemas with image field renamed to image_slugs", () => {
    const models = getImageModels();
    expect(models.nano_banana.params).toContain("image_slugs");
    expect(models.nano_banana.params).toContain("prompt");
    expect(models.nano_banana.params).toContain("aspect_ratio");
    expect(models.nano_banana.params).not.toContain("image_input");
  });

  it("each model has at least one provider", () => {
    const models = getImageModels();
    for (const info of Object.values(models)) {
      expect(info.providers.length).toBeGreaterThan(0);
    }
  });

  it("xai models list xai as a provider", () => {
    const models = getImageModels();
    expect(models.grok_imagine_image.providers.some((p) => p.key === "xai")).toBe(true);
    expect(models.grok_imagine_text.providers.some((p) => p.key === "xai")).toBe(true);
  });

  it("kie-only models do not list xai as a provider", () => {
    const models = getImageModels();
    expect(models.nano_banana.providers.some((p) => p.key === "xai")).toBe(false);
    expect(models.gpt_image.providers.some((p) => p.key === "xai")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Google Flow provider (Nano Banana Pro)
// ---------------------------------------------------------------------------

describe("google flow image provider", () => {
  it("nano_banana lists google as a provider", () => {
    const models = getImageModels();
    const google = models.nano_banana.providers.find((p) => p.key === "google");
    expect(google).toBeDefined();
    expect(google!.envKey).toBe("GOOGLE_FLOW_API_KEY");
  });

  it("selecting the google provider swaps the tool name with and without refs", () => {
    const originalGoogle = process.env.GOOGLE_FLOW_API_KEY;
    const originalKie = process.env.KIE_API_KEY;
    process.env.GOOGLE_FLOW_API_KEY = "real-google-key";
    process.env.KIE_API_KEY = "real-kie-key";
    try {
      const models = getImageModels();
      const noRefs = buildImageModelOption(
        "nano_banana",
        models.nano_banana,
        { prompt: "x", resolution: "4K", output_format: "jpg" },
        [],
        undefined,
        "google",
      );
      expect(noRefs.selected_provider).toBe("google");
      expect(noRefs.tool_name).toBe("generate_nano_banana_pro_google");
      expect(Object.keys(noRefs.schema!.properties)).toEqual(["prompt", "image_slugs", "character_refs", "aspect_ratio", "seed"]);
      expect(noRefs.prefilled_values).not.toHaveProperty("resolution");
      expect(noRefs.prefilled_values).not.toHaveProperty("output_format");
      expect(noRefs.image_slots).toEqual({ min: 0, max: 10 });

      const withRefs = buildImageModelOption("nano_banana", models.nano_banana, { prompt: "x" }, [
        { tag: "@img-ref", asset_id: "img-ref", asset_type: "image", file_path: "/p/ref.png", asset_dir: "/p" },
      ], undefined, "google");
      expect(withRefs.tool_name).toBe("generate_nano_banana_pro_google");
    } finally {
      if (originalGoogle === undefined) delete process.env.GOOGLE_FLOW_API_KEY;
      else process.env.GOOGLE_FLOW_API_KEY = originalGoogle;
      if (originalKie === undefined) delete process.env.KIE_API_KEY;
      else process.env.KIE_API_KEY = originalKie;
    }
  });

  it("kie selection keeps the base nano banana tool", () => {
    const models = getImageModels();
    const option = buildImageModelOption("nano_banana", models.nano_banana, { prompt: "x" }, [], undefined, "kie");
    expect(option.tool_name).toBe("generate_nano_banana_image");
  });
});
