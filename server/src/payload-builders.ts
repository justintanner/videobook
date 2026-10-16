import { buildGptImage25Payload } from "./gpt-image-2-5.js";
import {
  LIGHTNING_VIDEO_ASPECT_RATIO,
  LIGHTNING_VIDEO_DURATION_SECONDS,
  LIGHTNING_VIDEO_GENERATE_AUDIO,
  LIGHTNING_VIDEO_OUTPUT_FORMAT,
  LIGHTNING_VIDEO_RESOLUTION,
} from "./lightning-defaults.js";
import { seedance25FrameAspectRatio } from "./seedance25.js";
import type { GptImage25Input } from "./gpt-image-2-5.js";
/**
 * Shared payload builders: MCP tool args → @apicity request bodies.
 *
 * Used by job handlers (passes real upload URLs).
 */
import type {
  KlingVideoRequest,
  KlingMotionControlRequest,
  KlingElement,
  MultiShotPrompt,
  GrokTextToVideoRequest,
  GrokImageToVideoRequest,
  GrokImageToImageRequest,
  GrokTextToImageRequest,
  GrokVideoExtendRequest,
  Seedance2FastRequest,
  Seedance2Request,
  Seedance2MiniRequest,
  Seedance2MiniAspectRatio,
  Seedance2MiniResolution,
  Seedance25Request,
  NanoBananaProRequest,
  GptImage2ImageToImageRequest,
  GptImage2ImageToImageAspectRatio,
  GptImage2ImageToImageResolution,
  GptImage2TextToImageRequest,
  GptImage2TextToImageAspectRatio,
  GptImage2TextToImageResolution,
  SeedreamTextToImageRequest,
  SeedreamImageToImageRequest,
  Qwen2ImageEditRequest,
  Qwen3ImageToImageRequest,
  Qwen21TextToImageRequest,
  Qwen21ImageToImageRequest,
  HappyHorse11TextToVideoRequest,
  HappyHorse11ImageToVideoRequest,
  HappyHorse11ReferenceToVideoRequest,
  HappyHorse11AspectRatio,
  HappyHorseVideoEditRequest,
  HappyHorseResolution,
  HappyHorseAudioSetting,
  MiniMaxH3TextToVideoRequest,
  MiniMaxH3ImageToVideoRequest,
  MiniMaxH3ReferenceToVideoRequest,
  MiniMaxH3Resolution,
  MiniMaxH3FixedAspectRatio,
  MiniMaxH3ReferenceAspectRatio,
  // Named union types for cleaner type annotations
  KlingMode,
  KlingDuration,
  KlingAspectRatio,
  GrokImagineMode,
  GrokImagineResolution,
  NanoBananaResolution,
  NanoBananaOutputFormat,
  VolcengineVideoToVideoLipSyncRequest,
  VolcengineVideoToVideoLipSyncMode,
  Omnihuman15Request,
  Omnihuman15OutputResolution,
  GeminiOmniVideoRequest,
  GeminiOmniVideoDuration,
  GeminiOmniVideoAspectRatio,
  GeminiOmniVideoResolution,
  VeoGenerateRequest,
  VeoModel,
  KlingV3TurboImageToVideoRequest,
  KlingV3TurboTextToVideoRequest,
  KlingV3TurboDuration,
  KlingV3TurboTextToVideoDuration,
  KlingV3TurboResolution,
  KlingV3TurboAspectRatio,
  KlingOmniTextToVideoRequest,
  KlingOmniImageToVideoRequest,
  KlingOmniReferenceToVideoRequest,
  KlingOmniTransformationRequest,
} from "@apicity/kie";
import type { XaiImageEditRequest, XaiImageGenerateRequest, XaiVideoGenerateRequest, XaiImageReference } from "@apicity/xai";
import type { GoogleFlowImagesRequest, GoogleFlowVideosRequest } from "@apicity/googleflow";
import type { AlibabaMultimodalGenerationRequest } from "@apicity/alibaba/zod";
import {
  GrokImageToImageRequestSchema,
  GrokImageToVideoRequestSchema,
  GrokTextToVideoRequestSchema,
  KlingMotionControlRequestSchema,
  KlingV3TurboImageToVideoRequestSchema,
  KlingV3TurboTextToVideoRequestSchema,
  NanoBananaProRequestSchema,
  Omnihuman15RequestSchema,
  Qwen2ImageEditRequestSchema,
  Qwen3ImageToImageRequestSchema,
  Qwen21TextToImageRequestSchema,
  Qwen21ImageToImageRequestSchema,
  Seedance2FastInputSchema,
  Seedance2InputSchema,
  Seedance2MiniInputSchema,
  Seedance25InputSchema,
  SeedreamImageToImageRequestSchema,
  SeedreamTextToImageRequestSchema,
  VolcengineVideoToVideoLipSyncRequestSchema,
  Wan30VideoPrimeRequestSchema,
  Wan30VideoRequestSchema,
} from "@apicity/kie/zod";
import type { z } from "zod";
import { zodDefault } from "./zod-slots.js";
import {
  KLING_OMNI_API_MODELS,
  KLING_OMNI_IMAGE_TO_VIDEO_TOOL,
  KLING_OMNI_REFERENCE_TO_VIDEO_TOOL,
  KLING_OMNI_TEXT_TO_VIDEO_TOOL,
  KLING_OMNI_TRANSFORMATION_TOOL,
  type KlingOmniMode,
} from "./kling-omni.js";
import {
  assertProviderPayload,
  transformProviderPrompt,
} from "./provider-prompt-transform.js";
import {
  normalizeNotebookReference,
  replaceNotebookMentions,
} from "videobook-engine/notebook-mentions";
import { grokImagine1080pImageCountError } from "./grok-imagine-video-contract.js";

// ---------------------------------------------------------------------------
// Individual builders
// ---------------------------------------------------------------------------

type ZodLike = { _def?: unknown; unwrap?: () => unknown };

function valueOrZodDefault<T>(value: T | undefined, schema: ZodLike): T | undefined {
  if (value !== undefined) return value;
  const result = zodDefault(schema);
  return result.hasDefault ? result.value as T : undefined;
}

type Kling30Args = {
  prompt?: string;
  mode: KlingMode;
  duration: KlingDuration;
  sound?: boolean;
  aspect_ratio?: KlingAspectRatio;
  multi_shots: boolean;
  multi_prompt?: MultiShotPrompt[];
};

function buildKling30VideoPayload(
  args: Kling30Args,
  imageUrls: string[],
  elements: KlingElement[],
): KlingVideoRequest {
  return {
    model: "kling-3.0/video",
    input: {
      ...(args.prompt ? { prompt: args.prompt } : {}),
      ...(imageUrls.length > 0 ? { image_urls: imageUrls } : {}),
      // Omit sound when unset so Kie can promote multi-shot default true.
      ...(args.sound !== undefined ? { sound: args.sound } : {}),
      duration: args.duration,
      ...(args.aspect_ratio !== undefined ? { aspect_ratio: args.aspect_ratio as KlingAspectRatio } : {}),
      mode: args.mode,
      multi_shots: args.multi_shots,
      ...(args.multi_prompt && args.multi_prompt.length > 0 ? { multi_prompt: args.multi_prompt } : {}),
      ...(elements.length > 0 ? { kling_elements: elements } : {}),
    },
  };
}

export function buildKlingV3TurboVideoPayload(
  args: {
    prompt: string;
    duration?: KlingV3TurboDuration | KlingV3TurboTextToVideoDuration;
    resolution?: KlingV3TurboResolution;
    aspect_ratio?: KlingV3TurboAspectRatio;
  },
  imageUrls: string[],
): KlingV3TurboImageToVideoRequest | KlingV3TurboTextToVideoRequest {
  const isI2V = imageUrls.length > 0;
  const defaults = KlingV3TurboTextToVideoRequestSchema.shape.input.parse({ prompt: args.prompt });
  if (isI2V) {
    return KlingV3TurboImageToVideoRequestSchema.parse({
      model: "kling/v3-turbo-image-to-video",
      input: {
        prompt: args.prompt,
        image_urls: imageUrls,
        duration: args.duration ?? defaults.duration,
        resolution: args.resolution ?? defaults.resolution,
      },
    });
  }
  return KlingV3TurboTextToVideoRequestSchema.parse({
    model: "kling/v3-turbo-text-to-video",
    input: {
      prompt: args.prompt,
      ...(args.duration !== undefined ? { duration: args.duration } : {}),
      ...(args.resolution !== undefined ? { resolution: args.resolution } : {}),
      ...(args.aspect_ratio !== undefined ? { aspect_ratio: args.aspect_ratio } : {}),
    },
  });
}

type Kling30MotionControlArgs = {
  prompt?: string;
  mode?: KlingMotionControlRequest["input"]["mode"];
  character_orientation?: KlingMotionControlRequest["input"]["character_orientation"];
  background_source?: KlingMotionControlRequest["input"]["background_source"];
};

function buildKling30MotionControlPayload(
  args: Kling30MotionControlArgs,
  inputUrls: string[],
  videoUrls: string[],
): KlingMotionControlRequest {
  return KlingMotionControlRequestSchema.parse({
    model: "kling-3.0/motion-control",
    input: {
      input_urls: inputUrls,
      video_urls: videoUrls,
      ...(args.prompt !== undefined ? { prompt: args.prompt } : {}),
      mode: args.mode || "720p",
      character_orientation: args.character_orientation || "video",
      background_source: args.background_source || "input_video",
    },
  });
}

type KlingOmniVideoArgs = {
  prompt: string;
  audio?: boolean;
  resolution?: "720p" | "1080p" | "4k";
  aspect_ratio?: "16:9" | "9:16" | "1:1" | "auto";
  duration?: number | string;
  customize_multi_shots?: boolean;
  prefer_multi_shots?: boolean;
  multi_prompt?: Array<{ prompt: string; duration: number }>;
};

type KlingOmniVideoOpts = {
  imageUrls?: string[];
  videoUrls?: string[];
};

type KlingOmniVideoRequest =
  | KlingOmniTextToVideoRequest
  | KlingOmniImageToVideoRequest
  | KlingOmniReferenceToVideoRequest
  | KlingOmniTransformationRequest;

