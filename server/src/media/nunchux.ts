import {
  NunchuxAlibabaVideoSynthesisRequestSchema,
  NunchuxBytedanceGenerationTasksRequestSchema,
  NunchuxGoogleInteractionsRequestSchema,
  NunchuxMinimaxVideoGenerationRequestSchema,
  NunchuxOpenAiImagesEditsRequestSchema,
  NunchuxOpenAiImagesGenerationsRequestSchema,
} from "@apicity/nunchux";
import { z, type RefinementCtx, type ZodObject, type ZodRawShape, type ZodType } from "zod";
import type { InputRules, ModeSpec, ModelEntry, RefRole, WireSpec } from "./types.js";

type AnyObject = ZodObject<ZodRawShape>;
type Value = Record<string, unknown>;

export type NunchuxFamily = "alibaba" | "bytedance" | "google" | "minimax" | "openai";

const SUBMIT_DOT_PATHS: Readonly<Record<NunchuxFamily, string>> = {
  alibaba: "v1.alibaba.services.aigc.videoGeneration.videoSynthesis",
  bytedance: "v1.bytedance.contents.generations.tasks",
  google: "v1.google.v1beta.interactions",
  minimax: "v1.minimax.v2.videoGeneration",
  openai: "v2.openai.images.generations",
};

const OPENAI_EDIT_DOT_PATH = "v2.openai.images.edits";

interface NunchuxModel {
  family: NunchuxFamily;
  entry: Omit<ModelEntry, "id">;
  input: AnyObject;
  wrap: (value: Value) => Value;
  request: ZodType;
}

const PROMPT = z.string().min(1).describe("What to generate; name connected inputs by their slot, such as @image1");

function url(description: string): ZodType {
  return z.string().min(1).optional().describe(description);
}

function urls(max: number, description: string): ZodType {
  return z.array(z.string().min(1)).max(max).optional().describe(description);
}

