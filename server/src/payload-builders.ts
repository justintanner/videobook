/**
 * Shared payload builders: MCP tool args → @nakedapi request bodies.
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
  // Named union types for cleaner type annotations
  KlingMode,
  GrokImagineMode,
  GrokImagineDuration,
  GrokImagineResolution,
  NanoBananaResolution,
  NanoBananaOutputFormat,
  GptImageQuality,
} from "@nakedapi/kie";
import type { VeoGenerateRequest, VeoExtendRequest } from "@nakedapi/kie";
import type { XaiImageEditRequest, XaiImageGenerateRequest, XaiVideoGenerateRequest, XaiImageReference } from "@nakedapi/xai";
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
    case "generate_gpt_image": {
      const payload = buildGptImagePayload(args as GptImageArgs, imageSlugs);
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
]);

const IMAGE_TOOLS = new Set([
  "generate_nano_banana_image", "generate_grok_imagine_image", "generate_gpt_image", "generate_grok_imagine_text_image",
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
  buildGrokImagineTextPayload,
  buildGptImagePayload,
  buildSeedance2VideoPayload,
  extractKlingElements,
  translateToolPayload,
  getValidationWarnings,
};
export type { TranslateResult, Seedance2VideoArgs, Seedance2VideoOpts };
