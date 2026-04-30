/**
 * Shared payload builders: MCP tool args → @apicity request bodies.
 *
 * Used by both `translate_payload` (preview, passes raw slugs) and
 * job handlers (passes real upload URLs). Same functions, different strings.
 */
import type {
  KlingVideoRequest,
  KlingElement,
  MultiShotPrompt,
  GrokImageToVideoRequest,
  GrokImageToImageRequest,
  GrokTextToImageRequest,
  Seedance2FastRequest,
  Seedance2Request,
  NanoBananaProRequest,
  GptImage2ImageToImageRequest,
  GptImage2ImageToImageAspectRatio,
  GptImage2TextToImageRequest,
  GptImage2TextToImageAspectRatio,
  SeedreamTextToImageRequest,
  SeedreamImageToImageRequest,
  Qwen2ImageEditRequest,
  Wan27ImageToVideoRequest,
  Wan27RefToVideoRequest,
  Wan27VideoEditRequest,
  Wan27ImageRequest,
  Wan27ImageProRequest,
  // Named union types for cleaner type annotations
  KlingMode,
  KlingDuration,
  KlingAspectRatio,
  GrokImagineMode,
  GrokImageToVideoDuration,
  GrokImagineResolution,
  NanoBananaResolution,
  NanoBananaOutputFormat,
  Wan27Resolution,
  Wan27AspectRatio,
  Wan27ImageAspectRatio,
  Wan27ImageResolution,
} from "@apicity/kie";
import type { XaiImageEditRequest, XaiImageGenerateRequest, XaiVideoGenerateRequest, XaiImageReference } from "@apicity/xai";
import type {
  AlibabaImageGenerationRequest,
  AlibabaVideoSynthesisRequest,
  AlibabaVideoSynthesisInput,
  AlibabaVideoSynthesisParameters,
} from "@apicity/alibaba";
import type { AlibabaMultimodalGenerationRequest } from "@apicity/alibaba/zod";
import { validateVideoParams } from "./video-models.js";
import { validateImageParams } from "./image-models.js";

// ---------------------------------------------------------------------------
// Individual builders
// ---------------------------------------------------------------------------

type Kling30Args = {
  prompt?: string;
  mode?: KlingMode;
  duration?: string;
  sound?: boolean;
  aspect_ratio?: string;
  multi_shots?: boolean;
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
      sound: args.sound ?? true,
      duration: (args.duration ?? "8") as KlingDuration,
      ...(args.aspect_ratio !== undefined ? { aspect_ratio: args.aspect_ratio as KlingAspectRatio } : {}),
      mode: (args.mode ?? "std") as KlingMode,
      multi_shots: args.multi_shots ?? false,
      ...(args.multi_prompt && args.multi_prompt.length > 0 ? { multi_prompt: args.multi_prompt } : {}),
      ...(elements.length > 0 ? { kling_elements: elements } : {}),
    },
  };
}

type GrokImagineVideoArgs = {
  prompt?: string;
  mode?: GrokImagineMode;
  duration?: GrokImageToVideoDuration;
  resolution?: GrokImagineResolution;
  aspect_ratio?: string;
  task_id?: string;
  index?: number;
  nsfw_checker?: boolean;
};

function buildGrokImagineVideoPayload(
  args: GrokImagineVideoArgs,
  imageUrls: string[],
): GrokImageToVideoRequest {
  return {
    model: "grok-imagine/image-to-video",
    input: {
      ...(args.task_id !== undefined
        ? { task_id: args.task_id, ...(args.index !== undefined ? { index: args.index } : {}) }
        : imageUrls.length > 0
          ? { image_urls: imageUrls }
          : {}),
      ...(args.prompt !== undefined ? { prompt: args.prompt } : {}),
      ...(args.mode !== undefined ? { mode: args.mode } : {}),
      ...(args.duration !== undefined ? { duration: args.duration } : {}),
      ...(args.resolution !== undefined ? { resolution: args.resolution } : {}),
      ...(args.aspect_ratio !== undefined ? { aspect_ratio: args.aspect_ratio as GrokImageToVideoRequest["input"]["aspect_ratio"] } : {}),
      ...(args.nsfw_checker !== undefined ? { nsfw_checker: args.nsfw_checker } : {}),
    },
  };
}

