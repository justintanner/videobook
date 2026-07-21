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
  Wan27ImageToVideoRequest,
  Wan27RefToVideoRequest,
  Wan27VideoEditRequest,
  Wan27TextToVideoRequest,
  HappyHorse11TextToVideoRequest,
  HappyHorse11ImageToVideoRequest,
  HappyHorse11ReferenceToVideoRequest,
  HappyHorse11AspectRatio,
  HappyHorseVideoEditRequest,
  HappyHorseResolution,
  HappyHorseAudioSetting,
  Wan27ImageRequest,
  Wan27ImageProRequest,
  // Named union types for cleaner type annotations
  KlingMode,
  KlingDuration,
  KlingAspectRatio,
  GrokImagineMode,
  GrokImagineResolution,
  NanoBananaResolution,
  NanoBananaOutputFormat,
  Wan27Resolution,
  Wan27AspectRatio,
  Wan27ImageAspectRatio,
  Wan27ImageResolution,
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
} from "@apicity/kie";
import type { XaiImageEditRequest, XaiImageGenerateRequest, XaiVideoGenerateRequest, XaiImageReference } from "@apicity/xai";
import type { GoogleFlowImagesRequest, GoogleFlowVideosRequest } from "@apicity/googleflow";
import type {
  AlibabaImageGenerationRequest,
  AlibabaVideoSynthesisRequest,
  AlibabaVideoSynthesisInput,
  AlibabaVideoSynthesisParameters,
} from "@apicity/alibaba";
import type { AlibabaMultimodalGenerationRequest } from "@apicity/alibaba/zod";
import {
  GrokImageToImageRequestSchema,
  GrokImageToVideoRequestSchema,
  GrokTextToVideoRequestSchema,
  KlingV3TurboImageToVideoRequestSchema,
  KlingV3TurboTextToVideoRequestSchema,
  NanoBananaProRequestSchema,
  Omnihuman15RequestSchema,
  Qwen2ImageEditRequestSchema,
  Seedance2FastInputSchema,
  Seedance2InputSchema,
  SeedreamImageToImageRequestSchema,
  SeedreamTextToImageRequestSchema,
  VolcengineVideoToVideoLipSyncRequestSchema,
  Wan27ImageProRequestSchema,
  Wan27ImageRequestSchema,
} from "@apicity/kie/zod";
import { zodDefault } from "./zod-slots.js";
import { rewriteImageSlugMentions, stripSlugMentions, replaceHappyHorseAssetMentions } from "./google-flow-refs.js";

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
  sound: boolean;
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
      sound: args.sound,
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
  return {
    model: "kling-3.0/motion-control",
    input: {
      input_urls: inputUrls,
      video_urls: videoUrls,
      ...(args.prompt !== undefined ? { prompt: args.prompt } : {}),
      ...(args.mode !== undefined ? { mode: args.mode } : {}),
      ...(args.character_orientation !== undefined ? { character_orientation: args.character_orientation } : {}),
      ...(args.background_source !== undefined ? { background_source: args.background_source } : {}),
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
  image_slugs?: string[];
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
const GROK_IMG_MENTION_RE = /@img-[\w-]+/g;

function bareImageSlug(raw: string): string {
  return raw.replace(/^@/, "").trim();
}

/**
 * Align `image_urls` with prompt mention order so `@image1` is the first
 * image the user named, then rewrite every `@img-*` token to `@imageN`.
 * Images present in the list but never mentioned keep their relative order
 * after the mentioned ones.
 *
 * `slugKeys` is parallel to `imageUrls` when urls are already https (job path).
 * When omitted, slug identity is taken from the url itself if it still looks
 * like an `@img-*` / `img-*` asset ref (preview/translate path).
 */
function alignGrokImageUrlsAndPrompt(
  prompt: string | undefined,
  imageUrls: string[],
  slugKeys?: readonly string[],
): { prompt?: string; imageUrls: string[] } {
  if (imageUrls.length === 0) {
    return prompt === undefined ? { imageUrls } : { prompt, imageUrls };
  }

  // Parallel keys for each url: asset slug when known, else the url itself.
  const keys = imageUrls.map((url, i) => {
    if (slugKeys && slugKeys[i] !== undefined) return bareImageSlug(slugKeys[i]);
    return bareImageSlug(url);
  });

  const urlByKey = new Map<string, string>();
  imageUrls.forEach((url, i) => {
    urlByKey.set(keys[i], url);
  });

  if (prompt === undefined) return { imageUrls };

  // Mention order from the prompt (first occurrence wins).
  const mentioned: string[] = [];
  for (const m of prompt.matchAll(GROK_IMG_MENTION_RE)) {
    const bare = bareImageSlug(m[0]);
    if (urlByKey.has(bare) && !mentioned.includes(bare)) mentioned.push(bare);
  }

  // If the prompt has no @img-* tokens that match our keys, leave order alone
  // but still return the prompt unchanged (nothing to rewrite).
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

  const rewritten = prompt.replace(GROK_IMG_MENTION_RE, (match) => {
    const bare = bareImageSlug(match);
    const n = indexByKey.get(bare);
    return n !== undefined ? `@image${n}` : match;
  });

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

  // Preview passes slugs as imageUrls; job passes https urls + parallel image_slugs.
  const slugKeys = args.image_slugs?.map(bareImageSlug);
  const aligned = alignGrokImageUrlsAndPrompt(args.prompt, imageUrls, slugKeys);
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
      ...(args.duration !== undefined ? { duration: args.duration } : {}),
      ...(args.resolution !== undefined ? { resolution: args.resolution } : {}),
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
  return {
    model: "bytedance/seedance-2-mini",
    input: {
      ...(args.prompt !== undefined ? { prompt: args.prompt } : {}),
      ...(opts.referenceImageUrls && opts.referenceImageUrls.length > 0 ? { reference_image_urls: opts.referenceImageUrls } : {}),
      ...(opts.referenceVideoUrls && opts.referenceVideoUrls.length > 0 ? { reference_video_urls: opts.referenceVideoUrls } : {}),
      ...(opts.referenceAudioUrls && opts.referenceAudioUrls.length > 0 ? { reference_audio_urls: opts.referenceAudioUrls } : {}),
      ...(args.aspect_ratio !== undefined ? { aspect_ratio: args.aspect_ratio } : {}),
      ...(args.resolution !== undefined ? { resolution: args.resolution } : {}),
      ...(args.duration !== undefined ? { duration: parseInt(args.duration, 10) } : {}),
      ...(args.generate_audio !== undefined ? { generate_audio: args.generate_audio } : {}),
      ...(args.web_search !== undefined ? { web_search: args.web_search } : {}),
      ...(args.nsfw_checker !== undefined ? { nsfw_checker: args.nsfw_checker } : {}),
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
  return {
    prompt: args.prompt,
    model,
    ...(args.aspect_ratio !== undefined ? { aspectRatio: googleFlowVideoAspect(args.aspect_ratio) } : {}),
    ...(args.duration !== undefined ? { duration: GOOGLE_FLOW_DURATION_SECONDS[args.duration] } : {}),
    ...(args.seed !== undefined ? { seed: args.seed } : {}),
    ...(opts.startImageId !== undefined ? { startImage: opts.startImageId } : {}),
    ...(opts.endImageId !== undefined ? { endImage: opts.endImageId } : {}),
    ...googleFlowReferenceSlots("referenceImage", opts.referenceImageIds ?? []),
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

type Wan27ImageArgs = {
  prompt: string;
  aspect_ratio?: Wan27ImageAspectRatio;
  resolution?: Wan27ImageResolution;
  seed?: number;
  nsfw_checker?: boolean;
};

function buildWan27ImagePayload(
  args: Wan27ImageArgs,
  inputUrls: string[],
): Wan27ImageRequest {
  return Wan27ImageRequestSchema.parse({
    model: "wan/2-7-image",
    input: {
      prompt: args.prompt,
      ...(inputUrls.length > 0 ? { input_urls: inputUrls } : {}),
      ...(args.aspect_ratio !== undefined ? { aspect_ratio: args.aspect_ratio } : {}),
      ...(args.resolution !== undefined ? { resolution: args.resolution } : {}),
      ...(args.seed !== undefined ? { seed: args.seed } : {}),
      ...(args.nsfw_checker !== undefined ? { nsfw_checker: args.nsfw_checker } : {}),
    },
  });
}

function buildWan27ImageProPayload(
  args: Wan27ImageArgs,
  inputUrls: string[],
): Wan27ImageProRequest {
  return Wan27ImageProRequestSchema.parse({
    model: "wan/2-7-image-pro",
    input: {
      prompt: args.prompt,
      ...(inputUrls.length > 0 ? { input_urls: inputUrls } : {}),
      ...(args.aspect_ratio !== undefined ? { aspect_ratio: args.aspect_ratio } : {}),
      ...(args.resolution !== undefined ? { resolution: args.resolution } : {}),
      ...(args.seed !== undefined ? { seed: args.seed } : {}),
      ...(args.nsfw_checker !== undefined ? { nsfw_checker: args.nsfw_checker } : {}),
    },
  });
}

type Wan27TextToVideoArgs = {
  prompt: string;
  negative_prompt?: string;
  resolution?: Wan27Resolution;
  aspect_ratio?: Wan27AspectRatio;
  duration?: string;
  prompt_extend?: boolean;
  watermark?: boolean;
  nsfw_checker?: boolean;
  seed?: number;
};

type Wan27TextToVideoOpts = {
  audioUrl?: string;
};

function buildWan27TextToVideoPayload(
  args: Wan27TextToVideoArgs,
  opts: Wan27TextToVideoOpts,
): Wan27TextToVideoRequest {
  return {
    model: "wan/2-7-text-to-video",
    input: {
      prompt: args.prompt,
      ...(args.negative_prompt !== undefined ? { negative_prompt: args.negative_prompt } : {}),
      ...(opts.audioUrl !== undefined ? { audio_url: opts.audioUrl } : {}),
      ...(args.resolution !== undefined ? { resolution: args.resolution } : {}),
      ...(args.aspect_ratio !== undefined ? { ratio: args.aspect_ratio } : {}),
      ...(args.duration !== undefined ? { duration: parseInt(args.duration, 10) } : {}),
      ...(args.prompt_extend !== undefined ? { prompt_extend: args.prompt_extend } : {}),
      ...(args.watermark !== undefined ? { watermark: args.watermark } : {}),
      ...(args.seed !== undefined ? { seed: args.seed } : {}),
      ...(args.nsfw_checker !== undefined ? { nsfw_checker: args.nsfw_checker } : {}),
    },
  };
}

type Wan27FramesVideoArgs = {
  prompt: string;
  negative_prompt?: string;
  resolution?: Wan27Resolution;
  duration?: string;
  prompt_extend?: boolean;
  watermark?: boolean;
  nsfw_checker?: boolean;
  seed?: number;
};

type Wan27FramesVideoOpts = {
  firstFrameUrl?: string;
  lastFrameUrl?: string;
  firstClipUrl?: string;
  drivingAudioUrl?: string;
};

function buildWan27FramesVideoPayload(
  args: Wan27FramesVideoArgs,
  opts: Wan27FramesVideoOpts,
): Wan27ImageToVideoRequest {
  return {
    model: "wan/2-7-image-to-video",
    input: {
      prompt: args.prompt,
      ...(args.negative_prompt !== undefined ? { negative_prompt: args.negative_prompt } : {}),
      ...(opts.firstFrameUrl !== undefined ? { first_frame_url: opts.firstFrameUrl } : {}),
      ...(opts.lastFrameUrl !== undefined ? { last_frame_url: opts.lastFrameUrl } : {}),
      ...(opts.firstClipUrl !== undefined ? { first_clip_url: opts.firstClipUrl } : {}),
      ...(opts.drivingAudioUrl !== undefined ? { driving_audio_url: opts.drivingAudioUrl } : {}),
      ...(args.resolution !== undefined ? { resolution: args.resolution } : {}),
      ...(args.duration !== undefined ? { duration: parseInt(args.duration, 10) } : {}),
      ...(args.prompt_extend !== undefined ? { prompt_extend: args.prompt_extend } : {}),
      ...(args.watermark !== undefined ? { watermark: args.watermark } : {}),
      ...(args.nsfw_checker !== undefined ? { nsfw_checker: args.nsfw_checker } : {}),
      ...(args.seed !== undefined ? { seed: args.seed } : {}),
    },
  };
}

type Wan27ReferenceVideoArgs = {
  prompt: string;
  negative_prompt?: string;
  resolution?: Wan27Resolution;
  aspect_ratio?: Wan27AspectRatio;
  duration?: string;
  prompt_extend?: boolean;
  watermark?: boolean;
  nsfw_checker?: boolean;
  seed?: number;
};

type Wan27ReferenceVideoOpts = {
  referenceImageUrls?: string[];
  referenceVideoUrls?: string[];
  firstFrameUrl?: string;
  referenceVoiceUrl?: string;
};

function buildWan27ReferenceVideoPayload(
  args: Wan27ReferenceVideoArgs,
  opts: Wan27ReferenceVideoOpts,
): Wan27RefToVideoRequest {
  return {
    model: "wan/2-7-r2v",
    input: {
      prompt: args.prompt,
      ...(args.negative_prompt !== undefined ? { negative_prompt: args.negative_prompt } : {}),
      ...(opts.referenceImageUrls && opts.referenceImageUrls.length > 0 ? { reference_image: opts.referenceImageUrls } : {}),
      ...(opts.referenceVideoUrls && opts.referenceVideoUrls.length > 0 ? { reference_video: opts.referenceVideoUrls } : {}),
      ...(opts.firstFrameUrl !== undefined ? { first_frame: opts.firstFrameUrl } : {}),
      ...(opts.referenceVoiceUrl !== undefined ? { reference_voice: opts.referenceVoiceUrl } : {}),
      ...(args.resolution !== undefined ? { resolution: args.resolution } : {}),
      ...(args.aspect_ratio !== undefined ? { aspect_ratio: args.aspect_ratio } : {}),
      ...(args.duration !== undefined ? { duration: parseInt(args.duration, 10) } : {}),
      ...(args.prompt_extend !== undefined ? { prompt_extend: args.prompt_extend } : {}),
      ...(args.watermark !== undefined ? { watermark: args.watermark } : {}),
      ...(args.nsfw_checker !== undefined ? { nsfw_checker: args.nsfw_checker } : {}),
      ...(args.seed !== undefined ? { seed: args.seed } : {}),
    },
  };
}

type Wan27VideoEditArgs = {
  prompt?: string;
  negative_prompt?: string;
  resolution?: Wan27Resolution;
  aspect_ratio?: Wan27AspectRatio;
  duration?: string;
  audio_setting?: Wan27VideoEditRequest["input"]["audio_setting"];
  prompt_extend?: boolean;
  watermark?: boolean;
  nsfw_checker?: boolean;
  seed?: number;
};

type Wan27VideoEditOpts = {
  videoUrl: string;
  referenceImageUrl?: string;
};

export function buildWan27VideoEditPayload(
  args: Wan27VideoEditArgs,
  opts: Wan27VideoEditOpts,
): Wan27VideoEditRequest {
  return {
    model: "wan/2-7-videoedit",
    input: {
      video_url: opts.videoUrl,
      ...(args.prompt !== undefined ? { prompt: args.prompt } : {}),
      ...(args.negative_prompt !== undefined ? { negative_prompt: args.negative_prompt } : {}),
      ...(opts.referenceImageUrl !== undefined ? { reference_image: opts.referenceImageUrl } : {}),
      ...(args.resolution !== undefined ? { resolution: args.resolution } : {}),
      ...(args.aspect_ratio !== undefined ? { aspect_ratio: args.aspect_ratio } : {}),
      ...(args.duration !== undefined ? { duration: parseInt(args.duration, 10) } : {}),
      ...(args.audio_setting !== undefined ? { audio_setting: args.audio_setting } : {}),
      ...(args.prompt_extend !== undefined ? { prompt_extend: args.prompt_extend } : {}),
      ...(args.watermark !== undefined ? { watermark: args.watermark } : {}),
      ...(args.nsfw_checker !== undefined ? { nsfw_checker: args.nsfw_checker } : {}),
      ...(args.seed !== undefined ? { seed: args.seed } : {}),
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
    ...(args.resolution !== undefined ? { resolution: args.resolution } : {}),
    ...(args.aspect_ratio !== undefined ? { aspect_ratio: args.aspect_ratio as XaiVideoGenerateRequest["aspect_ratio"] } : {}),
  };
}

// ---------------------------------------------------------------------------
// Alibaba payload builders
// ---------------------------------------------------------------------------

type AlibabaImageModel = AlibabaImageGenerationRequest["model"];

type AlibabaImageArgs = {
  prompt: string;
  model?: AlibabaImageModel;
  size?: string;
  n?: number;
  watermark?: boolean;
  thinking_mode?: boolean;
  seed?: number;
};

function buildAlibabaImagePayload(
  args: AlibabaImageArgs,
  imageUrls: string[],
): AlibabaImageGenerationRequest {
  const content: Array<{ text: string } | { image: string }> = [
    { text: args.prompt },
  ];
  for (const url of imageUrls) {
    content.push({ image: url });
  }
  return {
    model: args.model ?? "wan2.7-image",
    input: {
      messages: [{ role: "user", content }],
    },
    parameters: {
      ...(args.size !== undefined ? { size: args.size } : {}),
      ...(args.n !== undefined ? { n: args.n } : {}),
      ...(args.watermark !== undefined ? { watermark: args.watermark } : {}),
      ...(args.thinking_mode !== undefined ? { thinking_mode: args.thinking_mode } : {}),
      ...(args.seed !== undefined ? { seed: args.seed } : {}),
    },
  };
}

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

type AlibabaVideoArgs = Partial<AlibabaVideoSynthesisParameters> & {
  prompt: string;
  negative_prompt?: string;
  model: AlibabaVideoSynthesisRequest["model"];
};

type AlibabaVideoMedia = {
  firstFrameUrl?: string;
  lastFrameUrl?: string;
  firstClipUrl?: string;
  drivingAudioUrl?: string;
  videoUrl?: string;
};

function buildAlibabaVideoPayload(
  args: AlibabaVideoArgs,
  media: AlibabaVideoMedia,
): AlibabaVideoSynthesisRequest {
  const mediaItems: AlibabaVideoSynthesisInput["media"] = [];
  if (media.firstFrameUrl) mediaItems.push({ type: "first_frame", url: media.firstFrameUrl });
  if (media.lastFrameUrl) mediaItems.push({ type: "last_frame", url: media.lastFrameUrl });
  if (media.firstClipUrl) mediaItems.push({ type: "first_clip", url: media.firstClipUrl });
  if (media.drivingAudioUrl) mediaItems.push({ type: "driving_audio", url: media.drivingAudioUrl });
  if (media.videoUrl) mediaItems.push({ type: "video", url: media.videoUrl });

  return {
    model: args.model,
    input: {
      prompt: args.prompt,
      media: mediaItems,
      ...(args.negative_prompt !== undefined ? { negative_prompt: args.negative_prompt } : {}),
    },
    parameters: {
      ...(args.resolution !== undefined ? { resolution: args.resolution } : {}),
      ...(args.duration !== undefined ? { duration: args.duration } : {}),
      ...(args.prompt_extend !== undefined ? { prompt_extend: args.prompt_extend } : {}),
      ...(args.watermark !== undefined ? { watermark: args.watermark } : {}),
      ...(args.audio_setting !== undefined ? { audio_setting: args.audio_setting } : {}),
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
    const slugs = args[`element${slot}_slugs`] as string[] | undefined;
    const name = args[`element${slot}_name`] as string | undefined;
    const desc = args[`element${slot}_desc`] as string | undefined;

    const hasSlugs = slugs && slugs.length > 0;
    const hasName = name && name.length > 0;
    const hasDesc = desc && desc.length > 0;

    if (!hasSlugs && !hasName && !hasDesc) continue;

    const element: KlingElement = {
      name: hasName ? name : (hasSlugs ? slugs[0] : ""),
      description: hasDesc ? desc : "",
    };

    if (hasSlugs) {
      const hasVideo = slugs.some((s) => s.startsWith("vid-") || s.startsWith("@vid-"));
      if (hasVideo) {
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

function translateToolPayload(
  toolName: string,
  args: Record<string, unknown>,
  provider?: string,
): TranslateResult | null {
  const imageSlugs = (args.image_slugs as string[] | undefined) ?? [];

  switch (toolName) {
    case "generate_kling30_video": {
      const elements = extractKlingElements(args);
      const payload = buildKling30VideoPayload(args as Kling30Args, imageSlugs, elements);
      return { provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_kling30_motion_control_video": {
      const characterImageUrls = (args.character_image_slugs as string[] | undefined) ?? [];
      const motionVideoUrls = (args.motion_video_slugs as string[] | undefined) ?? [];
      const payload = buildKling30MotionControlPayload(
        args as Kling30MotionControlArgs,
        characterImageUrls,
        motionVideoUrls,
      );
      return { provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_kling30_turbo_video": {
      const payload = buildKlingV3TurboVideoPayload(
        args as unknown as { prompt: string; duration?: string; resolution?: KlingV3TurboResolution; aspect_ratio?: KlingV3TurboAspectRatio },
        imageSlugs,
      );
      return { provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_grok_imagine_video": {
      if (isXaiProvider(provider)) {
        const payload = buildXaiGrokImagineVideoPayload(args as GrokImagineVideoArgs, imageSlugs);
        return { provider_path: "xai.post.v1.videos.generations(request, { otp })", payload: payload as unknown as Record<string, unknown> };
      }
      // Pass image_slugs explicitly so mention-order alignment works even when
      // the preview still shows asset slugs in image_urls.
      const payload = buildGrokImagineVideoPayload(
        { ...(args as GrokImagineVideoArgs), image_slugs: imageSlugs },
        imageSlugs,
      );
      return { provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_grok_imagine_t2v_video": {
      const payload = buildGrokImagineT2vVideoPayload(args as GrokImagineT2vArgs);
      return { provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_grok_imagine_image": {
      if (isXaiProvider(provider)) {
        const payload = buildXaiGrokImagineImagePayload(args as GrokImagineImageArgs, imageSlugs);
        return { provider_path: "xai.post.v1.images.edits(request, { otp })", payload: payload as unknown as Record<string, unknown> };
      }
      const payload = buildGrokImagineImagePayload(args as GrokImagineImageArgs, imageSlugs);
      return { provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_seedance2_video":
    case "generate_seedance2_fast_video": {
      const apiModel: Seedance2Model = toolName === "generate_seedance2_video"
        ? "bytedance/seedance-2"
        : "bytedance/seedance-2-fast";
      const firstFrameUrl = (args.first_frame_slug as string | undefined) ?? undefined;
      const lastFrameUrl = (args.last_frame_slug as string | undefined) ?? undefined;
      const referenceImageUrls = imageSlugs.length > 0 ? imageSlugs : undefined;
      const referenceVideoUrls = (args.video_slugs as string[] | undefined) ?? undefined;
      const referenceAudioUrls = (args.audio_slugs as string[] | undefined) ?? undefined;
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
    case "generate_seedance2_mini_video": {
      const referenceImageUrls = imageSlugs.length > 0 ? imageSlugs : undefined;
      const referenceVideoUrls = (args.video_slugs as string[] | undefined) ?? undefined;
      const referenceAudioUrls = (args.audio_slugs as string[] | undefined) ?? undefined;
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
    case "generate_gemini_omni_video": {
      const videoSlug = args.video_slug as string | undefined;
      const payload = buildGeminiOmniVideoPayload(
        args as GeminiOmniVideoArgs,
        {
          ...(imageSlugs.length > 0 ? { imageUrls: imageSlugs } : {}),
          ...(videoSlug !== undefined && videoSlug.trim() !== "" ? { videoUrl: videoSlug } : {}),
        },
      );
      return { provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_veo31_video":
    case "generate_veo31_fast_video":
    case "generate_veo31_lite_video":
    case "generate_veo31_lite_low_priority_video": {
      const model: GoogleVeo31Model = toolName === "generate_veo31_video"
        ? "veo-3.1-quality"
        : toolName === "generate_veo31_fast_video"
          ? "veo-3.1-fast"
          : toolName === "generate_veo31_lite_low_priority_video"
            ? "veo-3.1-lite-low-priority"
            : "veo-3.1-lite";
      const startImage = args.first_frame_slug as string | undefined;
      const endImage = args.last_frame_slug as string | undefined;
      // Google Flow prompts only resolve positional @-markers; rewrite/strip
      // @slug mentions exactly as tools/generate-veo31-video.ts does at submit.
      const prompt = stripSlugMentions(
        rewriteImageSlugMentions((args.prompt as string) ?? "", imageSlugs),
        [
          ...(startImage !== undefined && startImage.trim() !== "" ? [startImage] : []),
          ...(endImage !== undefined && endImage.trim() !== "" ? [endImage] : []),
        ],
      );
      const payload = buildVeo31VideoPayload(model, { ...(args as Veo31VideoArgs), prompt }, {
        ...(startImage !== undefined && startImage.trim() !== "" ? { startImageId: startImage } : {}),
        ...(endImage !== undefined && endImage.trim() !== "" ? { endImageId: endImage } : {}),
        ...(imageSlugs.length > 0 ? { referenceImageIds: imageSlugs } : {}),
      });
      return { provider_path: "googleflow.v1.videos({ async: true })", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_google_omni_video": {
      const startImage = args.first_frame_slug as string | undefined;
      const videoSlug = args.video_slug as string | undefined;
      const voiceRefs = ((args.voice_refs as string[] | undefined) ?? []).filter((s) => s.trim() !== "");
      const characterRefs = ((args.character_refs as string[] | undefined) ?? []).filter((s) => s.trim() !== "");
      const prompt = stripSlugMentions(
        rewriteImageSlugMentions((args.prompt as string) ?? "", imageSlugs),
        [
          ...(videoSlug !== undefined && videoSlug.trim() !== "" ? [videoSlug] : []),
          ...(startImage !== undefined && startImage.trim() !== "" ? [startImage] : []),
        ],
      );
      const payload = buildGoogleOmniVideoPayload({ ...(args as GoogleOmniVideoArgs), prompt }, {
        ...(startImage !== undefined && startImage.trim() !== "" ? { startImageId: startImage } : {}),
        ...(imageSlugs.length > 0 ? { referenceImageIds: imageSlugs } : {}),
        ...(videoSlug !== undefined && videoSlug.trim() !== "" ? { referenceVideoId: videoSlug } : {}),
        ...(voiceRefs.length > 0 ? { voiceRefs } : {}),
        ...(characterRefs.length > 0 ? { characterRefs } : {}),
      });
      return { provider_path: "googleflow.v1.videos({ async: true })", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_nano_banana_pro_google": {
      const characterRefs = ((args.character_refs as string[] | undefined) ?? []).filter((s) => s.trim() !== "");
      // Images use @reference_N markers (not @referenceImage_N), matching
      // tools/generate-nano-banana-pro-google.ts.
      const prompt = rewriteImageSlugMentions((args.prompt as string) ?? "", imageSlugs, "reference");
      const payload = buildGoogleNbpImagePayload({ ...(args as GoogleNbpImageArgs), prompt }, imageSlugs, characterRefs);
      return { provider_path: "googleflow.v1.images()", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_grok_imagine_text_image": {
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
    case "generate_grok_imagine_ref_video": {
      const payload = buildXaiGrokImagineRefVideoPayload(args as GrokImagineRefVideoArgs, imageSlugs);
      return { provider_path: "xai.post.v1.videos.generations(request, { otp })", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_nano_banana_image": {
      const payload = buildNanoBananaImagePayload(args as NanoBananaImageArgs, imageSlugs);
      return { provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_seedream_text_image": {
      const payload = buildSeedreamTextImagePayload(args as SeedreamImageArgs);
      return { provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_seedream_image": {
      const payload = buildSeedreamImageEditPayload(args as SeedreamImageArgs, imageSlugs);
      return { provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_qwen2_image_edit": {
      // qwen2/image-edit is single-image: use the first reference slug.
      const payload = buildQwen2ImageEditPayload(args as Qwen2ImageEditArgs, imageSlugs[0] ?? "");
      return { provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_gpt_image": {
      const payload = buildGptImagePayload(args as GptImageArgs, imageSlugs);
      return { provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_gpt_image_text": {
      const payload = buildGptImageTextPayload(args as GptImageTextArgs);
      return { provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_wan27_image": {
      const payload = buildWan27ImagePayload(args as Wan27ImageArgs, imageSlugs);
      return { provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_wan27_image_pro": {
      const payload = buildWan27ImageProPayload(args as Wan27ImageArgs, imageSlugs);
      return { provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_wan27_t2v_video": {
      const audioUrl = (args.audio_url as string | undefined) ?? (args.driving_audio_slug as string | undefined) ?? undefined;
      const payload = buildWan27TextToVideoPayload(args as Wan27TextToVideoArgs, { audioUrl });
      return { provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_wan27_i2v_video": {
      const firstFrameSlug = (args.first_frame_slug as string | undefined) ?? undefined;
      const lastFrameSlug = (args.last_frame_slug as string | undefined) ?? undefined;
      const firstClipSlug = (args.first_clip_slug as string | undefined) ?? undefined;
      const drivingAudioSlug = (args.driving_audio_slug as string | undefined) ?? undefined;
      const payload = buildWan27FramesVideoPayload(args as Wan27FramesVideoArgs, {
        firstFrameUrl: firstFrameSlug,
        lastFrameUrl: lastFrameSlug,
        firstClipUrl: firstClipSlug,
        drivingAudioUrl: drivingAudioSlug,
      });
      return { provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_wan27_videoedit_video": {
      const videoSlug = (args.video_slug as string) ?? "";
      const imageSlug = (args.image_slug as string | undefined) ?? undefined;
      const payload = buildWan27VideoEditPayload(args as Wan27VideoEditArgs, {
        videoUrl: videoSlug,
        referenceImageUrl: imageSlug,
      });
      return { provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_volcengine_lipsync_video": {
      const videoSlug = (args.video_slug as string) ?? "";
      const audioSlug = (args.audio_slug as string) ?? "";
      const payload = buildVolcengineLipSyncPayload(args as VolcengineLipSyncArgs, {
        videoUrl: videoSlug,
        audioUrl: audioSlug,
      });
      return { provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_omnihuman_video": {
      const imageSlug = (args.image_slug as string) ?? "";
      const audioSlug = (args.audio_slug as string) ?? "";
      const payload = buildOmnihumanPayload(args as OmnihumanArgs, {
        imageUrl: imageSlug,
        audioUrl: audioSlug,
      });
      return { provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_wan27_r2v_video": {
      const referenceImageUrls = imageSlugs;
      const referenceVideoUrls = (args.video_slugs as string[] | undefined) ?? [];
      const firstFrameUrl = (args.first_frame_slug as string | undefined) ?? undefined;
      const referenceVoiceUrl = (args.audio_slug as string | undefined) ?? undefined;
      const payload = buildWan27ReferenceVideoPayload(args as Wan27ReferenceVideoArgs, {
        referenceImageUrls,
        referenceVideoUrls,
        firstFrameUrl,
        referenceVoiceUrl,
      });
      return { provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", payload: payload as unknown as Record<string, unknown> };
    }
    case "extend_wan27_video": {
      const firstClipSlug = (args.video_slug as string) ?? "";
      const payload = buildWan27FramesVideoPayload(args as Wan27FramesVideoArgs, {
        firstClipUrl: firstClipSlug,
      });
      return { provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_happyhorse_t2v_video": {
      const payload = buildHappyHorseT2vPayload(args as HappyHorseT2vArgs);
      return { provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_happyhorse_i2v_video": {
      const imageUrl = (args.first_frame_slug as string | undefined) ?? "";
      const payload = buildHappyHorseI2vPayload(args as HappyHorseI2vArgs, imageUrl);
      return { provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_happyhorse_ref_video": {
      const referenceImages = (args.image_slugs as string[] | undefined) ?? [];
      const payload = buildHappyHorseRefPayload(args as HappyHorseRefArgs, referenceImages);
      return { provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_happyhorse_videoedit_video": {
      const videoSlug = (args.video_slug as string | undefined) ?? "";
      const referenceImages = (args.image_slugs as string[] | undefined) ?? [];
      // Kie's happyhorse/video-edit (1.0) prompt is a free-form edit
      // instruction with no inline marker syntax — the "[Image N]" form belongs
      // to the 1.1 t2v/i2v/ref endpoints only. Rewrite @<slug> mentions to
      // natural-language noun phrases so the outbound prompt (and this preview)
      // carries no local asset IDs while references stay unambiguous to the
      // model: @<video-slug> -> "the source video"; @<image-slug> ->
      // "reference image N" matching its position in the reference_image[] field.
      const rawPrompt = (args.prompt as string | undefined) ?? "";
      const normalizedPrompt = replaceHappyHorseAssetMentions(rawPrompt, videoSlug, referenceImages);
      const payload = buildHappyHorseVideoEditPayload(
        { ...(args as HappyHorseVideoEditArgs), prompt: normalizedPrompt },
        videoSlug,
        referenceImages,
      );
      return { provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", payload: payload as unknown as Record<string, unknown> };
    }
    case "extend_grok_imagine_video": {
      const payload: GrokVideoExtendRequest = {
        model: "grok-imagine/extend",
        input: {
          task_id: "<task_id_from_source_video_metadata>",
          prompt: args.prompt as string,
          extend_at: String(args.extend_at as number),
          extend_times: args.extend_times as GrokVideoExtendRequest["input"]["extend_times"],
        },
      };
      return { provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_alibaba_image": {
      const imageUrls = imageSlugs;
      const payload = buildAlibabaImagePayload(
        { prompt: args.prompt as string, model: (args.model as AlibabaImageModel) ?? "wan2.7-image", size: args.size as string | undefined, n: args.n as number | undefined, watermark: args.watermark as boolean | undefined, thinking_mode: args.thinking_mode as boolean | undefined, seed: args.seed as number | undefined },
        imageUrls,
      );
      return { provider_path: "alibaba.post.api.v1.services.aigc.imageGeneration.generation()", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_alibaba_image_pro": {
      const imageUrls = imageSlugs;
      const payload = buildAlibabaImagePayload(
        { prompt: args.prompt as string, model: "wan2.7-image-pro", size: args.size as string | undefined, n: args.n as number | undefined, watermark: args.watermark as boolean | undefined, thinking_mode: args.thinking_mode as boolean | undefined, seed: args.seed as number | undefined },
        imageUrls,
      );
      return { provider_path: "alibaba.post.api.v1.services.aigc.imageGeneration.generation()", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_alibaba_video": {
      const firstFrameUrl = (args.first_frame_slug as string | undefined) ?? undefined;
      const lastFrameUrl = (args.last_frame_slug as string | undefined) ?? undefined;
      const firstClipUrl = (args.first_clip_slug as string | undefined) ?? undefined;
      const drivingAudioUrl = (args.driving_audio_slug as string | undefined) ?? undefined;
      const videoUrl = (args.video_slug as string | undefined) ?? undefined;
      const payload = buildAlibabaVideoPayload(
        {
          prompt: args.prompt as string,
          negative_prompt: args.negative_prompt as string | undefined,
          model: (args.model as AlibabaVideoSynthesisRequest["model"] | undefined) ?? "wan2.7-i2v",
          resolution: args.resolution as AlibabaVideoSynthesisParameters["resolution"],
          duration: args.duration as AlibabaVideoSynthesisParameters["duration"],
          prompt_extend: args.prompt_extend as AlibabaVideoSynthesisParameters["prompt_extend"],
          watermark: args.watermark as AlibabaVideoSynthesisParameters["watermark"],
          audio_setting: args.audio_setting as AlibabaVideoSynthesisParameters["audio_setting"],
          seed: args.seed as AlibabaVideoSynthesisParameters["seed"],
        },
        { firstFrameUrl, lastFrameUrl, firstClipUrl, drivingAudioUrl, videoUrl },
      );
      return { provider_path: "alibaba.post.api.v1.services.aigc.videoGeneration.videoSynthesis()", payload: payload as unknown as Record<string, unknown> };
    }
    default:
      return null;
  }
}



// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
  buildKling30VideoPayload,
  buildKling30MotionControlPayload,
  buildGrokImagineVideoPayload,
  buildGrokImagineT2vVideoPayload,
  buildGrokImagineImagePayload,
  buildXaiGrokImagineImagePayload,
  buildXaiGrokImagineRefVideoPayload,
  buildXaiGrokImagineVideoPayload,
  buildNanoBananaImagePayload,
  buildQwen2ImageEditPayload,
  buildGrokImagineTextPayload,
  buildGptImagePayload,
  buildGptImageTextPayload,
  buildSeedreamTextImagePayload,
  buildSeedreamImageEditPayload,
  buildSeedance2VideoPayload,
  buildSeedance2MiniVideoPayload,
  buildGeminiOmniVideoPayload,
  buildVeo3VideoPayload,
  buildVeo31VideoPayload,
  buildGoogleOmniVideoPayload,
  buildGoogleNbpImagePayload,
  buildWan27TextToVideoPayload,
  buildWan27FramesVideoPayload,
  buildWan27ReferenceVideoPayload,
  buildWan27ImagePayload,
  buildWan27ImageProPayload,
  buildHappyHorseT2vPayload,
  buildHappyHorseI2vPayload,
  buildHappyHorseRefPayload,
  buildHappyHorseVideoEditPayload,
  buildAlibabaImagePayload,
  buildAlibabaQwenImagePayload,
  buildAlibabaVideoPayload,
  translateToolPayload,
};
export type { TranslateResult, Seedance2VideoArgs, Seedance2VideoOpts, Seedance2MiniVideoArgs, Seedance2MiniVideoOpts, Wan27FramesVideoArgs, Wan27FramesVideoOpts, Wan27ReferenceVideoArgs, Wan27ReferenceVideoOpts, GoogleVeo31Model, Veo31VideoArgs, Veo31VideoOpts, GoogleOmniVideoArgs, GoogleOmniVideoOpts, GoogleNbpImageArgs };
