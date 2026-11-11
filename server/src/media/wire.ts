import { z, type ZodObject, type ZodRawShape, type ZodType } from "zod";
import {
  GrokVideo15PreviewInputSchema,
  GrokVideo15PreviewRequestSchema,
  MediaGenerationRequestSchema,
  SunoGenerateRequestSchema,
  SunoSoundsRequestSchema,
  VeoGenerateRequestSchema,
} from "@apicity/kie/zod";
import { FAL_ENDPOINT_REQUEST_SCHEMAS } from "@apicity/fal/zod";
import {
  isXaiGrokImagineVideoLegacyModel,
  XaiImageEditRequestSchema,
  XaiImageGenerateRequestSchema,
  XaiVideoGenerateRequestSchema,
} from "@apicity/xai/zod";
import {
  AlibabaMultimodalGenerationParametersSchema,
  AlibabaQwenImageEditStableModelSchema,
  AlibabaQwenImageGenerationStableModelSchema,
} from "@apicity/alibaba/zod";
import {
  ElevenLabsComposeMusicRequestSchema,
  ElevenLabsSoundGenerationRequestSchema,
  ElevenLabsTextToSpeechRequestSchema,
  ElevenLabsVideoToMusicRequestSchema,
} from "@apicity/elevenlabs/zod";
import { machgenWire } from "./machgen.js";
import { wavespeedWire } from "./wavespeed.js";
import type { ParsedModelId, WireSpec } from "./types.js";
import { evenKeyframeSeconds } from "./item-param-defaults.js";

type AnyObject = ZodObject<ZodRawShape>;

const KIE_VEO_MODELS = new Set(["veo3", "veo3_fast", "veo3_lite"]);
const SUNO_CALLBACK_URL = "https://localhost/videobook/suno-callback";

function objectShape(schema: unknown): ZodRawShape | null {
  const shape = (schema as { shape?: unknown }).shape;
  return shape && typeof shape === "object" ? shape as ZodRawShape : null;
}

function literalValue(schema: unknown): string | null {
  const value = (schema as { value?: unknown }).value;
  return typeof value === "string" ? value : null;
}

function identity(input: Record<string, unknown>): Record<string, unknown> {
  return input;
}

function kieCreateTaskSchemas(): Map<string, AnyObject> {
  const map = new Map<string, AnyObject>();
  for (const option of MediaGenerationRequestSchema.options as readonly unknown[]) {
    const shape = objectShape(option);
    const model = shape ? literalValue(shape.model) : null;
    if (model) map.set(model, option as AnyObject);
  }
  return map;
}

let kieSchemas: Map<string, AnyObject> | null = null;

function kieCreateTaskWire(apiId: string): WireSpec | null {
  kieSchemas ??= kieCreateTaskSchemas();
  const request = kieSchemas.get(apiId);
  if (!request) return null;
  const input = request.shape.input as unknown as AnyObject;
  return {
    input,
    fixed: {},
    wrap: (value) => ({ model: apiId, input: value }),
    request,
  };
}

function omitShape(schema: AnyObject, keys: readonly string[]): AnyObject {
  const shape = Object.fromEntries(Object.entries(schema.shape).filter(([key]) => !keys.includes(key)));
  return z.object(shape);
}

function kieVeoWire(apiId: string): WireSpec | null {
  if (!KIE_VEO_MODELS.has(apiId)) return null;
  const request = VeoGenerateRequestSchema as unknown as AnyObject;
  return {
    input: omitShape(request, ["model", "callBackUrl"]),
    fixed: { model: apiId },
    wrap: (value) => ({ ...value, model: apiId }),
    request,
  };
}

function kieSunoWire(apiId: string): WireSpec | null {
  const request = apiId === "suno/generate"
    ? SunoGenerateRequestSchema as unknown as AnyObject
    : apiId === "suno/sounds-generate"
      ? SunoSoundsRequestSchema as unknown as AnyObject
      : null;
  if (!request) return null;
  return {
    input: omitShape(request, ["callBackUrl"]),
    fixed: { callBackUrl: SUNO_CALLBACK_URL },
    wrap: (value) => ({ ...value, callBackUrl: SUNO_CALLBACK_URL }),
    request,
  };
}