type GrokImagineImageArgs = Omit<GrokImageToImageRequest["input"], "image_urls">;

function buildGrokImagineImagePayload(
  args: GrokImagineImageArgs,
  imageUrls: string[],
): GrokImageToImageRequest {
  return {
    model: "grok-imagine/image-to-image",
    input: {
      image_urls: (imageUrls.length > 0 ? imageUrls : []) as [string],
      ...(args.prompt !== undefined ? { prompt: args.prompt } : {}),
      ...(args.aspect_ratio !== undefined ? { aspect_ratio: args.aspect_ratio } : {}),
    },
  };
}

type GrokImagineTextArgs = {
  prompt: string;
  aspect_ratio?: string;
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
      ...(args.aspect_ratio !== undefined ? { aspect_ratio: args.aspect_ratio as GrokTextToImageRequest["input"]["aspect_ratio"] } : {}),
      ...(args.enable_pro !== undefined ? { enable_pro: args.enable_pro } : {}),
      ...(args.nsfw_checker !== undefined ? { nsfw_checker: args.nsfw_checker } : {}),
    },
  };
}

type Seedance2Model = "bytedance/seedance-2-fast" | "bytedance/seedance-2";
type Seedance2Resolution = "480p" | "720p" | "1080p";

type Seedance2VideoArgs = {
  prompt: string;
  model?: Seedance2Model;
  aspect_ratio?: string;
  resolution?: Seedance2Resolution;
  duration?: string;
  generate_audio?: boolean;
  return_last_frame?: boolean;
  web_search?: boolean;
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
  const input = {
    prompt: args.prompt,
    ...(opts.firstFrameUrl !== undefined ? { first_frame_url: opts.firstFrameUrl } : {}),
    ...(opts.lastFrameUrl !== undefined ? { last_frame_url: opts.lastFrameUrl } : {}),
    ...(opts.referenceImageUrls && opts.referenceImageUrls.length > 0 ? { reference_image_urls: opts.referenceImageUrls } : {}),
    ...(opts.referenceVideoUrls && opts.referenceVideoUrls.length > 0 ? { reference_video_urls: opts.referenceVideoUrls } : {}),
    ...(opts.referenceAudioUrls && opts.referenceAudioUrls.length > 0 ? { reference_audio_urls: opts.referenceAudioUrls } : {}),
    ...(args.aspect_ratio !== undefined ? { aspect_ratio: args.aspect_ratio as Seedance2FastRequest["input"]["aspect_ratio"] } : {}),
    ...(args.duration !== undefined ? { duration: parseInt(args.duration, 10) } : {}),
    ...(args.generate_audio !== undefined ? { generate_audio: args.generate_audio } : {}),
    ...(args.return_last_frame !== undefined ? { return_last_frame: args.return_last_frame } : {}),
    ...(args.web_search !== undefined ? { web_search: args.web_search } : {}),
  };
  if (model === "bytedance/seedance-2") {
    return {
      model,
      input: {
        ...input,
        ...(args.resolution !== undefined ? { resolution: args.resolution } : {}),
      },
    } as Seedance2Request;
  }
  return {
    model,
    input: {
      ...input,
      ...(args.resolution !== undefined && args.resolution !== "1080p"
        ? { resolution: args.resolution as "480p" | "720p" }
        : {}),
    },
  } as Seedance2FastRequest;
}

type NanoBananaImageArgs = {
  prompt: string;
  aspect_ratio?: string;
  resolution?: NanoBananaResolution;
  output_format?: NanoBananaOutputFormat;
};

