import type { WaveSpeedPredictionResponse } from "@apicity/wavespeed";
import {
  WaveSpeedAlibabaHappyhorse1p1ImageToVideoRequestSchema,
  WaveSpeedAlibabaWan3p0ImageToVideoRequestSchema,
  WaveSpeedAlibabaWan3p0ReferenceToVideoRequestSchema,
  WaveSpeedAlibabaWan3p0TextToVideoRequestSchema,
  WaveSpeedAlibabaWan3p0VideoEditRequestSchema,
  WaveSpeedBlackForestLabsFlux3ImageToVideoRequestSchema,
  WaveSpeedBlackForestLabsFlux3TextToVideoRequestSchema,
  WaveSpeedBytedanceSeedance2p0ImageToVideoRequestSchema,
  WaveSpeedBytedanceSeedance2p0TextToVideoRequestSchema,
  WaveSpeedBytedanceSeedance2p5ImageToVideoRequestSchema,
  WaveSpeedBytedanceSeedance2p5ReferenceToVideoRequestSchema,
  WaveSpeedBytedanceSeedance2p5TextToVideoRequestSchema,
  WaveSpeedBytedanceSeedance2p5VideoEditRequestSchema,
  WaveSpeedGoogleGeminiOmni1p1FlashImageToVideoRequestSchema,
  WaveSpeedGoogleGeminiOmni1p1FlashTextToVideoRequestSchema,
  WaveSpeedGoogleGeminiOmni1p1FlashVideoEditRequestSchema,
  WaveSpeedHeygenVideo1p0ReferenceToVideoRequestSchema,
  WaveSpeedHeygenVideo1p0TextToVideoRequestSchema,
  WaveSpeedMinimaxH3ImageToVideoRequestSchema,
  WaveSpeedMinimaxH3ReferenceToVideoRequestSchema,
  WaveSpeedMinimaxH3TextToVideoRequestSchema,
  WaveSpeedWavespeedAiMinimaxH3VideoEditRequestSchema,
  WaveSpeedXAiGrokImagineVideoV1p5ImageToVideoRequestSchema,
} from "@apicity/wavespeed/zod";
import type { ZodObject, ZodRawShape } from "zod";
import type { ModeSpec, ModelEntry, Operation, PromptDialect, PromptGuide, RefRole, WireSpec } from "./types.js";

type AnyObject = ZodObject<ZodRawShape>;

export type WaveSpeedSubmit = (request: Record<string, unknown>, signal?: AbortSignal) => Promise<WaveSpeedPredictionResponse>;

interface WaveSpeedEndpoint {
  family: string;
  dotPath: string;
  schema: AnyObject;
}

function endpoint(family: string, path: string, schema: unknown): WaveSpeedEndpoint {
  return { family, dotPath: `api.v3.${path}`, schema: schema as AnyObject };
}

const WAVESPEED_ENDPOINTS: Readonly<Record<string, WaveSpeedEndpoint>> = {
  "bytedance/seedance-2.5/text-to-video": endpoint("Seedance 2.5", "bytedance.seedance2p5.textToVideo", WaveSpeedBytedanceSeedance2p5TextToVideoRequestSchema),
  "bytedance/seedance-2.5/image-to-video": endpoint("Seedance 2.5", "bytedance.seedance2p5.imageToVideo", WaveSpeedBytedanceSeedance2p5ImageToVideoRequestSchema),
  "bytedance/seedance-2.5/reference-to-video": endpoint("Seedance 2.5", "bytedance.seedance2p5.referenceToVideo", WaveSpeedBytedanceSeedance2p5ReferenceToVideoRequestSchema),
  "bytedance/seedance-2.5/video-edit": endpoint("Seedance 2.5", "bytedance.seedance2p5.videoEdit", WaveSpeedBytedanceSeedance2p5VideoEditRequestSchema),
  "bytedance/seedance-2.0/text-to-video": endpoint("Seedance 2.0", "bytedance.seedance2p0.textToVideo", WaveSpeedBytedanceSeedance2p0TextToVideoRequestSchema),
  "bytedance/seedance-2.0/image-to-video": endpoint("Seedance 2.0", "bytedance.seedance2p0.imageToVideo", WaveSpeedBytedanceSeedance2p0ImageToVideoRequestSchema),
  "minimax/h3/text-to-video": endpoint("MiniMax H3", "minimax.h3.textToVideo", WaveSpeedMinimaxH3TextToVideoRequestSchema),
  "minimax/h3/image-to-video": endpoint("MiniMax H3", "minimax.h3.imageToVideo", WaveSpeedMinimaxH3ImageToVideoRequestSchema),
  "minimax/h3/reference-to-video": endpoint("MiniMax H3", "minimax.h3.referenceToVideo", WaveSpeedMinimaxH3ReferenceToVideoRequestSchema),
  "wavespeed-ai/minimax-h3/video-edit": endpoint("MiniMax H3", "wavespeedAi.minimaxH3.videoEdit", WaveSpeedWavespeedAiMinimaxH3VideoEditRequestSchema),
  "alibaba/wan-3.0/text-to-video": endpoint("Wan 3.0", "alibaba.wan3p0.textToVideo", WaveSpeedAlibabaWan3p0TextToVideoRequestSchema),
  "alibaba/wan-3.0/image-to-video": endpoint("Wan 3.0", "alibaba.wan3p0.imageToVideo", WaveSpeedAlibabaWan3p0ImageToVideoRequestSchema),
  "alibaba/wan-3.0/reference-to-video": endpoint("Wan 3.0", "alibaba.wan3p0.referenceToVideo", WaveSpeedAlibabaWan3p0ReferenceToVideoRequestSchema),
  "alibaba/wan-3.0/video-edit": endpoint("Wan 3.0", "alibaba.wan3p0.videoEdit", WaveSpeedAlibabaWan3p0VideoEditRequestSchema),
  "alibaba/happyhorse-1.1/image-to-video": endpoint("HappyHorse 1.1", "alibaba.happyhorse1p1.imageToVideo", WaveSpeedAlibabaHappyhorse1p1ImageToVideoRequestSchema),
  "google/gemini-omni-1.1-flash/text-to-video": endpoint("Gemini Omni 1.1 Flash", "google.geminiOmni1p1Flash.textToVideo", WaveSpeedGoogleGeminiOmni1p1FlashTextToVideoRequestSchema),
  "google/gemini-omni-1.1-flash/image-to-video": endpoint("Gemini Omni 1.1 Flash", "google.geminiOmni1p1Flash.imageToVideo", WaveSpeedGoogleGeminiOmni1p1FlashImageToVideoRequestSchema),
  "google/gemini-omni-1.1-flash/video-edit": endpoint("Gemini Omni 1.1 Flash", "google.geminiOmni1p1Flash.videoEdit", WaveSpeedGoogleGeminiOmni1p1FlashVideoEditRequestSchema),
  "black-forest-labs/flux-3/text-to-video": endpoint("FLUX 3", "blackForestLabs.flux3.textToVideo", WaveSpeedBlackForestLabsFlux3TextToVideoRequestSchema),
  "black-forest-labs/flux-3/image-to-video": endpoint("FLUX 3", "blackForestLabs.flux3.imageToVideo", WaveSpeedBlackForestLabsFlux3ImageToVideoRequestSchema),
  "heygen/video-1.0/text-to-video": endpoint("HeyGen Video", "heygen.video1p0.textToVideo", WaveSpeedHeygenVideo1p0TextToVideoRequestSchema),
  "heygen/video-1.0/reference-to-video": endpoint("HeyGen Video", "heygen.video1p0.referenceToVideo", WaveSpeedHeygenVideo1p0ReferenceToVideoRequestSchema),
  "x-ai/grok-imagine-video-v1.5/image-to-video": endpoint("Grok Imagine Video 1.5", "xAi.grokImagineVideoV1p5.imageToVideo", WaveSpeedXAiGrokImagineVideoV1p5ImageToVideoRequestSchema),
};

