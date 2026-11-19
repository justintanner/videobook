import type { WaveSpeedPredictionResponse } from "@apicity/wavespeed";
import {
  WaveSpeedAlibabaHappyhorse1p0VideoEditRequestSchema,
  WaveSpeedAlibabaHappyhorse1p1ImageToVideoRequestSchema,
  WaveSpeedAlibabaHappyhorse1p1ReferenceToVideoRequestSchema,
  WaveSpeedAlibabaWan2p7VideoEditRequestSchema,
  WaveSpeedAlibabaWan3p0ImageToVideoRequestSchema,
  WaveSpeedAlibabaWan3p0ReferenceToVideoRequestSchema,
  WaveSpeedAlibabaWan3p0TextToVideoRequestSchema,
  WaveSpeedAlibabaWan3p0VideoEditRequestSchema,
  WaveSpeedBlackForestLabsFlux3ImageToVideoRequestSchema,
  WaveSpeedBlackForestLabsFlux3TextToVideoRequestSchema,
  WaveSpeedBytedanceSeedance2p0ImageToVideoRequestSchema,
  WaveSpeedBytedanceSeedance2p0ReferenceToVideoRequestSchema,
  WaveSpeedBytedanceSeedance2p0TextToVideoRequestSchema,
  WaveSpeedBytedanceSeedance2p0VideoEditRequestSchema,
  WaveSpeedBytedanceSeedance2p5ImageToVideoRequestSchema,
  WaveSpeedBytedanceSeedance2p5ReferenceToVideoRequestSchema,
  WaveSpeedBytedanceSeedance2p5TextToVideoRequestSchema,
  WaveSpeedBytedanceSeedance2p5VideoEditRequestSchema,
  WaveSpeedBytedanceSeedreamV5p5EditRequestSchema,
  WaveSpeedGoogleGeminiOmni1p1FlashImageToVideoRequestSchema,
  WaveSpeedGoogleGeminiOmni1p1FlashReferenceToVideoRequestSchema,
  WaveSpeedGoogleGeminiOmni1p1FlashTextToVideoRequestSchema,
  WaveSpeedGoogleGeminiOmni1p1FlashVideoEditRequestSchema,
  WaveSpeedGoogleGeminiOmni1p2FlashReferenceToVideoRequestSchema,
  WaveSpeedGoogleGeminiOmni1p2FlashTextToVideoRequestSchema,
  WaveSpeedGoogleGeminiOmni1p2FlashVideoEditRequestSchema,
  WaveSpeedGoogleNanoBanana2p1EditRequestSchema,
  WaveSpeedGoogleNanoBanana2p1TextToImageRequestSchema,
  WaveSpeedHeygenVideo1p0ImageToVideoRequestSchema,
  WaveSpeedHeygenVideo1p0ReferenceToVideoRequestSchema,
  WaveSpeedHeygenVideo1p0TextToVideoRequestSchema,
  WaveSpeedKwaivgiKlingVideoO3ProVideoEditRequestSchema,
  WaveSpeedMinimaxH3ImageToVideoRequestSchema,
  WaveSpeedMinimaxH3ReferenceToVideoRequestSchema,
  WaveSpeedMinimaxH3TextToVideoRequestSchema,
  WaveSpeedOpenaiGptImage2p5FlareTextToImageRequestSchema,
  WaveSpeedOpenaiGptImage2p5SunburstTextToImageRequestSchema,
  WaveSpeedOpenaiGptImage2p6FlareEditRequestSchema,
  WaveSpeedOpenaiGptImage2p6FlareTextToImageRequestSchema,
  WaveSpeedOpenaiGptImage2p6SunburstEditRequestSchema,
  WaveSpeedOpenaiGptImage2p6SunburstTextToImageRequestSchema,
  WaveSpeedOpenaiGptImage2TextToImageRequestSchema,
  WaveSpeedPrunaAiPVideo2ProImageToVideoRequestSchema,
  WaveSpeedRunwaymlAleph2RequestSchema,
  WaveSpeedSkyworkAiSkyreelsV4TextToVideoRequestSchema,
  WaveSpeedWavespeedAiMinimaxH3VideoEditRequestSchema,
  WaveSpeedXAiGrokImagineImageV2p0TextToImageRequestSchema,
  WaveSpeedXAiGrokImagineVideoV1p5ImageToVideoRequestSchema,
  WaveSpeedXAiGrokImagineVideoV1p5ReferenceToVideoRequestSchema,
} from "@apicity/wavespeed/zod";
import { z, type ZodObject, type ZodRawShape } from "zod";
import { storedImageFormats } from "./stored-image-formats.js";
import { OPERATIONS_BY_MEDIA, type ItemParamSpec, type Media, type ModeSpec, type ModelEntry, type Operation, type PromptDialect, type PromptGuide, type RefRole, type WireSpec } from "./types.js";