function omniDurationNumber(value: number | string | undefined): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function buildKlingOmniVideoPayload(
  mode: KlingOmniMode,
  args: KlingOmniVideoArgs,
  opts: KlingOmniVideoOpts,
): KlingOmniVideoRequest {
  const imageUrls = opts.imageUrls ?? [];
  const videoUrls = opts.videoUrls ?? [];
  const hasImages = imageUrls.length > 0;
  const hasVideo = videoUrls.length > 0;
  const multiPrompt = args.multi_prompt && args.multi_prompt.length > 0
    ? args.multi_prompt
    : undefined;
  const customize = args.customize_multi_shots ?? (multiPrompt !== undefined);
  const durationNumber = omniDurationNumber(args.duration);

  if (mode === "text") {
    return {
      model: KLING_OMNI_API_MODELS.text,
      input: {
        prompt: args.prompt,
        customize_multi_shots: customize === true,
        ...(args.prefer_multi_shots !== undefined
          ? { prefer_multi_shots: args.prefer_multi_shots }
          : {}),
        ...(multiPrompt && customize === true ? { multi_prompt: multiPrompt } : {}),
        ...(args.audio !== undefined ? { audio: args.audio } : {}),
        ...(args.resolution !== undefined ? { resolution: args.resolution } : {}),
        ...(args.aspect_ratio !== undefined && args.aspect_ratio !== "auto"
          ? { aspect_ratio: args.aspect_ratio }
          : {}),
        ...(durationNumber !== undefined ? { duration: durationNumber } : {}),
      },
    };
  }

  if (mode === "image") {
    return {
      model: KLING_OMNI_API_MODELS.image,
      input: {
        prompt: args.prompt,
        image_urls: imageUrls,
        ...(durationNumber !== undefined ? { duration: durationNumber } : {}),
        ...(args.resolution !== undefined ? { resolution: args.resolution } : {}),
        ...(args.aspect_ratio !== undefined ? { aspect_ratio: args.aspect_ratio } : {}),
        ...(args.audio !== undefined ? { audio: args.audio } : {}),
        ...(customize !== undefined ? { customize_multi_shots: customize } : {}),
        ...(args.prefer_multi_shots !== undefined
          ? { prefer_multi_shots: args.prefer_multi_shots }
          : {}),
        ...(multiPrompt ? { multi_prompt: multiPrompt } : {}),
      },
    };
  }

  if (mode === "reference") {
    return {
      model: KLING_OMNI_API_MODELS.reference,
      input: {
        prompt: args.prompt,
        ...(hasImages ? { image_urls: imageUrls } : {}),
        ...(hasVideo ? { video_urls: videoUrls } : {}),
        ...(durationNumber !== undefined ? { duration: durationNumber } : {}),
        ...(args.resolution !== undefined ? { resolution: args.resolution } : {}),
        ...(args.aspect_ratio !== undefined ? { aspect_ratio: args.aspect_ratio } : {}),
        ...(hasVideo ? { audio: false } : args.audio !== undefined ? { audio: args.audio } : {}),
        ...(customize !== undefined ? { customize_multi_shots: customize } : {}),
        ...(args.prefer_multi_shots !== undefined
          ? { prefer_multi_shots: args.prefer_multi_shots }
          : {}),
        ...(multiPrompt ? { multi_prompt: multiPrompt } : {}),
      },
    };
  }

  return {
    model: KLING_OMNI_API_MODELS.transformation,
    input: {
      prompt: args.prompt,
      ...(hasImages ? { image_urls: imageUrls } : {}),
      video_urls: videoUrls,
      ...(hasImages && args.duration !== undefined
        ? { duration: String(args.duration) }
        : {}),
      ...(args.resolution !== undefined ? { resolution: args.resolution } : {}),
      ...(args.aspect_ratio !== undefined
        ? { aspect_ratio: args.aspect_ratio }
        : hasImages ? {} : { aspect_ratio: "auto" }),
      ...(args.audio !== undefined ? { audio: args.audio } : {}),
    },
  };
}

type GrokImagineVideoArgs = {
  prompt?: string;
  mode?: GrokImagineMode;
  duration?: number | string;
  resolution?: GrokImagineResolution;
  aspect_ratio?: GrokImageToVideoRequest["input"]["aspect_ratio"];
  task_id?: string;
  index?: number;
  nsfw_checker?: boolean;
  /** Asset ids parallel to `imageUrls` (job path) so prompt @img-* mentions can reorder urls. */
  image_refs?: string[];
};

function numericDuration(value: number | string | undefined): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/**
 * Kie Grok Imagine 1.5 i2v (suite slug `grok-imagine/image-to-video`).
 *
 * Upstream contract (docs.kie.ai + @apicity/kie):
 * - Use either external `image_urls` OR `task_id`+`index` — never both.
 * - `index` is only meaningful with `task_id` (0-based among Grok text-to-image
 *   results); it must be omitted when `image_urls` is set.
 * - In prompts, reference uploaded images as `@image1` / `@image2` … not
 *   videocity `@img-*` asset slugs. `@imageN` is the Nth entry in `image_urls`
 *   (1-based), so we reorder urls to match first-mention order in the prompt.
 * - `mode: "spicy"` is only valid on the task_id path; external URLs normalize
 *   spicy → normal.
 */
function bareImageRef(raw: string): string {
  return normalizeNotebookReference(raw);
}

