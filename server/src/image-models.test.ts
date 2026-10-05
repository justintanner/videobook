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

  it("extracts settings from a single nano_banana log entry, stripping book_id", () => {
    const log: ActionLogEntry[] = [
      {
        hash: "abc123",
        action: "tool-generate-nano-banana-image",
        payload: { book_id: "my-proj", prompt: "sunset", aspect_ratio: "16:9", resolution: "2K" },
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
        action: "tool-generate-kie-gpt-image-2-5-flare-image",
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
        payload: { book_id: "test" },
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
    expect(option.prefilled_values.resolution).toBe("2K");
  });

  it("history params filtered by model's allowedParams", () => {
    const history: ActionLogEntry[] = [
      {
        hash: "h1",
        action: "tool-generate-kie-gpt-image-2-5-flare-image",
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
    expect(Object.keys(schema!.properties)).toEqual(["prompt", "image_refs", "character_refs", "aspect_ratio", "seed"]);
    expect(schema!.properties.aspect_ratio.enum).toEqual(["16:9", "4:3", "1:1", "3:4", "9:16", "auto"]);
    expect(schema!.properties).not.toHaveProperty("resolution");
    expect(schema!.properties).not.toHaveProperty("output_format");
  });

  it("grok_imagine_image: prompt NOT required, image_refs required", () => {
    const schema = getImageToolSchema("generate_grok_imagine_image");
    expect(schema).not.toBeNull();
    expect(schema!.required).not.toContain("prompt");
    expect(schema!.required).toContain("image_refs");
  });

  it("gpt_image: prompt required with optional image_refs and current provider options", () => {
    const schema = getImageToolSchema("generate_kie_gpt_image_2_5_flare_image");
    expect(schema).not.toBeNull();
    expect(schema!.required).toContain("prompt");
    expect(schema!.required).not.toContain("image_refs");
    expect(schema!.properties.aspect_ratio.enum).toEqual(["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "21:9", "27:16", "16:27", "9:8", "8:9"]);
    expect(schema!.properties.resolution.enum).toEqual(["1K", "2K", "4K"]);
    expect(schema!.properties.resolution.default).toBe("2K");
    expect(schema!.properties).not.toHaveProperty("quality");
  });

  it("gpt_image_sunburst: prompt required with optional references", () => {
    const schema = getImageToolSchema("generate_kie_gpt_image_2_5_sunburst_image");
    expect(schema).not.toBeNull();
    expect(schema!.required).toContain("prompt");
    expect(schema!.required).not.toContain("image_refs");
    expect(schema!.properties.aspect_ratio.enum).toEqual(["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "21:9", "27:16", "16:27", "9:8", "8:9"]);
    expect(schema!.properties.resolution.enum).toEqual(["1K", "2K", "4K"]);
    expect(schema!.properties.resolution.default).toBe("2K");
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
      image_refs: [],
    });
    expect(result.warnings.some((w) => w.includes("requires at least"))).toBe(true);
  });

  it("grok warns when >1 image (Zod tuple caps at 1)", () => {
    const result = validateImageParams("generate_grok_imagine_image", {
      image_refs: ["@img-a", "@img-b"],
    });
    expect(result.warnings.some((w) => w.includes("supports 1 images"))).toBe(true);
  });

  it("gpt warns when >16 images (Zod array capped at 16)", () => {
    const result = validateImageParams("generate_kie_gpt_image_2_5_flare_image", {
      prompt: "edit this",
      image_refs: Array.from({ length: 17 }, (_, i) => `@img-${i}`),
    });
    expect(result.warnings.some((w) => w.includes("supports 0-16 images"))).toBe(true);
  });

  it("gpt accepts text-only rendering without references", () => {
    const result = validateImageParams("generate_kie_gpt_image_2_5_flare_image", {
      prompt: "edit this",
      image_refs: [],
    });
    expect(result.valid).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it("qwen2 warns when no images provided", () => {
    const result = validateImageParams("generate_qwen2_image_edit", {
      prompt: "edit this",
      image_refs: [],
    });
    expect(result.warnings.some((w) => w.includes("requires at least 1"))).toBe(true);
  });

  it("qwen2 warns when >1 image (single-image slot)", () => {
    const result = validateImageParams("generate_qwen2_image_edit", {
      prompt: "edit this",
      image_refs: ["@img-a", "@img-b"],
    });
    expect(result.warnings.some((w) => w.includes("supports 1 images"))).toBe(true);
  });

  it("qwen2 accepts exactly 1 image", () => {
    const result = validateImageParams("generate_qwen2_image_edit", {
      prompt: "edit this",
      image_refs: ["@img-a"],
    });
    expect(result.warnings.some((w) => w.toLowerCase().includes("images"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getImageModels — provider-driven registry
// ---------------------------------------------------------------------------

describe("getImageModels", () => {
  it("returns all 26 image models", () => {
    const models = getImageModels();
    expect(Object.keys(models)).toHaveLength(26);
    expect(models).toHaveProperty("nano_banana");
    expect(models).toHaveProperty("grok_imagine_image");
    expect(models).toHaveProperty("gpt_image");
    expect(models).toHaveProperty("gpt_image_sunburst");
    expect(models).not.toHaveProperty("gpt_image_text");
    expect(models).toHaveProperty("grok_imagine_text");
    expect(models).toHaveProperty("qwen2_image_edit");
    expect(models).toHaveProperty("qwen3_image_edit");
    expect(models).toHaveProperty("qwen2_1_text");
    expect(models).toHaveProperty("qwen2_1_edit");
    expect(models).toHaveProperty("seedream_text");
    expect(models).toHaveProperty("seedream_image");
    expect(models).toHaveProperty("alibaba_qwen_image");
    expect(models).toHaveProperty("alibaba_qwen_image_edit");
  });

  it("params come from Kie schemas with image field renamed to image_refs", () => {
    const models = getImageModels();
    expect(models.nano_banana.params).toContain("image_refs");
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

  it("offers Qwen 3 through Fal by default and keeps Kie as an alternate", () => {
    const originalKie = process.env.KIE_API_KEY;
    const originalFal = process.env.FAL_API_KEY;
    process.env.KIE_API_KEY = "kie-key";
    process.env.FAL_API_KEY = "fal-key";
    try {
      const models = getImageModels();
      expect(models.qwen3_image_edit.tool_name).toBe("generate_kie_qwen_3_0_edit_image");
      expect(models.qwen3_image_edit.providers.map((provider) => provider.key)).toEqual(["fal", "kie"]);

      const defaultOption = buildImageModelOption(
        "qwen3_image_edit",
        models.qwen3_image_edit,
        { prompt: "edit" },
        [{ tag: "@image", artifactId: "image", artifactType: "image", filePath: "/image.png", workspacePath: "/" }],
      );
      expect(defaultOption.selected_provider).toBe("fal");
      expect(defaultOption.tool_name).toBe("generate_fal_qwen_3_0_edit_image");
      expect(defaultOption.schema?.properties).toHaveProperty("enable_prompt_expansion");
      expect(defaultOption.schema?.properties).not.toHaveProperty("resolution");

      const kieOption = buildImageModelOption(
        "qwen3_image_edit",
        models.qwen3_image_edit,
        { prompt: "edit" },
        [{ tag: "@image", artifactId: "image", artifactType: "image", filePath: "/image.png", workspacePath: "/" }],
        undefined,
        "kie",
      );
      expect(kieOption.selected_provider).toBe("kie");
      expect(kieOption.tool_name).toBe("generate_kie_qwen_3_0_edit_image");
      expect(kieOption.schema?.properties).toHaveProperty("resolution");
    } finally {
      if (originalKie === undefined) delete process.env.KIE_API_KEY;
      else process.env.KIE_API_KEY = originalKie;
      if (originalFal === undefined) delete process.env.FAL_API_KEY;
      else process.env.FAL_API_KEY = originalFal;
    }
  });

  it("preserves a historical Qwen 3 Fal choice", () => {
    const originalKie = process.env.KIE_API_KEY;
    const originalFal = process.env.FAL_API_KEY;
    process.env.KIE_API_KEY = "kie-key";
    process.env.FAL_API_KEY = "fal-key";
    try {
      const models = getImageModels();
      const option = buildImageModelOption(
        "qwen3_image_edit",
        models.qwen3_image_edit,
        { prompt: "edit" },
        [{ tag: "@image", artifactId: "image", artifactType: "image", filePath: "/image.png", workspacePath: "/" }],
        [{
          hash: "old",
          action: "tool-generate-fal-qwen-3-0-edit-image",
          payload: { prompt: "old", image_refs: ["@image"], _provider: "fal" },
          date: "2026-08-29T00:00:00Z",
        }],
      );
      expect(option.selected_provider).toBe("fal");
      expect(option.tool_name).toBe("generate_fal_qwen_3_0_edit_image");
    } finally {
      if (originalKie === undefined) delete process.env.KIE_API_KEY;
      else process.env.KIE_API_KEY = originalKie;
      if (originalFal === undefined) delete process.env.FAL_API_KEY;
      else process.env.FAL_API_KEY = originalFal;
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

  it("routes Alibaba Qwen image models through multimodal generation", () => {
    const models = getImageModels();
    for (const key of ["alibaba_qwen_image", "alibaba_qwen_image_edit"]) {
      const provider = models[key].providers.find((candidate) => candidate.key === "alibaba");
      expect(provider?.provider_path).toContain("multimodalGeneration");
    }
  });

  it("builds the canonical Alibaba picker schemas", () => {
    const models = getImageModels();
    const generate = getImageToolSchema(models.alibaba_qwen_image.tool_name);
    expect(generate?.required).toEqual(["prompt", "model"]);

    const edit = getImageToolSchema(models.alibaba_qwen_image_edit.tool_name);
    expect(edit?.required).toEqual(["prompt", "image_refs", "model"]);
    expect(edit?.properties.model.enum).toContain("qwen-image-edit");
  });

  it("routes Qwen 2.1 image models through Kie only", () => {
    const models = getImageModels();
    for (const key of ["qwen2_1_text", "qwen2_1_edit"]) {
      expect(models[key].providers.map((provider) => provider.key)).toEqual(["kie"]);
      expect(models[key].tool_name).toBe(
        key === "qwen2_1_text" ? "generate_kie_qwen_2_1_text_to_image" : "generate_kie_qwen_2_1_edit_image",
      );
    }

    const text = getImageToolSchema(models.qwen2_1_text.tool_name);
    expect(text?.required).toEqual(["prompt"]);
    expect(text?.properties).not.toHaveProperty("image_refs");

    const edit = getImageToolSchema(models.qwen2_1_edit.tool_name);
    expect(edit?.required).toHaveLength(2);
    expect(edit?.required).toEqual(expect.arrayContaining(["prompt", "image_refs"]));
    expect(edit?.properties.image_refs.minItems).toBe(1);
    expect(edit?.properties.image_refs.maxItems).toBe(10);
    expect(edit?.properties.aspect_ratio.enum).toContain("auto");
    expect(edit?.properties).not.toHaveProperty("mask_url");
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
      expect(noRefs.tool_name).toBe("generate_google_flow_nano_banana_pro_image");
      expect(Object.keys(noRefs.schema!.properties)).toEqual(["prompt", "image_refs", "character_refs", "aspect_ratio", "seed"]);
      expect(noRefs.prefilled_values).not.toHaveProperty("resolution");
      expect(noRefs.prefilled_values).not.toHaveProperty("output_format");
      expect(noRefs.image_slots).toEqual({ min: 0, max: 10 });

      const withRefs = buildImageModelOption("nano_banana", models.nano_banana, { prompt: "x" }, [
        { tag: "@img-ref", artifactId: "img-ref", artifactType: "image", filePath: "/p/ref.png", workspacePath: "/p" },
      ], undefined, "google");
      expect(withRefs.tool_name).toBe("generate_google_flow_nano_banana_pro_image");
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
    expect(option.tool_name).toBe("generate_kie_nano_banana_pro_text_to_image");
  });

  it("validates Google Flow character references under the canonical name", () => {
    const result = validateImageParams("generate_google_flow_nano_banana_pro_image", {
      prompt: "x",
      character_refs: ["character-a", "character-a"],
    });
    expect(result.warnings.some((warning) => warning.includes("Duplicate character"))).toBe(true);
  });
});

describe("apicity 0.14.0 image models", () => {
  const releaseModels: Array<[string, string, string, "fal" | "kie"]> = [
    ["fibo_product_holding", "fal Bria FIBO Edit 1.5 product holding", "generate_fal_bria_fibo_edit_1_5_product_holding", "fal"],
    ["fibo_virtual_try_on", "fal Bria FIBO Edit 1.5 virtual try-on", "generate_fal_bria_fibo_edit_1_5_virtual_try_on", "fal"],
    ["recraft_v4_1_flash", "fal Recraft 4.1 Flash text-to-image", "generate_fal_recraft_v4_1_flash_text_to_image", "fal"],
    ["seedream_v5_flash_text", "fal Seedream 5 Flash text-to-image", "generate_fal_seedream_v5_flash_text_to_image", "fal"],
    ["seedream_v5_flash_edit", "fal Seedream 5 Flash edit", "generate_fal_seedream_v5_flash_edit_image", "fal"],
    ["seedream_v5_flash_layerize", "fal Seedream 5 Flash layerize", "generate_fal_seedream_v5_flash_layerize", "fal"],
    ["ideogram_v4_5", "fal Ideogram 4.5 text-to-image", "generate_fal_ideogram_v4_5_text_to_image", "fal"],
    ["ideogram_v4_5_edit", "fal Ideogram 4.5 image editing", "generate_fal_ideogram_v4_5_edit_image", "fal"],
    ["flux_3", "fal FLUX 3 text-to-image", "generate_fal_flux_3_text_to_image", "fal"],
    ["flux_3_edit", "fal FLUX 3 image editing", "generate_fal_flux_3_edit_image", "fal"],
    ["seedream_v5_flash_kie_text", "kie Seedream 5 Flash text-to-image", "generate_kie_seedream_v5_flash_text_to_image", "kie"],
    ["seedream_v5_flash_kie_edit", "kie Seedream 5 Flash image-to-image", "generate_kie_seedream_v5_flash_image_to_image", "kie"],
    ["seedream_v5_flash_kie_layers", "kie Seedream 5 Flash layer decomposition", "generate_kie_seedream_v5_flash_layer_decomposition", "kie"],
  ];

  it("lists each new fal and kie image action under its release name", () => {
    const models = getImageModels();
    for (const [key, label, toolName, provider] of releaseModels) {
      expect(models[key], key).toMatchObject({ label, tool_name: toolName });
      expect(models[key].providers.map((item) => item.key), key).toEqual([provider]);
    }
  });

  it("keeps edit, layer, try-on, and product-holding actions from being text-only", () => {
    const requiredMedia: Array<[string, number]> = [
      ["generate_fal_bria_fibo_edit_1_5_product_holding", 2],
      ["generate_fal_bria_fibo_edit_1_5_virtual_try_on", 2],
      ["generate_fal_seedream_v5_flash_edit_image", 1],
      ["generate_fal_seedream_v5_flash_layerize", 1],
      ["generate_fal_ideogram_v4_5_edit_image", 1],
      ["generate_fal_flux_3_edit_image", 1],
      ["generate_kie_seedream_v5_flash_image_to_image", 1],
      ["generate_kie_seedream_v5_flash_layer_decomposition", 1],
    ];
    for (const [toolName, min] of requiredMedia) {
      const schema = getImageToolSchema(toolName);
      expect(schema?.required, toolName).toContain("image_refs");
      expect(schema?.properties.image_refs.minItems, toolName).toBeGreaterThanOrEqual(min);
      const textOnly = validateImageParams(toolName, { prompt: "a paper crane at dusk" });
      expect(textOnly.image_slots?.min, toolName).toBeGreaterThanOrEqual(min);
      expect(textOnly.missing_required, toolName).toContain("image_refs");
    }
  });

  it("offers the new text-to-image actions without a required image", () => {
    for (const toolName of [
      "generate_fal_recraft_v4_1_flash_text_to_image",
      "generate_fal_seedream_v5_flash_text_to_image",
      "generate_fal_ideogram_v4_5_text_to_image",
      "generate_fal_flux_3_text_to_image",
      "generate_kie_seedream_v5_flash_text_to_image",
    ]) {
      const schema = getImageToolSchema(toolName);
      expect(schema?.required, toolName).toContain("prompt");
      expect(schema?.required, toolName).not.toContain("image_refs");
      const textOnly = validateImageParams(toolName, { prompt: "a paper crane at dusk" });
      expect(textOnly.missing_required, toolName).not.toContain("image_refs");
    }
  });
});
