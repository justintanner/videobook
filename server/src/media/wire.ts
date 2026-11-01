import { z, type ZodObject, type ZodRawShape, type ZodType } from "zod";
import { MediaGenerationRequestSchema, SunoGenerateRequestSchema, SunoSoundsRequestSchema, VeoGenerateRequestSchema } from "@apicity/kie/zod";
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
import type { ParsedModelId, WireSpec } from "./types.js";

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

export function isKieVeoModel(apiId: string): boolean {
  return KIE_VEO_MODELS.has(apiId);
}

export function isKieSunoModel(apiId: string): boolean {
  return apiId === "suno/generate" || apiId === "suno/sounds-generate";
}

function falWire(apiId: string): WireSpec | null {
  const schemas = FAL_ENDPOINT_REQUEST_SCHEMAS as unknown as Record<string, ZodType | undefined>;
  const request = schemas[apiId];
  if (!request || !objectShape(request)) return null;
  return { input: request as unknown as AnyObject, fixed: {}, wrap: identity, request };
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
      return kieCreateTaskWire(parsed.apiId) ?? kieVeoWire(parsed.apiId) ?? kieSunoWire(parsed.apiId);
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
  }
}
