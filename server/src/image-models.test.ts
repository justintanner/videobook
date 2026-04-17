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
    expect(option.prefilled_values).not.toHaveProperty("resolution");
  });

  it("history params filtered by model's allowedParams", () => {
    const history: ActionLogEntry[] = [
      {
        hash: "h1",
        action: "tool-generate-gpt-image",
        payload: { prompt: "test", quality: "high", output_format: "png" },
        date: "2026-03-08T00:00:00Z",
      },
    ];
    const option = buildImageModelOption("gpt_image", gptImage, {}, [], history);
    expect(option.prefilled_values.prompt).toBe("test");
    expect(option.prefilled_values.quality).toBe("high");
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

  it("grok_imagine_image: prompt NOT required, image_slugs required", () => {
    const schema = getImageToolSchema("generate_grok_imagine_image");
    expect(schema).not.toBeNull();
    expect(schema!.required).not.toContain("prompt");
    expect(schema!.required).toContain("image_slugs");
  });

  it("gpt_image: both prompt and image_slugs required, quality/aspect_ratio enums", () => {
    const schema = getImageToolSchema("generate_gpt_image");
    expect(schema).not.toBeNull();
    expect(schema!.required).toContain("prompt");
    expect(schema!.required).toContain("image_slugs");
    expect(schema!.properties.quality.enum).toEqual(["medium", "high"]);
    expect(schema!.properties.aspect_ratio.enum).toEqual(["1:1", "2:3", "3:2"]);
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

  it("gpt warns when >4 images (Zod array capped at 4)", () => {
    const result = validateImageParams("generate_gpt_image", {
      prompt: "edit this",
      image_slugs: ["@img-a", "@img-b", "@img-c", "@img-d", "@img-e"],
    });
    expect(result.warnings.some((w) => w.includes("supports 1-4 images"))).toBe(true);
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

  it("qwen2 warns when >3 images (slot constraint override)", () => {
    const result = validateImageParams("generate_qwen2_image_edit", {
      prompt: "edit this",
      image_slugs: ["@img-a", "@img-b", "@img-c", "@img-d"],
    });
    expect(result.warnings.some((w) => w.includes("supports 1-3 images"))).toBe(true);
  });

  it("qwen2 accepts 1-3 images", () => {
    const result = validateImageParams("generate_qwen2_image_edit", {
      prompt: "edit this",
      image_slugs: ["@img-a", "@img-b"],
    });
    expect(result.warnings.some((w) => w.toLowerCase().includes("images"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getImageModels — provider-driven registry
// ---------------------------------------------------------------------------

describe("getImageModels", () => {
  it("returns all 9 image models", () => {
    const models = getImageModels();
    expect(Object.keys(models)).toHaveLength(9);
    expect(models).toHaveProperty("nano_banana");
    expect(models).toHaveProperty("grok_imagine_image");
    expect(models).toHaveProperty("gpt_image");
    expect(models).toHaveProperty("grok_imagine_text");
    expect(models).toHaveProperty("qwen2_image_edit");
    expect(models).toHaveProperty("wan27_image");
    expect(models).toHaveProperty("wan27_image_pro");
    expect(models).toHaveProperty("alibaba_image");
    expect(models).toHaveProperty("alibaba_image_pro");
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