type AnyObject = ZodObject<ZodRawShape>;

export type WaveSpeedSubmit = (request: Record<string, unknown>, signal?: AbortSignal) => Promise<WaveSpeedPredictionResponse>;

interface WaveSpeedEndpoint {
  family: string;
  dotPath: string;
  schema: AnyObject;
  operation?: Operation;
  input?: AnyObject;
  wrap?: (input: Record<string, unknown>) => Record<string, unknown>;
  entry?: Pick<ModelEntry, "itemParams" | "inputLimits">;
}

type EndpointExtras = Omit<WaveSpeedEndpoint, "family" | "dotPath" | "schema">;

function endpoint(family: string, path: string, schema: unknown, extras: EndpointExtras = {}): WaveSpeedEndpoint {
  return { family, dotPath: `api.v3.${path}`, schema: schema as AnyObject, ...extras };
}

const ALEPH_KEYFRAME_MAX = 5;
const ALEPH_KEYFRAME_LIMIT = `First, last and timed keyframes together can't exceed ${ALEPH_KEYFRAME_MAX}`;

const ALEPH_KEYFRAME_TIME: ItemParamSpec = {
  name: "timestamp_s",
  label: "Time",
  valueType: "number",
  minimum: 0,
  exclusiveMinimum: true,
  unit: "s",
};

const AlephInputSchema = WaveSpeedRunwaymlAleph2RequestSchema
  .omit({ keyframe_images: true, keyframe_positions: true })
  .extend({
    first_frame: z.string().optional().describe("Keyframe image for the first frame of the edited video."),
    last_frame: z.string().optional().describe("Keyframe image for the last frame of the edited video."),
    keyframes: z.array(z.object({ url: z.string(), timestamp_s: z.number().positive().optional() }))
      .max(ALEPH_KEYFRAME_MAX)
      .optional()
      .describe("Keyframe images, each at a time in seconds into the source video."),
  })
  .superRefine((value, ctx) => {
    const keyframes = value.keyframes ?? [];
    if (keyframes.length + (value.first_frame ? 1 : 0) + (value.last_frame ? 1 : 0) > ALEPH_KEYFRAME_MAX) {
      ctx.addIssue({ code: "custom", path: ["keyframes"], message: ALEPH_KEYFRAME_LIMIT });
    }
    keyframes.forEach((keyframe, index) => {
      if (keyframe.timestamp_s === undefined) {
        ctx.addIssue({ code: "custom", path: ["keyframes"], message: `set keyframe ${index + 1}'s time in seconds` });
      }
    });
  });

function alephRequest(input: Record<string, unknown>): Record<string, unknown> {
  const { first_frame: first, last_frame: last, keyframes, ...request } = input as z.infer<typeof AlephInputSchema>;
  const placed = [
    ...(first ? [{ image: first, position: "first" }] : []),
    ...(keyframes ?? []).map((keyframe) => ({ image: keyframe.url, position: String(keyframe.timestamp_s) })),
    ...(last ? [{ image: last, position: "last" }] : []),
  ];
  if (placed.length === 0) return request;
  return { ...request, keyframe_images: placed.map((keyframe) => keyframe.image), keyframe_positions: placed.map((keyframe) => keyframe.position) };
}

