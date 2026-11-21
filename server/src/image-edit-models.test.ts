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
import { MachGenGenerateRequestSchema } from "@apicity/machgen/zod";
import {
  NunchuxGoogleInteractionsRequestSchema,
  NunchuxOpenAiImagesEditsRequestSchema,
} from "@apicity/nunchux/zod";
import {
  WaveSpeedGoogleNanoBanana2p1EditRequestSchema,
  WaveSpeedOpenaiGptImage2p6FlareEditRequestSchema,
  WaveSpeedOpenaiGptImage2p6SunburstEditRequestSchema,
} from "@apicity/wavespeed/zod";
import { resolveModel } from "./media/descriptor.js";
import { listModels } from "./media/listing.js";
import { buildWireRequest } from "./media/request.js";
import { modelFamily } from "./media/model-family.js";
import {
  DEFAULT_IMAGE_EDIT_MODEL_ID,
  findImageEditModel,
  IMAGE_EDIT_MODELS,
} from "./image-edit-models.js";

type ImageField = { safeParse(value: unknown): { success: boolean } };

function machgenImageField(catalogModel: string): ImageField {
  const built = buildWireRequest(resolveModel(catalogModel), {
    prompt: "x",
    refUrls: { image: ["https://example.com/base.png"] },
  });
  if (!built.ok) throw new Error(built.error);
  return {
    safeParse: (urls) => MachGenGenerateRequestSchema.safeParse({ ...built.request, src_image_urls: urls }),
  };
}

const nunchuxNanoBananaField: ImageField = {
  safeParse: (urls) => NunchuxGoogleInteractionsRequestSchema.shape.input.safeParse([
    { type: "text", text: "x" },
    ...(urls as string[]).map(() => ({ type: "image", data: "AA==", mime_type: "image/png" })),
  ]),
};

const nunchuxGptImageField: ImageField = {
  safeParse: (urls) => NunchuxOpenAiImagesEditsRequestSchema.shape.images
    .safeParse((urls as string[]).map((url) => ({ image_url: url }))),
};

function imageFieldFor(entryId: string): ImageField | null {
  if (entryId.startsWith("machgen:")) return machgenImageField(entryId);
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
    case "wavespeed:google/nano-banana-2.1/edit":
      return WaveSpeedGoogleNanoBanana2p1EditRequestSchema.shape.images;
    case "wavespeed:openai/gpt-image-2.6-sunburst/edit":
      return WaveSpeedOpenaiGptImage2p6SunburstEditRequestSchema.shape.images;
    case "wavespeed:openai/gpt-image-2.6-flare/edit":
      return WaveSpeedOpenaiGptImage2p6FlareEditRequestSchema.shape.images;
    case "nunchux:gemini-nano-banana-2.1":
      return nunchuxNanoBananaField;
    case "nunchux:gpt-image-2.6-sunburst":
    case "nunchux:gpt-image-2.6-flare":
      return nunchuxGptImageField;
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
      expect(entry.id).toBe(entry.provider === "kie" || entry.provider === "fal" ? model.apiId : model.id);
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
      "image:nano-banana-2-1": ["kie", "fal", "wavespeed", "machgen", "nunchux"],
      "image:gpt-image-2-6-sunburst": ["kie", "fal", "wavespeed", "machgen", "nunchux"],
      "image:gpt-image-2-6-flare": ["kie", "fal", "wavespeed", "machgen", "nunchux"],
      "image:gpt-image-2-5-flare": ["kie", "machgen"],
      "image:gpt-image-2-5-sunburst": ["kie", "machgen"],
      "image:gpt-image-2": ["kie", "fal", "machgen"],
      "image:nano-banana-pro": ["kie", "fal"],
      "image:nano-banana-2": ["fal", "machgen"],
    });
    expect(findImageEditModel("fal:google/nano-banana-2.1/edit")?.id).toBe("google/nano-banana-2.1/edit");
    expect(findImageEditModel("wavespeed:google/nano-banana-2.1/edit")?.id).toBe("wavespeed:google/nano-banana-2.1/edit");
  });

  it("lists every catalog edit endpoint in a family the picker already offers", () => {
    const families = new Set(IMAGE_EDIT_MODELS.map((entry) => entry.family.id));
    const listed = new Set(IMAGE_EDIT_MODELS.map((entry) => entry.catalogModel));
    const missing = listModels({ includeHidden: true })
      .filter((model) => model.entry.operations.includes("edit_image"))
      .filter((model) => families.has(modelFamily(model).family.id) && !listed.has(model.id))
      .map((model) => model.id);
    expect(missing).toEqual([]);
  });

  it("matches env keys and provider families", () => {
    const envKeys = {
      kie: "KIE_API_KEY",
      fal: "FAL_API_KEY",
      machgen: "MACHGEN_API_KEY",
      wavespeed: "WAVESPEED_API_KEY",
      nunchux: "NUNCHUX_API_KEY",
    };
    for (const entry of IMAGE_EDIT_MODELS) {
      expect(entry.envKey).toBe(envKeys[entry.provider]);
      expect(entry.capabilities.semantic).toBe(true);
      expect(entry.capabilities.exactMask).toBe(false);
    }
  });
});