function buildNanoBananaImagePayload(
  args: NanoBananaImageArgs,
  imageInput: string[],
): NanoBananaProRequest {
  return {
    model: "nano-banana-pro",
    input: {
      prompt: args.prompt,
      ...(imageInput.length > 0 ? { image_input: imageInput } : {}),
      ...(args.aspect_ratio !== undefined ? { aspect_ratio: args.aspect_ratio as NanoBananaProRequest["input"]["aspect_ratio"] } : {}),
      ...(args.resolution !== undefined ? { resolution: args.resolution } : {}),
      ...(args.output_format !== undefined ? { output_format: args.output_format } : {}),
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
  return {
    model: "seedream/5-lite-text-to-image",
    input: {
      prompt: args.prompt,
      nsfw_checker: args.nsfw_checker ?? false,
      quality: args.quality ?? "basic",
      ...(args.aspect_ratio !== undefined ? { aspect_ratio: args.aspect_ratio } : {}),
    },
  };
}

function buildSeedreamImageEditPayload(
  args: SeedreamImageArgs,
  imageUrls: string[],
): SeedreamImageToImageRequest {
  return {
    model: "seedream/5-lite-image-to-image",
    input: {
      prompt: args.prompt,
      image_urls: imageUrls,
      nsfw_checker: args.nsfw_checker ?? false,
      quality: args.quality ?? "basic",
      ...(args.aspect_ratio !== undefined ? { aspect_ratio: args.aspect_ratio } : {}),
    },
  };
}

type Qwen2ImageEditArgs = {
  prompt: string;
  image_size?: string;
  output_format?: NonNullable<Qwen2ImageEditRequest["input"]["output_format"]>;
  seed?: number;
};

function buildQwen2ImageEditPayload(
  args: Qwen2ImageEditArgs,
  imageInput: string[],
): Qwen2ImageEditRequest {
  const image_size = (args.image_size ?? "16:9") as NonNullable<Qwen2ImageEditRequest["input"]["image_size"]>;
  const output_format = args.output_format ?? "png";
  return {
    model: "qwen2/image-edit",
    input: {
      prompt: args.prompt,
      image_url: imageInput,
      image_size,
      output_format,
      ...(args.seed !== undefined ? { seed: args.seed } : {}),
    },
  };
}

type GptImageArgs = {
  prompt: string;
  aspect_ratio?: string;
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
      ...(args.aspect_ratio !== undefined ? { aspect_ratio: args.aspect_ratio as GptImage2ImageToImageAspectRatio } : {}),
      ...(args.nsfw_checker !== undefined ? { nsfw_checker: args.nsfw_checker } : {}),
    },
  };
}

type GptImageTextArgs = {
  prompt: string;
  aspect_ratio?: string;
  nsfw_checker?: boolean;
};

function buildGptImageTextPayload(
  args: GptImageTextArgs,
): GptImage2TextToImageRequest {
  return {
    model: "gpt-image-2-text-to-image",
    input: {
      prompt: args.prompt,
      ...(args.aspect_ratio !== undefined ? { aspect_ratio: args.aspect_ratio as GptImage2TextToImageAspectRatio } : {}),
      ...(args.nsfw_checker !== undefined ? { nsfw_checker: args.nsfw_checker } : {}),
    },
  };
}

type Wan27ImageArgs = {
  prompt: string;
  aspect_ratio?: string;
  resolution?: string;
  seed?: number;
  nsfw_checker?: boolean;
};

function buildWan27ImagePayload(
  args: Wan27ImageArgs,
  inputUrls: string[],
): Wan27ImageRequest {
  return {
    model: "wan/2-7-image",
    input: {
      prompt: args.prompt,
      ...(inputUrls.length > 0 ? { input_urls: inputUrls } : {}),
      ...(args.aspect_ratio !== undefined ? { aspect_ratio: args.aspect_ratio as Wan27ImageAspectRatio } : {}),
      ...(args.resolution !== undefined ? { resolution: args.resolution as Wan27ImageResolution } : {}),
      ...(args.seed !== undefined ? { seed: args.seed } : {}),
      ...(args.nsfw_checker !== undefined ? { nsfw_checker: args.nsfw_checker } : {}),
    },
  };
}