function list(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function addIssue(ctx: RefinementCtx, path: string, message: string): void {
  ctx.addIssue({ code: "custom", message, path: path ? [path] : [] });
}

function referenceCount(value: Value): number {
  return list(value.image_urls).length + list(value.video_urls).length + list(value.audio_urls).length;
}

function checkFrames(value: Value, ctx: RefinementCtx): void {
  const first = text(value.first_frame_url);
  const last = text(value.last_frame_url);
  if (last && !first) addIssue(ctx, "last_frame_url", "A last frame needs a first frame");
  if ((first || last) && referenceCount(value) > 0) addIssue(ctx, "first_frame_url", "Frames can't be combined with reference media");
}

const FRAME_FIELDS: ZodRawShape = {
  first_frame_url: url("First frame image"),
  last_frame_url: url("Last frame image; needs a first frame"),
};

const TEXT_MODE: ModeSpec = { id: "t2v", label: "Text to video", roles: [] };
const FRAMES_MODE: ModeSpec = { id: "i2v", label: "Frames", roles: ["first_frame", "last_frame"], requireAny: ["first_frame"] };

function referencesMode(roles: readonly RefRole[], extra: Partial<ModeSpec> = {}): ModeSpec {
  return { id: "r2v", label: "References", roles, requireAny: roles, ...extra };
}

const WAN_30_INPUT = z.object({
  prompt: PROMPT,
  ...FRAME_FIELDS,
  image_urls: urls(10, "Reference images, up to 10"),
  video_urls: urls(5, "Reference videos"),
  audio_urls: urls(5, "Reference audio, up to 5 clips totaling 15 seconds"),
  resolution: z.enum(["480P", "720P", "1080P"]).default("1080P").describe("Output resolution"),
  duration: z.number().int().min(2).max(30).default(5).describe("Output seconds, 2-30"),
}).superRefine((value, ctx) => checkFrames(value, ctx));

function alibabaMedia(value: Value): Array<{ type: string; url: string }> {
  return [
    ...(text(value.first_frame_url) ? [{ type: "first_frame", url: text(value.first_frame_url)! }] : []),
    ...(text(value.last_frame_url) ? [{ type: "last_frame", url: text(value.last_frame_url)! }] : []),
    ...(text(value.video_url) ? [{ type: "video", url: text(value.video_url)! }] : []),
    ...list(value.image_urls).map((ref) => ({ type: "reference_image", url: ref })),
    ...list(value.video_urls).map((ref) => ({ type: "reference_video", url: ref })),
    ...list(value.audio_urls).map((ref) => ({ type: "reference_audio", url: ref })),
  ];
}

function alibabaRequest(model: string, value: Value): Value {
  const media = alibabaMedia(value);
  return {
    model,
    input: { prompt: value.prompt, ...(media.length > 0 ? { media } : {}) },
    parameters: {
      resolution: value.resolution,
      ...(typeof value.duration === "number" ? { duration: value.duration } : {}),
      watermark: false,
    },
  };
}

function alibabaEditInput(resolutions: readonly [string, ...string[]], minSeconds: number, maxSeconds: number): AnyObject {
  return z.object({
    prompt: PROMPT,
    video_url: z.string().min(1).describe("The video to edit"),
    resolution: z.enum(resolutions).default(resolutions.at(-1)!).describe("Output resolution"),
    duration: z.number().int().min(minSeconds).max(maxSeconds).optional()
      .describe(`Output seconds, ${minSeconds}-${maxSeconds}; omit to follow the source video`),
  });
}

const EDIT_MODE: ModeSpec = { id: "v2v", label: "Edit video", roles: ["video"], requireAny: ["video"] };

function alibabaModel(model: string, input: AnyObject, entry: Omit<ModelEntry, "id">): NunchuxModel {
  return {
    family: "alibaba",
    entry,
    input,
    wrap: (value) => alibabaRequest(model, value),
    request: NunchuxAlibabaVideoSynthesisRequestSchema,
  };
}

function contentItems(value: Value, wrapUrl: (url: string) => Value): Value[] {
  const frame = (role: string, ref: string | null) => ref ? [{ type: "image_url", role, image_url: wrapUrl(ref) }] : [];
  return [
    { type: "text", text: value.prompt },
    ...frame("first_frame", text(value.first_frame_url)),
    ...frame("last_frame", text(value.last_frame_url)),
    ...list(value.image_urls).map((ref) => ({ type: "image_url", role: "reference_image", image_url: wrapUrl(ref) })),
    ...list(value.video_urls).map((ref) => ({ type: "video_url", role: "reference_video", video_url: wrapUrl(ref) })),
    ...list(value.audio_urls).map((ref) => ({ type: "audio_url", role: "reference_audio", audio_url: wrapUrl(ref) })),
  ];
}

interface SeedanceLimits {
  images: number;
  videos: number;
  audios: number;
  maxSeconds: number;
}

function seedanceInput(limits: SeedanceLimits): AnyObject {
  return z.object({
    prompt: PROMPT,
    ...FRAME_FIELDS,
    image_urls: urls(limits.images, `Reference images, up to ${limits.images}`),
    video_urls: urls(limits.videos, `Reference videos, up to ${limits.videos}`),
    audio_urls: urls(limits.audios, `Reference audio clips of up to 30 seconds, up to ${limits.audios}`),
    duration: z.number().int().min(4).max(limits.maxSeconds).default(5).describe(`Output length in whole seconds, 4-${limits.maxSeconds}`),
    resolution: z.enum(["480p", "720p"]).default("720p").describe("Output resolution"),
    generate_audio: z.boolean().default(true).describe("Generate a soundtrack with the video"),
  }).superRefine((value, ctx) => checkFrames(value, ctx));
}

function seedanceModel(model: string, title: string, guide: ModelEntry["guide"], limits: SeedanceLimits): NunchuxModel {
  return {
    family: "bytedance",
    entry: {
      media: "video",
      operations: ["text_to_video", "image_to_video", "reference_to_video"],
      title,
      guide,
      dialect: "natural_strip_frames",
      modes: [TEXT_MODE, FRAMES_MODE, referencesMode(["image", "video", "audio"])],
    },
    input: seedanceInput(limits),
    wrap: (value) => ({
      model,
      content: contentItems(value, (ref) => ({ url: ref })),
      duration: value.duration,
      resolution: value.resolution,
      generate_audio: value.generate_audio,
    }),
    request: NunchuxBytedanceGenerationTasksRequestSchema,
  };
}

const MINIMAX_MAX_FILES = 12;
const MINIMAX_ASPECTS = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"] as const;

const MINIMAX_INPUT = z.object({
  prompt: z.string().min(1).max(7000).describe("What to generate, up to 7,000 characters"),
  ...FRAME_FIELDS,
  image_urls: urls(9, "Reference images, up to 9"),
  video_urls: urls(3, "Reference clips of 2-15 seconds each, 15 seconds in total, up to 3"),
  audio_urls: urls(1, "One reference audio track"),
  resolution: z.enum(["768P", "2K"]).default("2K").describe("Output tier"),
  duration: z.number().int().min(4).max(15).default(5).describe("Clip length in whole seconds, 4-15"),
  aspect_ratio: z.enum(MINIMAX_ASPECTS).optional().describe("Aspect ratio of a text-to-video clip; frames and references keep their source shape"),
}).superRefine((value, ctx) => {
  const record = value as Value;
  checkFrames(record, ctx);
  if (referenceCount(record) > MINIMAX_MAX_FILES) addIssue(ctx, "image_urls", `References can't exceed ${MINIMAX_MAX_FILES} files in all`);
  const media = referenceCount(record) > 0 || text(record.first_frame_url) !== null;
  if (!media && !text(record.aspect_ratio)) addIssue(ctx, "aspect_ratio", "Choose an aspect ratio for text-to-video");
});

function minimaxRequest(value: Value): Value {
  const content = contentItems(value, (ref) => ({ url: ref }));
  return {
    model: "MiniMax-H3",
    content,
    resolution: value.resolution,
    duration: value.duration,
    ...(content.length === 1 && text(value.aspect_ratio) ? { ratio: value.aspect_ratio } : {}),
  };
}

const MINIMAX_CLIPS: InputRules = { refDurationMs: { video: { minimum: 2000, maximum: 15_000, maximumTotal: 15_000 } } };

const NANO_BANANA_ASPECTS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9", "1:8", "8:1", "1:4", "4:1"] as const;

const NANO_BANANA_INPUT = z.object({
  prompt: PROMPT,
  image_urls: urls(14, "Images to edit, up to 14"),
  aspect_ratio: z.enum(NANO_BANANA_ASPECTS).optional().describe("Output aspect ratio; an edit without one keeps the first image's shape"),
  resolution: z.enum(["1K", "2K", "4K"]).default("2K").describe("Output size"),
});

const PendingImagePartSchema = z.object({ type: z.literal("image"), ref: z.string().min(1) });

const NunchuxPendingInteractionsRequestSchema = NunchuxGoogleInteractionsRequestSchema.extend({
  input: z.array(z.union([z.object({ type: z.literal("text"), text: z.string() }), PendingImagePartSchema])).min(1),
});

export type NunchuxPendingImagePart = z.infer<typeof PendingImagePartSchema>;

function nanoBananaRequest(value: Value): Value {
  return {
    model: "gemini-nano-banana-2.1",
    input: [{ type: "text", text: value.prompt }, ...list(value.image_urls).map((ref) => ({ type: "image", ref }))],
    response_format: {
      type: "image",
      image_size: value.resolution,
      ...(text(value.aspect_ratio) ? { aspect_ratio: value.aspect_ratio } : {}),
    },
  };
}

const GPT_IMAGE_SIZES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "1:1": { "1K": "1024x1024", "2K": "2048x2048", "4K": "2880x2880" },
  "16:9": { "1K": "1536x864", "2K": "2048x1152", "4K": "3840x2160" },
  "9:16": { "1K": "864x1536", "2K": "1152x2048", "4K": "2160x3840" },
  "4:3": { "1K": "1152x864", "2K": "2048x1536", "4K": "3264x2448" },
  "3:4": { "1K": "864x1152", "2K": "1536x2048", "4K": "2448x3264" },
  "3:2": { "1K": "1536x1024", "2K": "2448x1632", "4K": "3504x2336" },
  "2:3": { "1K": "1024x1536", "2K": "1632x2448", "4K": "2336x3504" },
  "21:9": { "1K": "1680x720", "2K": "2688x1152", "4K": "3808x1632" },
};

