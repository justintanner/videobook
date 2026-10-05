import { z } from "zod";
import { readSlotConstraints } from "./zod-slots.js";
import type { GptImage25FlareTextToImageRequest } from "@apicity/kie";
import {
  GptImage25FlareImageToImageRequestSchema,
  GptImage25FlareTextToImageRequestSchema,
  GptImage25SunburstImageToImageRequestSchema,
  GptImage25SunburstTextToImageRequestSchema,
} from "@apicity/kie/zod";

const resolution = GptImage25FlareTextToImageRequestSchema.shape.input.shape.resolution.default("2K");

export const GPT_IMAGE_2_5_MODELS = {
  flare: {
    key: "gpt_image",
    tool: "generate_kie_gpt_image_2_5_flare_image",
    label: "GPT Image 2.5 Flare",
    textSchema: GptImage25FlareTextToImageRequestSchema.safeExtend({
      input: GptImage25FlareTextToImageRequestSchema.shape.input.extend({ resolution }),
    }),
    editSchema: GptImage25FlareImageToImageRequestSchema.safeExtend({
      input: GptImage25FlareImageToImageRequestSchema.shape.input.extend({ resolution }),
    }),
  },
  sunburst: {
    key: "gpt_image_sunburst",
    tool: "generate_kie_gpt_image_2_5_sunburst_image",
    label: "GPT Image 2.5 Sunburst",
    textSchema: GptImage25SunburstTextToImageRequestSchema.safeExtend({
      input: GptImage25SunburstTextToImageRequestSchema.shape.input.extend({ resolution }),
    }),
    editSchema: GptImage25SunburstImageToImageRequestSchema.safeExtend({
      input: GptImage25SunburstImageToImageRequestSchema.shape.input.extend({ resolution }),
    }),
  },
} as const;

export type GptImage25Variant = keyof typeof GPT_IMAGE_2_5_MODELS;
export type GptImage25Input = GptImage25FlareTextToImageRequest["input"];

export const DEFAULT_GPT_IMAGE_MODEL = GPT_IMAGE_2_5_MODELS.sunburst;

export const GPT_IMAGE_2_5_REFERENCE_SCHEMA = z.array(
  GptImage25FlareImageToImageRequestSchema.shape.input.shape.input_urls.element,
).max(readSlotConstraints(GptImage25FlareImageToImageRequestSchema.shape.input.shape.input_urls)?.max ?? 16).optional();

export function gptImage25Request(
  variant: GptImage25Variant,
  input: GptImage25Input,
  imageUrls: string[],
) {
  const config = GPT_IMAGE_2_5_MODELS[variant];
  const schema = imageUrls.length > 0 ? config.editSchema : config.textSchema;
  return schema.safeParse({
    model: schema.shape.model.value,
    input: {
      ...input,
      ...(imageUrls.length > 0 ? { input_urls: imageUrls } : {}),
    },
  });
}

export function buildGptImage25Payload(
  variant: GptImage25Variant,
  input: GptImage25Input,
  imageUrls: string[],
) {
  const parsed = gptImage25Request(variant, input, imageUrls);
  if (!parsed.success) throw parsed.error;
  return parsed.data;
}