const GROK_PREVIEW_MODEL = "grok-imagine-video-1-5-preview";
const GROK_PREVIEW_KEYFRAMES = 4;
const KEYFRAME_SECONDS = Array.from({ length: GROK_PREVIEW_KEYFRAMES }, (_, index) => `keyframe_${index + 1}_seconds`);

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function keyframeSecondsFields(): ZodRawShape {
  return Object.fromEntries(KEYFRAME_SECONDS.map((name, index) => [name, z.number().positive().optional()
    .describe(`Seconds into the clip for keyframe ${index + 1}, below the duration; unset keyframes are spaced evenly`)]));
}

function grokPreviewInput(): AnyObject {
  const base = GrokVideo15PreviewInputSchema as unknown as AnyObject;
  return omitShape(base, ["keyframes"]).extend({
    image_urls: (base.shape.image_urls as ZodType).optional(),
    keyframe_urls: z.array(z.string()).max(GROK_PREVIEW_KEYFRAMES).optional(),
    ...keyframeSecondsFields(),
  }).superRefine((value, ctx) => {
    const record = value as Record<string, unknown>;
    if (stringList(record.image_urls).length === 0 && typeof record.loop_url !== "string") {
      ctx.addIssue({ code: "custom", path: ["image_urls"], message: "connect a reference image or a loop image" });
    }
    const keyframes = stringList(record.keyframe_urls).length;
    KEYFRAME_SECONDS.forEach((name, index) => {
      if (index >= keyframes && record[name] !== undefined) {
        ctx.addIssue({ code: "custom", path: [name], message: `connect keyframe ${index + 1} or clear its seconds` });
      }
    });
  });
}

function grokPreviewKeyframes(value: Record<string, unknown>): Array<{ url: string; timestamp_s: number }> {
  const urls = stringList(value.keyframe_urls);
  const duration = typeof value.duration === "number" ? value.duration : 0;
  return urls.map((url, index) => {
    const seconds = value[KEYFRAME_SECONDS[index]!];
    return { url, timestamp_s: typeof seconds === "number" ? seconds : evenKeyframeSeconds(duration, urls.length, index) };
  });
}

function grokPreviewRequest(value: Record<string, unknown>): Record<string, unknown> {
  const input = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "keyframe_urls" && !KEYFRAME_SECONDS.includes(key)));
  const images = stringList(value.image_urls);
  const sources = images.length > 0 ? images : typeof value.loop_url === "string" ? [value.loop_url] : [];
  const keyframes = grokPreviewKeyframes(value);
  return {
    model: GROK_PREVIEW_MODEL,
    input: {
      ...input,
      ...(sources.length > 0 ? { image_urls: sources } : {}),
      ...(keyframes.length > 0 ? { keyframes } : {}),
    },
  };
}

function kieGrokPreviewWire(apiId: string): WireSpec | null {
  if (apiId !== GROK_PREVIEW_MODEL) return null;
  return { input: grokPreviewInput(), fixed: {}, wrap: grokPreviewRequest, request: GrokVideo15PreviewRequestSchema };
}

export function isKieVeoModel(apiId: string): boolean {
  return KIE_VEO_MODELS.has(apiId);
}

export function isKieSunoModel(apiId: string): boolean {
  return apiId === "suno/generate" || apiId === "suno/sounds-generate";
}

const LUMA_RAY_32 = new Set(["luma/agent/ray/v3.2/image-to-video", "luma/agent/ray/v3.2/video-to-video"]);

function present(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "" && !(Array.isArray(value) && value.length === 0);
}

function lumaKeyframeIssue(record: Record<string, unknown>): string | null {
  const keyframes = Array.isArray(record.keyframes) ? record.keyframes : null;
  const indexes = Array.isArray(record.keyframe_indexes) ? record.keyframe_indexes : null;
  if (!keyframes && !indexes) return null;
  if (!keyframes || !indexes || keyframes.length !== indexes.length) return "give one keyframe index per keyframe";
  const valid = indexes.every((index) => typeof index === "number" && Number.isInteger(index) && index >= 0);
  return valid && new Set(indexes).size === indexes.length ? null : "keyframe indexes must be unique and non-negative";
}

function lumaRayInput(request: AnyObject): AnyObject {
  return request.superRefine((value, ctx) => {
    const record = value as Record<string, unknown>;
    const keyframeIssue = lumaKeyframeIssue(record);
    if (keyframeIssue) ctx.addIssue({ code: "custom", path: ["keyframe_indexes"], message: keyframeIssue });
    if (present(record.keyframes)) {
      for (const field of ["image_url", "end_image_url", "start_image_url"]) {
        if (present(record[field])) ctx.addIssue({ code: "custom", path: [field], message: "can't be combined with keyframes" });
      }
      if (record.loop === true) ctx.addIssue({ code: "custom", path: ["loop"], message: "can't be combined with keyframes" });
    }
    if (record.loop === true && present(record.end_image_url)) ctx.addIssue({ code: "custom", path: ["loop"], message: "can't loop with an end frame" });
    if (record.loop === true && record.hdr === true) ctx.addIssue({ code: "custom", path: ["loop"], message: "can't loop an HDR generation" });
  }) as unknown as AnyObject;
}