const GPT_IMAGE_ASPECTS = Object.keys(GPT_IMAGE_SIZES) as [string, ...string[]];

const GPT_IMAGE_INPUT = z.object({
  prompt: z.string().min(1).max(32_000).describe("What to generate or how to change the images, up to 32,000 characters; name connected inputs by their slot, such as @image1"),
  image_urls: urls(16, "Images to edit, up to 16"),
  mask_url: url("Mask over the first image; its transparent areas may change"),
  markup: url("Markup PNG laid over the first image, with the same dimensions"),
  aspect_ratio: z.enum(GPT_IMAGE_ASPECTS).default("1:1").describe("Output aspect ratio"),
  resolution: z.enum(["1K", "2K", "4K"]).default("2K").describe("Output size"),
  quality: z.enum(["low", "medium", "high"]).default("high").describe("Rendering quality; high is the top setting Nunchux offers"),
  complexity: z.enum(["low", "medium", "high"]).optional().describe("Planning effort, separate from quality; omit for OpenAI's default"),
  output_format: z.enum(["png", "jpeg", "webp"]).default("png").describe("Output format"),
  background: z.enum(["auto", "opaque", "transparent"]).default("auto").describe("Background; transparent needs png or webp"),
}).superRefine((value, ctx) => {
  const record = value as Value;
  if (record.background === "transparent" && record.output_format === "jpeg") addIssue(ctx, "background", "A transparent background needs png or webp output");
  if (text(record.mask_url) && text(record.markup)) addIssue(ctx, "markup", "can't be combined with a mask");
  if ((text(record.mask_url) || text(record.markup)) && list(record.image_urls).length === 0) addIssue(ctx, "image_urls", "A mask or markup needs an image to edit");
});