const OPERATION_BY_TASK: Readonly<Record<string, Operation>> = {
  "text-to-video": "text_to_video",
  "image-to-video": "image_to_video",
  "reference-to-video": "reference_to_video",
  "video-edit": "edit_video",
};

const TITLE_SUFFIX: Readonly<Record<Operation, string>> = {
  text_to_image: "",
  edit_image: "",
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
  return { input: found.schema, fixed: {}, wrap: (value) => value, request: found.schema };
}

export function wavespeedMethod(client: object, apiId: string): WaveSpeedSubmit {
  let current: unknown = client;
  for (const segment of wavespeedDotPath(apiId).split(".")) {
    current = current !== null && typeof current === "object" ? (current as Record<string, unknown>)[segment] : undefined;
  }
  if (typeof current !== "function") throw new Error(`WaveSpeed client has no method for ${apiId}`);
  return current as WaveSpeedSubmit;
}

function operationFor(apiId: string): Operation {
  const operation = OPERATION_BY_TASK[apiId.split("/").at(-1)!];
  if (!operation) throw new Error(`WaveSpeed model ${apiId} has no known task`);
  return operation;
}

function field(shape: ZodRawShape, name: string): string | null {
  return name in shape ? name : null;
}

function refsFor(shape: ZodRawShape): Partial<Record<RefRole, string | null>> {
  return {
    first_frame: field(shape, "image"),
    last_frame: field(shape, "last_image"),
    image: field(shape, "reference_images"),
    video: field(shape, "video") ?? field(shape, "reference_videos"),
    audio: field(shape, "reference_audios"),
    loop: null,
    keyframe: null,
  };
}

function guideFor(apiId: string): PromptGuide | undefined {
  if (apiId.startsWith("bytedance/seedance-2.5/")) return "seedance25";
  if (apiId.startsWith("bytedance/seedance-2.0/")) return "seedance2";
  if (apiId.startsWith("x-ai/grok-imagine-video")) return "grok_imagine";
  return undefined;
}

function dialectFor(apiId: string, refs: Partial<Record<RefRole, string | null>>): PromptDialect {
  if (apiId.startsWith("bytedance/")) return "seedance";
  return refs.image || refs.video || refs.audio ? "natural_strip_frames" : "strip_frames";
}


function wavespeedModel(apiId: string, found: WaveSpeedEndpoint): ModelEntry {
  const operation = operationFor(apiId);
  const refs = refsFor(found.schema.shape);
  const guide = guideFor(apiId);
  return {
    id: `wavespeed:${apiId}`,
    media: "video",
    operations: [operation],
    title: `${found.family}${TITLE_SUFFIX[operation]} (WaveSpeed)`,
    dialect: dialectFor(apiId, refs),
    refs,
    ...(guide ? { guide } : {}),
    ...(refs.last_frame ? { modes: FRAME_MODES } : {}),
  };
}

export const WAVESPEED_MODEL_ENTRIES: readonly ModelEntry[] = Object.entries(WAVESPEED_ENDPOINTS)
  .map(([apiId, found]) => wavespeedModel(apiId, found));
