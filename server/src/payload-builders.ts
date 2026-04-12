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
  NanoBananaProRequest,
  GptImageToImageRequest,
  Qwen2ImageEditRequest,
  Wan27ImageToVideoRequest,
  Wan27RefToVideoRequest,
  Wan27VideoEditRequest,
  Wan27ImageRequest,
  Wan27ImageProRequest,
  // Named union types for cleaner type annotations
  KlingMode,
  GrokImagineMode,
  GrokImagineDuration,
  GrokImagineResolution,
  NanoBananaResolution,
  NanoBananaOutputFormat,
  GptImageQuality,
} from "@apicity/kie";
import type { VeoGenerateRequest, VeoExtendRequest } from "@apicity/kie";
import type { XaiImageEditRequest, XaiImageGenerateRequest, XaiVideoGenerateRequest, XaiImageReference } from "@apicity/xai";
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
      duration: (args.duration ?? "8") as KlingVideoRequest["input"]["duration"],
      ...(args.aspect_ratio !== undefined ? { aspect_ratio: args.aspect_ratio as "16:9" | "9:16" | "1:1" } : {}),
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
  duration?: GrokImagineDuration;
  resolution?: GrokImagineResolution;
  aspect_ratio?: string;
};

function buildGrokImagineVideoPayload(
  args: GrokImagineVideoArgs,
  imageUrls: string[],
): GrokImageToVideoRequest {
  return {
    model: "grok-imagine/image-to-video",
    input: {
      ...(imageUrls.length > 0 ? { image_urls: imageUrls } : {}),
      ...(args.prompt !== undefined ? { prompt: args.prompt } : {}),
      ...(args.mode !== undefined ? { mode: args.mode } : {}),
      ...(args.duration !== undefined ? { duration: args.duration } : {}),
      ...(args.resolution !== undefined ? { resolution: args.resolution } : {}),
      ...(args.aspect_ratio !== undefined ? { aspect_ratio: args.aspect_ratio as GrokImageToVideoRequest["input"]["aspect_ratio"] } : {}),
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
};

function buildGrokImagineTextPayload(
  args: GrokImagineTextArgs,
): GrokTextToImageRequest {
  return {
    model: "grok-imagine/text-to-image",
    input: {
      prompt: args.prompt,
      ...(args.aspect_ratio !== undefined ? { aspect_ratio: args.aspect_ratio as GrokTextToImageRequest["input"]["aspect_ratio"] } : {}),
    },
  };
}

type Seedance2VideoArgs = {
  prompt: string;
  aspect_ratio?: string;
  resolution?: "480p" | "720p";
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
): Seedance2FastRequest {
  return {
    model: "bytedance/seedance-2-fast",
    input: {
      prompt: args.prompt,
      ...(opts.firstFrameUrl !== undefined ? { first_frame_url: opts.firstFrameUrl } : {}),
      ...(opts.lastFrameUrl !== undefined ? { last_frame_url: opts.lastFrameUrl } : {}),
      ...(opts.referenceImageUrls && opts.referenceImageUrls.length > 0 ? { reference_image_urls: opts.referenceImageUrls } : {}),
      ...(opts.referenceVideoUrls && opts.referenceVideoUrls.length > 0 ? { reference_video_urls: opts.referenceVideoUrls } : {}),
      ...(opts.referenceAudioUrls && opts.referenceAudioUrls.length > 0 ? { reference_audio_urls: opts.referenceAudioUrls } : {}),
      ...(args.aspect_ratio !== undefined ? { aspect_ratio: args.aspect_ratio as Seedance2FastRequest["input"]["aspect_ratio"] } : {}),
      ...(args.resolution !== undefined ? { resolution: args.resolution } : {}),
      ...(args.duration !== undefined ? { duration: parseInt(args.duration, 10) } : {}),
      ...(args.generate_audio !== undefined ? { generate_audio: args.generate_audio } : {}),
      ...(args.return_last_frame !== undefined ? { return_last_frame: args.return_last_frame } : {}),
      ...(args.web_search !== undefined ? { web_search: args.web_search } : {}),
    },
  };
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

type Qwen2ImageEditArgs = {
  prompt: string;
  image_size?: string;
  output_format?: "png" | "jpeg";
  seed?: number;
};

function buildQwen2ImageEditPayload(
  args: Qwen2ImageEditArgs,
  imageInput: string[],
): Qwen2ImageEditRequest {
  return {
    model: "qwen2/image-edit",
    input: {
      prompt: args.prompt,
      image_url: imageInput[0] ?? "",
      ...(args.image_size !== undefined ? { image_size: args.image_size as Qwen2ImageEditRequest["input"]["image_size"] } : {}),
      ...(args.output_format !== undefined ? { output_format: args.output_format } : {}),
      ...(args.seed !== undefined ? { seed: args.seed } : {}),
    },
  };
}

type GptImageArgs = {
  prompt: string;
  aspect_ratio?: string;
  quality?: GptImageQuality;
};

function buildGptImagePayload(
  args: GptImageArgs,
  inputUrls: string[],
): GptImageToImageRequest {
  return {
    model: "gpt-image/1.5-image-to-image",
    input: {
      prompt: args.prompt,
      input_urls: inputUrls,
      ...(args.aspect_ratio !== undefined ? { aspect_ratio: args.aspect_ratio as "1:1" | "2:3" | "3:2" } : {}),
      ...(args.quality !== undefined ? { quality: args.quality } : {}),
    },
  };
}

function buildVeoVideoPayload(
  args: Record<string, unknown>,
  imageUrls: string[],
): VeoGenerateRequest {
  return {
    prompt: args.prompt as string,
    ...(args.model !== undefined ? { model: args.model as VeoGenerateRequest["model"] } : {}),
    ...(args.aspect_ratio !== undefined ? { aspectRatio: args.aspect_ratio as VeoGenerateRequest["aspectRatio"] } : {}),
    ...(args.generation_type !== undefined ? { generationType: args.generation_type as VeoGenerateRequest["generationType"] } : {}),
    ...(imageUrls.length > 0 ? { imageUrls } : {}),
    ...(args.seeds !== undefined ? { seeds: args.seeds as number } : {}),
    ...(args.watermark !== undefined ? { watermark: args.watermark as string } : {}),
    ...(args.enable_translation !== undefined ? { enableTranslation: args.enable_translation as boolean } : {}),
  };
}

function buildVeoExtendPayload(
  args: Record<string, unknown>,
  taskId: string,
): VeoExtendRequest {
  return {
    taskId,
    prompt: args.prompt as string,
    ...(args.model !== undefined ? { model: args.model as "fast" | "quality" } : {}),
    ...(args.seeds !== undefined ? { seeds: args.seeds as number } : {}),
    ...(args.watermark !== undefined ? { watermark: args.watermark as string } : {}),
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
      ...(args.aspect_ratio !== undefined ? { aspect_ratio: args.aspect_ratio as Wan27ImageRequest["input"]["aspect_ratio"] } : {}),
      ...(args.resolution !== undefined ? { resolution: args.resolution as Wan27ImageRequest["input"]["resolution"] } : {}),
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
      ...(args.aspect_ratio !== undefined ? { aspect_ratio: args.aspect_ratio as Wan27ImageProRequest["input"]["aspect_ratio"] } : {}),
      ...(args.resolution !== undefined ? { resolution: args.resolution as Wan27ImageProRequest["input"]["resolution"] } : {}),
      ...(args.seed !== undefined ? { seed: args.seed } : {}),
      ...(args.nsfw_checker !== undefined ? { nsfw_checker: args.nsfw_checker } : {}),
    },
  };
}

type Wan27FramesVideoArgs = {
  prompt: string;
  negative_prompt?: string;
  resolution?: "720p" | "1080p";
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
  resolution?: "720p" | "1080p";
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
      ...(args.aspect_ratio !== undefined ? { aspect_ratio: args.aspect_ratio as Wan27RefToVideoRequest["input"]["aspect_ratio"] } : {}),
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
  resolution?: "720p" | "1080p";
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
      ...(args.aspect_ratio !== undefined ? { aspect_ratio: args.aspect_ratio as Wan27VideoEditRequest["input"]["aspect_ratio"] } : {}),
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
    ...(imageUrls.length > 0 ? { image: { url: imageUrls[0] } } : {}),
    ...(args.duration !== undefined ? { duration: parseInt(args.duration, 10) } : {}),
    ...(args.resolution !== undefined ? { resolution: args.resolution } : {}),
    ...(args.aspect_ratio !== undefined ? { aspect_ratio: args.aspect_ratio as XaiVideoGenerateRequest["aspect_ratio"] } : {}),
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
    case "generate_qwen2_image_edit": {
      const payload = buildQwen2ImageEditPayload(args as Qwen2ImageEditArgs, imageSlugs);
      return { provider_path: "kie.post.api.v1.jobs.createTask()", payload: payload as unknown as Record<string, unknown> };
    }
    case "generate_gpt_image": {
      const payload = buildGptImagePayload(args as GptImageArgs, imageSlugs);
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
    case "generate_veo_video": {
      const payload = buildVeoVideoPayload(args, imageSlugs);
      return { provider_path: "kie.veo.post.api.v1.veo.generate()", payload: payload as unknown as Record<string, unknown> };
    }
    case "extend_veo_video": {
      const videoSlug = (args.video_slug as string) ?? "";
      const payload = buildVeoExtendPayload(args, videoSlug);
      return { provider_path: "kie.veo.post.api.v1.veo.extend()", payload: payload as unknown as Record<string, unknown> };
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
    case "extend_grok_imagine_video": {
      if (isXaiProvider(provider)) {
        const videoSlug = (args.video_slug as string) ?? "";
        const payload = {
          prompt: (args.prompt as string) ?? "",
          video: { url: videoSlug },
          ...(args.duration !== undefined ? { duration: parseInt(args.duration as string, 10) } : {}),
        };
        return { provider_path: "xai.post.v1.videos.extensions()", payload: payload as unknown as Record<string, unknown> };
      }
      // Kie path uses task_id from metadata (not available at preview time)
      const payload = {
        model: "grok-imagine/extend",
        input: {
          task_id: "<task_id_from_source_video_metadata>",
          prompt: (args.prompt as string) ?? "",
          extend_at: 0,
          extend_times: (args.duration as string) ?? "6",
        },
      };
      return { provider_path: "kie.post.api.v1.jobs.createTask()", payload: payload as unknown as Record<string, unknown> };
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Validation warnings helper (for translate_payload tool)
// ---------------------------------------------------------------------------

const VIDEO_TOOLS = new Set([
  "generate_kling30_video", "generate_veo_video", "extend_veo_video",
  "generate_seedance2_t2v_video", "generate_seedance2_frames_video", "generate_seedance2_reference_video",
  "generate_grok_imagine_video", "generate_grok_imagine_ref_video",
  "extend_grok_imagine_video",
  "generate_wan27_i2v_video", "generate_wan27_videoedit_video", "generate_wan27_r2v_video",
]);

const IMAGE_TOOLS = new Set([
  "generate_nano_banana_image", "generate_grok_imagine_image", "generate_gpt_image", "generate_grok_imagine_text_image",
  "generate_qwen2_image_edit", "generate_wan27_image", "generate_wan27_image_pro",
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
  buildSeedance2VideoPayload,
  buildWan27FramesVideoPayload,
  buildWan27ReferenceVideoPayload,
  buildWan27ImagePayload,
  buildWan27ImageProPayload,
  extractKlingElements,
  translateToolPayload,
  getValidationWarnings,
};
export type { TranslateResult, Seedance2VideoArgs, Seedance2VideoOpts, Wan27FramesVideoArgs, Wan27FramesVideoOpts, Wan27ReferenceVideoArgs, Wan27ReferenceVideoOpts };
