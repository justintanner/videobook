import { describe, expect, it } from "vitest";
import {
  NanoBanana21RequestSchema,
  GptImage25FlareImageToImageRequestSchema,
  GptImage25SunburstImageToImageRequestSchema,
  GptImage2ImageToImageRequestSchema,
  SeedreamProImageToImageRequestSchema,
} from "@apicity/kie/zod";
import {
  FalAlibabaQwenImage3EditRequestSchema,
  FalNanoBanana2EditRequestSchema,
  FalNanoBananaProEditRequestSchema,
  FalWanV2p7EditRequestSchema,
} from "@apicity/fal/zod";
import { GENERATION_ACTIONS, RETIRED_GENERATION_ACTIONS } from "./generation-registry.js";
import { getImageModels, getImageToolSchema, validateImageParams } from "./image-models.js";
import {
  DEFAULT_IMAGE_EDIT_MODEL_ID,
  findImageEditModel,
  IMAGE_EDIT_MODELS,
} from "./image-edit-models.js";

function imageFieldFor(entryId: string): { safeParse(value: unknown): { success: boolean } } | null {
  switch (entryId) {
    case "nano-banana-2-1":
      return NanoBanana21RequestSchema.shape.input.shape.image_input;
    case "seedream/5-pro-image-to-image":
      return SeedreamProImageToImageRequestSchema.shape.input.shape.image_urls;
    case "gpt-image-2-5-flare-image-to-image":
      return GptImage25FlareImageToImageRequestSchema.shape.input.shape.input_urls;
    case "gpt-image-2-5-sunburst-image-to-image":
      return GptImage25SunburstImageToImageRequestSchema.shape.input.shape.input_urls;
    case "gpt-image-2-image-to-image":
      return GptImage2ImageToImageRequestSchema.shape.input.shape.input_urls;
    case "fal-ai/nano-banana-pro/edit":
      return FalNanoBananaProEditRequestSchema.shape.image_urls;
    case "fal-ai/nano-banana-2/edit":
      return FalNanoBanana2EditRequestSchema.shape.image_urls;
    case "alibaba/qwen-image-3/edit":
      return FalAlibabaQwenImage3EditRequestSchema.shape.image_urls;
    case "fal-ai/wan/v2.7/edit":
      return FalWanV2p7EditRequestSchema.shape.image_urls;
    default:
      return null;
  }
}

function imageUrl(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `https://example.com/${index}.png`);
}

describe("image edit model catalog", () => {
  it("maps every entry to a registry action or the seedream pro i2i special case", () => {
    const liveActions = new Set(GENERATION_ACTIONS.map((action) => action.canonical_name));
    const retiredActions = new Set(RETIRED_GENERATION_ACTIONS.map((action) => action.canonical_name));
    const shadowingRetired: string[] = [];
    for (const entry of IMAGE_EDIT_MODELS) {
      if (entry.shadowedAction === null) {
        expect(entry.id).toBe("seedream/5-pro-image-to-image");
        continue;
      }
      expect(
        liveActions.has(entry.shadowedAction) || retiredActions.has(entry.shadowedAction),
        `${entry.id} shadows ${entry.shadowedAction}`,
      ).toBe(true);
      if (retiredActions.has(entry.shadowedAction)) shadowingRetired.push(entry.id);
    }
    expect(shadowingRetired).toEqual([
      "gpt-image-2-image-to-image",
      "fal-ai/wan/v2.7/edit",
    ]);
  });

  it("derives max input images from the apicity schema boundary, not literals", () => {
    for (const entry of IMAGE_EDIT_MODELS) {
      const field = imageFieldFor(entry.id);
      expect(field, `no image field probed for ${entry.id}`).not.toBeNull();
      const probed = field!;
      if (entry.maxInputImages === null) {
        expect(probed.safeParse(imageUrl(32)).success).toBe(true);
        continue;
      }
      expect(entry.maxInputImages).toBeGreaterThanOrEqual(1);
      expect(probed.safeParse(imageUrl(entry.maxInputImages)).success).toBe(true);
      expect(probed.safeParse(imageUrl(entry.maxInputImages + 1)).success).toBe(false);
    }
  });

  it("uses Nano Banana 2.1 as the default and keeps ids unique", () => {
    expect(DEFAULT_IMAGE_EDIT_MODEL_ID).toBe("nano-banana-2-1");
    expect(findImageEditModel(DEFAULT_IMAGE_EDIT_MODEL_ID)?.provider).toBe("kie");
    expect(new Set(IMAGE_EDIT_MODELS.map((entry) => entry.id)).size).toBe(IMAGE_EDIT_MODELS.length);
  });

  it("lists apicity 0.14.0 edit actions on the image generation list with required media", () => {
    const models = getImageModels();
    const requiredMedia = [
      "fibo_product_holding",
      "fibo_virtual_try_on",
      "seedream_v5_flash_edit",
      "seedream_v5_flash_layerize",
      "ideogram_v4_5_edit",
      "flux_3_edit",
      "seedream_v5_flash_kie_edit",
      "seedream_v5_flash_kie_layers",
    ];
    for (const key of requiredMedia) {
      const model = models[key];
      expect(model, key).toBeDefined();
      const schema = getImageToolSchema(model.tool_name);
      expect(schema?.required, key).toContain("image_refs");
      const textOnly = validateImageParams(model.tool_name, { prompt: "a paper crane at dusk" });
      expect(textOnly.image_slots?.min ?? 0, key).toBeGreaterThan(0);
      expect(textOnly.missing_required, key).toContain("image_refs");
    }
  });

  it("matches env keys and provider families", () => {
    for (const entry of IMAGE_EDIT_MODELS) {
      expect(entry.envKey).toBe(entry.provider === "kie" ? "KIE_API_KEY" : "FAL_API_KEY");
      expect(entry.capabilities.semantic).toBe(true);
      expect(entry.capabilities.exactMask).toBe(false);
    }
  });
});