const GEMINI_OMNI_12_FRAMES = "google/gemini-omni-flash/v1.2/image-to-video";
const GEMINI_OMNI_12_END_FRAME_SECONDS = 10;

function geminiOmniFramesInput(request: AnyObject): AnyObject {
  return request.superRefine((value, ctx) => {
    const record = value as Record<string, unknown>;
    if (present(record.end_image_url) && Number(record.duration) > GEMINI_OMNI_12_END_FRAME_SECONDS) {
      ctx.addIssue({ code: "custom", path: ["duration"], message: `at most ${GEMINI_OMNI_12_END_FRAME_SECONDS} seconds with a last frame` });
    }
  }) as unknown as AnyObject;
}

const GPT_IMAGE_26 = "openai/gpt-image-2.6/";
const GPT_IMAGE_26_ANIMATION_FIELDS = ["frame_count", "frame_duration_ms", "svg_model"];
const STORED_IMAGE_FORMATS = ["jpeg", "png", "webp"] as const;

function gptImage26Request(request: AnyObject): AnyObject {
  return omitShape(request, GPT_IMAGE_26_ANIMATION_FIELDS).extend({
    output_format: z.enum(STORED_IMAGE_FORMATS).default("png").describe("Output format for the images"),
  });
}

function markupWithoutMask(request: AnyObject): AnyObject {
  if (!("markup_image_url" in request.shape)) return request;
  return request.superRefine((value, ctx) => {
    const record = value as Record<string, unknown>;
    if (present(record.markup_image_url) && present(record.mask_url)) {
      ctx.addIssue({ code: "custom", path: ["markup_image_url"], message: "can't be combined with a mask" });
    }
  }) as unknown as AnyObject;
}

function falInput(apiId: string, request: AnyObject): AnyObject {
  if (LUMA_RAY_32.has(apiId)) return lumaRayInput(request);
  if (apiId === GEMINI_OMNI_12_FRAMES) return geminiOmniFramesInput(request);
  return apiId.startsWith(GPT_IMAGE_26) ? markupWithoutMask(request) : request;
}

function falWire(apiId: string): WireSpec | null {
  const schemas = FAL_ENDPOINT_REQUEST_SCHEMAS as unknown as Record<string, ZodType | undefined>;
  const schema = schemas[apiId];
  if (!schema || !objectShape(schema)) return null;
  const request = apiId.startsWith(GPT_IMAGE_26) ? gptImage26Request(schema as unknown as AnyObject) : schema as unknown as AnyObject;
  return { input: falInput(apiId, request), fixed: {}, wrap: identity, request };
}

export function isXaiImageModel(apiId: string): boolean {
  return apiId.startsWith("grok-imagine-image");
}

export function hasXaiImageSources(request: Record<string, unknown>): boolean {
  return Array.isArray(request.images) && request.images.length > 0;
}

const XAI_IMAGE_INPUT_OMITTED = ["model", "image", "image_file_id", "image_file_ids", "n", "response_format", "deferred", "storage_options", "user"];

const XaiImageRequestSchema = z.record(z.string(), z.unknown()).transform((value, ctx) => {
  const schema = hasXaiImageSources(value) ? XaiImageEditRequestSchema : XaiImageGenerateRequestSchema;
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data as Record<string, unknown>;
  for (const issue of parsed.error.issues) ctx.addIssue({ code: "custom", message: issue.message, path: issue.path });
  return z.NEVER;
});

function xaiImageWire(apiId: string): WireSpec {
  const edit = XaiImageEditRequestSchema as unknown as { shape?: ZodRawShape; _def: { schema?: AnyObject } };
  const shape = edit.shape ?? edit._def.schema!.shape;
  return {
    input: omitShape(z.object(shape), XAI_IMAGE_INPUT_OMITTED),
    fixed: { model: apiId },
    wrap: (value) => ({ ...value, model: apiId }),
    request: XaiImageRequestSchema,
  };
}