const ALEPH: EndpointExtras = {
  operation: "edit_video",
  input: AlephInputSchema as unknown as AnyObject,
  wrap: alephRequest,
  entry: {
    itemParams: { keyframe: [ALEPH_KEYFRAME_TIME] },
    inputLimits: [{
      kind: "max",
      roles: [{ role: "first_frame" }, { role: "last_frame" }, { role: "keyframe" }],
      max: ALEPH_KEYFRAME_MAX,
      message: ALEPH_KEYFRAME_LIMIT,
    }],
  },
};

function gptImage26Input(schema: unknown): AnyObject {
  return storedImageFormats((schema as AnyObject).omit({ frame_count: true, frame_duration_ms: true }));
}

function markupWithoutMask(schema: AnyObject): AnyObject {
  return schema.superRefine((value, ctx) => {
    const record = value as Record<string, unknown>;
    if (record.markup_image && record.mask_image) {
      ctx.addIssue({ code: "custom", path: ["markup_image"], message: "can't be combined with a mask" });
    }
  }) as unknown as AnyObject;
}

const GPT_IMAGE_26: EndpointExtras = { input: gptImage26Input(WaveSpeedOpenaiGptImage2p6SunburstTextToImageRequestSchema) };
const GPT_IMAGE_26_FLARE: EndpointExtras = { input: gptImage26Input(WaveSpeedOpenaiGptImage2p6FlareTextToImageRequestSchema) };
const GPT_IMAGE_26_EDIT: EndpointExtras = { input: markupWithoutMask(gptImage26Input(WaveSpeedOpenaiGptImage2p6SunburstEditRequestSchema)) };
const GPT_IMAGE_26_FLARE_EDIT: EndpointExtras = { input: markupWithoutMask(gptImage26Input(WaveSpeedOpenaiGptImage2p6FlareEditRequestSchema)) };

const SKYREELS_V4: EndpointExtras = {
  input: WaveSpeedSkyworkAiSkyreelsV4TextToVideoRequestSchema.superRefine((value, ctx) => {
    if (value.mode === "fast" && value.sound === true) {
      ctx.addIssue({ code: "custom", path: ["sound"], message: "fast mode can't generate sound" });
    }
  }) as unknown as AnyObject,
};