const ARTIFACT_ID_TOKEN_PATTERN =
  /@([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?![\w-])/giu;

/**
 * Align `image_urls` with prompt mention order so `@image1` is the first
 * image the user named, then rewrite every `@img-*` token to `@imageN`.
 * Images present in the list but never mentioned keep their relative order
 * after the mentioned ones.
 *
 * `refKeys` is parallel to `imageUrls` when urls are already https (job path).
 * When omitted, slug identity is taken from the url itself if it still looks
 * like an `@img-*` / `img-*` asset ref (preview/translate path).
 */
function alignGrokImageUrlsAndPrompt(
  prompt: string | undefined,
  imageUrls: string[],
  refKeys?: readonly string[],
): { prompt?: string; imageUrls: string[] } {
  if (imageUrls.length === 0) {
    return prompt === undefined ? { imageUrls } : { prompt, imageUrls };
  }

  // Parallel keys for each url: asset slug when known, else the url itself.
  const keys = imageUrls.map((url, i) => {
    if (refKeys && refKeys[i] !== undefined) return bareImageRef(refKeys[i]);
    return bareImageRef(url);
  });

  const urlByKey = new Map<string, string>();
  imageUrls.forEach((url, i) => {
    urlByKey.set(keys[i], url);
  });

  if (prompt === undefined) return { imageUrls };

  // Mention order from the prompt (first occurrence wins). Post-resolution
  // prompts reference media as @<artifact-id> tokens.
  const mentioned: string[] = [];
  for (const match of prompt.matchAll(ARTIFACT_ID_TOKEN_PATTERN)) {
    const bare = (match[1] ?? "").toLowerCase();
    if (urlByKey.has(bare) && !mentioned.includes(bare)) mentioned.push(bare);
  }

  // If the prompt has no @<artifact-id> tokens that match our keys, leave
  // order alone but still return the prompt unchanged (nothing to rewrite).
  if (mentioned.length === 0) {
    return { prompt, imageUrls };
  }

  // Mentioned first (prompt order), then any remaining urls in original order.
  const ordered: string[] = [];
  const orderedKeys: string[] = [];
  const used = new Set<string>();
  for (const bare of mentioned) {
    const url = urlByKey.get(bare);
    if (url !== undefined) {
      ordered.push(url);
      orderedKeys.push(bare);
      used.add(bare);
    }
  }
  imageUrls.forEach((url, i) => {
    const bare = keys[i];
    if (!used.has(bare)) {
      ordered.push(url);
      orderedKeys.push(bare);
      used.add(bare);
    }
  });

  const indexByKey = new Map<string, number>();
  orderedKeys.forEach((bare, i) => {
    indexByKey.set(bare, i + 1);
  });

  const rewritten = replaceNotebookMentions(
    prompt,
    [...indexByKey].map(([reference, index]) => ({
      reference,
      replacement: `@image${index}`,
    })),
  );

  return { prompt: rewritten, imageUrls: ordered };
}

function buildGrokImagineVideoPayload(
  args: GrokImagineVideoArgs,
  imageUrls: string[],
): GrokImageToVideoRequest {
  const rawMode = valueOrZodDefault(args.mode, GrokImageToVideoRequestSchema.shape.input.shape.mode);
  const mode = rawMode === "fun" ? "fun" : rawMode === "spicy" ? "normal" : rawMode;
  const duration = numericDuration(args.duration) ?? valueOrZodDefault<number>(undefined, GrokImageToVideoRequestSchema.shape.input.shape.duration) as number;
  const resolution = valueOrZodDefault(args.resolution, GrokImageToVideoRequestSchema.shape.input.shape.resolution) as GrokImagineResolution;
  const aspectRatio = valueOrZodDefault(
    args.aspect_ratio as GrokImageToVideoRequest["input"]["aspect_ratio"] | undefined,
    GrokImageToVideoRequestSchema.shape.input.shape.aspect_ratio,
  ) as GrokImageToVideoRequest["input"]["aspect_ratio"];
  const nsfwChecker = valueOrZodDefault(args.nsfw_checker, GrokImageToVideoRequestSchema.shape.input.shape.nsfw_checker) as boolean;

  // Preview passes slugs as imageUrls; job passes https urls + parallel image_refs.
  const refKeys = args.image_refs?.map(bareImageRef);
  const aligned = alignGrokImageUrlsAndPrompt(args.prompt, imageUrls, refKeys);
  const resolutionError = grokImagine1080pImageCountError(
    aligned.imageUrls.length,
    resolution,
  );
  if (resolutionError) throw new Error(resolutionError);
  const hasImageUrls = aligned.imageUrls.length > 0;
  const hasTaskId = typeof args.task_id === "string" && args.task_id.length > 0;
  // Prefer image_urls when both are present (tool path always supplies urls).
  const useTaskId = hasTaskId && !hasImageUrls;
  const index = useTaskId
    ? (valueOrZodDefault(args.index, GrokImageToVideoRequestSchema.shape.input.shape.index) as number)
    : undefined;

  return {
    model: "grok-imagine/image-to-video",
    input: {
      ...(hasImageUrls ? { image_urls: aligned.imageUrls } : {}),
      ...(useTaskId ? { task_id: args.task_id, index } : {}),
      ...(aligned.prompt !== undefined ? { prompt: aligned.prompt } : {}),
      mode: mode as GrokImageToVideoRequest["input"]["mode"],
      aspect_ratio: aspectRatio,
      resolution,
      duration,
      nsfw_checker: nsfwChecker,
    },
  };
}

type GrokImagineT2vArgs = {
  prompt: string;
  mode?: GrokImagineMode;
  duration?: number;
  resolution?: GrokImagineResolution;
  aspect_ratio?: GrokTextToVideoRequest["input"]["aspect_ratio"];
  nsfw_checker?: boolean;
};

function buildGrokImagineT2vVideoPayload(
  args: GrokImagineT2vArgs,
): GrokTextToVideoRequest {
  const nsfwChecker = valueOrZodDefault(args.nsfw_checker, GrokTextToVideoRequestSchema.shape.input.shape.nsfw_checker) as boolean;
  return {
    model: "grok-imagine/text-to-video",
    input: {
      prompt: args.prompt,
      ...(args.mode !== undefined ? { mode: args.mode } : {}),
      duration: args.duration ?? 6,
      resolution: args.resolution ?? "480p",
      ...(args.aspect_ratio !== undefined ? { aspect_ratio: args.aspect_ratio as GrokTextToVideoRequest["input"]["aspect_ratio"] } : {}),
      nsfw_checker: nsfwChecker,
    },
  };
}

type GrokImagineImageArgs = Partial<Omit<GrokImageToImageRequest["input"], "image_urls">>;

function buildGrokImagineImagePayload(
  args: GrokImagineImageArgs,
  imageUrls: string[],
): GrokImageToImageRequest {
  const nsfwChecker = valueOrZodDefault(args.nsfw_checker, GrokImageToImageRequestSchema.shape.input.shape.nsfw_checker) as boolean;
  return {
    model: "grok-imagine/image-to-image",
    input: {
      image_urls: (imageUrls.length > 0 ? imageUrls : []) as [string],
      nsfw_checker: nsfwChecker,
      ...(args.prompt !== undefined ? { prompt: args.prompt } : {}),
    },
  };
}

type GrokImagineTextArgs = {
  prompt: string;
  aspect_ratio?: GrokTextToImageRequest["input"]["aspect_ratio"];
  enable_pro?: boolean;
  nsfw_checker?: boolean;
};

function buildGrokImagineTextPayload(
  args: GrokImagineTextArgs,
): GrokTextToImageRequest {
  return {
    model: "grok-imagine/text-to-image",
    input: {
      prompt: args.prompt,
      ...(args.aspect_ratio !== undefined ? { aspect_ratio: args.aspect_ratio } : {}),
      ...(args.enable_pro !== undefined ? { enable_pro: args.enable_pro } : {}),
      ...(args.nsfw_checker !== undefined ? { nsfw_checker: args.nsfw_checker } : {}),
    },
  };
}

type Seedance2Model = Seedance2FastRequest["model"] | Seedance2Request["model"];
type Seedance2Resolution = NonNullable<Seedance2Request["input"]["resolution"]>;

type Seedance2VideoArgs = {
  prompt: string;
  model?: Seedance2Model;
  aspect_ratio?: Seedance2Request["input"]["aspect_ratio"];
  resolution?: Seedance2Resolution;
  duration?: string;
  generate_audio?: boolean;
  web_search?: boolean;
  nsfw_checker?: boolean;
};

type Seedance2VideoOpts = {
  firstFrameUrl?: string;
  lastFrameUrl?: string;
  referenceImageUrls?: string[];
  referenceVideoUrls?: string[];
  referenceAudioUrls?: string[];
};

function buildSeedance2VideoPayload(
  args: Seedance2VideoArgs,
  opts: Seedance2VideoOpts,
): Seedance2FastRequest | Seedance2Request {
  const model: Seedance2Model = args.model ?? "bytedance/seedance-2-fast";
  const inputSchema = model === "bytedance/seedance-2" ? Seedance2InputSchema : Seedance2FastInputSchema;
  const duration = args.duration !== undefined
    ? parseInt(args.duration, 10)
    : valueOrZodDefault<number>(undefined, inputSchema.shape.duration);
  const nsfwChecker = valueOrZodDefault(args.nsfw_checker, inputSchema.shape.nsfw_checker);
  const input = {
    prompt: args.prompt,
    ...(args.web_search !== undefined ? { web_search: args.web_search } : {}),
    ...(opts.firstFrameUrl !== undefined ? { first_frame_url: opts.firstFrameUrl } : {}),
    ...(opts.lastFrameUrl !== undefined ? { last_frame_url: opts.lastFrameUrl } : {}),
    ...(opts.referenceImageUrls && opts.referenceImageUrls.length > 0 ? { reference_image_urls: opts.referenceImageUrls } : {}),
    ...(opts.referenceVideoUrls && opts.referenceVideoUrls.length > 0 ? { reference_video_urls: opts.referenceVideoUrls } : {}),
    ...(opts.referenceAudioUrls && opts.referenceAudioUrls.length > 0 ? { reference_audio_urls: opts.referenceAudioUrls } : {}),
    ...(args.aspect_ratio !== undefined ? { aspect_ratio: args.aspect_ratio as Seedance2FastRequest["input"]["aspect_ratio"] } : {}),
    ...(duration !== undefined ? { duration } : {}),
    ...(args.generate_audio !== undefined ? { generate_audio: args.generate_audio } : {}),
    ...(nsfwChecker !== undefined ? { nsfw_checker: nsfwChecker } : {}),
  };
  if (model === "bytedance/seedance-2") {
    return {
      model,
      input: {
        ...input,
        ...(args.resolution !== undefined ? { resolution: args.resolution } : {}),
      },
    };
  }
  return {
    model,
    input: {
      ...input,
      ...(args.resolution !== undefined && args.resolution !== "1080p"
        ? { resolution: args.resolution as Seedance2FastRequest["input"]["resolution"] }
        : {}),
    },
  };
}

type Seedance25VideoArgs = {
  prompt?: string;
  return_last_frame?: boolean;
  generate_audio?: boolean;
  resolution?: Seedance25Request["input"]["resolution"];
  aspect_ratio?: Seedance25Request["input"]["aspect_ratio"];
  duration?: string;
  output_format?: Seedance25Request["input"]["output_format"];
  web_search?: boolean;
  nsfw_checker?: boolean;
};

type Seedance25VideoOpts = {
  firstFrameUrl?: string;
  lastFrameUrl?: string;
  referenceImageUrls?: string[];
  referenceVideoUrls?: string[];
  referenceAudioUrls?: string[];
};

function buildSeedance25VideoPayload(
  args: Seedance25VideoArgs,
  opts: Seedance25VideoOpts,
): Seedance25Request {
  const inputSchema = Seedance25InputSchema.shape;
  const returnLastFrame = valueOrZodDefault(args.return_last_frame, inputSchema.return_last_frame);
  const generateAudio = args.generate_audio ?? LIGHTNING_VIDEO_GENERATE_AUDIO;
  const resolution = args.resolution ?? LIGHTNING_VIDEO_RESOLUTION;
  const aspectRatio = seedance25FrameAspectRatio("bytedance/seedance-2-5", {
    first_frame_url: opts.firstFrameUrl,
    last_frame_url: opts.lastFrameUrl,
  }) ?? args.aspect_ratio ?? LIGHTNING_VIDEO_ASPECT_RATIO;
  const duration = args.duration !== undefined
    ? parseInt(args.duration, 10)
    : LIGHTNING_VIDEO_DURATION_SECONDS;
  const outputFormat = args.output_format ?? LIGHTNING_VIDEO_OUTPUT_FORMAT;
  const nsfwChecker = valueOrZodDefault(args.nsfw_checker, inputSchema.nsfw_checker);
  return {
    model: "bytedance/seedance-2-5",
    input: {
      ...(args.prompt !== undefined ? { prompt: args.prompt } : {}),
      ...(opts.firstFrameUrl !== undefined ? { first_frame_url: opts.firstFrameUrl } : {}),
      ...(opts.lastFrameUrl !== undefined ? { last_frame_url: opts.lastFrameUrl } : {}),
      ...(opts.referenceImageUrls && opts.referenceImageUrls.length > 0 ? { reference_image_urls: opts.referenceImageUrls } : {}),
      ...(opts.referenceVideoUrls && opts.referenceVideoUrls.length > 0 ? { reference_video_urls: opts.referenceVideoUrls } : {}),
      ...(opts.referenceAudioUrls && opts.referenceAudioUrls.length > 0 ? { reference_audio_urls: opts.referenceAudioUrls } : {}),
      ...(returnLastFrame !== undefined ? { return_last_frame: returnLastFrame } : {}),
      ...(generateAudio !== undefined ? { generate_audio: generateAudio } : {}),
      ...(resolution !== undefined ? { resolution } : {}),
      ...(aspectRatio !== undefined ? { aspect_ratio: aspectRatio } : {}),
      ...(duration !== undefined ? { duration } : {}),
      ...(outputFormat !== undefined ? { output_format: outputFormat } : {}),
      ...(args.web_search !== undefined ? { web_search: args.web_search } : {}),
      ...(nsfwChecker !== undefined ? { nsfw_checker: nsfwChecker } : {}),
    },
  };
}

type Wan30VideoRequest = z.input<typeof Wan30VideoRequestSchema>;
type Wan30VideoPrimeRequest = z.input<typeof Wan30VideoPrimeRequestSchema>;

type Wan30VideoArgs = {
  prompt?: string;
  resolution?: Wan30VideoRequest["input"]["resolution"];
  aspect_ratio?: Wan30VideoRequest["input"]["aspect_ratio"];
  duration?: string;
  audio?: boolean;
  seed?: number;
  nsfw_checker?: boolean;
};

type Wan30VideoOpts = {
  firstFrameUrl?: string;
  lastFrameUrl?: string;
  referenceImageUrls?: string[];
  referenceVideoUrls?: string[];
  referenceAudioUrls?: string[];
};

function buildWan30VideoPayload(
  model: "wan/3-0-video" | "wan/3-0-video-prime",
  args: Wan30VideoArgs,
  opts: Wan30VideoOpts,
): Wan30VideoRequest | Wan30VideoPrimeRequest {
  const nsfwChecker = valueOrZodDefault(args.nsfw_checker, Wan30VideoRequestSchema.shape.input.shape.nsfw_checker);
  return {
    model,
    input: {
      ...(args.prompt !== undefined ? { prompt: args.prompt } : {}),
      ...(opts.firstFrameUrl !== undefined ? { first_frame_url: opts.firstFrameUrl } : {}),
      ...(opts.lastFrameUrl !== undefined ? { last_frame_url: opts.lastFrameUrl } : {}),
      ...(opts.referenceImageUrls && opts.referenceImageUrls.length > 0 ? { reference_image_urls: opts.referenceImageUrls } : {}),
      ...(opts.referenceVideoUrls && opts.referenceVideoUrls.length > 0 ? { reference_video_urls: opts.referenceVideoUrls } : {}),
      ...(opts.referenceAudioUrls && opts.referenceAudioUrls.length > 0 ? { reference_audio_urls: opts.referenceAudioUrls } : {}),
      ...(args.resolution !== undefined ? { resolution: args.resolution } : {}),
      ...(args.aspect_ratio !== undefined ? { aspect_ratio: args.aspect_ratio } : {}),
      ...(args.duration !== undefined ? { duration: parseInt(args.duration, 10) } : {}),
      ...(args.audio !== undefined ? { audio: args.audio } : {}),
      ...(args.seed !== undefined ? { seed: args.seed } : {}),
      ...(nsfwChecker !== undefined ? { nsfw_checker: nsfwChecker } : {}),
    },
  };
}

// Seedance 2 Mini is a distinct kie endpoint from seedance-2/-fast: no
// first/last frame, prompt optional, 480p/720p only. Kept separate from
// buildSeedance2VideoPayload rather than branching that two-model switch.
type Seedance2MiniVideoArgs = {
  prompt?: string;
  aspect_ratio?: Seedance2MiniAspectRatio;
  resolution?: Seedance2MiniResolution;
  duration?: string;
  generate_audio?: boolean;
  web_search?: boolean;
  nsfw_checker?: boolean;
};

type Seedance2MiniVideoOpts = {
  referenceImageUrls?: string[];
  referenceVideoUrls?: string[];
  referenceAudioUrls?: string[];
};

function buildSeedance2MiniVideoPayload(
  args: Seedance2MiniVideoArgs,
  opts: Seedance2MiniVideoOpts,
): Seedance2MiniRequest {
  // Always surface schema defaults for rate selectors. @apicity/cost keys
  // bytedance/seedance-2-mini by resolution|videoInput; omitting resolution
  // with reference_video_urls yields unbounded "variant 'video'" (vc-3vn2).
  const mini = Seedance2MiniInputSchema.shape;
  const resolution = valueOrZodDefault(args.resolution, mini.resolution);
  const duration = args.duration !== undefined
    ? parseInt(args.duration, 10)
    : valueOrZodDefault<number>(undefined, mini.duration);
  const aspect_ratio = valueOrZodDefault(args.aspect_ratio, mini.aspect_ratio);
  const generate_audio = valueOrZodDefault(args.generate_audio, mini.generate_audio);
  const web_search = valueOrZodDefault(args.web_search, mini.web_search);
  const nsfw_checker = valueOrZodDefault(args.nsfw_checker, mini.nsfw_checker);
  return {
    model: "bytedance/seedance-2-mini",
    input: {
      ...(args.prompt !== undefined ? { prompt: args.prompt } : {}),
      ...(opts.referenceImageUrls && opts.referenceImageUrls.length > 0 ? { reference_image_urls: opts.referenceImageUrls } : {}),
      ...(opts.referenceVideoUrls && opts.referenceVideoUrls.length > 0 ? { reference_video_urls: opts.referenceVideoUrls } : {}),
      ...(opts.referenceAudioUrls && opts.referenceAudioUrls.length > 0 ? { reference_audio_urls: opts.referenceAudioUrls } : {}),
      ...(aspect_ratio !== undefined ? { aspect_ratio } : {}),
      ...(resolution !== undefined ? { resolution } : {}),
      ...(duration !== undefined ? { duration } : {}),
      ...(generate_audio !== undefined ? { generate_audio } : {}),
      ...(web_search !== undefined ? { web_search } : {}),
      ...(nsfw_checker !== undefined ? { nsfw_checker } : {}),
    },
  };
}

type GeminiOmniVideoArgs = {
  prompt: string;
  duration: GeminiOmniVideoDuration;
  aspect_ratio?: GeminiOmniVideoAspectRatio;
  resolution?: GeminiOmniVideoResolution;
  seed?: number;
  video_clip_start?: number;
  video_clip_ends?: number;
};

type GeminiOmniVideoOpts = {
  imageUrls?: string[];
  videoUrl?: string;
};

function buildGeminiOmniVideoPayload(
  args: GeminiOmniVideoArgs,
  opts: GeminiOmniVideoOpts,
): GeminiOmniVideoRequest {
  return {
    model: "gemini-omni-video",
    input: {
      prompt: args.prompt,
      ...(opts.imageUrls && opts.imageUrls.length > 0 ? { image_urls: opts.imageUrls } : {}),
      ...(opts.videoUrl !== undefined
        ? { video_list: [{ url: opts.videoUrl, start: args.video_clip_start ?? 0, ends: args.video_clip_ends ?? 0 }] }
        : {}),
      duration: args.duration,
      ...(args.aspect_ratio !== undefined ? { aspect_ratio: args.aspect_ratio } : {}),
      ...(args.seed !== undefined ? { seed: args.seed } : {}),
      ...(args.resolution !== undefined ? { resolution: args.resolution } : {}),
    },
  };
}

// Veo 3 / Veo 3 Fast: Google's video model exposed via kie's separate veo
// namespace (kie.veo.post.api.v1.veo.generate). Flat request shape — no nested
// `input` object. generationType is inferred from whether reference images are
// supplied (REFERENCE_2_VIDEO vs TEXT_2_VIDEO).
type Veo3VideoArgs = {
  prompt: string;
  aspect_ratio?: VeoGenerateRequest["aspectRatio"];
  seed?: number;
};

type Veo3VideoOpts = {
  imageUrls?: string[];
};

function buildVeo3VideoPayload(
  model: VeoModel,
  args: Veo3VideoArgs,
  opts: Veo3VideoOpts,
): VeoGenerateRequest {
  const hasImages = opts.imageUrls !== undefined && opts.imageUrls.length > 0;
  return {
    prompt: args.prompt,
    model,
    ...(args.aspect_ratio !== undefined ? { aspectRatio: args.aspect_ratio } : {}),
    ...(hasImages ? { generationType: "REFERENCE_2_VIDEO" as const, imageUrls: opts.imageUrls } : { generationType: "TEXT_2_VIDEO" as const }),
    ...(args.seed !== undefined ? { seeds: args.seed } : {}),
  };
}

// ---------------------------------------------------------------------------
// Google Flow (useapi.net) — @apicity/googleflow
//
// Veo 3.1 / Omni Flash video and Nano Banana Pro image generation ride the
// google-flow endpoints. @apicity/googleflow's request schemas are $loose objects
// with no enums/ranges (docs/apicity-gaps.md §14), so allowed values are
// hand-typed from the useapi.net docs and reference assets are spread into
// the positional referenceImage_N / reference_N keys the API expects. Refs
// are mediaGenerationIds from prior POST /google-flow/assets uploads, not
// URLs.
// ---------------------------------------------------------------------------

type GoogleVeo31Model = "veo-3.1-quality" | "veo-3.1-fast" | "veo-3.1-lite" | "veo-3.1-lite-low-priority";
type GoogleFlowVideoAspectRatio = "16:9" | "9:16" | "1:1" | "4:3" | "3:4";

// The videos endpoint takes landscape/portrait keywords where the rest of the
// app uses ratio strings; 1:1 / 4:3 / 3:4 pass through unchanged.
function googleFlowVideoAspect(ratio: GoogleFlowVideoAspectRatio): string {
  if (ratio === "16:9") return "landscape";
  if (ratio === "9:16") return "portrait";
  return ratio;
}

function googleFlowReferenceSlots(prefix: string, ids: readonly string[]): Record<string, string> {
  const slots: Record<string, string> = {};
  ids.forEach((id, index) => { slots[`${prefix}_${index + 1}`] = id; });
  return slots;
}

// @apicity/googleflow@0.7.2 tightened videos.duration to the numeric-literal
// union 4|6|8|10; the app's tool contracts carry the value as a string enum, so
// map it back to the exact literal the request type demands.
type GoogleFlowDurationString = "4" | "6" | "8" | "10";
const GOOGLE_FLOW_DURATION_SECONDS = { "4": 4, "6": 6, "8": 8, "10": 10 } as const satisfies Record<GoogleFlowDurationString, 4 | 6 | 8 | 10>;

type Veo31VideoArgs = {
  prompt: string;
  aspect_ratio?: GoogleFlowVideoAspectRatio;
  duration?: "4" | "6" | "8";
  seed?: number;
};

type Veo31VideoOpts = {
  startImageId?: string;
  endImageId?: string;
  referenceImageIds?: string[];
};

function buildVeo31VideoPayload(
  model: GoogleVeo31Model,
  args: Veo31VideoArgs,
  opts: Veo31VideoOpts,
): GoogleFlowVideosRequest {
  const referenceImageIds = opts.referenceImageIds ?? [];
  // Google Flow reference-to-video only accepts duration 8.
  const durationSeconds = referenceImageIds.length > 0
    ? 8
    : args.duration !== undefined
      ? GOOGLE_FLOW_DURATION_SECONDS[args.duration]
      : undefined;
  return {
    prompt: args.prompt,
    model,
    ...(args.aspect_ratio !== undefined ? { aspectRatio: googleFlowVideoAspect(args.aspect_ratio) } : {}),
    ...(durationSeconds !== undefined ? { duration: durationSeconds } : {}),
    ...(args.seed !== undefined ? { seed: args.seed } : {}),
    ...(opts.startImageId !== undefined ? { startImage: opts.startImageId } : {}),
    ...(opts.endImageId !== undefined ? { endImage: opts.endImageId } : {}),
    ...googleFlowReferenceSlots("referenceImage", referenceImageIds),
  };
}

type GoogleOmniVideoArgs = {
  prompt: string;
  duration?: "4" | "6" | "8" | "10";
  aspect_ratio?: "16:9" | "9:16";
  seed?: number;
  video_clip_start?: number;
  video_clip_ends?: number;
};

type GoogleOmniVideoOpts = {
  startImageId?: string;
  referenceImageIds?: string[];
  referenceVideoId?: string;
  voiceRefs?: string[];
  characterRefs?: string[];
};

// Omni Flash trims the reference clip on a 24fps frame timeline capped at
// 240 frames (10s); the tool contract stays in seconds like the kie
// gemini-omni tool, converted here.
const OMNI_FLASH_FPS = 24;
const OMNI_FLASH_MAX_FRAME = 240;

function buildGoogleOmniVideoPayload(
  args: GoogleOmniVideoArgs,
  opts: GoogleOmniVideoOpts,
): GoogleFlowVideosRequest {
  const hasVideo = opts.referenceVideoId !== undefined;
  let clipSlots: Record<string, unknown> = {};
  if (hasVideo) {
    clipSlots = {
      referenceVideo_1: opts.referenceVideoId,
      ...(args.video_clip_start !== undefined
        ? {
            startFrameIndex_1: Math.min(
              Math.max(Math.round(args.video_clip_start * OMNI_FLASH_FPS), 0),
              OMNI_FLASH_MAX_FRAME - 1,
            ),
          }
        : {}),
      ...(args.video_clip_ends !== undefined
        ? {
            endFrameIndex_1: Math.min(
              Math.max(Math.round(args.video_clip_ends * OMNI_FLASH_FPS), 1),
              OMNI_FLASH_MAX_FRAME,
            ),
          }
        : {}),
    };
  }
  return {
    prompt: args.prompt,
    model: "omni-flash",
    // V2V edit rejects duration — the output length matches the trimmed clip.
    ...(!hasVideo ? { duration: GOOGLE_FLOW_DURATION_SECONDS[args.duration ?? "8"] } : {}),
    ...(args.aspect_ratio !== undefined ? { aspectRatio: googleFlowVideoAspect(args.aspect_ratio) } : {}),
    ...(args.seed !== undefined ? { seed: args.seed } : {}),
    ...(opts.startImageId !== undefined ? { startImage: opts.startImageId } : {}),
    ...googleFlowReferenceSlots("referenceImage", opts.referenceImageIds ?? []),
    // Voice refs (from create_google_flow_voice) → referenceAudio_1..5;
    // character refs (from create_google_flow_character) → character_1..7.
    ...googleFlowReferenceSlots("referenceAudio", opts.voiceRefs ?? []),
    ...googleFlowReferenceSlots("character", opts.characterRefs ?? []),
    ...clipSlots,
  };
}

type GoogleNbpImageArgs = {
  prompt: string;
  aspect_ratio?: "16:9" | "4:3" | "1:1" | "3:4" | "9:16" | "auto";
  seed?: number;
};

function buildGoogleNbpImagePayload(
  args: GoogleNbpImageArgs,
  referenceIds: readonly string[],
  characterRefs?: readonly string[],
): GoogleFlowImagesRequest {
  return {
    prompt: args.prompt,
    model: "nano-banana-pro",
    // The endpoint defaults to 4 variations; videocity persists exactly one
    // image per asset, so pin count to 1 (4x credits otherwise).
    count: 1,
    ...(args.aspect_ratio !== undefined ? { aspectRatio: args.aspect_ratio } : {}),
    ...(args.seed !== undefined ? { seed: args.seed } : {}),
    ...googleFlowReferenceSlots("reference", referenceIds),
    ...googleFlowReferenceSlots("character", characterRefs ?? []),
  };
}

type NanoBananaImageArgs = {
  prompt: string;
  aspect_ratio?: NanoBananaProRequest["input"]["aspect_ratio"];
  resolution?: NanoBananaResolution;
  output_format?: NanoBananaOutputFormat;
};

function buildNanoBananaImagePayload(
  args: NanoBananaImageArgs,
  imageInput: string[],
): NanoBananaProRequest {
  const aspectRatio = valueOrZodDefault(
    args.aspect_ratio,
    NanoBananaProRequestSchema.shape.input.shape.aspect_ratio,
  );
  const resolution = valueOrZodDefault(args.resolution, NanoBananaProRequestSchema.shape.input.shape.resolution);
  const outputFormat = valueOrZodDefault(args.output_format, NanoBananaProRequestSchema.shape.input.shape.output_format);
  return {
    model: "nano-banana-pro",
    input: {
      prompt: args.prompt,
      ...(imageInput.length > 0 ? { image_input: imageInput } : {}),
      ...(aspectRatio !== undefined ? { aspect_ratio: aspectRatio } : {}),
      ...(resolution !== undefined ? { resolution } : {}),
      ...(outputFormat !== undefined ? { output_format: outputFormat } : {}),
    },
  };
}

type SeedreamAspectRatio = NonNullable<SeedreamTextToImageRequest["input"]["aspect_ratio"]>;
type SeedreamQuality = NonNullable<SeedreamTextToImageRequest["input"]["quality"]>;

type SeedreamImageArgs = {
  prompt: string;
  aspect_ratio?: SeedreamAspectRatio;
  quality?: SeedreamQuality;
  nsfw_checker?: boolean;
};

function buildSeedreamTextImagePayload(
  args: SeedreamImageArgs,
): SeedreamTextToImageRequest {
  const nsfwChecker = valueOrZodDefault(args.nsfw_checker, SeedreamTextToImageRequestSchema.shape.input.shape.nsfw_checker);
  const quality = valueOrZodDefault(args.quality, SeedreamTextToImageRequestSchema.shape.input.shape.quality) as SeedreamQuality;
  return {
    model: "seedream/5-lite-text-to-image",
    input: {
      prompt: args.prompt,
      quality,
      ...(nsfwChecker !== undefined ? { nsfw_checker: nsfwChecker } : {}),
      ...(args.aspect_ratio !== undefined ? { aspect_ratio: args.aspect_ratio } : {}),
    },
  };
}

function buildSeedreamImageEditPayload(
  args: SeedreamImageArgs,
  imageUrls: string[],
): SeedreamImageToImageRequest {
  const nsfwChecker = valueOrZodDefault(args.nsfw_checker, SeedreamImageToImageRequestSchema.shape.input.shape.nsfw_checker);
  const quality = valueOrZodDefault(args.quality, SeedreamImageToImageRequestSchema.shape.input.shape.quality) as SeedreamQuality;
  return {
    model: "seedream/5-lite-image-to-image",
    input: {
      prompt: args.prompt,
      image_urls: imageUrls,
      quality,
      ...(nsfwChecker !== undefined ? { nsfw_checker: nsfwChecker } : {}),
      ...(args.aspect_ratio !== undefined ? { aspect_ratio: args.aspect_ratio } : {}),
    },
  };
}

type Qwen2ImageEditArgs = {
  prompt: string;
  image_size?: Qwen2ImageEditRequest["input"]["image_size"];
  output_format?: NonNullable<Qwen2ImageEditRequest["input"]["output_format"]>;
  seed?: number;
};

function buildQwen2ImageEditPayload(
  args: Qwen2ImageEditArgs,
  imageUrl: string,
): Qwen2ImageEditRequest {
  const image_size = valueOrZodDefault(
    args.image_size,
    Qwen2ImageEditRequestSchema.shape.input.shape.image_size,
  );
  const output_format = valueOrZodDefault(args.output_format, Qwen2ImageEditRequestSchema.shape.input.shape.output_format);
  return {
    model: "qwen2/image-edit",
    input: {
      prompt: args.prompt,
      image_url: imageUrl,
      ...(image_size !== undefined ? { image_size } : {}),
      ...(output_format !== undefined ? { output_format } : {}),
      ...(args.seed !== undefined ? { seed: args.seed } : {}),
    },
  };
}

type Qwen3ImageEditArgs = {
  prompt: string;
  image_size?: Qwen3ImageToImageRequest["input"]["image_size"];
  output_format?: Qwen3ImageToImageRequest["input"]["output_format"];
  prompt_extend?: boolean;
  nsfw_checker?: boolean;
  negative_prompt?: string;
  seed?: number;
  resolution?: Qwen3ImageToImageRequest["input"]["resolution"];
};

function buildQwen3ImageEditPayload(
  args: Qwen3ImageEditArgs,
  imageUrls: string[],
): Qwen3ImageToImageRequest {
  const imageSize = valueOrZodDefault(args.image_size, Qwen3ImageToImageRequestSchema.shape.input.shape.image_size);
  const outputFormat = valueOrZodDefault(args.output_format, Qwen3ImageToImageRequestSchema.shape.input.shape.output_format);
  const promptExtend = valueOrZodDefault(args.prompt_extend, Qwen3ImageToImageRequestSchema.shape.input.shape.prompt_extend);
  const nsfwChecker = valueOrZodDefault(args.nsfw_checker, Qwen3ImageToImageRequestSchema.shape.input.shape.nsfw_checker);
  const seed = valueOrZodDefault(args.seed, Qwen3ImageToImageRequestSchema.shape.input.shape.seed);
  const resolution = valueOrZodDefault(args.resolution, Qwen3ImageToImageRequestSchema.shape.input.shape.resolution);
  return {
    model: "qwen3/image-to-image",
    input: {
      prompt: args.prompt,
      image_urls: imageUrls,
      ...(imageSize !== undefined ? { image_size: imageSize } : {}),
      ...(outputFormat !== undefined ? { output_format: outputFormat } : {}),
      ...(promptExtend !== undefined ? { prompt_extend: promptExtend } : {}),
      ...(nsfwChecker !== undefined ? { nsfw_checker: nsfwChecker } : {}),
      ...(args.negative_prompt !== undefined ? { negative_prompt: args.negative_prompt } : {}),
      ...(seed !== undefined ? { seed } : {}),
      ...(resolution !== undefined ? { resolution } : {}),
    },
  };
}

type Qwen21TextToImageArgs = {
  prompt: string;
  aspect_ratio?: Qwen21TextToImageRequest["input"]["aspect_ratio"];
  background?: Qwen21TextToImageRequest["input"]["background"];
  output_format?: Qwen21TextToImageRequest["input"]["output_format"];
  resolution?: Qwen21TextToImageRequest["input"]["resolution"];
  enhance_prompt?: boolean;
  nsfw_checker?: boolean;
  seed?: number;
};

function buildQwen21TextToImagePayload(
  args: Qwen21TextToImageArgs,
): Qwen21TextToImageRequest {
  const aspectRatio = valueOrZodDefault(args.aspect_ratio, Qwen21TextToImageRequestSchema.shape.input.shape.aspect_ratio);
  const background = valueOrZodDefault(args.background, Qwen21TextToImageRequestSchema.shape.input.shape.background);
  const outputFormat = valueOrZodDefault(args.output_format, Qwen21TextToImageRequestSchema.shape.input.shape.output_format);
  const resolution = valueOrZodDefault(args.resolution, Qwen21TextToImageRequestSchema.shape.input.shape.resolution);
  const enhancePrompt = valueOrZodDefault(args.enhance_prompt, Qwen21TextToImageRequestSchema.shape.input.shape.enhance_prompt);
  const nsfwChecker = valueOrZodDefault(args.nsfw_checker, Qwen21TextToImageRequestSchema.shape.input.shape.nsfw_checker);
  const seed = valueOrZodDefault(args.seed, Qwen21TextToImageRequestSchema.shape.input.shape.seed);
  return {
    model: "qwen2-1/text-to-image",
    input: {
      prompt: args.prompt,
      ...(aspectRatio !== undefined ? { aspect_ratio: aspectRatio } : {}),
      ...(background !== undefined ? { background } : {}),
      ...(outputFormat !== undefined ? { output_format: outputFormat } : {}),
      ...(resolution !== undefined ? { resolution } : {}),
      ...(enhancePrompt !== undefined ? { enhance_prompt: enhancePrompt } : {}),
      ...(nsfwChecker !== undefined ? { nsfw_checker: nsfwChecker } : {}),
      ...(seed !== undefined ? { seed } : {}),
    },
  };
}

type Qwen21ImageEditArgs = {
  prompt: string;
  aspect_ratio?: Qwen21ImageToImageRequest["input"]["aspect_ratio"];
  background?: Qwen21ImageToImageRequest["input"]["background"];
  output_format?: Qwen21ImageToImageRequest["input"]["output_format"];
  resolution?: Qwen21ImageToImageRequest["input"]["resolution"];
  enhance_prompt?: boolean;
  nsfw_checker?: boolean;
  seed?: number;
};

function buildQwen21ImageEditPayload(
  args: Qwen21ImageEditArgs,
  imageUrls: string[],
): Qwen21ImageToImageRequest {
  const aspectRatio = valueOrZodDefault(args.aspect_ratio, Qwen21ImageToImageRequestSchema.shape.input.shape.aspect_ratio);
  const background = valueOrZodDefault(args.background, Qwen21ImageToImageRequestSchema.shape.input.shape.background);
  const outputFormat = valueOrZodDefault(args.output_format, Qwen21ImageToImageRequestSchema.shape.input.shape.output_format);
  const resolution = valueOrZodDefault(args.resolution, Qwen21ImageToImageRequestSchema.shape.input.shape.resolution);
  const enhancePrompt = valueOrZodDefault(args.enhance_prompt, Qwen21ImageToImageRequestSchema.shape.input.shape.enhance_prompt);
  const nsfwChecker = valueOrZodDefault(args.nsfw_checker, Qwen21ImageToImageRequestSchema.shape.input.shape.nsfw_checker);
  const seed = valueOrZodDefault(args.seed, Qwen21ImageToImageRequestSchema.shape.input.shape.seed);
  return {
    model: "qwen2-1/image-to-image",
    input: {
      prompt: args.prompt,
      image_urls: imageUrls,
      ...(aspectRatio !== undefined ? { aspect_ratio: aspectRatio } : {}),
      ...(background !== undefined ? { background } : {}),
      ...(outputFormat !== undefined ? { output_format: outputFormat } : {}),
      ...(resolution !== undefined ? { resolution } : {}),
      ...(enhancePrompt !== undefined ? { enhance_prompt: enhancePrompt } : {}),
      ...(nsfwChecker !== undefined ? { nsfw_checker: nsfwChecker } : {}),
      ...(seed !== undefined ? { seed } : {}),
    },
  };
}

type GptImageArgs = {
  prompt: string;
  aspect_ratio?: GptImage2ImageToImageAspectRatio;
  resolution?: GptImage2ImageToImageResolution;
  nsfw_checker?: boolean;
};

function buildGptImagePayload(
  args: GptImageArgs,
  inputUrls: string[],
): GptImage2ImageToImageRequest {
  return {
    model: "gpt-image-2-image-to-image",
    input: {
      prompt: args.prompt,
      input_urls: inputUrls,
      ...(args.aspect_ratio !== undefined ? { aspect_ratio: args.aspect_ratio } : {}),
      ...(args.resolution !== undefined ? { resolution: args.resolution } : {}),
      ...(args.nsfw_checker !== undefined ? { nsfw_checker: args.nsfw_checker } : {}),
    },
  };
}

type GptImageTextArgs = {
  prompt: string;
  aspect_ratio?: GptImage2TextToImageAspectRatio;
  resolution?: GptImage2TextToImageResolution;
  nsfw_checker?: boolean;
};

function buildGptImageTextPayload(
  args: GptImageTextArgs,
): GptImage2TextToImageRequest {
  return {
    model: "gpt-image-2-text-to-image",
    input: {
      prompt: args.prompt,
      ...(args.aspect_ratio !== undefined ? { aspect_ratio: args.aspect_ratio } : {}),
      ...(args.resolution !== undefined ? { resolution: args.resolution } : {}),
      ...(args.nsfw_checker !== undefined ? { nsfw_checker: args.nsfw_checker } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Volcengine payload builders
// ---------------------------------------------------------------------------

type VolcengineLipSyncArgs = {
  mode: VolcengineVideoToVideoLipSyncMode;
  separate_vocal?: boolean;
  open_scenedet?: boolean;
  align_audio?: boolean;
  align_audio_reverse?: boolean;
  templ_start_seconds?: number;
};

type VolcengineLipSyncOpts = {
  videoUrl: string;
  audioUrl: string;
};

export function buildVolcengineLipSyncPayload(
  args: VolcengineLipSyncArgs,
  opts: VolcengineLipSyncOpts,
): VolcengineVideoToVideoLipSyncRequest {
  return VolcengineVideoToVideoLipSyncRequestSchema.parse({
    model: "volcengine/video-to-video-lip-sync",
    input: {
      mode: args.mode,
      video_url: opts.videoUrl,
      audio_url: opts.audioUrl,
      ...(args.separate_vocal !== undefined ? { separate_vocal: args.separate_vocal } : {}),
      ...(args.open_scenedet !== undefined ? { open_scenedet: args.open_scenedet } : {}),
      ...(args.align_audio !== undefined ? { align_audio: args.align_audio } : {}),
      ...(args.align_audio_reverse !== undefined ? { align_audio_reverse: args.align_audio_reverse } : {}),
      ...(args.templ_start_seconds !== undefined ? { templ_start_seconds: args.templ_start_seconds } : {}),
    },
  });
}

// ---------------------------------------------------------------------------
// OmniHuman payload builders
// ---------------------------------------------------------------------------

type OmnihumanArgs = {
  prompt?: string;
  output_resolution?: Omnihuman15OutputResolution;
  pe_fast_mode?: boolean;
  seed?: number;
};

type OmnihumanOpts = {
  imageUrl: string;
  audioUrl: string;
  maskUrls?: string[];
};

export function buildOmnihumanPayload(
  args: OmnihumanArgs,
  opts: OmnihumanOpts,
): Omnihuman15Request {
  const outputResolution = valueOrZodDefault(args.output_resolution, Omnihuman15RequestSchema.shape.input.shape.output_resolution) as Omnihuman15OutputResolution;
  const peFastMode = valueOrZodDefault(args.pe_fast_mode, Omnihuman15RequestSchema.shape.input.shape.pe_fast_mode) as boolean;
  const seed = valueOrZodDefault(args.seed, Omnihuman15RequestSchema.shape.input.shape.seed) as number;
  return {
    model: "omnihuman-1-5",
    input: {
      image_url: opts.imageUrl,
      audio_url: opts.audioUrl,
      ...(opts.maskUrls && opts.maskUrls.length > 0 ? { mask_url: opts.maskUrls } : {}),
      ...(args.prompt !== undefined ? { prompt: args.prompt } : {}),
      output_resolution: outputResolution,
      pe_fast_mode: peFastMode,
      seed,
    },
  };
}

// ---------------------------------------------------------------------------
// HappyHorse payload builders
// ---------------------------------------------------------------------------

type HappyHorseT2vArgs = {
  prompt: string;
  resolution?: HappyHorseResolution;
  aspect_ratio?: HappyHorse11AspectRatio;
  duration?: string;
};

function buildHappyHorseT2vPayload(args: HappyHorseT2vArgs): HappyHorse11TextToVideoRequest {
  return {
    model: "happyhorse-1-1/text-to-video",
    input: {
      prompt: args.prompt,
      ...(args.resolution !== undefined ? { resolution: args.resolution } : {}),
      ...(args.aspect_ratio !== undefined ? { aspect_ratio: args.aspect_ratio } : {}),
      ...(args.duration !== undefined ? { duration: parseInt(args.duration, 10) } : {}),
    },
  };
}

type HappyHorseI2vArgs = {
  prompt?: string;
  resolution?: HappyHorseResolution;
  duration?: string;
};

function buildHappyHorseI2vPayload(args: HappyHorseI2vArgs, imageUrl: string): HappyHorse11ImageToVideoRequest {
  return {
    model: "happyhorse-1-1/image-to-video",
    input: {
      image_urls: [imageUrl],
      ...(args.prompt !== undefined ? { prompt: args.prompt } : {}),
      ...(args.resolution !== undefined ? { resolution: args.resolution } : {}),
      ...(args.duration !== undefined ? { duration: parseInt(args.duration, 10) } : {}),
    },
  };
}

type HappyHorseRefArgs = {
  prompt: string;
  resolution?: HappyHorseResolution;
  aspect_ratio?: HappyHorse11AspectRatio;
  duration?: string;
};

function buildHappyHorseRefPayload(args: HappyHorseRefArgs, referenceImages: string[]): HappyHorse11ReferenceToVideoRequest {
  return {
    model: "happyhorse-1-1/reference-to-video",
    input: {
      prompt: args.prompt,
      reference_image: referenceImages,
      ...(args.resolution !== undefined ? { resolution: args.resolution } : {}),
      ...(args.aspect_ratio !== undefined ? { aspect_ratio: args.aspect_ratio } : {}),
      ...(args.duration !== undefined ? { duration: parseInt(args.duration, 10) } : {}),
    },
  };
}

type HappyHorseVideoEditArgs = {
  prompt: string;
  resolution?: HappyHorseResolution;
  audio_setting?: HappyHorseAudioSetting;
  seed?: number;
};

function buildHappyHorseVideoEditPayload(
  args: HappyHorseVideoEditArgs,
  videoUrl: string,
  referenceImages?: string[],
): HappyHorseVideoEditRequest {
  return {
    model: "happyhorse/video-edit",
    input: {
      prompt: args.prompt,
      video_url: videoUrl,
      ...(referenceImages && referenceImages.length > 0 ? { reference_image: referenceImages } : {}),
      ...(args.resolution !== undefined ? { resolution: args.resolution } : {}),
      ...(args.audio_setting !== undefined ? { audio_setting: args.audio_setting } : {}),
      ...(args.seed !== undefined ? { seed: args.seed } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// MiniMax H3 payload builders
// ---------------------------------------------------------------------------

type MiniMaxH3T2vArgs = {
  prompt: string;
  aspect_ratio: MiniMaxH3FixedAspectRatio;
  duration: string;
  resolution?: MiniMaxH3Resolution;
};

function buildMiniMaxH3T2vPayload(args: MiniMaxH3T2vArgs): MiniMaxH3TextToVideoRequest {
  return {
    model: "minimax-h3/text-to-video",
    input: {
      prompt: args.prompt,
      aspect_ratio: args.aspect_ratio,
      duration: parseInt(args.duration, 10),
      ...(args.resolution !== undefined ? { resolution: args.resolution } : {}),
    },
  };
}

type MiniMaxH3I2vArgs = {
  prompt: string;
  duration: string;
  resolution?: MiniMaxH3Resolution;
};

type MiniMaxH3I2vOpts = {
  firstFrameUrl?: string;
  lastFrameUrl?: string;
};

function buildMiniMaxH3I2vPayload(args: MiniMaxH3I2vArgs, opts: MiniMaxH3I2vOpts): MiniMaxH3ImageToVideoRequest {
  return {
    model: "minimax-h3/image-to-video",
    input: {
      prompt: args.prompt,
      duration: parseInt(args.duration, 10),
      ...(opts.firstFrameUrl !== undefined ? { first_frame_url: opts.firstFrameUrl } : {}),
      ...(opts.lastFrameUrl !== undefined ? { last_frame_url: opts.lastFrameUrl } : {}),
      ...(args.resolution !== undefined ? { resolution: args.resolution } : {}),
    },
  };
}

type MiniMaxH3R2vArgs = {
  prompt: string;
  duration: string;
  aspect_ratio?: MiniMaxH3ReferenceAspectRatio;
  resolution?: MiniMaxH3Resolution;
};

type MiniMaxH3R2vOpts = {
  referenceImageUrls?: string[];
  referenceVideoUrls?: string[];
  referenceAudioUrls?: string[];
};

function buildMiniMaxH3R2vPayload(args: MiniMaxH3R2vArgs, opts: MiniMaxH3R2vOpts): MiniMaxH3ReferenceToVideoRequest {
  return {
    model: "minimax-h3/reference-to-video",
    input: {
      prompt: args.prompt,
      duration: parseInt(args.duration, 10),
      ...(opts.referenceImageUrls && opts.referenceImageUrls.length > 0 ? { reference_image_urls: opts.referenceImageUrls } : {}),
      ...(opts.referenceVideoUrls && opts.referenceVideoUrls.length > 0 ? { reference_video_urls: opts.referenceVideoUrls } : {}),
      ...(opts.referenceAudioUrls && opts.referenceAudioUrls.length > 0 ? { reference_audio_urls: opts.referenceAudioUrls } : {}),
      ...(args.aspect_ratio !== undefined ? { aspect_ratio: args.aspect_ratio } : {}),
      ...(args.resolution !== undefined ? { resolution: args.resolution } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// xAI payload builders
// ---------------------------------------------------------------------------

function buildXaiGrokImagineImagePayload(
  args: GrokImagineImageArgs,
  imageUrls: string[],
): XaiImageEditRequest {
  return {
    prompt: args.prompt ?? "",
    ...(imageUrls.length === 1
      ? { image: { url: imageUrls[0], type: "image_url" } as XaiImageReference }
      : imageUrls.length > 1
        ? { images: imageUrls.map((url): XaiImageReference => ({ url, type: "image_url" })) }
        : {}),
  };
}

type GrokImagineRefVideoArgs = {
  prompt: string;
  duration?: string;
  resolution?: XaiVideoGenerateRequest["resolution"];
  aspect_ratio?: XaiVideoGenerateRequest["aspect_ratio"];
};

function buildXaiGrokImagineRefVideoPayload(
  args: GrokImagineRefVideoArgs,
  imageUrls: string[],
): XaiVideoGenerateRequest {
  return {
    prompt: args.prompt,
    ...(imageUrls.length > 0 ? { reference_images: imageUrls.map((url) => ({ url })) } : {}),
    ...(args.duration !== undefined ? { duration: parseInt(args.duration, 10) as XaiVideoGenerateRequest["duration"] } : {}),
    ...(args.resolution !== undefined ? { resolution: args.resolution } : {}),
    ...(args.aspect_ratio !== undefined ? { aspect_ratio: args.aspect_ratio } : {}),
  };
}

function buildXaiGrokImagineVideoPayload(
  args: GrokImagineVideoArgs,
  imageUrls: string[],
): XaiVideoGenerateRequest {
  return {
    prompt: args.prompt ?? "",
    ...(imageUrls.length === 1
      ? { image: { url: imageUrls[0] } }
      : imageUrls.length > 1
        ? { reference_images: imageUrls.map((url) => ({ url })) }
        : {}),
    ...(numericDuration(args.duration) !== undefined ? { duration: numericDuration(args.duration) as XaiVideoGenerateRequest["duration"] } : {}),
    ...(args.resolution !== undefined ? { resolution: args.resolution as XaiVideoGenerateRequest["resolution"] } : {}),
    ...(args.aspect_ratio !== undefined ? { aspect_ratio: args.aspect_ratio as XaiVideoGenerateRequest["aspect_ratio"] } : {}),
  };
}

// ---------------------------------------------------------------------------
// Alibaba payload builders
// ---------------------------------------------------------------------------

type AlibabaQwenImageModel = AlibabaMultimodalGenerationRequest["model"];

type AlibabaQwenImageArgs = {
  prompt: string;
  model: AlibabaQwenImageModel;
  size?: string;
  n?: number;
  negative_prompt?: string;
  prompt_extend?: boolean;
  watermark?: boolean;
  seed?: number;
};

function buildAlibabaQwenImagePayload(
  args: AlibabaQwenImageArgs,
  imageUrls: string[],
): AlibabaMultimodalGenerationRequest {
  const content: Array<{ text: string } | { image: string }> = [];
  for (const url of imageUrls) content.push({ image: url });
  content.push({ text: args.prompt });
  return {
    model: args.model,
    input: { messages: [{ role: "user", content }] },
    parameters: {
      ...(args.size !== undefined ? { size: args.size } : {}),
      ...(args.n !== undefined ? { n: args.n } : {}),
      ...(args.negative_prompt !== undefined ? { negative_prompt: args.negative_prompt } : {}),
      ...(args.prompt_extend !== undefined ? { prompt_extend: args.prompt_extend } : {}),
      ...(args.watermark !== undefined ? { watermark: args.watermark } : {}),
      ...(args.seed !== undefined ? { seed: args.seed } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Kling element extraction helper
// ---------------------------------------------------------------------------

function extractKlingElements(args: Record<string, unknown>): KlingElement[] {
  const elements: KlingElement[] = [];
  for (let slot = 1; slot <= 3; slot++) {
    const slugs = args[`element${slot}_refs`] as string[] | undefined;
    const name = args[`element${slot}_name`] as string | undefined;
    const desc = args[`element${slot}_desc`] as string | undefined;

    const hasSlugs = slugs && slugs.length > 0;
    const hasName = name && name.length > 0;
    const hasDesc = desc && desc.length > 0;

    if (!hasSlugs && !hasName && !hasDesc) continue;

    const element: KlingElement = {
      name: hasName ? name : `element ${slot}`,
      description: hasDesc ? desc : "",
    };

    if (hasSlugs) {
      // Refs are artifact ids, so media kind cannot be sniffed from the
      // value; the tool layer passes element<N>_video when the element
      // holds a video reference.
      if (args[`element${slot}_video`] === true) {
        element.element_input_video_urls = slugs;
      } else {
        element.element_input_urls = slugs;
      }
    }

    elements.push(element);
  }
  return elements;
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

type TranslateResult = {
  provider_path: string;
  payload: Record<string, unknown>;
};

function isXaiProvider(provider?: string): boolean {
  return provider !== undefined && provider.startsWith("xai");
}

import { getCanonicalName } from "./generation-registry.js";
import { buildApicity014TranslateResult } from "./apicity-014-media.js";
import { buildAudioGenerationTranslateResult } from "./audio-generation-models.js";

function translateToolPayloadUnchecked(
  rawToolName: string,
  rawArgs: Record<string, unknown>,
  provider?: string,
): TranslateResult | null {
  const toolName = getCanonicalName(rawToolName);
  const transformedPrompt = transformProviderPrompt(toolName, rawArgs, provider);
  const args = transformedPrompt === undefined
    ? rawArgs
    : { ...rawArgs, prompt: transformedPrompt };
  const apicity014 = buildApicity014TranslateResult(toolName, args);
  if (apicity014) return apicity014;
  const audio = buildAudioGenerationTranslateResult(toolName, args);
  if (audio) return audio;
  const imageRefs = (args.image_refs as string[] | undefined) ?? [];

  switch (toolName) {
    case "generate_kie_kling_3_0_video": {
      const elements = extractKlingElements(args);
      const payload = buildKling30VideoPayload(
        args as Kling30Args,
        imageRefs,
        elements,
      );
      return { provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_kie_kling_3_0_motion_control": {
      const characterImageUrls = (args.character_image_refs as string[] | undefined) ?? [];
      const motionVideoUrls = (args.motion_video_refs as string[] | undefined) ?? [];
      const payload = buildKling30MotionControlPayload(
        args as Kling30MotionControlArgs,
        characterImageUrls,
        motionVideoUrls,
      );
      return { provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_kie_kling_3_0_turbo_video": {
      const payload = buildKlingV3TurboVideoPayload(
        args as unknown as { prompt: string; duration?: string; resolution?: KlingV3TurboResolution; aspect_ratio?: KlingV3TurboAspectRatio },
        imageRefs,
      );
      return { provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", payload: payload as unknown as Record<string, unknown> };
    }
    case KLING_OMNI_TEXT_TO_VIDEO_TOOL:
    case KLING_OMNI_IMAGE_TO_VIDEO_TOOL:
    case KLING_OMNI_REFERENCE_TO_VIDEO_TOOL:
    case KLING_OMNI_TRANSFORMATION_TOOL: {
      const mode: KlingOmniMode =
        toolName === KLING_OMNI_IMAGE_TO_VIDEO_TOOL
          ? "image"
          : toolName === KLING_OMNI_REFERENCE_TO_VIDEO_TOOL
            ? "reference"
            : toolName === KLING_OMNI_TRANSFORMATION_TOOL
              ? "transformation"
              : "text";
      const payload = buildKlingOmniVideoPayload(
        mode,
        args as KlingOmniVideoArgs,
        {
          imageUrls: imageRefs,
          videoUrls: (args.video_refs as string[] | undefined) ?? [],
        },
      );
      return { provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_kie_grok_imagine_image_to_video": {
      if (isXaiProvider(provider)) {
        const payload = buildXaiGrokImagineVideoPayload(
          args as GrokImagineVideoArgs,
          imageRefs,
        );
        return { provider_path: "xai.post.v1.videos.generations(request, { otp })", payload: payload as unknown as Record<string, unknown> };
      }
      // Pass image_refs explicitly so mention-order alignment works even when
      // the preview still shows asset slugs in image_urls.
      const payload = buildGrokImagineVideoPayload(
        { ...(args as GrokImagineVideoArgs), image_refs: imageRefs },
        imageRefs,
      );
      return { provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_kie_grok_imagine_text_to_video": {
      const payload = buildGrokImagineT2vVideoPayload(args as GrokImagineT2vArgs);
      return { provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_kie_grok_imagine_image_to_image": {
      if (isXaiProvider(provider)) {
        const payload = buildXaiGrokImagineImagePayload(
          args as GrokImagineImageArgs,
          imageRefs,
        );
        return { provider_path: "xai.post.v1.images.edits(request, { otp })", payload: payload as unknown as Record<string, unknown> };
      }
      const payload = buildGrokImagineImagePayload(args as GrokImagineImageArgs, imageRefs);
      return { provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_kie_seedance_2_5_video": {
      const firstFrameUrl = (args.first_frame_ref as string | undefined) ?? undefined;
      const lastFrameUrl = (args.last_frame_ref as string | undefined) ?? undefined;
      const referenceImageUrls = imageRefs.length > 0 ? imageRefs : undefined;
      const referenceVideoUrls = (args.video_refs as string[] | undefined) ?? undefined;
      const referenceAudioUrls = (args.audio_refs as string[] | undefined) ?? undefined;
      const payload = buildSeedance25VideoPayload(
        args as Seedance25VideoArgs,
        {
          ...(firstFrameUrl !== undefined ? { firstFrameUrl } : {}),
          ...(lastFrameUrl !== undefined ? { lastFrameUrl } : {}),
          ...(referenceImageUrls !== undefined ? { referenceImageUrls } : {}),
          ...(referenceVideoUrls !== undefined && referenceVideoUrls.length > 0 ? { referenceVideoUrls } : {}),
          ...(referenceAudioUrls !== undefined && referenceAudioUrls.length > 0 ? { referenceAudioUrls } : {}),
        },
      );
      return { provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_kie_wan_3_0_video":
    case "generate_kie_wan_3_0_prime_video": {
      const apiModel = toolName === "generate_kie_wan_3_0_prime_video"
        ? "wan/3-0-video-prime"
        : "wan/3-0-video";
      const firstFrameUrl = (args.first_frame_ref as string | undefined) ?? undefined;
      const lastFrameUrl = (args.last_frame_ref as string | undefined) ?? undefined;
      const referenceVideoUrls = (args.video_refs as string[] | undefined) ?? undefined;
      const referenceAudioUrls = (args.audio_refs as string[] | undefined) ?? undefined;
      const payload = buildWan30VideoPayload(
        apiModel,
        args as Wan30VideoArgs,
        {
          ...(firstFrameUrl !== undefined ? { firstFrameUrl } : {}),
          ...(lastFrameUrl !== undefined ? { lastFrameUrl } : {}),
          ...(imageRefs.length > 0 ? { referenceImageUrls: imageRefs } : {}),
          ...(referenceVideoUrls !== undefined && referenceVideoUrls.length > 0 ? { referenceVideoUrls } : {}),
          ...(referenceAudioUrls !== undefined && referenceAudioUrls.length > 0 ? { referenceAudioUrls } : {}),
        },
      );
      return { provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_kie_seedance_2_0_video":
    case "generate_kie_seedance_2_0_fast_video": {
      const isFast = toolName === "generate_kie_seedance_2_0_fast_video";
      const apiModel: Seedance2Model = isFast
        ? "bytedance/seedance-2-fast"
        : "bytedance/seedance-2";
      const firstFrameUrl = (args.first_frame_ref as string | undefined) ?? undefined;
      const lastFrameUrl = (args.last_frame_ref as string | undefined) ?? undefined;
      const referenceImageUrls = imageRefs.length > 0 ? imageRefs : undefined;
      const referenceVideoUrls = (args.video_refs as string[] | undefined) ?? undefined;
      const referenceAudioUrls = (args.audio_refs as string[] | undefined) ?? undefined;
      const payload = buildSeedance2VideoPayload(
        { ...(args as Seedance2VideoArgs), model: apiModel },
        {
          ...(firstFrameUrl !== undefined ? { firstFrameUrl } : {}),
          ...(lastFrameUrl !== undefined ? { lastFrameUrl } : {}),
          ...(referenceImageUrls !== undefined ? { referenceImageUrls } : {}),
          ...(referenceVideoUrls !== undefined && referenceVideoUrls.length > 0 ? { referenceVideoUrls } : {}),
          ...(referenceAudioUrls !== undefined && referenceAudioUrls.length > 0 ? { referenceAudioUrls } : {}),
        },
      );
      return { provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_kie_seedance_2_0_mini_video": {
      const referenceImageUrls = imageRefs.length > 0 ? imageRefs : undefined;
      const referenceVideoUrls = (args.video_refs as string[] | undefined) ?? undefined;
      const referenceAudioUrls = (args.audio_refs as string[] | undefined) ?? undefined;
      const payload = buildSeedance2MiniVideoPayload(
        args as Seedance2MiniVideoArgs,
        {
          ...(referenceImageUrls !== undefined ? { referenceImageUrls } : {}),
          ...(referenceVideoUrls !== undefined && referenceVideoUrls.length > 0 ? { referenceVideoUrls } : {}),
          ...(referenceAudioUrls !== undefined && referenceAudioUrls.length > 0 ? { referenceAudioUrls } : {}),
        },
      );
      return { provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_kie_gemini_omni_video": {
      const videoRef = args.video_ref as string | undefined;
      const payload = buildGeminiOmniVideoPayload(
        args as GeminiOmniVideoArgs,
        {
          ...(imageRefs.length > 0 ? { imageUrls: imageRefs } : {}),
          ...(videoRef !== undefined && videoRef.trim() !== "" ? { videoUrl: videoRef } : {}),
        },
      );
      return { provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_google_flow_veo_3_1_quality_video":
    case "generate_google_flow_veo_3_1_fast_video":
    case "generate_google_flow_veo_3_1_lite_video":
    case "generate_google_flow_veo_3_1_lite_low_priority_video": {
      const model: GoogleVeo31Model = toolName === "generate_google_flow_veo_3_1_quality_video"
        ? "veo-3.1-quality"
        : toolName === "generate_google_flow_veo_3_1_fast_video"
          ? "veo-3.1-fast"
          : toolName === "generate_google_flow_veo_3_1_lite_low_priority_video"
            ? "veo-3.1-lite-low-priority"
            : "veo-3.1-lite";
      const startImage = args.first_frame_ref as string | undefined;
      const endImage = args.last_frame_ref as string | undefined;
      const payload = buildVeo31VideoPayload(model, args as Veo31VideoArgs, {
        ...(startImage !== undefined && startImage.trim() !== "" ? { startImageId: startImage } : {}),
        ...(endImage !== undefined && endImage.trim() !== "" ? { endImageId: endImage } : {}),
        ...(imageRefs.length > 0 ? { referenceImageIds: imageRefs } : {}),
      });
      return { provider_path: "googleflow.v1.videos({ async: true })", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_google_flow_omni_flash_video": {
      const startImage = args.first_frame_ref as string | undefined;
      const videoRef = args.video_ref as string | undefined;
      const voiceRefs = ((args.voice_refs as string[] | undefined) ?? []).filter((s) => s.trim() !== "");
      const characterRefs = ((args.character_refs as string[] | undefined) ?? []).filter((s) => s.trim() !== "");
      const payload = buildGoogleOmniVideoPayload(args as GoogleOmniVideoArgs, {
        ...(startImage !== undefined && startImage.trim() !== "" ? { startImageId: startImage } : {}),
        ...(imageRefs.length > 0 ? { referenceImageIds: imageRefs } : {}),
        ...(videoRef !== undefined && videoRef.trim() !== "" ? { referenceVideoId: videoRef } : {}),
        ...(voiceRefs.length > 0 ? { voiceRefs } : {}),
        ...(characterRefs.length > 0 ? { characterRefs } : {}),
      });
      return { provider_path: "googleflow.v1.videos({ async: true })", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_google_flow_nano_banana_pro_image": {
      const characterRefs = ((args.character_refs as string[] | undefined) ?? []).filter((s) => s.trim() !== "");
      const payload = buildGoogleNbpImagePayload(args as GoogleNbpImageArgs, imageRefs, characterRefs);
      return { provider_path: "googleflow.v1.images()", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_kie_grok_imagine_text_to_image": {
      if (isXaiProvider(provider)) {
        const payload: XaiImageGenerateRequest = {
          prompt: (args as GrokImagineTextArgs).prompt ?? "",
          n: 1,
          response_format: "url",
          ...(args.aspect_ratio !== undefined ? { aspect_ratio: args.aspect_ratio as XaiImageGenerateRequest["aspect_ratio"] } : {}),
        };
        return { provider_path: "xai.post.v1.images.generations(request, { otp })", payload: payload as unknown as Record<string, unknown> };
      }
      const payload = buildGrokImagineTextPayload(args as GrokImagineTextArgs);
      return { provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_xai_grok_imagine_video": {
      const payload = buildXaiGrokImagineRefVideoPayload(
        args as GrokImagineRefVideoArgs,
        imageRefs,
      );
      return { provider_path: "xai.post.v1.videos.generations(request, { otp })", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_kie_nano_banana_pro_text_to_image": {
      const payload = buildNanoBananaImagePayload(
        args as NanoBananaImageArgs,
        imageRefs,
      );
      return { provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_kie_seedream_v5_lite_text_to_image": {
      const payload = buildSeedreamTextImagePayload(args as SeedreamImageArgs);
      return { provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_kie_seedream_v5_lite_image_to_image": {
      const payload = buildSeedreamImageEditPayload(
        args as SeedreamImageArgs,
        imageRefs,
      );
      return { provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_kie_qwen_2_0_edit_image": {
      const payload = buildQwen2ImageEditPayload(
        args as Qwen2ImageEditArgs,
        imageRefs[0] ?? "",
      );
      return { provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_kie_qwen_3_0_edit_image": {
      const payload = buildQwen3ImageEditPayload(
        args as Qwen3ImageEditArgs,
        imageRefs,
      );
      return { provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_kie_qwen_2_1_text_to_image": {
      const payload = buildQwen21TextToImagePayload(args as Qwen21TextToImageArgs);
      return { provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_kie_qwen_2_1_edit_image": {
      const payload = buildQwen21ImageEditPayload(
        args as Qwen21ImageEditArgs,
        imageRefs,
      );
      return { provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_kie_gpt_image_2_5_flare_image":
    case "generate_kie_gpt_image_2_5_sunburst_image": {
      const payload = buildGptImage25Payload(
        toolName === "generate_kie_gpt_image_2_5_flare_image" ? "flare" : "sunburst",
        {
          prompt: args.prompt as string,
          aspect_ratio: args.aspect_ratio as GptImage25Input["aspect_ratio"],
          resolution: args.resolution as GptImage25Input["resolution"],
          background: args.background as GptImage25Input["background"],
        },
        imageRefs,
      );
      return { provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", payload };
    }
    case "generate_kie_gpt_image_2_image_to_image": {
      const payload = buildGptImagePayload(
        args as GptImageArgs,
        imageRefs,
      );
      return { provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_kie_gpt_image_2_text_to_image": {
      const payload = buildGptImageTextPayload(args as GptImageTextArgs);
      return { provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", payload: payload as unknown as Record<string, unknown> };
    }
    case "extend_kie_grok_imagine_video": {
      const payload: GrokVideoExtendRequest = {
        model: "grok-imagine/extend",
        input: {
          task_id: "<task_id_from_source_video_metadata>",
          prompt: args.prompt as string,
          extend_at: args.extend_at as number,
          extend_times: args.extend_times as GrokVideoExtendRequest["input"]["extend_times"],
        },
      };
      return { provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_kie_volcengine_video_to_video_lip_sync": {
      const videoRef = (args.video_ref as string) ?? "";
      const audioRef = (args.audio_ref as string) ?? "";
      const payload = buildVolcengineLipSyncPayload(args as VolcengineLipSyncArgs, {
        videoUrl: videoRef,
        audioUrl: audioRef,
      });
      return { provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_kie_omnihuman_1_5_video": {
      const imageRef = (args.image_ref as string) ?? "";
      const audioRef = (args.audio_ref as string) ?? "";
      const payload = buildOmnihumanPayload(args as OmnihumanArgs, {
        imageUrl: imageRef,
        audioUrl: audioRef,
      });
      return { provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_kie_happyhorse_1_1_text_to_video": {
      const payload = buildHappyHorseT2vPayload(args as HappyHorseT2vArgs);
      return { provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_kie_happyhorse_1_1_image_to_video": {
      const imageUrl = (args.first_frame_ref as string | undefined) ?? "";
      const payload = buildHappyHorseI2vPayload(
        args as HappyHorseI2vArgs,
        imageUrl,
      );
      return { provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_kie_happyhorse_1_1_reference_to_video": {
      const referenceImages = (args.image_refs as string[] | undefined) ?? [];
      const payload = buildHappyHorseRefPayload(
        args as HappyHorseRefArgs,
        referenceImages,
      );
      return { provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_kie_happyhorse_1_1_edit_video": {
      const videoRef = (args.video_ref as string | undefined) ?? "";
      const referenceImages = (args.image_refs as string[] | undefined) ?? [];
      const payload = buildHappyHorseVideoEditPayload(
        args as HappyHorseVideoEditArgs,
        videoRef,
        referenceImages,
      );
      return { provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_kie_minimax_h3_text_to_video": {
      const payload = buildMiniMaxH3T2vPayload(args as MiniMaxH3T2vArgs);
      return { provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_kie_minimax_h3_image_to_video": {
      const firstFrameUrl = (args.first_frame_ref as string | undefined) ?? undefined;
      const lastFrameUrl = (args.last_frame_ref as string | undefined) ?? undefined;
      const payload = buildMiniMaxH3I2vPayload(
        args as MiniMaxH3I2vArgs,
        {
          ...(firstFrameUrl !== undefined && firstFrameUrl.trim() !== "" ? { firstFrameUrl } : {}),
          ...(lastFrameUrl !== undefined && lastFrameUrl.trim() !== "" ? { lastFrameUrl } : {}),
        },
      );
      return { provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_kie_minimax_h3_reference_to_video": {
      const referenceImageUrls = imageRefs.length > 0 ? imageRefs : undefined;
      const referenceVideoUrls = (args.video_refs as string[] | undefined) ?? undefined;
      const referenceAudioUrls = (args.audio_refs as string[] | undefined) ?? undefined;
      const payload = buildMiniMaxH3R2vPayload(
        args as MiniMaxH3R2vArgs,
        {
          ...(referenceImageUrls !== undefined ? { referenceImageUrls } : {}),
          ...(referenceVideoUrls !== undefined && referenceVideoUrls.length > 0 ? { referenceVideoUrls } : {}),
          ...(referenceAudioUrls !== undefined && referenceAudioUrls.length > 0 ? { referenceAudioUrls } : {}),
        },
      );
      return { provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", payload: payload as unknown as Record<string, unknown> };
    }

    default:
      return null;
  }
}

function translateToolPayload(
  rawToolName: string,
  args: Record<string, unknown>,
  provider?: string,
): TranslateResult | null {
  const result = translateToolPayloadUnchecked(rawToolName, args, provider);
  if (!result) return null;
  assertProviderPayload(result.payload, {
    toolName: getCanonicalName(rawToolName),
  });
  return result;
}



// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
  buildKling30VideoPayload,
  buildKling30MotionControlPayload,
  buildKlingOmniVideoPayload,
  buildGrokImagineVideoPayload,
  buildGrokImagineT2vVideoPayload,
  buildGrokImagineImagePayload,
  buildXaiGrokImagineImagePayload,
  buildXaiGrokImagineRefVideoPayload,
  buildXaiGrokImagineVideoPayload,
  buildNanoBananaImagePayload,
  buildQwen2ImageEditPayload,
  buildQwen3ImageEditPayload,
  buildQwen21TextToImagePayload,
  buildQwen21ImageEditPayload,
  buildGrokImagineTextPayload,
  buildGptImagePayload,
  buildGptImageTextPayload,
  buildSeedreamTextImagePayload,
  buildSeedreamImageEditPayload,
  buildSeedance2VideoPayload,
  buildSeedance25VideoPayload,
  buildSeedance2MiniVideoPayload,
  buildWan30VideoPayload,
  buildGeminiOmniVideoPayload,
  buildVeo3VideoPayload,
  buildVeo31VideoPayload,
  buildGoogleOmniVideoPayload,
  buildGoogleNbpImagePayload,
  buildHappyHorseT2vPayload,
  buildHappyHorseI2vPayload,
  buildHappyHorseRefPayload,
  buildHappyHorseVideoEditPayload,
  buildMiniMaxH3T2vPayload,
  buildMiniMaxH3I2vPayload,
  buildMiniMaxH3R2vPayload,
  buildAlibabaQwenImagePayload,
  translateToolPayload,
};
export type { GoogleVeo31Model, Veo31VideoArgs, GoogleOmniVideoArgs, GoogleNbpImageArgs };