const XAI_LEGACY_REFERENCE_IMAGES = 7;

function xaiVideoInput(apiId: string, input: AnyObject): AnyObject {
  if (!isXaiGrokImagineVideoLegacyModel(apiId)) return input;
  const references = input.shape.reference_images as z.ZodOptional<z.ZodArray<ZodType>>;
  return input.extend({ reference_images: references.unwrap().max(XAI_LEGACY_REFERENCE_IMAGES).optional() });
}

function xaiWire(apiId: string): WireSpec | null {
  if (isXaiImageModel(apiId)) return xaiImageWire(apiId);
  if (apiId !== "grok-imagine-video" && !apiId.startsWith("grok-imagine-video-")) return null;
  const request = XaiVideoGenerateRequestSchema as unknown as AnyObject;
  return {
    input: xaiVideoInput(apiId, omitShape(request, ["model", "storage_options"])),
    fixed: { model: apiId },
    wrap: (value) => ({ ...value, model: apiId }),
    request,
  };
}

const ALIBABA_MODELS = new Set<string>([
  ...Object.values((AlibabaQwenImageGenerationStableModelSchema as unknown as { _def: { entries: Record<string, string> } })._def.entries),
  ...Object.values((AlibabaQwenImageEditStableModelSchema as unknown as { _def: { entries: Record<string, string> } })._def.entries),
]);

const ALIBABA_EDIT_MODELS = new Set<string>(
  Object.values((AlibabaQwenImageEditStableModelSchema as unknown as { _def: { entries: Record<string, string> } })._def.entries),
);

function alibabaInput(apiId: string): AnyObject {
  const parameters = AlibabaMultimodalGenerationParametersSchema as unknown as AnyObject;
  const base = z.object({ prompt: z.string().min(1), ...parameters.shape });
  return ALIBABA_EDIT_MODELS.has(apiId) ? base.extend({ images: z.array(z.string()).min(1).max(3) }) : base;
}

function alibabaRequest(apiId: string, value: Record<string, unknown>): Record<string, unknown> {
  const { prompt, images, ...parameters } = value;
  const content: Array<Record<string, string>> = [];
  for (const image of Array.isArray(images) ? images : []) content.push({ image: String(image) });
  content.push({ text: String(prompt ?? "") });
  return { model: apiId, input: { messages: [{ role: "user", content }] }, parameters };
}

function alibabaWire(apiId: string): WireSpec | null {
  if (!ALIBABA_MODELS.has(apiId)) return null;
  const input = alibabaInput(apiId);
  return {
    input,
    fixed: {},
    wrap: (value) => alibabaRequest(apiId, value),
    request: z.record(z.string(), z.unknown()),
  };
}

function elevenLabsWire(apiId: string): WireSpec | null {
  if (apiId === "sound-generation") {
    const request = ElevenLabsSoundGenerationRequestSchema as unknown as AnyObject;
    return { input: request, fixed: {}, wrap: identity, request };
  }
  if (apiId === "music") {
    const request = ElevenLabsComposeMusicRequestSchema as unknown as AnyObject;
    return { input: request, fixed: {}, wrap: identity, request };
  }
  if (apiId === "video-to-music") {
    const base = ElevenLabsVideoToMusicRequestSchema as unknown as AnyObject;
    const input = omitShape(base, ["videos"]).extend({ videos: z.array(z.string()).min(1).max(1) });
    return { input, fixed: {}, wrap: identity, request: input };
  }
  if (apiId === "text-to-speech") {
    const base = ElevenLabsTextToSpeechRequestSchema as unknown as AnyObject;
    const input = base.extend({ voice_id: z.string().min(1).describe("ElevenLabs voice id") });
    return { input, fixed: {}, wrap: identity, request: input };
  }
  return null;
}

export function wireSpec(parsed: ParsedModelId): WireSpec | null {
  switch (parsed.provider) {
    case "kie":
      return kieGrokPreviewWire(parsed.apiId) ?? kieCreateTaskWire(parsed.apiId) ?? kieVeoWire(parsed.apiId) ?? kieSunoWire(parsed.apiId);
    case "fal":
      return falWire(parsed.apiId);
    case "xai":
      return xaiWire(parsed.apiId);
    case "alibaba":
      return alibabaWire(parsed.apiId);
    case "elevenlabs":
      return elevenLabsWire(parsed.apiId);
    case "machgen":
      return machgenWire(parsed.apiId);
    case "wavespeed":
      return wavespeedWire(parsed.apiId);
  }
}