const WAVESPEED_ENDPOINTS: Readonly<Record<string, WaveSpeedEndpoint>> = {
  "openai/gpt-image-2.6-sunburst/text-to-image": endpoint("GPT Image 2.6 Sunburst", "openai.gptImage2p6Sunburst.textToImage", WaveSpeedOpenaiGptImage2p6SunburstTextToImageRequestSchema, GPT_IMAGE_26),
  "openai/gpt-image-2.6-sunburst/edit": endpoint("GPT Image 2.6 Sunburst", "openai.gptImage2p6Sunburst.edit", WaveSpeedOpenaiGptImage2p6SunburstEditRequestSchema, GPT_IMAGE_26_EDIT),
  "openai/gpt-image-2.6-flare/text-to-image": endpoint("GPT Image 2.6 Flare", "openai.gptImage2p6Flare.textToImage", WaveSpeedOpenaiGptImage2p6FlareTextToImageRequestSchema, GPT_IMAGE_26_FLARE),
  "openai/gpt-image-2.6-flare/edit": endpoint("GPT Image 2.6 Flare", "openai.gptImage2p6Flare.edit", WaveSpeedOpenaiGptImage2p6FlareEditRequestSchema, GPT_IMAGE_26_FLARE_EDIT),
  "openai/gpt-image-2.5-sunburst/text-to-image": endpoint("GPT Image 2.5 Sunburst", "openai.gptImage2p5Sunburst.textToImage", WaveSpeedOpenaiGptImage2p5SunburstTextToImageRequestSchema),
  "openai/gpt-image-2.5-flare/text-to-image": endpoint("GPT Image 2.5 Flare", "openai.gptImage2p5Flare.textToImage", WaveSpeedOpenaiGptImage2p5FlareTextToImageRequestSchema),
  "openai/gpt-image-2/text-to-image": endpoint("GPT Image 2", "openai.gptImage2.textToImage", WaveSpeedOpenaiGptImage2TextToImageRequestSchema),
  "google/nano-banana-2.1/text-to-image": endpoint("Nano Banana 2.1", "google.nanoBanana2p1.textToImage", WaveSpeedGoogleNanoBanana2p1TextToImageRequestSchema),
  "google/nano-banana-2.1/edit": endpoint("Nano Banana 2.1", "google.nanoBanana2p1.edit", WaveSpeedGoogleNanoBanana2p1EditRequestSchema),
  "x-ai/grok-imagine-image-v2.0/text-to-image": endpoint("Grok Imagine Image 2.0", "xAi.grokImagineImageV2p0.textToImage", WaveSpeedXAiGrokImagineImageV2p0TextToImageRequestSchema),
  "bytedance/seedream-v5.5/edit": endpoint("Seedream 5.5", "bytedance.seedreamV5p5.edit", WaveSpeedBytedanceSeedreamV5p5EditRequestSchema),
  "bytedance/seedance-2.5/text-to-video": endpoint("Seedance 2.5", "bytedance.seedance2p5.textToVideo", WaveSpeedBytedanceSeedance2p5TextToVideoRequestSchema),
  "bytedance/seedance-2.5/image-to-video": endpoint("Seedance 2.5", "bytedance.seedance2p5.imageToVideo", WaveSpeedBytedanceSeedance2p5ImageToVideoRequestSchema),
  "bytedance/seedance-2.5/reference-to-video": endpoint("Seedance 2.5", "bytedance.seedance2p5.referenceToVideo", WaveSpeedBytedanceSeedance2p5ReferenceToVideoRequestSchema),
  "bytedance/seedance-2.5/video-edit": endpoint("Seedance 2.5", "bytedance.seedance2p5.videoEdit", WaveSpeedBytedanceSeedance2p5VideoEditRequestSchema),
  "bytedance/seedance-2.0/text-to-video": endpoint("Seedance 2.0", "bytedance.seedance2p0.textToVideo", WaveSpeedBytedanceSeedance2p0TextToVideoRequestSchema),
  "bytedance/seedance-2.0/image-to-video": endpoint("Seedance 2.0", "bytedance.seedance2p0.imageToVideo", WaveSpeedBytedanceSeedance2p0ImageToVideoRequestSchema),
  "bytedance/seedance-2.0/reference-to-video": endpoint("Seedance 2.0", "bytedance.seedance2p0.referenceToVideo", WaveSpeedBytedanceSeedance2p0ReferenceToVideoRequestSchema),
  "bytedance/seedance-2.0/video-edit": endpoint("Seedance 2.0", "bytedance.seedance2p0.videoEdit", WaveSpeedBytedanceSeedance2p0VideoEditRequestSchema),
  "minimax/h3/text-to-video": endpoint("MiniMax H3", "minimax.h3.textToVideo", WaveSpeedMinimaxH3TextToVideoRequestSchema),
  "minimax/h3/image-to-video": endpoint("MiniMax H3", "minimax.h3.imageToVideo", WaveSpeedMinimaxH3ImageToVideoRequestSchema),
  "minimax/h3/reference-to-video": endpoint("MiniMax H3", "minimax.h3.referenceToVideo", WaveSpeedMinimaxH3ReferenceToVideoRequestSchema),
  "wavespeed-ai/minimax-h3/video-edit": endpoint("MiniMax H3", "wavespeedAi.minimaxH3.videoEdit", WaveSpeedWavespeedAiMinimaxH3VideoEditRequestSchema),
  "alibaba/wan-3.0/text-to-video": endpoint("Wan 3.0", "alibaba.wan3p0.textToVideo", WaveSpeedAlibabaWan3p0TextToVideoRequestSchema),
  "alibaba/wan-3.0/image-to-video": endpoint("Wan 3.0", "alibaba.wan3p0.imageToVideo", WaveSpeedAlibabaWan3p0ImageToVideoRequestSchema),
  "alibaba/wan-3.0/reference-to-video": endpoint("Wan 3.0", "alibaba.wan3p0.referenceToVideo", WaveSpeedAlibabaWan3p0ReferenceToVideoRequestSchema),
  "alibaba/wan-3.0/video-edit": endpoint("Wan 3.0", "alibaba.wan3p0.videoEdit", WaveSpeedAlibabaWan3p0VideoEditRequestSchema),
  "alibaba/wan-2.7/video-edit": endpoint("Wan 2.7", "alibaba.wan2p7.videoEdit", WaveSpeedAlibabaWan2p7VideoEditRequestSchema),
  "alibaba/happyhorse-1.1/image-to-video": endpoint("HappyHorse 1.1", "alibaba.happyhorse1p1.imageToVideo", WaveSpeedAlibabaHappyhorse1p1ImageToVideoRequestSchema),
  "alibaba/happyhorse-1.1/reference-to-video": endpoint("HappyHorse 1.1", "alibaba.happyhorse1p1.referenceToVideo", WaveSpeedAlibabaHappyhorse1p1ReferenceToVideoRequestSchema),
  "alibaba/happyhorse-1.0/video-edit": endpoint("HappyHorse 1.0", "alibaba.happyhorse1p0.videoEdit", WaveSpeedAlibabaHappyhorse1p0VideoEditRequestSchema),
  "google/gemini-omni-1.1-flash/text-to-video": endpoint("Gemini Omni 1.1 Flash", "google.geminiOmni1p1Flash.textToVideo", WaveSpeedGoogleGeminiOmni1p1FlashTextToVideoRequestSchema),
  "google/gemini-omni-1.1-flash/image-to-video": endpoint("Gemini Omni 1.1 Flash", "google.geminiOmni1p1Flash.imageToVideo", WaveSpeedGoogleGeminiOmni1p1FlashImageToVideoRequestSchema),
  "google/gemini-omni-1.1-flash/reference-to-video": endpoint("Gemini Omni 1.1 Flash", "google.geminiOmni1p1Flash.referenceToVideo", WaveSpeedGoogleGeminiOmni1p1FlashReferenceToVideoRequestSchema),
  "google/gemini-omni-1.1-flash/video-edit": endpoint("Gemini Omni 1.1 Flash", "google.geminiOmni1p1Flash.videoEdit", WaveSpeedGoogleGeminiOmni1p1FlashVideoEditRequestSchema),
  "google/gemini-omni-1.2-flash/text-to-video": endpoint("Gemini Omni 1.2 Flash", "google.geminiOmni1p2Flash.textToVideo", WaveSpeedGoogleGeminiOmni1p2FlashTextToVideoRequestSchema),
  "google/gemini-omni-1.2-flash/reference-to-video": endpoint("Gemini Omni 1.2 Flash", "google.geminiOmni1p2Flash.referenceToVideo", WaveSpeedGoogleGeminiOmni1p2FlashReferenceToVideoRequestSchema),
  "google/gemini-omni-1.2-flash/video-edit": endpoint("Gemini Omni 1.2 Flash", "google.geminiOmni1p2Flash.videoEdit", WaveSpeedGoogleGeminiOmni1p2FlashVideoEditRequestSchema),
  "black-forest-labs/flux-3/text-to-video": endpoint("FLUX 3", "blackForestLabs.flux3.textToVideo", WaveSpeedBlackForestLabsFlux3TextToVideoRequestSchema),
  "black-forest-labs/flux-3/image-to-video": endpoint("FLUX 3", "blackForestLabs.flux3.imageToVideo", WaveSpeedBlackForestLabsFlux3ImageToVideoRequestSchema),
  "heygen/video-1.0/text-to-video": endpoint("HeyGen Video", "heygen.video1p0.textToVideo", WaveSpeedHeygenVideo1p0TextToVideoRequestSchema),
  "heygen/video-1.0/image-to-video": endpoint("HeyGen Video", "heygen.video1p0.imageToVideo", WaveSpeedHeygenVideo1p0ImageToVideoRequestSchema),
  "heygen/video-1.0/reference-to-video": endpoint("HeyGen Video", "heygen.video1p0.referenceToVideo", WaveSpeedHeygenVideo1p0ReferenceToVideoRequestSchema),
  "skywork-ai/skyreels-v4/text-to-video": endpoint("SkyReels V4", "skyworkAi.skyreelsV4.textToVideo", WaveSpeedSkyworkAiSkyreelsV4TextToVideoRequestSchema, SKYREELS_V4),
  "pruna-ai/p-video-2-pro/image-to-video": endpoint("P-Video 2 Pro", "prunaAi.pVideo2Pro.imageToVideo", WaveSpeedPrunaAiPVideo2ProImageToVideoRequestSchema),
  "x-ai/grok-imagine-video-v1.5/image-to-video": endpoint("Grok Imagine Video 1.5", "xAi.grokImagineVideoV1p5.imageToVideo", WaveSpeedXAiGrokImagineVideoV1p5ImageToVideoRequestSchema),
  "x-ai/grok-imagine-video-v1.5/reference-to-video": endpoint("Grok Imagine Video 1.5", "xAi.grokImagineVideoV1p5.referenceToVideo", WaveSpeedXAiGrokImagineVideoV1p5ReferenceToVideoRequestSchema),
  "kwaivgi/kling-video-o3-pro/video-edit": endpoint("Kling o3 Pro", "kwaivgi.klingVideoO3Pro.videoEdit", WaveSpeedKwaivgiKlingVideoO3ProVideoEditRequestSchema),
  "runwayml/aleph-2": endpoint("Runway Aleph 2", "runwayml.aleph2", WaveSpeedRunwaymlAleph2RequestSchema, ALEPH),
};

