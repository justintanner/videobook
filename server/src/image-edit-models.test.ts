import { describe, expect, it } from "vitest";
import {
  NanoBanana21RequestSchema,
  NanoBananaProRequestSchema,
  Flux3KleinEditImageRequestSchema,
  GptImage25FlareImageToImageRequestSchema,
  GptImage25SunburstImageToImageRequestSchema,
  GptImage26FlareImageToImageRequestSchema,
  GptImage26SunburstImageToImageRequestSchema,
  GptImage2ImageToImageRequestSchema,
  SeedreamProImageToImageRequestSchema,
} from "@apicity/kie/zod";
import {
  FalAlibabaQwenImage3EditRequestSchema,
  FalBriaFibo2EditRequestSchema,
  FalNanoBanana2EditRequestSchema,
  FalNanoBanana2p1EditRequestSchema,
  FalNanoBananaProEditRequestSchema,
  FalOpenaiGptImage2EditRequestSchema,
  FalOpenaiGptImage2p6FlareEditRequestSchema,
  FalOpenaiGptImage2p6SunburstEditRequestSchema,
  FalWanV2p7EditRequestSchema,
} from "@apicity/fal/zod";
import { resolveModel } from "./media/descriptor.js";
import { modelFamily } from "./media/model-family.js";
import {
  DEFAULT_IMAGE_EDIT_MODEL_ID,
  findImageEditModel,
  IMAGE_EDIT_MODELS,
} from "./image-edit-models.js";

function imageFieldFor(entryId: string): { safeParse(value: unknown): { success: boolean } } | null {
  switch (entryId) {
    case "flux-3/klein-edit-image":
      return Flux3KleinEditImageRequestSchema.shape.input.shape.image_urls;
    case "nano-banana-2-1":
      return NanoBanana21RequestSchema.shape.input.shape.image_input;
    case "google/nano-banana-2.1/edit":
      return FalNanoBanana2p1EditRequestSchema.shape.image_urls;
    case "seedream/5-pro-image-to-image":
      return SeedreamProImageToImageRequestSchema.shape.input.shape.image_urls;
    case "gpt-image-2-5-flare-image-to-image":
      return GptImage25FlareImageToImageRequestSchema.shape.input.shape.input_urls;
    case "gpt-image-2-5-sunburst-image-to-image":
      return GptImage25SunburstImageToImageRequestSchema.shape.input.shape.input_urls;
    case "gpt-image-2-6/sunburst-image-to-image":
      return GptImage26SunburstImageToImageRequestSchema.shape.input.shape.input_urls;
    case "openai/gpt-image-2.6/sunburst/edit":
      return FalOpenaiGptImage2p6SunburstEditRequestSchema.shape.image_urls;
    case "gpt-image-2-6/flare-image-to-image":
      return GptImage26FlareImageToImageRequestSchema.shape.input.shape.input_urls;
    case "openai/gpt-image-2.6/flare/edit":
      return FalOpenaiGptImage2p6FlareEditRequestSchema.shape.image_urls;
    case "gpt-image-2-image-to-image":
      return GptImage2ImageToImageRequestSchema.shape.input.shape.input_urls;
    case "openai/gpt-image-2/edit":
      return FalOpenaiGptImage2EditRequestSchema.shape.image_urls;
    case "nano-banana-pro":
      return NanoBananaProRequestSchema.shape.input.shape.image_input;
    case "fal-ai/nano-banana-pro/edit":
      return FalNanoBananaProEditRequestSchema.shape.image_urls;
    case "fal-ai/nano-banana-2/edit":
      return FalNanoBanana2EditRequestSchema.shape.image_urls;
    case "alibaba/qwen-image-3/edit":
      return FalAlibabaQwenImage3EditRequestSchema.shape.image_urls;
    case "fal-ai/wan/v2.7/edit":
      return FalWanV2p7EditRequestSchema.shape.image_urls;
    case "bria/fibo-2/edit":
      return FalBriaFibo2EditRequestSchema.shape.image_urls;
    default:
      return null;
  }
}

function imageUrl(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `https://example.com/${index}.png`);
}

describe("image edit model catalog", () => {
  it("maps every entry to an image-editing catalog model", () => {
    for (const entry of IMAGE_EDIT_MODELS) {
      const model = resolveModel(entry.catalogModel);
      expect(model.media, entry.id).toBe("image");
      expect(model.apiId, entry.id).toBe(entry.id);
      expect(model.slots.some((slot) => slot.role === "image"), entry.id).toBe(true);
    }
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

  it("keeps every pre-split edit model id resolvable for saved edits", () => {
    for (const id of [
      "nano-banana-2-1",
      "flux-3/klein-edit-image",
      "seedream/5-pro-image-to-image",
      "gpt-image-2-5-flare-image-to-image",
      "gpt-image-2-5-sunburst-image-to-image",
      "gpt-image-2-image-to-image",
      "fal-ai/nano-banana-pro/edit",
      "fal-ai/nano-banana-2/edit",
      "alibaba/qwen-image-3/edit",
      "fal-ai/wan/v2.7/edit",
      "bria/fibo-2/edit",
    ]) {
      expect(findImageEditModel(id)?.id, id).toBe(id);
    }
  });

  it("groups edit endpoints by catalog family with one endpoint per provider", () => {
    const providers = new Map<string, string[]>();
    for (const entry of IMAGE_EDIT_MODELS) {
      expect(entry.family, entry.id).toEqual(modelFamily(resolveModel(entry.catalogModel)).family);
      providers.set(entry.family.id, [...providers.get(entry.family.id) ?? [], entry.provider]);
    }
    for (const [family, list] of providers) expect(new Set(list).size, family).toBe(list.length);
    expect(Object.fromEntries([...providers].filter(([, list]) => list.length > 1))).toEqual({
      "image:nano-banana-2-1": ["kie", "fal"],
      "image:gpt-image-2-6-sunburst": ["kie", "fal"],
      "image:gpt-image-2-6-flare": ["kie", "fal"],
      "image:gpt-image-2": ["kie", "fal"],
      "image:nano-banana-pro": ["kie", "fal"],
    });
    expect(findImageEditModel("fal:google/nano-banana-2.1/edit")?.id).toBe("google/nano-banana-2.1/edit");
  });

  it("matches env keys and provider families", () => {
    for (const entry of IMAGE_EDIT_MODELS) {
      expect(entry.envKey).toBe(entry.provider === "kie" ? "KIE_API_KEY" : "FAL_API_KEY");
      expect(entry.capabilities.semantic).toBe(true);
      expect(entry.capabilities.exactMask).toBe(false);
    }
  });
});
