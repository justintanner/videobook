import { AlibabaVideoSynthesisRequestSchema } from "@apicity/alibaba/zod";
import { z, type RefinementCtx, type ZodObject, type ZodRawShape, type ZodType } from "zod";
import type { InputRules, ModeSpec, ModelEntry, WireSpec } from "./types.js";

type AnyObject = ZodObject<ZodRawShape>;
type Value = Record<string, unknown>;

interface AlibabaVideoModel {
  entry: Omit<ModelEntry, "id">;
  input: AnyObject;
  wrap: (value: Value) => Value;
}

const PROMPT = z.string().min(1).max(5000).describe("What to generate; name connected inputs by their slot, such as @image1");
const WAN_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4"] as const;

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

function checkWanFrames(value: Value, ctx: RefinementCtx): void {
  const first = text(value.first_frame_url);
  const last = text(value.last_frame_url);
  const refs = list(value.image_urls).length + list(value.video_urls).length + list(value.audio_urls).length;
  if (last && !first) addIssue(ctx, "last_frame_url", "A last frame needs a first frame");
  if ((first || last) && refs > 0) addIssue(ctx, "first_frame_url", "Frames can't be combined with reference media");
}

const WAN_30_INPUT = z.object({
  prompt: PROMPT,
  first_frame_url: url("First frame image"),
  last_frame_url: url("Last frame image; needs a first frame"),
  image_urls: urls(10, "Reference images, up to 10"),
  video_urls: urls(5, "Reference videos, up to 5"),
  audio_urls: urls(5, "Reference audio, up to 5 clips totaling 15 seconds"),
  resolution: z.enum(["480P", "720P", "1080P"]).default("1080P").describe("Output resolution"),
  ratio: z.enum(WAN_RATIOS).optional().describe("Output aspect ratio"),
  duration: z.number().int().min(2).max(30).default(5).describe("Output seconds, 2-30"),
  audio: z.boolean().default(true).describe("Generate native audio with the video"),
  prompt_extend: z.boolean().optional().describe("Allow DashScope to expand the prompt"),
  seed: z.number().int().min(0).max(2_147_483_647).optional().describe("Seed for reproducible output"),
}).superRefine((value, ctx) => checkWanFrames(value, ctx));

const HAPPYHORSE_EDIT_INPUT = z.object({
  prompt: PROMPT,
  video_url: z.string().min(1).describe("The video to edit (3-15 seconds)"),
  image_urls: urls(5, "Reference images, up to 5"),
  resolution: z.enum(["720P", "1080P"]).default("1080P").describe("Output resolution"),
  seed: z.number().int().min(0).max(2_147_483_647).optional().describe("Seed for reproducible output"),
});

function wanMedia(value: Value): Array<{ type: string; url: string }> {
  return [
    ...(text(value.first_frame_url) ? [{ type: "first_frame", url: text(value.first_frame_url)! }] : []),
    ...(text(value.last_frame_url) ? [{ type: "last_frame", url: text(value.last_frame_url)! }] : []),
    ...list(value.image_urls).map((ref) => ({ type: "reference_image", url: ref })),
    ...list(value.video_urls).map((ref) => ({ type: "reference_video", url: ref })),
    ...list(value.audio_urls).map((ref) => ({ type: "reference_audio", url: ref })),
  ];
}

function wanRequest(model: string, value: Value): Value {
  const media = wanMedia(value);
  return {
    model,
    input: { prompt: value.prompt, ...(media.length > 0 ? { media } : {}) },
    parameters: {
      resolution: value.resolution,
      ...(typeof value.duration === "number" ? { duration: value.duration } : {}),
      ...(text(value.ratio) ? { ratio: value.ratio } : {}),
      ...(typeof value.audio === "boolean" ? { audio: value.audio } : {}),
      ...(typeof value.prompt_extend === "boolean" ? { prompt_extend: value.prompt_extend } : {}),
      ...(typeof value.seed === "number" ? { seed: value.seed } : {}),
      watermark: false,
    },
  };
}

function happyhorseEditRequest(value: Value): Value {
  const media: Array<{ type: string; url: string }> = [
    { type: "video", url: String(value.video_url) },
    ...list(value.image_urls).map((ref) => ({ type: "reference_image", url: ref })),
  ];
  return {
    model: "happyhorse-1.0-video-edit",
    input: { prompt: value.prompt, media },
    parameters: {
      resolution: value.resolution,
      ...(typeof value.seed === "number" ? { seed: value.seed } : {}),
      watermark: false,
    },
  };
}

const WAN_30_MODES: readonly ModeSpec[] = [
  { id: "t2v", label: "Text to video", roles: [] },
  { id: "i2v", label: "Frames", roles: ["first_frame", "last_frame"], requireAny: ["first_frame"] },
  { id: "r2v", label: "References", roles: ["image", "video", "audio"], requireAny: ["image", "video", "audio"] },
  { id: "v2v", label: "Edit video", roles: ["video", "image", "audio"], requireAny: ["video"] },
];

const WAN_30_RULES: InputRules = {
  refDurationMs: { audio: { minimum: 0, maximum: 15_000, maximumTotal: 15_000 } },
};

const ALIBABA_VIDEO_MODELS: Readonly<Record<string, AlibabaVideoModel>> = {
  "wan3.0-video": {
    entry: {
      media: "video",
      operations: ["text_to_video", "image_to_video", "reference_to_video", "edit_video"],
      title: "Wan 3.0 (Alibaba)",
      family: "Wan 3.0",
      dialect: "natural_strip_frames",
      modes: WAN_30_MODES,
      rules: WAN_30_RULES,
    },
    input: WAN_30_INPUT,
    wrap: (value) => wanRequest("wan3.0-video", value),
  },
  "wan3.0-video-prime": {
    entry: {
      media: "video",
      operations: ["text_to_video", "image_to_video", "reference_to_video", "edit_video"],
      title: "Wan 3.0 Prime (Alibaba)",
      family: "Wan 3.0",
      variant: "Prime",
      dialect: "natural_strip_frames",
      modes: WAN_30_MODES,
      rules: WAN_30_RULES,
    },
    input: WAN_30_INPUT,
    wrap: (value) => wanRequest("wan3.0-video-prime", value),
  },
  "happyhorse-1.0-video-edit": {
    entry: {
      media: "video",
      operations: ["edit_video"],
      title: "HappyHorse 1.0 Video Edit (Alibaba)",
      family: "HappyHorse 1.0",
      dialect: "happyhorse_edit",
      outputLength: "video",
      modes: [{ id: "v2v", label: "Edit video", roles: ["video", "image"], requireAny: ["video"] }],
    },
    input: HAPPYHORSE_EDIT_INPUT,
    wrap: happyhorseEditRequest,
  },
};

export function isAlibabaVideoModel(apiId: string): boolean {
  return Object.hasOwn(ALIBABA_VIDEO_MODELS, apiId);
}

export function alibabaVideoWire(apiId: string): WireSpec | null {
  const model = Object.hasOwn(ALIBABA_VIDEO_MODELS, apiId) ? ALIBABA_VIDEO_MODELS[apiId] : undefined;
  if (!model) return null;
  return {
    input: model.input,
    fixed: {},
    wrap: model.wrap,
    request: AlibabaVideoSynthesisRequestSchema,
  };
}

export const ALIBABA_VIDEO_MODEL_ENTRIES: readonly ModelEntry[] = Object.entries(ALIBABA_VIDEO_MODELS)
  .map(([apiId, model]) => ({ id: `alibaba:${apiId}`, ...model.entry }));