const OPERATION_BY_TASK: Readonly<Record<string, Operation>> = {
  "text-to-image": "text_to_image",
  edit: "edit_image",
  "text-to-video": "text_to_video",
  "image-to-video": "image_to_video",
  "reference-to-video": "reference_to_video",
  "video-edit": "edit_video",
};

const TITLE_SUFFIX: Readonly<Record<Operation, string>> = {
  text_to_image: "",
  edit_image: " Edit",
  layer_image: "",
  text_to_video: "",
  image_to_video: " Image",
  reference_to_video: " References",
  edit_video: " Edit",
  extend_video: "",
  upscale_video: "",
  lip_sync: "",
  motion_control: "",
  speech: "",
  dialogue: "",
  music: "",
  sfx: "",
  video_to_music: "",
};

const FRAME_MODES: readonly ModeSpec[] = [
  { id: "i2v", label: "Frames", roles: ["first_frame", "last_frame"], requireAny: ["first_frame"] },
];

function wavespeedEndpoint(apiId: string): WaveSpeedEndpoint | undefined {
  return Object.hasOwn(WAVESPEED_ENDPOINTS, apiId) ? WAVESPEED_ENDPOINTS[apiId] : undefined;
}

export function wavespeedDotPath(apiId: string): string {
  const found = wavespeedEndpoint(apiId);
  if (!found) throw new Error(`Unknown WaveSpeed model ${apiId}`);
  return found.dotPath;
}

