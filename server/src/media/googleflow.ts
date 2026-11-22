import {
  GoogleFlowImagesRequestSchema,
  GoogleFlowVideosRequestSchema,
} from "@apicity/googleflow/zod";
import { z, type RefinementCtx, type ZodObject, type ZodRawShape, type ZodType } from "zod";
import type { ModeSpec, ModelEntry, WireSpec } from "./types.js";

type AnyObject = ZodObject<ZodRawShape>;
type Value = Record<string, unknown>;

interface GoogleFlowModel {
  video: boolean;
  entry: Omit<ModelEntry, "id">;
  input: AnyObject;
  wrap: (value: Value) => Value;
  request: ZodType;
}

const PROMPT = z.string().min(1).describe("What to generate; name connected inputs by their slot, such as @image1");
const IMAGE_ASPECT_RATIOS = ["16:9", "4:3", "1:1", "3:4", "9:16", "auto"] as const;
const VIDEO_ASPECT_RATIOS = ["landscape", "portrait"] as const;
const VIDEO_RESOLUTIONS = ["360p", "720p"] as const;
const SEED = z.number().int().min(0).max(2_147_483_647).optional().describe("Seed for reproducible output");

function list(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function addIssue(ctx: RefinementCtx, path: string, message: string): void {
  ctx.addIssue({ code: "custom", message, path: path ? [path] : [] });
}

function indexedFields(prefix: string, items: readonly string[]): Record<string, string> {
  return Object.fromEntries(items.map((item, index) => [`${prefix}${index + 1}`, item]));
}

const NANO_BANANA_2_INPUT = z.object({
  prompt: PROMPT,
  referenceImages: z.array(z.string().min(1)).max(10).optional().describe("Reference or edit images, up to 10"),
  aspectRatio: z.enum(IMAGE_ASPECT_RATIOS).optional().describe("Output aspect ratio; auto requires at least one reference image"),
  seed: SEED,
}).superRefine((value, ctx) => {
  if (value.aspectRatio === "auto" && list(value.referenceImages).length === 0) {
    addIssue(ctx, "aspectRatio", "aspectRatio auto requires at least one reference image");
  }
});

function nanoBanana2Request(value: Value): Value {
  const images = list(value.referenceImages);
  return {
    prompt: String(value.prompt),
    model: "nano-banana-2",
    ...(text(value.aspectRatio) ? { aspectRatio: value.aspectRatio } : {}),
    count: 1,
    ...(typeof value.seed === "number" ? { seed: value.seed } : {}),
    ...indexedFields("reference_", images),
  };
}

function checkOmniVideo(value: Value, ctx: RefinementCtx, maxDualFrameSeconds?: number): void {
  const hasStart = text(value.startImage) !== null;
  const hasEnd = text(value.endImage) !== null;
  const hasVideo = text(value.referenceVideo_1) !== null;
  const hasImages = list(value.referenceImages).length > 0;
  if (hasEnd && !hasStart) addIssue(ctx, "endImage", "endImage requires startImage");
  if ((hasStart || hasEnd) && hasImages) {
    addIssue(ctx, "referenceImages", "referenceImages cannot be combined with startImage/endImage keyframes");
  }
  if ((hasStart || hasEnd) && hasVideo) {
    addIssue(ctx, "referenceVideo_1", "referenceVideo_1 cannot be combined with startImage/endImage keyframes");
  }
  if (hasVideo && value.duration !== undefined) {
    addIssue(ctx, "duration", "video-to-video does not accept an explicit duration");
  }
  if (maxDualFrameSeconds !== undefined && hasStart && hasEnd && typeof value.duration === "number" && value.duration > maxDualFrameSeconds) {
    addIssue(ctx, "duration", `at most ${maxDualFrameSeconds} seconds with both start and end frames`);
  }
}

function omniVideoInput(maxImages: number, duration: ZodType, allowSilent: boolean, maxDualFrameSeconds?: number): AnyObject {
  return z.object({
    prompt: PROMPT,
    startImage: z.string().min(1).optional().describe("First frame image"),
    endImage: z.string().min(1).optional().describe("Last frame image; requires startImage"),
    referenceImages: z.array(z.string().min(1)).max(maxImages).optional().describe(`Reference images, up to ${maxImages}`),
    referenceAudios: z.array(z.string().min(1)).max(5).optional().describe("Reference audio clips, up to 5"),
    referenceVideo_1: z.string().min(1).optional().describe("Source video for video-to-video editing"),
    aspectRatio: z.enum(VIDEO_ASPECT_RATIOS).optional().describe("Output aspect ratio"),
    resolution: z.enum(VIDEO_RESOLUTIONS).optional().describe("Output resolution (360p or 720p)"),
    duration,
    ...(allowSilent ? { returnSilentVideos: z.boolean().optional().describe("Return silent video output") } : {}),
    seed: SEED,
  }).superRefine((value, ctx) => checkOmniVideo(value, ctx, maxDualFrameSeconds)) as unknown as AnyObject;
}

function omniVideoRequest(model: "omni-flash-1.2" | "omni-flash", value: Value): Value {
  const startImage = text(value.startImage);
  const endImage = text(value.endImage);
  const referenceVideo = text(value.referenceVideo_1);
  const images = list(value.referenceImages);
  const audios = list(value.referenceAudios);
  return {
    prompt: String(value.prompt),
    model,
    ...(text(value.aspectRatio) ? { aspectRatio: value.aspectRatio } : {}),
    ...(text(value.resolution) ? { resolution: value.resolution } : {}),
    ...(!referenceVideo && typeof value.duration === "number" ? { duration: value.duration } : {}),
    count: 1,
    ...(typeof value.seed === "number" ? { seed: value.seed } : {}),
    ...(startImage ? { startImage } : {}),
    ...(endImage ? { endImage } : {}),
    ...indexedFields("referenceImage_", images),
    ...indexedFields("referenceAudio_", audios),
    ...(referenceVideo ? { referenceVideo_1: referenceVideo } : {}),
    ...(typeof value.returnSilentVideos === "boolean" ? { returnSilentVideos: value.returnSilentVideos } : {}),
    async: true,
  };
}

const OMNI_REFS: ModelEntry["refs"] = {
  first_frame: "startImage",
  last_frame: "endImage",
  image: "referenceImages",
  audio: "referenceAudios",
  video: "referenceVideo_1",
};

const OMNI_12_MODES: readonly ModeSpec[] = [
  { id: "t2v", label: "Text to video", roles: [] },
  { id: "i2v", label: "Frames", roles: ["first_frame", "last_frame"], requireAny: ["first_frame"], defaults: { duration: 10 } },
  { id: "r2v", label: "References", roles: ["image", "audio"], requireAny: ["image", "audio"] },
  { id: "v2v", label: "Edit video", roles: ["video", "image", "audio"], requireAny: ["video"], omit: ["duration"] },
];

const OMNI_11_MODES: readonly ModeSpec[] = [
  { id: "t2v", label: "Text to video", roles: [] },
  { id: "i2v", label: "Frames", roles: ["first_frame", "last_frame"], requireAny: ["first_frame"] },
  { id: "r2v", label: "References", roles: ["image", "audio"], requireAny: ["image", "audio"] },
  { id: "v2v", label: "Edit video", roles: ["video", "image", "audio"], requireAny: ["video"], omit: ["duration"] },
];

const GOOGLEFLOW_MODELS: Readonly<Record<string, GoogleFlowModel>> = {
  "omni-flash-1.2": {
    video: true,
    entry: {
      media: "video",
      operations: ["text_to_video", "image_to_video", "reference_to_video", "edit_video"],
      title: "Gemini Omni 1.2 Flash (Google Flow)",
      family: "Gemini Omni 1.2 Flash",
      dialect: "natural_strip_frames",
      refs: OMNI_REFS,
      modes: OMNI_12_MODES,
      defaults: { aspectRatio: "portrait", resolution: "720p", duration: 8 },
      pinnedDefaults: ["duration"],
    },
    input: omniVideoInput(
      10,
      z.number().int().min(3).max(15).optional().describe("Output seconds, 3-15 (3-10 with start and end frames)"),
      true,
      10,
    ),
    wrap: (value) => omniVideoRequest("omni-flash-1.2", value),
    request: GoogleFlowVideosRequestSchema,
  },
  "omni-flash": {
    video: true,
    entry: {
      media: "video",
      operations: ["text_to_video", "image_to_video", "reference_to_video", "edit_video"],
      title: "Gemini Omni 1.1 Flash (Google Flow)",
      family: "Gemini Omni 1.1 Flash",
      dialect: "natural_strip_frames",
      refs: OMNI_REFS,
      modes: OMNI_11_MODES,
      defaults: { aspectRatio: "portrait", resolution: "720p", duration: 8 },
      pinnedDefaults: ["duration"],
    },
    input: omniVideoInput(
      7,
      z.union([z.literal(4), z.literal(6), z.literal(8), z.literal(10)]).optional().describe("Output seconds (4, 6, 8, or 10)"),
      false,
    ),
    wrap: (value) => omniVideoRequest("omni-flash", value),
    request: GoogleFlowVideosRequestSchema,
  },
  "nano-banana-2": {
    video: false,
    entry: {
      media: "image",
      operations: ["text_to_image", "edit_image"],
      title: "Nano Banana 2.1 (Google Flow)",
      family: "Nano Banana 2.1",
      guide: "nano_banana",
      dialect: "natural",
      refs: { image: "referenceImages" },
      defaults: { aspectRatio: "9:16" },
    },
    input: NANO_BANANA_2_INPUT,
    wrap: nanoBanana2Request,
    request: GoogleFlowImagesRequestSchema,
  },
};

export function isGoogleFlowVideoModel(apiId: string): boolean {
  return Boolean(Object.hasOwn(GOOGLEFLOW_MODELS, apiId) && GOOGLEFLOW_MODELS[apiId]!.video);
}

export function googleFlowDotPath(apiId: string): string {
  return isGoogleFlowVideoModel(apiId) ? "v1.videos" : "v1.images";
}

export function googleFlowWire(apiId: string): WireSpec | null {
  const model = Object.hasOwn(GOOGLEFLOW_MODELS, apiId) ? GOOGLEFLOW_MODELS[apiId] : undefined;
  if (!model) return null;
  return {
    input: model.input,
    fixed: { model: apiId },
    wrap: model.wrap,
    request: model.request,
  };
}

export const GOOGLEFLOW_MODEL_ENTRIES: readonly ModelEntry[] = Object.entries(GOOGLEFLOW_MODELS)
  .map(([apiId, model]) => ({ id: `googleflow:${apiId}`, ...model.entry }));
