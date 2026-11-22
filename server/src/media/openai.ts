import { OpenAiImageComplexitySchema } from "@apicity/openai/zod";
import { z, type RefinementCtx, type ZodObject, type ZodRawShape } from "zod";
import type { ModelEntry, WireSpec } from "./types.js";

type AnyObject = ZodObject<ZodRawShape>;
type Value = Record<string, unknown>;

interface OpenAiImageModel {
  entry: Omit<ModelEntry, "id">;
  input: AnyObject;
}

const PROMPT = z.string().min(1).describe("Text prompt describing the image to create or edit");
const SIZES = ["1024x1024", "1536x1024", "1024x1536"] as const;
const FORMATS = ["png", "jpeg", "webp"] as const;
const BACKGROUNDS = ["auto", "opaque", "transparent"] as const;
const QUALITIES_25_26 = ["low", "medium", "high", "xhigh", "max"] as const;
const QUALITIES_2 = ["low", "medium", "high"] as const;

function addIssue(ctx: RefinementCtx, path: string, message: string): void {
  ctx.addIssue({ code: "custom", message, path: path ? [path] : [] });
}

function checkImageRules(value: Value, ctx: RefinementCtx): void {
  if (typeof value.mask === "string" && value.mask && typeof value.markup === "string" && value.markup) {
    addIssue(ctx, "markup", "can't be combined with a mask");
  }
  if (value.background === "transparent" && value.output_format === "jpeg") {
    addIssue(ctx, "background", "a transparent background needs png or webp output");
  }
}

function buildInput(qualities: readonly [string, ...string[]], is26: boolean): AnyObject {
  const base = z.object({
    prompt: PROMPT,
    images: z.array(z.string().min(1)).max(16).optional().describe("Input images to edit, up to 16"),
    mask: z.string().min(1).optional().describe("Mask image for inpainting"),
    ...(is26 ? { markup: z.string().min(1).optional().describe("Markup guide image for the edit; cannot be combined with a mask") } : {}),
    size: z.enum(SIZES).default("1024x1536").describe("Output image dimensions"),
    quality: z.enum(qualities).default("high").describe("Rendering quality"),
    ...(is26 ? { complexity: OpenAiImageComplexitySchema.optional().describe("Reasoning complexity for GPT Image 2.6") } : {}),
    background: z.enum(BACKGROUNDS).default("auto").describe("Background transparency mode"),
    output_format: z.enum(FORMATS).default("png").describe("Output image format"),
    input_fidelity: z.enum(["low", "high"]).optional().describe("How closely edits preserve input image details"),
  });
  return base.superRefine((value, ctx) => checkImageRules(value, ctx)) as unknown as AnyObject;
}

const INPUT_26 = buildInput(QUALITIES_25_26, true);
const INPUT_25 = buildInput(QUALITIES_25_26, false);
const INPUT_2 = buildInput(QUALITIES_2, false);

const OPENAI_IMAGE_MODELS: Readonly<Record<string, OpenAiImageModel>> = {
  "gpt-image-2.6-sunburst": {
    entry: {
      media: "image",
      operations: ["text_to_image", "edit_image"],
      title: "GPT Image 2.6 Sunburst (OpenAI)",
      family: "GPT Image 2.6 Sunburst",
      guide: "gpt_image_26",
      dialect: "natural",
    },
    input: INPUT_26,
  },
  "gpt-image-2.6-flare": {
    entry: {
      media: "image",
      operations: ["text_to_image", "edit_image"],
      title: "GPT Image 2.6 Flare (OpenAI)",
      family: "GPT Image 2.6 Flare",
      guide: "gpt_image_26",
      dialect: "natural",
    },
    input: INPUT_26,
  },
  "gpt-image-2.5-sunburst": {
    entry: {
      media: "image",
      operations: ["text_to_image", "edit_image"],
      title: "GPT Image 2.5 Sunburst (OpenAI)",
      family: "GPT Image 2.5 Sunburst",
      guide: "gpt_image",
      dialect: "natural",
    },
    input: INPUT_25,
  },
  "gpt-image-2.5-flare": {
    entry: {
      media: "image",
      operations: ["text_to_image", "edit_image"],
      title: "GPT Image 2.5 Flare (OpenAI)",
      family: "GPT Image 2.5 Flare",
      guide: "gpt_image",
      dialect: "natural",
    },
    input: INPUT_25,
  },
  "gpt-image-2": {
    entry: {
      media: "image",
      operations: ["text_to_image", "edit_image"],
      title: "GPT Image 2 (OpenAI)",
      family: "GPT Image 2",
      guide: "gpt_image",
      dialect: "natural",
      hidden: true,
    },
    input: INPUT_2,
  },
};

export function hasOpenAiImageSources(request: Record<string, unknown>): boolean {
  return Array.isArray(request.images) && request.images.length > 0;
}

export function openaiImageDotPath(edit: boolean): string {
  return edit ? "v1.images.edits" : "v1.images.generations";
}

export function openaiImageWire(apiId: string): WireSpec | null {
  const model = Object.hasOwn(OPENAI_IMAGE_MODELS, apiId) ? OPENAI_IMAGE_MODELS[apiId] : undefined;
  if (!model) return null;
  return {
    input: model.input,
    fixed: { model: apiId },
    wrap: (value) => ({ ...value, model: apiId }),
    request: z.record(z.string(), z.unknown()),
  };
}

export const OPENAI_IMAGE_MODEL_ENTRIES: readonly ModelEntry[] = Object.entries(OPENAI_IMAGE_MODELS)
  .map(([apiId, model]) => ({ id: `openai:${apiId}`, ...model.entry }));