export function wavespeedWire(apiId: string): WireSpec | null {
  const found = wavespeedEndpoint(apiId);
  if (!found) return null;
  return { input: found.input ?? found.schema, fixed: {}, wrap: found.wrap ?? ((value) => value), request: found.schema };
}

export function wavespeedMethod(client: object, apiId: string): WaveSpeedSubmit {
  let current: unknown = client;
  for (const segment of wavespeedDotPath(apiId).split(".")) {
    current = current !== null && typeof current === "object" ? (current as Record<string, unknown>)[segment] : undefined;
  }
  if (typeof current !== "function") throw new Error(`WaveSpeed client has no method for ${apiId}`);
  return current as WaveSpeedSubmit;
}

function operationFor(apiId: string, found: WaveSpeedEndpoint): Operation {
  const operation = found.operation ?? OPERATION_BY_TASK[apiId.split("/").at(-1)!];
  if (!operation) throw new Error(`WaveSpeed model ${apiId} has no known task`);
  return operation;
}

function field(shape: ZodRawShape, name: string): string | null {
  return name in shape ? name : null;
}

function refsFor(shape: ZodRawShape): Partial<Record<RefRole, string | null>> {
  return {
    first_frame: field(shape, "image") ?? field(shape, "first_frame"),
    last_frame: field(shape, "last_image") ?? field(shape, "last_frame"),
    image: field(shape, "reference_images") ?? field(shape, "images"),
    video: field(shape, "video") ?? field(shape, "reference_videos"),
    audio: field(shape, "reference_audios"),
    loop: null,
    keyframe: field(shape, "keyframes"),
  };
}