function gptImageRequest(model: string, value: Value): Value {
  const images = list(value.image_urls);
  const mask = text(value.mask_url);
  const markup = text(value.markup);
  return {
    model,
    prompt: value.prompt,
    ...(images.length > 0 ? { images: images.map((ref) => ({ image_url: ref })) } : {}),
    ...(mask ? { mask: { image_url: mask } } : {}),
    ...(markup ? { markup: { image_url: markup } } : {}),
    size: GPT_IMAGE_SIZES[String(value.aspect_ratio)]?.[String(value.resolution)],
    quality: value.quality,
    ...(text(value.complexity) ? { complexity: value.complexity } : {}),
    output_format: value.output_format,
    background: value.background,
  };
}

const INLINE_PLACEHOLDER = "data:image/png;base64,AA==";

function placeholderImage(part: unknown): unknown {
  const ref = (part as { image_url?: unknown } | undefined)?.image_url;
  return typeof ref === "string" && ref.length > 0 ? { image_url: INLINE_PLACEHOLDER } : part;
}

const GPT_IMAGE_PENDING_REQUEST = z.record(z.string(), z.unknown()).superRefine((value, ctx) => {
  const checked: Value = {
    ...value,
    ...(Array.isArray(value.images) ? { images: value.images.map(placeholderImage) } : {}),
    ...(value.mask !== undefined ? { mask: placeholderImage(value.mask) } : {}),
    ...(value.markup !== undefined ? { markup: placeholderImage(value.markup) } : {}),
  };
  const schema = Array.isArray(value.images) ? NunchuxOpenAiImagesEditsRequestSchema : NunchuxOpenAiImagesGenerationsRequestSchema;
  const parsed = schema.safeParse(checked);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) ctx.addIssue({ code: "custom", message: issue.message, path: issue.path });
  }
});

function gptImageModel(model: string, title: string): NunchuxModel {
  return {
    family: "openai",
    entry: { media: "image", operations: ["text_to_image", "edit_image"], title, guide: "gpt_image_26", dialect: "natural" },
    input: GPT_IMAGE_INPUT,
    wrap: (value) => gptImageRequest(model, value),
    request: GPT_IMAGE_PENDING_REQUEST,
  };
}

