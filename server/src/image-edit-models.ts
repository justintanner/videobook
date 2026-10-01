import type { ZodType } from "zod";
import {
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
import { readSlotConstraints } from "./zod-slots.js";

export type ImageEditCapability = "semantic" | "regionReplace" | "wholeImage" | "exactMask";

export interface ImageEditModelInfo {
  /** Catalog and adapter id; the provider model/endpoint identifier. */
  readonly id: string;
  readonly label: string;
  readonly provider: "kie" | "fal";
  readonly envKey: "KIE_API_KEY" | "FAL_API_KEY";
  /** Apicity request schema backing the provider call; also the stored-payload discriminator. */
  readonly requestSchema: ZodType;
  /** Max image inputs from the schema's slot constraints; null = unbounded. */
  readonly maxInputImages: number | null;
  readonly capabilities: Readonly<Record<ImageEditCapability, boolean>>;
  /**
   * GENERATION_ACTIONS canonical_name whose cost adapter prices this model.
   * null = seedream/5-pro-image-to-image, priced directly by @apicity/cost
   * without a registry action (the seedream pro i2i special case).
   */
  readonly shadowedAction: string | null;
}

function maxInputImagesFrom(inputUrls: ZodType): number | null {
  return readSlotConstraints(inputUrls)?.max ?? null;
}

const STANDARD_IMAGE_EDIT_CAPABILITIES = {
  semantic: true,
  regionReplace: true,
  wholeImage: true,
  exactMask: false,
} as const;

export const IMAGE_EDIT_MODELS: readonly ImageEditModelInfo[] = [
  {
    id: "seedream/5-pro-image-to-image",
    label: "Seedream 5 Pro",
    provider: "kie",
    envKey: "KIE_API_KEY",
    requestSchema: SeedreamProImageToImageRequestSchema,
    maxInputImages: maxInputImagesFrom(SeedreamProImageToImageRequestSchema.shape.input.shape.image_urls),
    capabilities: STANDARD_IMAGE_EDIT_CAPABILITIES,
    shadowedAction: null,
  },
  {
    id: "gpt-image-2-5-flare-image-to-image",
    label: "GPT Image 2.5 Flare",
    provider: "kie",
    envKey: "KIE_API_KEY",
    requestSchema: GptImage25FlareImageToImageRequestSchema,
    maxInputImages: maxInputImagesFrom(GptImage25FlareImageToImageRequestSchema.shape.input.shape.input_urls),
    capabilities: STANDARD_IMAGE_EDIT_CAPABILITIES,
    shadowedAction: "generate_kie_gpt_image_2_5_flare_image",
  },
  {
    id: "gpt-image-2-5-sunburst-image-to-image",
    label: "GPT Image 2.5 Sunburst",
    provider: "kie",
    envKey: "KIE_API_KEY",
    requestSchema: GptImage25SunburstImageToImageRequestSchema,
    maxInputImages: maxInputImagesFrom(GptImage25SunburstImageToImageRequestSchema.shape.input.shape.input_urls),
    capabilities: STANDARD_IMAGE_EDIT_CAPABILITIES,
    shadowedAction: "generate_kie_gpt_image_2_5_sunburst_image",
  },
  {
    id: "gpt-image-2-image-to-image",
    label: "GPT Image 2",
    provider: "kie",
    envKey: "KIE_API_KEY",
    requestSchema: GptImage2ImageToImageRequestSchema,
    maxInputImages: maxInputImagesFrom(GptImage2ImageToImageRequestSchema.shape.input.shape.input_urls),
    capabilities: STANDARD_IMAGE_EDIT_CAPABILITIES,
    shadowedAction: "generate_kie_gpt_image_2_image_to_image",
  },
  {
    id: "fal-ai/nano-banana-pro/edit",
    label: "Nano Banana Pro",
    provider: "fal",
    envKey: "FAL_API_KEY",
    requestSchema: FalNanoBananaProEditRequestSchema,
    maxInputImages: maxInputImagesFrom(FalNanoBananaProEditRequestSchema.shape.image_urls),
    capabilities: STANDARD_IMAGE_EDIT_CAPABILITIES,
    shadowedAction: "generate_fal_nano_banana_pro_edit_image",
  },
  {
    id: "fal-ai/nano-banana-2/edit",
    label: "Nano Banana 2",
    provider: "fal",
    envKey: "FAL_API_KEY",
    requestSchema: FalNanoBanana2EditRequestSchema,
    maxInputImages: maxInputImagesFrom(FalNanoBanana2EditRequestSchema.shape.image_urls),
    capabilities: STANDARD_IMAGE_EDIT_CAPABILITIES,
    shadowedAction: "generate_fal_nano_banana_2_edit_image",
  },
  {
    id: "alibaba/qwen-image-3/edit",
    label: "Qwen 3.0 Edit",
    provider: "fal",
    envKey: "FAL_API_KEY",
    requestSchema: FalAlibabaQwenImage3EditRequestSchema,
    maxInputImages: maxInputImagesFrom(FalAlibabaQwenImage3EditRequestSchema.shape.image_urls),
    capabilities: STANDARD_IMAGE_EDIT_CAPABILITIES,
    shadowedAction: "generate_fal_qwen_3_0_edit_image",
  },
  {
    id: "fal-ai/wan-v2-7/edit",
    label: "Wan 2.7 Edit",
    provider: "fal",
    envKey: "FAL_API_KEY",
    requestSchema: FalWanV2p7EditRequestSchema,
    maxInputImages: maxInputImagesFrom(FalWanV2p7EditRequestSchema.shape.image_urls),
    capabilities: STANDARD_IMAGE_EDIT_CAPABILITIES,
    shadowedAction: "generate_fal_wan_2_7_edit_image",
  },
];

export const DEFAULT_IMAGE_EDIT_MODEL_ID = "seedream/5-pro-image-to-image";

export function findImageEditModel(id: string): ImageEditModelInfo | undefined {
  return IMAGE_EDIT_MODELS.find((model) => model.id === id);
}