function mediaOf(operation: Operation): Media {
  return (OPERATIONS_BY_MEDIA.image as readonly Operation[]).includes(operation) ? "image" : "video";
}

function guideFor(apiId: string): PromptGuide | undefined {
  if (apiId.startsWith("openai/gpt-image-2.6-")) return "gpt_image_26";
  if (apiId.startsWith("openai/gpt-image-")) return "gpt_image";
  if (apiId.startsWith("google/nano-banana-")) return "nano_banana";
  if (apiId.startsWith("x-ai/grok-imagine-image")) return "grok_image";
  if (apiId.startsWith("bytedance/seedance-2.5/")) return "seedance25";
  if (apiId.startsWith("bytedance/seedance-2.0/")) return "seedance2";
  if (apiId.startsWith("x-ai/grok-imagine-video")) return "grok_imagine";
  if (apiId.startsWith("kwaivgi/kling-video-o3")) return "kling30";
  return undefined;
}

function dialectFor(apiId: string, media: Media, refs: Partial<Record<RefRole, string | null>>): PromptDialect {
  if (media === "image") return "natural";
  if (apiId.startsWith("bytedance/")) return "seedance";
  if (apiId.startsWith("kwaivgi/kling-video-o3")) return "kling_omni";
  if (apiId.startsWith("google/gemini-omni-") && apiId.endsWith("/reference-to-video")) return "gemini_omni";
  if (apiId === "x-ai/grok-imagine-video-v1.5/reference-to-video") return "grok";
  if (apiId.startsWith("alibaba/happyhorse-") && refs.video) return "happyhorse_edit";
  if (apiId.startsWith("alibaba/happyhorse-") && refs.image) return "brackets";
  return refs.image || refs.video || refs.audio ? "natural_strip_frames" : "strip_frames";
}

function wavespeedModel(apiId: string, found: WaveSpeedEndpoint): ModelEntry {
  const operation = operationFor(apiId, found);
  const media = mediaOf(operation);
  const refs = refsFor((found.input ?? found.schema).shape);
  const guide = guideFor(apiId);
  return {
    id: `wavespeed:${apiId}`,
    media,
    operations: [operation],
    title: `${found.family}${TITLE_SUFFIX[operation]} (WaveSpeed)`,
    dialect: dialectFor(apiId, media, refs),
    refs,
    ...(guide ? { guide } : {}),
    ...(operation === "image_to_video" && refs.last_frame ? { modes: FRAME_MODES } : {}),
    ...found.entry,
  };
}

export const WAVESPEED_MODEL_ENTRIES: readonly ModelEntry[] = Object.entries(WAVESPEED_ENDPOINTS)
  .map(([apiId, found]) => wavespeedModel(apiId, found));