function buildWan27ImageProPayload(
  args: Wan27ImageArgs,
  inputUrls: string[],
): Wan27ImageProRequest {
  return {
    model: "wan/2-7-image-pro",
    input: {
      prompt: args.prompt,
      ...(inputUrls.length > 0 ? { input_urls: inputUrls } : {}),
      ...(args.aspect_ratio !== undefined ? { aspect_ratio: args.aspect_ratio as Wan27ImageAspectRatio } : {}),
      ...(args.resolution !== undefined ? { resolution: args.resolution as Wan27ImageResolution } : {}),
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
      ...(args.nsfw_checker !== undefined ? { nsfw_checker: args.nsfw_checker } : {}),
      ...(args.seed !== undefined ? { seed: args.seed } : {}),
    },
  };
}

type Wan27ReferenceVideoArgs = {
  prompt: string;
  negative_prompt?: string;
  resolution?: Wan27Resolution;
  aspect_ratio?: string;
  duration?: string;
  prompt_extend?: boolean;
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
      ...(args.aspect_ratio !== undefined ? { aspect_ratio: args.aspect_ratio as Wan27AspectRatio } : {}),
      ...(args.duration !== undefined ? { duration: parseInt(args.duration, 10) } : {}),
      ...(args.prompt_extend !== undefined ? { prompt_extend: args.prompt_extend } : {}),
      ...(args.nsfw_checker !== undefined ? { nsfw_checker: args.nsfw_checker } : {}),
      ...(args.seed !== undefined ? { seed: args.seed } : {}),
    },
  };
}

type Wan27VideoEditArgs = {
  prompt?: string;
  negative_prompt?: string;
  resolution?: Wan27Resolution;
  aspect_ratio?: string;
  duration?: string;
  audio_setting?: "auto" | "origin";
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
      ...(args.aspect_ratio !== undefined ? { aspect_ratio: args.aspect_ratio as Wan27AspectRatio } : {}),
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
    ...(args.aspect_ratio !== undefined ? { aspect_ratio: args.aspect_ratio } : {}),
  };
}

type GrokImagineRefVideoArgs = {
  prompt: string;
  duration?: string;
  resolution?: GrokImagineResolution;
  aspect_ratio?: string;
};