const NUNCHUX_MODELS: Readonly<Record<string, NunchuxModel>> = {
  "gpt-image-2.6-sunburst": gptImageModel("gpt-image-2.6-sunburst", "GPT Image 2.6 Sunburst (Nunchux)"),
  "gpt-image-2.6-flare": gptImageModel("gpt-image-2.6-flare", "GPT Image 2.6 Flare (Nunchux)"),
  "gemini-nano-banana-2.1": {
    family: "google",
    entry: { media: "image", operations: ["text_to_image", "edit_image"], title: "Nano Banana 2.1 (Nunchux)", guide: "nano_banana", dialect: "natural" },
    input: NANO_BANANA_INPUT,
    wrap: nanoBananaRequest,
    request: NunchuxPendingInteractionsRequestSchema,
  },
  "wan3.0-video": alibabaModel("wan3.0-video", WAN_30_INPUT, {
    media: "video",
    operations: ["text_to_video", "image_to_video", "reference_to_video"],
    title: "Wan 3.0 (Nunchux)",
    dialect: "natural_strip_frames",
    modes: [TEXT_MODE, FRAMES_MODE, referencesMode(["image", "video", "audio"])],
    rules: { refDurationMs: { audio: { minimum: 0, maximum: 15_000, maximumTotal: 15_000 } } },
  }),
  "wan2.7-videoedit": alibabaModel("wan2.7-videoedit", alibabaEditInput(["720P", "1080P"], 2, 10), {
    media: "video",
    operations: ["edit_video"],
    title: "Wan 2.7 Edit (Nunchux)",
    dialect: "natural_strip_frames",
    modes: [EDIT_MODE],
    rules: { refDurationMs: { video: { minimum: 2000, maximum: 10_000, maximumTotal: 10_000 } } },
    outputLength: "video",
  }),
  "happyhorse-1.0-video-edit": alibabaModel("happyhorse-1.0-video-edit", alibabaEditInput(["720P", "1080P"], 3, 15), {
    media: "video",
    operations: ["edit_video"],
    title: "HappyHorse 1.0 Edit (Nunchux)",
    dialect: "happyhorse_edit",
    modes: [EDIT_MODE],
    outputLength: "video",
  }),
  "dreamina-seedance-2-5-260628": seedanceModel("dreamina-seedance-2-5-260628", "Seedance 2.5 (Nunchux)", "seedance25", { images: 30, videos: 10, audios: 10, maxSeconds: 30 }),
  "dreamina-seedance-2-0-260128": seedanceModel("dreamina-seedance-2-0-260128", "Seedance 2.0 (Nunchux)", "seedance2", { images: 9, videos: 3, audios: 3, maxSeconds: 15 }),
  "MiniMax-H3": {
    family: "minimax",
    entry: {
      media: "video",
      operations: ["text_to_video", "image_to_video", "reference_to_video"],
      title: "MiniMax H3 (Nunchux)",
      dialect: "natural_strip_frames",
      modes: [
        TEXT_MODE,
        { ...FRAMES_MODE, omit: ["aspect_ratio"] },
        referencesMode(["image", "video", "audio"], { omit: ["aspect_ratio"] }),
      ],
      rules: MINIMAX_CLIPS,
    },
    input: MINIMAX_INPUT,
    wrap: minimaxRequest,
    request: NunchuxMinimaxVideoGenerationRequestSchema,
  },
};

function nunchuxModel(apiId: string): NunchuxModel | undefined {
  return Object.hasOwn(NUNCHUX_MODELS, apiId) ? NUNCHUX_MODELS[apiId] : undefined;
}

export function nunchuxFamily(apiId: string): NunchuxFamily {
  const found = nunchuxModel(apiId);
  if (!found) throw new Error(`Unknown Nunchux model ${apiId}`);
  return found.family;
}

export function isNunchuxTaskModel(apiId: string): boolean {
  const family = nunchuxModel(apiId)?.family;
  return family !== undefined && family !== "google" && family !== "openai";
}

export function nunchuxDotPath(apiId: string, edit = false): string {
  const family = nunchuxFamily(apiId);
  return family === "openai" && edit ? OPENAI_EDIT_DOT_PATH : SUBMIT_DOT_PATHS[family];
}

export function isNunchuxGptImage(apiId: string): boolean {
  return nunchuxModel(apiId)?.family === "openai";
}

export function isNunchuxSeedance(apiId: string): boolean {
  return nunchuxModel(apiId)?.family === "bytedance";
}

export function nunchuxWire(apiId: string): WireSpec | null {
  const found = nunchuxModel(apiId);
  if (!found) return null;
  return { input: found.input, fixed: {}, wrap: found.wrap, request: found.request };
}

export const NUNCHUX_MODEL_ENTRIES: readonly ModelEntry[] = Object.entries(NUNCHUX_MODELS)
  .map(([apiId, found]) => ({ id: `nunchux:${apiId}`, ...found.entry }));
