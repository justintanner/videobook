import {
  GoogleGenerateContentRequestSchema,
  GoogleImageAspectRatioSchema,
  GoogleImageSizeSchema,
  GoogleInteractionCreateRequestSchema,
  GoogleInteractionVideoAspectRatioSchema,
  GoogleInteractionVideoResolutionSchema,
  GoogleThinkingLevelSchema,
} from "@apicity/google/zod";
import { z, type ZodObject, type ZodRawShape, type ZodType } from "zod";
import type { ModeSpec, ModelEntry, WireSpec } from "./types.js";

type AnyObject = ZodObject<ZodRawShape>;
type Value = Record<string, unknown>;

interface GoogleModel {
  interaction: boolean;
  entry: Omit<ModelEntry, "id">;
  input: AnyObject;
  wrap: (value: Value) => Value;
  request: ZodType;
}

const PROMPT = z.string().min(1).describe("What to generate; name connected inputs by their slot, such as @image1");

function list(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

const NANO_BANANA_INPUT = z.object({
  prompt: PROMPT,
  images: z.array(z.string().min(1)).max(14).optional().describe("Reference or edit images, up to 14"),
  aspect_ratio: GoogleImageAspectRatioSchema.default("9:16").describe("Output aspect ratio"),
  image_size: GoogleImageSizeSchema.default("2K").describe("Output image size"),
  output_format: z.enum(["png", "jpeg"]).default("png").describe("Output image format"),
  thinking_level: GoogleThinkingLevelSchema.optional().describe("Model thinking effort"),
});

function nanoBananaRequest(value: Value): Value {
  const parts: Array<Record<string, unknown>> = [
    ...list(value.images).map((ref) => ({ inlineData: { mimeType: "image/png", data: ref } })),
    { text: String(value.prompt) },
  ];
  const outputMime = value.output_format === "jpeg" ? "image/jpeg" : "image/png";
  return {
    contents: [{ role: "user", parts }],
    generationConfig: {
      responseModalities: ["IMAGE"],
      imageConfig: {
        aspectRatio: value.aspect_ratio,
        imageSize: value.image_size,
        imageOutputOptions: { mimeType: outputMime },
      },
      ...(typeof value.thinking_level === "string" ? { thinkingConfig: { thinkingLevel: value.thinking_level } } : {}),
    },
  };
}

function omniInput(maxSeconds: number): AnyObject {
  return z.object({
    prompt: PROMPT,
    images: z.array(z.string().min(1)).max(10).optional().describe("Reference images, up to 10"),
    videos: z.array(z.string().min(1)).max(3).optional().describe("Input or reference videos, up to 3"),
    aspect_ratio: GoogleInteractionVideoAspectRatioSchema.optional().describe("Output aspect ratio"),
    resolution: GoogleInteractionVideoResolutionSchema.optional().describe("Output resolution"),
    duration: z.number().int().min(3).max(maxSeconds).optional().describe(`Output length in whole seconds, 3-${maxSeconds}`),
    task: z.enum(["text_to_video", "image_to_video", "reference_to_video", "edit", "extend"]).optional()
      .describe("Video generation task type (set to edit for video editing)"),
    seed: z.number().int().min(0).max(2_147_483_647).optional().describe("Seed for reproducible output"),
  }) as unknown as AnyObject;
}

function omniRequest(model: string, value: Value): Value {
  const content: Array<Record<string, unknown>> = [
    { type: "text", text: String(value.prompt) },
    ...list(value.images).map((ref) => ({ type: "image", data: ref, mime_type: "image/png" })),
    ...list(value.videos).map((ref) => ({ type: "video", data: ref, mime_type: "video/mp4" })),
  ];
  const videoFormat: Record<string, unknown> = {
    type: "video",
    delivery: "inline",
    ...(typeof value.aspect_ratio === "string" ? { aspect_ratio: value.aspect_ratio } : {}),
    ...(typeof value.resolution === "string" ? { resolution: value.resolution } : {}),
    ...(typeof value.duration === "number" ? { duration: `${value.duration}s` } : {}),
  };
  const generationConfig: Record<string, unknown> = {
    ...(typeof value.seed === "number" ? { seed: value.seed } : {}),
    ...(typeof value.task === "string" ? { video_config: { task: value.task } } : {}),
  };
  return {
    model,
    store: false,
    input: [{ type: "user_input", content }],
    response_format: [videoFormat],
    ...(Object.keys(generationConfig).length > 0 ? { generation_config: generationConfig } : {}),
  };
}

const OMNI_MODES: readonly ModeSpec[] = [
  { id: "t2v", label: "Text to video", roles: [] },
  { id: "r2v", label: "References", roles: ["image", "video"], requireAny: ["image", "video"] },
  { id: "v2v", label: "Edit video", roles: ["video", "image"], requireAny: ["video"], defaults: { task: "edit" }, omit: ["duration", "aspect_ratio"] },
];

const GOOGLE_MODELS: Readonly<Record<string, GoogleModel>> = {
  "gemini-nano-banana-2.1": {
    interaction: false,
    entry: {
      media: "image",
      operations: ["text_to_image", "edit_image"],
      title: "Nano Banana 2.1 (Google)",
      family: "Nano Banana 2.1",
      guide: "nano_banana",
      dialect: "natural",
    },
    input: NANO_BANANA_INPUT,
    wrap: nanoBananaRequest,
    request: GoogleGenerateContentRequestSchema,
  },
  "gemini-omni-1.2-flash": {
    interaction: true,
    entry: {
      media: "video",
      operations: ["text_to_video", "image_to_video", "reference_to_video", "edit_video"],
      title: "Gemini Omni 1.2 Flash (Google)",
      family: "Gemini Omni 1.2 Flash",
      dialect: "natural",
      modes: OMNI_MODES,
      defaults: { aspect_ratio: "9:16", resolution: "720p", duration: 8 },
      pinnedDefaults: ["resolution", "duration"],
    },
    input: omniInput(15),
    wrap: (value) => omniRequest("gemini-omni-1.2-flash", value),
    request: GoogleInteractionCreateRequestSchema,
  },
  "gemini-omni-1.1-flash-preview": {
    interaction: true,
    entry: {
      media: "video",
      operations: ["text_to_video", "image_to_video", "reference_to_video", "edit_video"],
      title: "Gemini Omni 1.1 Flash (Google)",
      family: "Gemini Omni 1.1 Flash",
      dialect: "natural",
      modes: OMNI_MODES,
      defaults: { aspect_ratio: "9:16", resolution: "720p", duration: 8 },
      pinnedDefaults: ["resolution", "duration"],
    },
    input: omniInput(10),
    wrap: (value) => omniRequest("gemini-omni-1.1-flash-preview", value),
    request: GoogleInteractionCreateRequestSchema,
  },
};

export function isGoogleInteractionModel(apiId: string): boolean {
  return Boolean(Object.hasOwn(GOOGLE_MODELS, apiId) && GOOGLE_MODELS[apiId]!.interaction);
}

export function googleDotPath(apiId: string): string {
  return isGoogleInteractionModel(apiId)
    ? "v1.projects.locations.global.interactions"
    : "v1.projects.locations.global.publishers.google.models.generateContent";
}

export function googleWire(apiId: string): WireSpec | null {
  const model = Object.hasOwn(GOOGLE_MODELS, apiId) ? GOOGLE_MODELS[apiId] : undefined;
  if (!model) return null;
  return {
    input: model.input,
    fixed: {},
    wrap: model.wrap,
    request: model.request,
  };
}

export const GOOGLE_MODEL_ENTRIES: readonly ModelEntry[] = Object.entries(GOOGLE_MODELS)
  .map(([apiId, model]) => ({ id: `google:${apiId}`, ...model.entry }));