function buildXaiGrokImagineRefVideoPayload(
  args: GrokImagineRefVideoArgs,
  imageUrls: string[],
): XaiVideoGenerateRequest {
  return {
    prompt: args.prompt,
    ...(imageUrls.length > 0 ? { reference_images: imageUrls.map((url) => ({ url })) } : {}),
    ...(args.duration !== undefined ? { duration: parseInt(args.duration, 10) } : {}),
    ...(args.resolution !== undefined ? { resolution: args.resolution } : {}),
    ...(args.aspect_ratio !== undefined ? { aspect_ratio: args.aspect_ratio as XaiVideoGenerateRequest["aspect_ratio"] } : {}),
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
    ...(args.duration !== undefined ? { duration: parseInt(args.duration, 10) } : {}),
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
  model?: AlibabaVideoSynthesisRequest["model"];
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
    model: args.model ?? "wan2.7-i2v",
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
// Dispatcher (used by translate_payload tool)
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
      return { provider_path: "kie.post.api.v1.jobs.createTask()", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_grok_imagine_video": {
      if (isXaiProvider(provider)) {
        const payload = buildXaiGrokImagineVideoPayload(args as GrokImagineVideoArgs, imageSlugs);
        return { provider_path: "xai.post.v1.videos.generations()", payload: payload as unknown as Record<string, unknown> };
      }
      const payload = buildGrokImagineVideoPayload(args as GrokImagineVideoArgs, imageSlugs);
      return { provider_path: "kie.post.api.v1.jobs.createTask()", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_grok_imagine_image": {
      if (isXaiProvider(provider)) {
        const payload = buildXaiGrokImagineImagePayload(args as GrokImagineImageArgs, imageSlugs);
        return { provider_path: "xai.post.v1.images.edits()", payload: payload as unknown as Record<string, unknown> };
      }
      const payload = buildGrokImagineImagePayload(args as GrokImagineImageArgs, imageSlugs);
      return { provider_path: "kie.post.api.v1.jobs.createTask()", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_seedance2_t2v_video": {
      const payload = buildSeedance2VideoPayload(args as Seedance2VideoArgs, {});
      return { provider_path: "kie.post.api.v1.jobs.createTask()", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_seedance2_i2v_video": {
      const firstFrameUrl = (args.first_frame_slug as string | undefined) ?? undefined;
      const lastFrameUrl = (args.last_frame_slug as string | undefined) ?? undefined;
      const payload = buildSeedance2VideoPayload(args as Seedance2VideoArgs, { firstFrameUrl, lastFrameUrl });
      return { provider_path: "kie.post.api.v1.jobs.createTask()", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_seedance2_frames_video": {
      const firstFrameUrl = (args.first_frame_slug as string | undefined) ?? undefined;
      const lastFrameUrl = (args.last_frame_slug as string | undefined) ?? undefined;
      const payload = buildSeedance2VideoPayload(args as Seedance2VideoArgs, { firstFrameUrl, lastFrameUrl });
      return { provider_path: "kie.post.api.v1.jobs.createTask()", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_seedance2_reference_video": {
      const referenceImageUrls = imageSlugs;
      const referenceVideoUrls = (args.video_slugs as string[] | undefined) ?? [];
      const referenceAudioUrls = (args.audio_slugs as string[] | undefined) ?? [];
      const payload = buildSeedance2VideoPayload(args as Seedance2VideoArgs, {
        referenceImageUrls,
        referenceVideoUrls,
        referenceAudioUrls,
      });
      return { provider_path: "kie.post.api.v1.jobs.createTask()", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_grok_imagine_text_image": {
      if (isXaiProvider(provider)) {
        const payload: XaiImageGenerateRequest = {
          prompt: (args as GrokImagineTextArgs).prompt ?? "",
          n: 1,
          response_format: "url",
          ...(args.aspect_ratio !== undefined ? { aspect_ratio: args.aspect_ratio as string } : {}),
        };
        return { provider_path: "xai.post.v1.images.generations()", payload: payload as unknown as Record<string, unknown> };
      }
      const payload = buildGrokImagineTextPayload(args as GrokImagineTextArgs);
      return { provider_path: "kie.post.api.v1.jobs.createTask()", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_grok_imagine_ref_video": {
      const payload = buildXaiGrokImagineRefVideoPayload(args as GrokImagineRefVideoArgs, imageSlugs);
      return { provider_path: "xai.post.v1.videos.generations()", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_nano_banana_image": {
      const payload = buildNanoBananaImagePayload(args as NanoBananaImageArgs, imageSlugs);
      return { provider_path: "kie.post.api.v1.jobs.createTask()", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_seedream_text_image": {
      const payload = buildSeedreamTextImagePayload(args as SeedreamImageArgs);
      return { provider_path: "kie.post.api.v1.jobs.createTask()", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_seedream_image": {
      const payload = buildSeedreamImageEditPayload(args as SeedreamImageArgs, imageSlugs);
      return { provider_path: "kie.post.api.v1.jobs.createTask()", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_qwen2_image_edit": {
      const payload = buildQwen2ImageEditPayload(args as Qwen2ImageEditArgs, imageSlugs);
      return { provider_path: "kie.post.api.v1.jobs.createTask()", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_gpt_image": {
      const payload = buildGptImagePayload(args as GptImageArgs, imageSlugs);
      return { provider_path: "kie.post.api.v1.jobs.createTask()", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_gpt_image_text": {
      const payload = buildGptImageTextPayload(args as GptImageTextArgs);
      return { provider_path: "kie.post.api.v1.jobs.createTask()", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_wan27_image": {
      const payload = buildWan27ImagePayload(args as Wan27ImageArgs, imageSlugs);
      return { provider_path: "kie.post.api.v1.jobs.createTask()", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_wan27_image_pro": {
      const payload = buildWan27ImageProPayload(args as Wan27ImageArgs, imageSlugs);
      return { provider_path: "kie.post.api.v1.jobs.createTask()", payload: payload as unknown as Record<string, unknown> };
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
      return { provider_path: "kie.post.api.v1.jobs.createTask()", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_wan27_videoedit_video": {
      const videoSlug = (args.video_slug as string) ?? "";
      const imageSlug = (args.image_slug as string | undefined) ?? undefined;
      const payload = buildWan27VideoEditPayload(args as Wan27VideoEditArgs, {
        videoUrl: videoSlug,
        referenceImageUrl: imageSlug,
      });
      return { provider_path: "kie.post.api.v1.jobs.createTask()", payload: payload as unknown as Record<string, unknown> };
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
      return { provider_path: "kie.post.api.v1.jobs.createTask()", payload: payload as unknown as Record<string, unknown> };
    }
    case "extend_wan27_video": {
      const firstClipSlug = (args.video_slug as string) ?? "";
      const payload = buildWan27FramesVideoPayload(args as Wan27FramesVideoArgs, {
        firstClipUrl: firstClipSlug,
      });
      return { provider_path: "kie.post.api.v1.jobs.createTask()", payload: payload as unknown as Record<string, unknown> };
    }
    case "extend_grok_imagine_video": {
      const payload = {
        model: "grok-imagine/extend",
        input: {
          task_id: "<task_id_from_source_video_metadata>",
          prompt: (args.prompt as string) ?? "",
          extend_at: String((args.extend_at as number | undefined) ?? 0),
          extend_times: (args.extend_times as "6" | "10" | undefined) ?? "6",
        },
      };
      return { provider_path: "kie.post.api.v1.jobs.createTask()", payload: payload as unknown as Record<string, unknown> };
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
          model: args.model as AlibabaVideoSynthesisRequest["model"] | undefined,
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
// Validation warnings helper (for translate_payload tool)
// ---------------------------------------------------------------------------

const VIDEO_TOOLS = new Set([
  "generate_kling30_video",
  "generate_seedance2_t2v_video", "generate_seedance2_i2v_video", "generate_seedance2_frames_video", "generate_seedance2_reference_video",
  "generate_grok_imagine_video", "generate_grok_imagine_ref_video",
  "extend_grok_imagine_video",
  "generate_wan27_i2v_video", "generate_wan27_videoedit_video", "generate_wan27_r2v_video", "extend_wan27_video",
  "generate_alibaba_video",
]);

const IMAGE_TOOLS = new Set([
  "generate_nano_banana_image", "generate_grok_imagine_image", "generate_gpt_image", "generate_gpt_image_text", "generate_grok_imagine_text_image",
  "generate_qwen2_image_edit", "generate_wan27_image", "generate_wan27_image_pro",
  "generate_seedream_text_image", "generate_seedream_image",
  "generate_alibaba_image", "generate_alibaba_image_pro",
]);

function getValidationWarnings(toolName: string, args: Record<string, unknown>): string[] {
  if (VIDEO_TOOLS.has(toolName)) {
    return validateVideoParams(toolName, args).warnings;
  }
  if (IMAGE_TOOLS.has(toolName)) {
    return validateImageParams(toolName, args).warnings;
  }
  return [];
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
  buildKling30VideoPayload,
  buildGrokImagineVideoPayload,
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
  buildWan27FramesVideoPayload,
  buildWan27ReferenceVideoPayload,
  buildWan27ImagePayload,
  buildWan27ImageProPayload,
  buildAlibabaImagePayload,
  buildAlibabaQwenImagePayload,
  buildAlibabaVideoPayload,
  extractKlingElements,
  translateToolPayload,
  getValidationWarnings,
};
export type { TranslateResult, Seedance2VideoArgs, Seedance2VideoOpts, Wan27FramesVideoArgs, Wan27FramesVideoOpts, Wan27ReferenceVideoArgs, Wan27ReferenceVideoOpts };
