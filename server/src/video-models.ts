/**
 * Video model registry, schemas, validation, and routing prompt.
 */
import type { ResolvedAsset } from "videocity-engine";
import {
  GrokImageToVideoRequestSchema,
  GrokTextToVideoRequestSchema,
  GrokVideoExtendRequestSchema,
  GrokImagineDurationSchema,
  GrokImagineModeSchema,
  KlingMotionControlRequestSchema,
  KlingVideoRequestSchema,
  Seedance2FastInputSchema,
  Seedance2InputSchema,
  Seedance2MiniInputSchema,
  Wan27AudioSettingSchema,
  Wan27ImageToVideoRequestSchema,
  Wan27RefToVideoRequestSchema,
  Wan27TextToVideoRequestSchema,
  Wan27VideoEditRequestSchema,
  HappyHorse11ImageToVideoRequestSchema,
  HappyHorse11ReferenceToVideoRequestSchema,
  HappyHorse11TextToVideoRequestSchema,
  HappyHorseVideoEditRequestSchema,
  VolcengineVideoToVideoLipSyncRequestSchema,
  Omnihuman15RequestSchema,
  GeminiOmniVideoRequestSchema,
} from "@apicity/kie/zod";
import { XaiVideoGenerateRequestSchema } from "@apicity/xai/zod";
import { AlibabaVideoSynthesisParametersSchema } from "@apicity/alibaba/zod";
import {
  FalWanV2p7EditVideoRequestSchema,
  FalWanV2p7ImageToVideoRequestSchema,
  FalWanV2p7TextToVideoRequestSchema,
  FalSeedance2p0ReferenceToVideoRequestSchema,
  FalXaiGrokImagineVideoReferenceToVideoRequestSchema,
  FalXaiGrokImagineVideoEditVideoRequestSchema,
} from "@apicity/fal/zod";
import {
  readSlotConstraints,
  enumOptions,
  zodDefault,
  zodEnumOptionsOrNull,
  zodIsRequired,
  zodNumberRange,
  type SlotConstraints,
} from "./zod-slots.js";

// ---------------------------------------------------------------------------
// Provider routes
// ---------------------------------------------------------------------------

type ProviderRoute = {
  key: string;
  label: string;
  provider_path: string;
  envKey: string;
};

// ---------------------------------------------------------------------------
// Model registry
// ---------------------------------------------------------------------------

type VideoModelInfo = {
  label: string;
  tool_name: string;
  description: string;
  params: string[];
  defaults: Record<string, unknown>;
  providers: ProviderRoute[];
  /** When set, exposes "fal" as a provider option. The fal tool name is
   *  picked at submit time by image-slug count: withRefs when one or more
   *  reference images are present, noRefs otherwise. */
  falToolNames?: { noRefs?: string; withRefs?: string };
};

const VIDEO_MODELS: Record<string, VideoModelInfo> = {
  kling30: {
    label: "Kling 3.0",
    tool_name: "generate_kling30_video",
    description: "Kling 3.0 text/image-to-video with duration, sound, and aspect ratio control",
    params: [
      "prompt", "mode", "image_slugs",
      "element1_slugs", "element1_name", "element1_desc",
      "element2_slugs", "element2_name", "element2_desc",
      "element3_slugs", "element3_name", "element3_desc",
      "multi_prompt", "multi_shots",
      "duration", "sound", "aspect_ratio",
    ],
    defaults: {},
    providers: [
      { key: "kie", label: "Kie", provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", envKey: "KIE_API_KEY" },
    ],
  },
  kling30_motion_control: {
    label: "Kling 3.0 Motion Control",
    tool_name: "generate_kling30_motion_control_video",
    description: "Apply motion from reference videos to character images using Kling 3.0 motion-control",
    params: [
      "prompt", "character_image_slugs", "motion_video_slugs",
      "mode", "character_orientation", "background_source",
    ],
    defaults: {},
    providers: [
      { key: "kie", label: "Kie", provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", envKey: "KIE_API_KEY" },
    ],
  },
  seedance2: {
    label: "Seedance 2",
    tool_name: "generate_seedance2_video",
    description: "ByteDance Seedance 2 — text/image-to-video with optional first/last frame and reference images, videos, and/or audio (up to 1080p)",
    params: [
      "prompt",
      "first_frame_slug", "last_frame_slug",
      "image_slugs", "video_slugs", "audio_slugs",
      "aspect_ratio", "resolution", "duration",
      "generate_audio", "web_search", "nsfw_checker",
    ],
    defaults: {},
    providers: [
      { key: "kie", label: "Kie", provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", envKey: "KIE_API_KEY" },
    ],
  },
  seedance2_fast: {
    label: "Seedance 2 Fast",
    tool_name: "generate_seedance2_fast_video",
    description: "ByteDance Seedance 2 Fast — text/image-to-video with optional first/last frame and reference images, videos, and/or audio (up to 720p)",
    params: [
      "prompt",
      "first_frame_slug", "last_frame_slug",
      "image_slugs", "video_slugs", "audio_slugs",
      "aspect_ratio", "resolution", "duration",
      "generate_audio", "web_search", "nsfw_checker",
    ],
    defaults: {},
    providers: [
      { key: "kie", label: "Kie", provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", envKey: "KIE_API_KEY" },
    ],
  },
  seedance2_mini: {
    label: "Seedance 2 Mini",
    tool_name: "generate_seedance2_mini_video",
    description: "ByteDance Seedance 2 Mini — text-to-video with optional reference images, videos, and/or audio (no first/last frame; up to 720p)",
    params: [
      "prompt",
      "image_slugs", "video_slugs", "audio_slugs",
      "aspect_ratio", "resolution", "duration",
      "generate_audio", "web_search", "nsfw_checker",
    ],
    defaults: {},
    providers: [
      { key: "kie", label: "Kie", provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", envKey: "KIE_API_KEY" },
    ],
  },
  gemini_omni: {
    label: "Gemini Omni Video",
    tool_name: "generate_gemini_omni_video",
    description: "Google Gemini Omni — multimodal text/image/clip-to-video. A prompt plus optional reference images (0-7) and one reference video clip with in/out timecodes",
    params: [
      "prompt",
      "image_slugs", "video_slug", "video_clip_start", "video_clip_ends",
      "duration", "aspect_ratio", "resolution", "seed",
    ],
    defaults: {},
    providers: [
      { key: "kie", label: "Kie", provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", envKey: "KIE_API_KEY" },
    ],
  },
  wan27_t2v: {
    label: "Wan 2.7 Text to Video",
    tool_name: "generate_wan27_t2v_video",
    description: "Wan 2.7 text-to-video with optional custom audio (kie)",
    params: [
      "prompt", "negative_prompt", "audio_slug",
      "resolution", "aspect_ratio", "duration", "prompt_extend", "watermark", "nsfw_checker", "seed",
    ],
    defaults: {},
    providers: [
      { key: "kie", label: "Kie", provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", envKey: "KIE_API_KEY" },
    ],
  },
  wan27_i2v: {
    label: "Wan 2.7 Image to Video",
    tool_name: "generate_wan27_i2v_video",
    description: "Wan 2.7 image-to-video with first/last frame, clip continuation, and driving audio",
    params: [
      "prompt", "negative_prompt",
      "first_frame_slug", "last_frame_slug", "first_clip_slug",
      "driving_audio_slug",
      "resolution", "duration", "prompt_extend", "watermark", "nsfw_checker", "seed",
    ],
    defaults: {},
    providers: [
      { key: "kie", label: "Kie", provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", envKey: "KIE_API_KEY" },
    ],
  },
  wan27_videoedit: {
    label: "Wan 2.7 Video Edit",
    tool_name: "generate_wan27_videoedit_video",
    description: "Wan 2.7 video editing with optional reference image for character, clothing, or style guidance",
    params: [
      "prompt", "negative_prompt",
      "video_slug", "image_slug",
      "resolution", "aspect_ratio", "duration", "audio_setting", "prompt_extend", "watermark", "nsfw_checker", "seed",
    ],
    defaults: {},
    providers: [
      { key: "kie", label: "Kie", provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", envKey: "KIE_API_KEY" },
    ],
  },
  wan27_r2v: {
    label: "Wan 2.7 Reference",
    tool_name: "generate_wan27_r2v_video",
    description: "Wan 2.7 reference-to-video guided by reference images, videos, voice, and optional first frame",
    params: [
      "prompt", "negative_prompt",
      "image_slugs", "video_slugs", "first_frame_slug",
      "audio_slug",
      "resolution", "aspect_ratio", "duration", "prompt_extend", "watermark", "nsfw_checker", "seed",
    ],
    defaults: {},
    providers: [
      { key: "kie", label: "Kie", provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", envKey: "KIE_API_KEY" },
    ],
  },
  wan27_extend: {
    label: "Wan 2.7 Extend",
    tool_name: "extend_wan27_video",
    description: "Extend an existing video using Wan 2.7 Image to Video with clip continuation",
    params: [
      "video_slug", "prompt", "negative_prompt",
      "resolution", "duration", "prompt_extend", "watermark", "nsfw_checker", "seed",
    ],
    defaults: {},
    providers: [
      { key: "kie", label: "Kie", provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", envKey: "KIE_API_KEY" },
    ],
  },
  grok_imagine: {
    label: "Grok Imagine 1.5 — Kie",
    tool_name: "generate_grok_imagine_video",
    description: "Kie Grok Imagine Video 1.5 image-to-video",
    params: ["prompt", "image_slugs", "mode", "duration", "resolution", "aspect_ratio", "nsfw_checker"],
    defaults: {},
    providers: [
      { key: "kie", label: "Kie", provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", envKey: "KIE_API_KEY" },
    ],
  },
  grok_imagine_t2v: {
    label: "Grok Imagine — Text",
    tool_name: "generate_grok_imagine_t2v_video",
    description: "Grok Imagine text-to-video (no reference images, kie)",
    params: ["prompt", "mode", "duration", "resolution", "aspect_ratio", "nsfw_checker"],
    defaults: {},
    providers: [
      { key: "kie", label: "Kie", provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", envKey: "KIE_API_KEY" },
    ],
  },
  grok_imagine_ref: {
    label: "Grok Imagine Reference",
    tool_name: "generate_grok_imagine_ref_video",
    description: "Video generation guided by reference images (0-4 optional)",
    params: ["prompt", "image_slugs", "duration", "resolution", "aspect_ratio"],
    defaults: {},
    providers: [
      { key: "xai", label: "xAI", provider_path: "xai.post.v1.videos.generations(request, { otp })", envKey: "XAI_API_KEY" },
    ],
  },
  grok_imagine_extend: {
    label: "Grok Imagine Extend",
    tool_name: "extend_grok_imagine_video",
    description: "Extend an existing video into a longer video using Grok Imagine",
    params: ["video_slug", "prompt", "extend_at", "extend_times"],
    defaults: {},
    providers: [
      { key: "kie", label: "Kie", provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", envKey: "KIE_API_KEY" },
    ],
  },
  happyhorse_t2v: {
    label: "HappyHorse 1.1 — Text",
    tool_name: "generate_happyhorse_t2v_video",
    description: "HappyHorse 1.1 text-to-video (kie)",
    params: ["prompt", "resolution", "aspect_ratio", "duration"],
    defaults: {},
    providers: [
      { key: "kie", label: "Kie", provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", envKey: "KIE_API_KEY" },
    ],
  },
  happyhorse_i2v: {
    label: "HappyHorse 1.1 — First Frame",
    tool_name: "generate_happyhorse_i2v_video",
    description: "HappyHorse 1.1 image-to-video from a single first-frame image (kie)",
    params: ["prompt", "first_frame_slug", "resolution", "duration"],
    defaults: {},
    providers: [
      { key: "kie", label: "Kie", provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", envKey: "KIE_API_KEY" },
    ],
  },
  happyhorse_ref: {
    label: "HappyHorse 1.1 — Reference",
    tool_name: "generate_happyhorse_ref_video",
    description: "HappyHorse 1.1 reference-to-video for multi-character scenes (1-9 reference images)",
    params: ["prompt", "image_slugs", "resolution", "aspect_ratio", "duration"],
    defaults: {},
    providers: [
      { key: "kie", label: "Kie", provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", envKey: "KIE_API_KEY" },
    ],
  },
  happyhorse_videoedit: {
    label: "HappyHorse — Video Edit",
    tool_name: "generate_happyhorse_videoedit_video",
    description: "HappyHorse video editing with optional reference images for character/style guidance (kie)",
    params: ["prompt", "video_slug", "image_slugs", "resolution", "audio_setting", "seed"],
    defaults: {},
    providers: [
      { key: "kie", label: "Kie", provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", envKey: "KIE_API_KEY" },
    ],
  },
  volcengine_lipsync: {
    label: "Volcengine Lip-Sync",
    tool_name: "generate_volcengine_lipsync_video",
    description: "Volcengine video-to-video lip-sync — drive a source video's lips from a separate audio track (kie)",
    params: [
      "video_slug", "audio_slug", "mode",
      "separate_vocal", "open_scenedet", "align_audio", "align_audio_reverse", "templ_start_seconds",
    ],
    defaults: {},
    providers: [
      { key: "kie", label: "Kie", provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", envKey: "KIE_API_KEY" },
    ],
  },
  omnihuman: {
    label: "OmniHuman 1.5",
    tool_name: "generate_omnihuman_video",
    description: "ByteDance OmniHuman 1.5 — animate a portrait image with a driving audio track into a talking/singing avatar video (kie)",
    params: ["image_slug", "audio_slug", "prompt", "output_resolution", "pe_fast_mode", "seed"],
    defaults: {},
    providers: [
      { key: "kie", label: "Kie", provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", envKey: "KIE_API_KEY" },
    ],
  },
  alibaba_video: {
    label: "Alibaba Video Synthesis",
    tool_name: "generate_alibaba_video",
    description: "Alibaba Cloud video synthesis with first/last frame, reference video, driving audio, and resolution control",
    params: [
      "prompt", "negative_prompt", "model",
      "first_frame_slug", "last_frame_slug", "first_clip_slug", "driving_audio_slug", "video_slug",
      "resolution", "duration", "prompt_extend", "watermark", "audio_setting", "seed",
    ],
    defaults: {},
    providers: [
      { key: "alibaba", label: "Alibaba", provider_path: "alibaba.post.api.v1.services.aigc.videoGeneration.videoSynthesis()", envKey: "DASHSCOPE_API_KEY" },
    ],
  },
  seedance2_fast_t2v: {
    label: "Seedance 2.0 Fast — Text",
    tool_name: "generate_seedance2_fast_t2v_video",
    description: "ByteDance Seedance 2.0 Fast text-to-video via fal.ai",
    params: ["prompt", "resolution", "duration", "aspect_ratio", "generate_audio", "seed"],
    defaults: {},
    providers: [],
    falToolNames: { noRefs: "generate_seedance2_fast_t2v_fal" },
  },
  seedance2_fast_i2v: {
    label: "Seedance 2.0 Fast — First Frame",
    tool_name: "generate_seedance2_fast_i2v_video",
    description: "ByteDance Seedance 2.0 Fast image-to-video via fal.ai",
    params: ["prompt", "first_frame_slug", "end_frame_slug", "resolution", "duration", "aspect_ratio", "generate_audio", "seed"],
    defaults: {},
    providers: [],
    falToolNames: { withRefs: "generate_seedance2_fast_i2v_fal" },
  },
  wan27_t2v_fal: {
    label: "Wan v2.7 — Text (fal)",
    tool_name: "generate_wan27_t2v_fal_video",
    description: "Alibaba Wan v2.7 text-to-video via fal.ai",
    params: ["prompt", "aspect_ratio", "resolution", "duration", "negative_prompt", "enable_prompt_expansion", "enable_safety_checker", "seed"],
    defaults: {},
    providers: [],
    falToolNames: { noRefs: "generate_wan27_t2v_fal" },
  },
  wan27_i2v_fal: {
    label: "Wan v2.7 — First Frame (fal)",
    tool_name: "generate_wan27_i2v_fal_video",
    description: "Alibaba Wan v2.7 image-to-video via fal.ai",
    params: ["prompt", "first_frame_slug", "end_frame_slug", "resolution", "duration", "negative_prompt", "enable_prompt_expansion", "enable_safety_checker", "seed"],
    defaults: {},
    providers: [],
    falToolNames: { withRefs: "generate_wan27_i2v_fal" },
  },
  kling30_standard: {
    label: "Kling 3.0 Standard",
    tool_name: "generate_kling30_standard_video",
    description: "Kling Video v3 Standard tier via fal.ai (text- or image-to-video)",
    params: ["prompt", "first_frame_slug", "end_frame_slug", "duration", "aspect_ratio", "generate_audio", "shot_type", "negative_prompt", "cfg_scale"],
    defaults: {},
    providers: [],
    falToolNames: { noRefs: "generate_kling_v3_standard_t2v_fal", withRefs: "generate_kling_v3_standard_i2v_fal" },
  },
  kling30_pro_fal: {
    label: "Kling 3.0 Pro",
    tool_name: "generate_kling30_pro_video",
    description: "Kling Video v3 Pro tier via fal.ai (text- or image-to-video)",
    params: ["prompt", "first_frame_slug", "end_frame_slug", "duration", "aspect_ratio", "generate_audio", "shot_type", "negative_prompt", "cfg_scale"],
    defaults: {},
    providers: [],
    falToolNames: { noRefs: "generate_kling_v3_pro_t2v_fal", withRefs: "generate_kling_v3_pro_i2v_fal" },
  },
  wan27_r2v_fal: {
    label: "Wan v2.7 — Reference (fal)",
    tool_name: "generate_wan27_r2v_fal_video",
    description: "Alibaba Wan v2.7 reference-to-video via fal.ai, guided by reference images and/or videos",
    params: ["prompt", "image_slugs", "video_slugs", "aspect_ratio", "resolution", "duration", "multi_shots", "negative_prompt", "enable_safety_checker", "seed"],
    defaults: {},
    providers: [],
    falToolNames: { noRefs: "generate_wan27_r2v_fal", withRefs: "generate_wan27_r2v_fal" },
  },
  wan27_videoedit_fal: {
    label: "Wan v2.7 — Video Edit (fal)",
    tool_name: "generate_wan27_videoedit_fal_video",
    description: "Alibaba Wan v2.7 video editing via fal.ai with optional reference image for character/style guidance",
    params: ["prompt", "video_slug", "image_slug", "aspect_ratio", "resolution", "duration", "audio_setting", "negative_prompt", "enable_safety_checker", "seed"],
    defaults: {},
    providers: [],
    falToolNames: { noRefs: "generate_wan27_videoedit_fal", withRefs: "generate_wan27_videoedit_fal" },
  },
  seedance2_r2v_fal: {
    label: "Seedance 2.0 — Reference (fal)",
    tool_name: "generate_seedance2_r2v_fal_video",
    description: "ByteDance Seedance 2.0 reference-to-video via fal.ai, guided by reference images, videos, and/or audio",
    params: ["prompt", "image_slugs", "video_slugs", "audio_slugs", "resolution", "duration", "aspect_ratio", "generate_audio", "seed"],
    defaults: {},
    providers: [],
    falToolNames: { noRefs: "generate_seedance2_r2v_fal", withRefs: "generate_seedance2_r2v_fal" },
  },
  seedance2_fast_r2v_fal: {
    label: "Seedance 2.0 Fast — Reference (fal)",
    tool_name: "generate_seedance2_fast_r2v_fal_video",
    description: "ByteDance Seedance 2.0 Fast reference-to-video via fal.ai, guided by reference images, videos, and/or audio",
    params: ["prompt", "image_slugs", "video_slugs", "audio_slugs", "resolution", "duration", "aspect_ratio", "generate_audio", "seed"],
    defaults: {},
    providers: [],
    falToolNames: { noRefs: "generate_seedance2_fast_r2v_fal", withRefs: "generate_seedance2_fast_r2v_fal" },
  },
  grok_imagine_r2v_fal: {
    label: "Grok Imagine — Reference (fal)",
    tool_name: "generate_grok_imagine_r2v_fal_video",
    description: "xAI Grok Imagine reference-to-video via fal.ai, guided by 1-7 reference images",
    params: ["prompt", "image_slugs", "duration", "aspect_ratio", "resolution"],
    defaults: {},
    providers: [],
    falToolNames: { noRefs: "generate_grok_imagine_video_r2v_fal", withRefs: "generate_grok_imagine_video_r2v_fal" },
  },
  grok_imagine_extend_fal: {
    label: "Grok Imagine — Extend (fal)",
    tool_name: "generate_grok_imagine_extend_fal_video",
    description: "xAI Grok Imagine extend-video via fal.ai, continues an existing video",
    params: ["prompt", "video_slug", "duration"],
    defaults: {},
    providers: [],
    falToolNames: { noRefs: "generate_grok_imagine_video_extend_fal", withRefs: "generate_grok_imagine_video_extend_fal" },
  },
  grok_imagine_edit_fal: {
    label: "Grok Imagine — Video Edit (fal)",
    tool_name: "generate_grok_imagine_edit_fal_video",
    description: "xAI Grok Imagine edit-video via fal.ai, re-renders a source video",
    params: ["prompt", "video_slug", "resolution"],
    defaults: {},
    providers: [],
    falToolNames: { noRefs: "generate_grok_imagine_video_edit_fal", withRefs: "generate_grok_imagine_video_edit_fal" },
  },
};

// ---------------------------------------------------------------------------
// Image slot schemas — source of truth is the Apicity Zod request schema.
// Tools absent from this map have no image-array field; their `image_slots`
// resolves to null and the UI omits the /images panel.
// ---------------------------------------------------------------------------

type ZodLike = { _def?: unknown; unwrap?: () => unknown };

const IMAGE_FIELD_SCHEMAS: Record<string, ZodLike> = {
  generate_kling30_video: KlingVideoRequestSchema.shape.input.shape.image_urls,
  generate_seedance2_video: Seedance2InputSchema.shape.reference_image_urls,
  generate_seedance2_fast_video: Seedance2FastInputSchema.shape.reference_image_urls,
  generate_seedance2_mini_video: Seedance2MiniInputSchema.shape.reference_image_urls,
  generate_gemini_omni_video: GeminiOmniVideoRequestSchema.shape.input.shape.image_urls,
  generate_grok_imagine_video: GrokImageToVideoRequestSchema.shape.input.shape.image_urls,
  generate_grok_imagine_ref_video: XaiVideoGenerateRequestSchema.shape.reference_images,
  generate_wan27_r2v_video: Wan27RefToVideoRequestSchema.shape.input.shape.reference_image,
  generate_happyhorse_ref_video: HappyHorse11ReferenceToVideoRequestSchema.shape.input.shape.reference_image,
};

const IMAGE_SLOT_OVERRIDES: Record<string, SlotConstraints> = {
  generate_grok_imagine_video: { min: 1, max: 7 },
};

const VIDEO_PARAM_ZOD_SCHEMAS: Record<string, Record<string, ZodLike>> = {
  generate_kling30_video: {
    prompt: KlingVideoRequestSchema.shape.input.shape.prompt,
    sound: KlingVideoRequestSchema.shape.input.shape.sound,
    duration: KlingVideoRequestSchema.shape.input.shape.duration,
    aspect_ratio: KlingVideoRequestSchema.shape.input.shape.aspect_ratio,
    mode: KlingVideoRequestSchema.shape.input.shape.mode,
    multi_shots: KlingVideoRequestSchema.shape.input.shape.multi_shots,
    multi_prompt: KlingVideoRequestSchema.shape.input.shape.multi_prompt,
  },
  generate_kling30_motion_control_video: {
    prompt: KlingMotionControlRequestSchema.shape.input.shape.prompt,
    mode: KlingMotionControlRequestSchema.shape.input.shape.mode,
    character_orientation: KlingMotionControlRequestSchema.shape.input.shape.character_orientation,
    background_source: KlingMotionControlRequestSchema.shape.input.shape.background_source,
  },
  generate_seedance2_video: {
    prompt: Seedance2InputSchema.shape.prompt,
    resolution: Seedance2InputSchema.shape.resolution,
    aspect_ratio: Seedance2InputSchema.shape.aspect_ratio,
    duration: Seedance2InputSchema.shape.duration,
    generate_audio: Seedance2InputSchema.shape.generate_audio,
    web_search: Seedance2InputSchema.shape.web_search,
    nsfw_checker: Seedance2InputSchema.shape.nsfw_checker,
  },
  generate_seedance2_fast_video: {
    prompt: Seedance2FastInputSchema.shape.prompt,
    resolution: Seedance2FastInputSchema.shape.resolution,
    aspect_ratio: Seedance2FastInputSchema.shape.aspect_ratio,
    duration: Seedance2FastInputSchema.shape.duration,
    generate_audio: Seedance2FastInputSchema.shape.generate_audio,
    web_search: Seedance2FastInputSchema.shape.web_search,
    nsfw_checker: Seedance2FastInputSchema.shape.nsfw_checker,
  },
  generate_seedance2_mini_video: {
    prompt: Seedance2MiniInputSchema.shape.prompt,
    resolution: Seedance2MiniInputSchema.shape.resolution,
    aspect_ratio: Seedance2MiniInputSchema.shape.aspect_ratio,
    duration: Seedance2MiniInputSchema.shape.duration,
    generate_audio: Seedance2MiniInputSchema.shape.generate_audio,
    web_search: Seedance2MiniInputSchema.shape.web_search,
    nsfw_checker: Seedance2MiniInputSchema.shape.nsfw_checker,
  },
  generate_gemini_omni_video: {
    prompt: GeminiOmniVideoRequestSchema.shape.input.shape.prompt,
    duration: GeminiOmniVideoRequestSchema.shape.input.shape.duration,
    aspect_ratio: GeminiOmniVideoRequestSchema.shape.input.shape.aspect_ratio,
    resolution: GeminiOmniVideoRequestSchema.shape.input.shape.resolution,
    seed: GeminiOmniVideoRequestSchema.shape.input.shape.seed,
  },
  generate_grok_imagine_video: {
    prompt: GrokImageToVideoRequestSchema.shape.input.shape.prompt,
    mode: GrokImageToVideoRequestSchema.shape.input.shape.mode,
    duration: GrokImageToVideoRequestSchema.shape.input.shape.duration,
    resolution: GrokImageToVideoRequestSchema.shape.input.shape.resolution,
    aspect_ratio: GrokImageToVideoRequestSchema.shape.input.shape.aspect_ratio,
    nsfw_checker: GrokImageToVideoRequestSchema.shape.input.shape.nsfw_checker,
  },
  generate_grok_imagine_t2v_video: {
    prompt: GrokTextToVideoRequestSchema.shape.input.shape.prompt,
    mode: GrokTextToVideoRequestSchema.shape.input.shape.mode,
    duration: GrokTextToVideoRequestSchema.shape.input.shape.duration,
    resolution: GrokTextToVideoRequestSchema.shape.input.shape.resolution,
    aspect_ratio: GrokTextToVideoRequestSchema.shape.input.shape.aspect_ratio,
    nsfw_checker: GrokTextToVideoRequestSchema.shape.input.shape.nsfw_checker,
  },
  generate_grok_imagine_ref_video: {
    duration: XaiVideoGenerateRequestSchema.shape.duration,
    resolution: XaiVideoGenerateRequestSchema.shape.resolution,
    aspect_ratio: XaiVideoGenerateRequestSchema.shape.aspect_ratio,
  },
  extend_grok_imagine_video: {
    extend_at: GrokVideoExtendRequestSchema.shape.input.shape.extend_at,
    extend_times: GrokVideoExtendRequestSchema.shape.input.shape.extend_times,
  },
  generate_wan27_t2v_video: {
    resolution: Wan27TextToVideoRequestSchema.shape.input.shape.resolution,
    aspect_ratio: Wan27TextToVideoRequestSchema.shape.input.shape.ratio,
    duration: Wan27TextToVideoRequestSchema.shape.input.shape.duration,
    prompt_extend: Wan27TextToVideoRequestSchema.shape.input.shape.prompt_extend,
    watermark: Wan27TextToVideoRequestSchema.shape.input.shape.watermark,
    nsfw_checker: Wan27TextToVideoRequestSchema.shape.input.shape.nsfw_checker,
  },
  generate_wan27_i2v_video: {
    resolution: Wan27ImageToVideoRequestSchema.shape.input.shape.resolution,
    duration: Wan27ImageToVideoRequestSchema.shape.input.shape.duration,
    prompt_extend: Wan27ImageToVideoRequestSchema.shape.input.shape.prompt_extend,
    watermark: Wan27ImageToVideoRequestSchema.shape.input.shape.watermark,
    nsfw_checker: Wan27ImageToVideoRequestSchema.shape.input.shape.nsfw_checker,
  },
  generate_wan27_videoedit_video: {
    resolution: Wan27VideoEditRequestSchema.shape.input.shape.resolution,
    aspect_ratio: Wan27VideoEditRequestSchema.shape.input.shape.aspect_ratio,
    duration: Wan27VideoEditRequestSchema.shape.input.shape.duration,
    audio_setting: Wan27VideoEditRequestSchema.shape.input.shape.audio_setting,
    prompt_extend: Wan27VideoEditRequestSchema.shape.input.shape.prompt_extend,
    watermark: Wan27VideoEditRequestSchema.shape.input.shape.watermark,
    nsfw_checker: Wan27VideoEditRequestSchema.shape.input.shape.nsfw_checker,
  },
  generate_wan27_r2v_video: {
    resolution: Wan27RefToVideoRequestSchema.shape.input.shape.resolution,
    aspect_ratio: Wan27RefToVideoRequestSchema.shape.input.shape.aspect_ratio,
    duration: Wan27RefToVideoRequestSchema.shape.input.shape.duration,
    prompt_extend: Wan27RefToVideoRequestSchema.shape.input.shape.prompt_extend,
    watermark: Wan27RefToVideoRequestSchema.shape.input.shape.watermark,
    nsfw_checker: Wan27RefToVideoRequestSchema.shape.input.shape.nsfw_checker,
  },
  extend_wan27_video: {
    resolution: Wan27ImageToVideoRequestSchema.shape.input.shape.resolution,
    duration: Wan27ImageToVideoRequestSchema.shape.input.shape.duration,
    prompt_extend: Wan27ImageToVideoRequestSchema.shape.input.shape.prompt_extend,
    watermark: Wan27ImageToVideoRequestSchema.shape.input.shape.watermark,
    nsfw_checker: Wan27ImageToVideoRequestSchema.shape.input.shape.nsfw_checker,
  },
  generate_happyhorse_t2v_video: {
    resolution: HappyHorse11TextToVideoRequestSchema.shape.input.shape.resolution,
    aspect_ratio: HappyHorse11TextToVideoRequestSchema.shape.input.shape.aspect_ratio,
    duration: HappyHorse11TextToVideoRequestSchema.shape.input.shape.duration,
  },
  generate_happyhorse_i2v_video: {
    resolution: HappyHorse11ImageToVideoRequestSchema.shape.input.shape.resolution,
    duration: HappyHorse11ImageToVideoRequestSchema.shape.input.shape.duration,
  },
  generate_happyhorse_ref_video: {
    resolution: HappyHorse11ReferenceToVideoRequestSchema.shape.input.shape.resolution,
    aspect_ratio: HappyHorse11ReferenceToVideoRequestSchema.shape.input.shape.aspect_ratio,
    duration: HappyHorse11ReferenceToVideoRequestSchema.shape.input.shape.duration,
  },
  generate_happyhorse_videoedit_video: {
    resolution: HappyHorseVideoEditRequestSchema.shape.input.shape.resolution,
    audio_setting: HappyHorseVideoEditRequestSchema.shape.input.shape.audio_setting,
  },
  generate_volcengine_lipsync_video: {
    mode: VolcengineVideoToVideoLipSyncRequestSchema.shape.input.shape.mode,
    separate_vocal: VolcengineVideoToVideoLipSyncRequestSchema.shape.input.shape.separate_vocal,
    open_scenedet: VolcengineVideoToVideoLipSyncRequestSchema.shape.input.shape.open_scenedet,
    align_audio: VolcengineVideoToVideoLipSyncRequestSchema.shape.input.shape.align_audio,
    align_audio_reverse: VolcengineVideoToVideoLipSyncRequestSchema.shape.input.shape.align_audio_reverse,
    templ_start_seconds: VolcengineVideoToVideoLipSyncRequestSchema.shape.input.shape.templ_start_seconds,
  },
  generate_omnihuman_video: {
    output_resolution: Omnihuman15RequestSchema.shape.input.shape.output_resolution,
    pe_fast_mode: Omnihuman15RequestSchema.shape.input.shape.pe_fast_mode,
    seed: Omnihuman15RequestSchema.shape.input.shape.seed,
  },
  generate_alibaba_video: {
    resolution: AlibabaVideoSynthesisParametersSchema.shape.resolution,
    duration: AlibabaVideoSynthesisParametersSchema.shape.duration,
    prompt_extend: AlibabaVideoSynthesisParametersSchema.shape.prompt_extend,
    watermark: AlibabaVideoSynthesisParametersSchema.shape.watermark,
    audio_setting: AlibabaVideoSynthesisParametersSchema.shape.audio_setting,
    seed: AlibabaVideoSynthesisParametersSchema.shape.seed,
  },
  generate_seedance2_r2v_fal_video: {
    resolution: FalSeedance2p0ReferenceToVideoRequestSchema.shape.resolution,
    duration: FalSeedance2p0ReferenceToVideoRequestSchema.shape.duration,
    aspect_ratio: FalSeedance2p0ReferenceToVideoRequestSchema.shape.aspect_ratio,
    generate_audio: FalSeedance2p0ReferenceToVideoRequestSchema.shape.generate_audio,
  },
  generate_seedance2_fast_r2v_fal_video: {
    resolution: FalSeedance2p0ReferenceToVideoRequestSchema.shape.resolution,
    duration: FalSeedance2p0ReferenceToVideoRequestSchema.shape.duration,
    aspect_ratio: FalSeedance2p0ReferenceToVideoRequestSchema.shape.aspect_ratio,
    generate_audio: FalSeedance2p0ReferenceToVideoRequestSchema.shape.generate_audio,
  },
  generate_wan27_t2v_fal_video: {
    aspect_ratio: FalWanV2p7TextToVideoRequestSchema.shape.aspect_ratio,
    resolution: FalWanV2p7TextToVideoRequestSchema.shape.resolution,
    duration: FalWanV2p7TextToVideoRequestSchema.shape.duration,
    enable_safety_checker: FalWanV2p7TextToVideoRequestSchema.shape.enable_safety_checker,
  },
  generate_wan27_i2v_fal_video: {
    resolution: FalWanV2p7ImageToVideoRequestSchema.shape.resolution,
    duration: FalWanV2p7ImageToVideoRequestSchema.shape.duration,
    enable_safety_checker: FalWanV2p7ImageToVideoRequestSchema.shape.enable_safety_checker,
  },
  generate_wan27_r2v_fal_video: {
    aspect_ratio: FalWanV2p7EditVideoRequestSchema.shape.aspect_ratio,
    resolution: FalWanV2p7EditVideoRequestSchema.shape.resolution,
    duration: FalWanV2p7EditVideoRequestSchema.shape.duration,
    enable_safety_checker: FalWanV2p7EditVideoRequestSchema.shape.enable_safety_checker,
  },
  generate_wan27_videoedit_fal_video: {
    aspect_ratio: FalWanV2p7EditVideoRequestSchema.shape.aspect_ratio,
    resolution: FalWanV2p7EditVideoRequestSchema.shape.resolution,
    duration: FalWanV2p7EditVideoRequestSchema.shape.duration,
    audio_setting: FalWanV2p7EditVideoRequestSchema.shape.audio_setting,
    enable_safety_checker: FalWanV2p7EditVideoRequestSchema.shape.enable_safety_checker,
  },
  generate_grok_imagine_r2v_fal_video: {
    aspect_ratio: FalXaiGrokImagineVideoReferenceToVideoRequestSchema.shape.aspect_ratio,
    resolution: FalXaiGrokImagineVideoReferenceToVideoRequestSchema.shape.resolution,
  },
  generate_grok_imagine_edit_fal_video: {
    resolution: FalXaiGrokImagineVideoEditVideoRequestSchema.shape.resolution,
  },
};

// ---------------------------------------------------------------------------
// Parameter schemas (static JSON Schema defs)
// ---------------------------------------------------------------------------

type ParamSchema = {
  type: string;
  description: string;
  enum?: (string | number | boolean)[];
  default?: unknown;
  items?: Record<string, unknown>;
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
};

// Most per-tool enums/ranges are now derived from VIDEO_PARAM_ZOD_SCHEMAS at
// schema-build time (see applyApicityConstraints). Only constants that encode a
// deliberate divergence from Apicity, or that feed PARAM_SCHEMAS, remain here.

const SEEDANCE2_TOOL_NAMES = [
  "generate_seedance2_video",
  "generate_seedance2_fast_video",
];

// grok image-to-video rejects "spicy" though the Apicity mode enum includes it.
const GROK_IMAGINE_MODES = enumOptions(GrokImagineModeSchema);
const GROK_IMAGE_TO_VIDEO_MODES = GROK_IMAGINE_MODES.filter((mode) => mode !== "spicy");
// grok ref-to-video routes through xAI (unbounded duration); kie's enum is 6/10.
const GROK_IMAGINE_DURATIONS = enumOptions(GrokImagineDurationSchema);

// Feeds the shared audio_setting entry in PARAM_SCHEMAS.
const WAN27_AUDIO_SETTINGS = enumOptions(Wan27AudioSettingSchema);

// Apicity exposes no standalone Alibaba video-model enum (docs/apicity-gaps.md).
const ALIBABA_VIDEO_MODELS = ["wan2.7-i2v", "wan2.7-videoedit"];

const PARAM_SCHEMAS: Record<string, ParamSchema> = {
  prompt: { type: "string", description: "Text description of what to generate" },
  image_slugs: {
    type: "array",
    items: { type: "string" },
    description: "List of asset slugs (e.g., '@img-sunset') for reference images",
  },
  aspect_ratio: { type: "string", description: "Output aspect ratio" },
  model: { type: "string", description: "Model variant" },
  watermark: { type: "boolean", description: "Add provider watermark to output" },
  video_slug: { type: "string", description: "Video asset to extend (e.g., @vid-sunset-drone)" },
  duration: { type: "string", description: "Video duration in seconds" },
  mode: { type: "string", description: "Generation mode" },
  resolution: { type: "string", description: "Output resolution" },
  generate_audio: { type: "boolean", description: "Generate sound effects (Seedance)" },
  image_slug: { type: "string", description: "Reference image asset (e.g., @img-outfit)" },
  first_frame_slug: { type: "string", description: "First frame image asset (e.g., @img-sunset)" },
  last_frame_slug: { type: "string", description: "Last frame image asset (e.g., @img-ending)" },
  video_slugs: {
    type: "array",
    items: { type: "string" },
    description: "Reference video assets (0-3, total duration ≤15s, e.g., @vid-motion-ref)",
  },
  audio_slugs: {
    type: "array",
    items: { type: "string" },
    description: "Reference audio assets (0-3, total duration ≤15s, e.g., @aud-soundtrack)",
  },
  return_last_frame: { type: "boolean", description: "Return final frame as image" },
  web_search: { type: "boolean", description: "Use web search for enhanced grounding" },
  sound: { type: "boolean", description: "Generate audio for the video" },
  multi_shots: { type: "boolean", description: "Enable multi-shot mode" },
  enable_safety_checker: { type: "boolean", description: "Content safety filter" },
  enable_prompt_expansion: { type: "boolean", description: "Intelligent prompt rewriting" },
  multi_prompt: {
    type: "array",
    items: {
      type: "object",
      properties: { prompt: { type: "string" }, duration: { type: "integer" } },
      required: ["prompt", "duration"],
    },
    description: "List of scene dicts for multi-shot mode.",
  },
  element1_slugs: { type: "array", items: { type: "string" }, description: "1-4 image @slugs or 1 video @slug for element 1" },
  element1_name: { type: "string", description: "Name for element 1 (default: derived from first slug)" },
  element1_desc: { type: "string", description: "Description for element 1 (required when element1_slugs set)" },
  element2_slugs: { type: "array", items: { type: "string" }, description: "1-4 image @slugs or 1 video @slug for element 2" },
  element2_name: { type: "string", description: "Name for element 2 (default: derived from first slug)" },
  element2_desc: { type: "string", description: "Description for element 2 (required when element2_slugs set)" },
  element3_slugs: { type: "array", items: { type: "string" }, description: "1-4 image @slugs or 1 video @slug for element 3" },
  element3_name: { type: "string", description: "Name for element 3 (default: derived from first slug)" },
  element3_desc: { type: "string", description: "Description for element 3 (required when element3_slugs set)" },
  negative_prompt: { type: "string", description: "Negative prompt — things to avoid (max 500 chars)", maxLength: 500 },
  first_clip_slug: { type: "string", description: "Video asset for continuation (e.g., @vid-scene)" },
  driving_audio_slug: { type: "string", description: "Audio asset for audio-driven motion (e.g., @aud-music)" },
  audio_slug: { type: "string", description: "Audio asset for voice timbre reference (e.g., @aud-voice)" },
  audio_setting: { type: "string", enum: WAN27_AUDIO_SETTINGS, description: "Audio: auto (model decides) or origin (keep original)" },
  prompt_extend: { type: "boolean", description: "Intelligent prompt rewriting" },
  nsfw_checker: { type: "boolean", description: "Content safety filter" },
  seed: { type: "integer", description: "Random seed for reproducibility" },
  extend_at: { type: "number", description: "Seconds into the source video to start extending from" },
  extend_times: { type: "string", description: "Extension duration in seconds" },
  task_id: { type: "string", description: "Reference task ID (kie only, used for Grok spicy mode without external images)" },
  index: { type: "integer", description: "Frame index (0-5) when reusing a prior task_id (kie only)", minimum: 0, maximum: 5 },
  audio_url: { type: "string", description: "Custom audio asset (e.g., @aud-music)" },
  character_image_slugs: { type: "array", items: { type: "string" }, description: "Character image @slugs (input_urls)" },
  motion_video_slugs: { type: "array", items: { type: "string" }, description: "Motion reference video @slugs (video_urls)" },
  character_orientation: { type: "string", description: "Character orientation source: video / image" },
  background_source: { type: "string", description: "Background source: input_video / input_image" },
  separate_vocal: { type: "boolean", description: "Separate vocals from background audio before sync" },
  open_scenedet: { type: "boolean", description: "Enable scene-cut detection" },
  align_audio: { type: "boolean", description: "Align audio to the video timeline" },
  align_audio_reverse: { type: "boolean", description: "Reverse the audio alignment direction" },
  templ_start_seconds: { type: "number", description: "Template start offset in seconds", minimum: 0 },
  output_resolution: { type: "string", description: "Output resolution" },
  pe_fast_mode: { type: "boolean", description: "Prompt-enhance fast mode" },
  video_clip_start: { type: "number", description: "Reference clip start time in seconds", minimum: 0 },
  video_clip_ends: { type: "number", description: "Reference clip end time in seconds (must be > start and < start+10s)", minimum: 0 },
};

// ---------------------------------------------------------------------------
// Schema builder
// ---------------------------------------------------------------------------

type ToolSchema = {
  type: string;
  properties: Record<string, ParamSchema>;
  required: string[];
  defaults: Record<string, unknown>;
};

function normalizeDefaultForParam(prop: ParamSchema, value: unknown): unknown {
  if (prop.type === "string" && typeof value !== "string") return String(value);
  if (prop.type === "integer" && typeof value === "string") return parseInt(value, 10);
  if (prop.type === "number" && typeof value === "string") return Number(value);
  return value;
}

// (tool, param) pairs whose enum/range deliberately diverges from the mapped
// Apicity schema — auto-derivation is skipped and the per-tool override block
// remains the source. Each divergence is documented in docs/apicity-gaps.md.
const APICITY_DERIVE_SKIP: Record<string, ReadonlySet<string>> = {
  // grok image-to-video rejects "spicy" though the Apicity mode enum includes it.
  generate_grok_imagine_video: new Set(["mode"]),
  // Apicity Wan27VideoEditRequestSchema.duration is an unbounded int; the
  // "0"/2-10 set is provider knowledge absent from the schema.
  generate_wan27_videoedit_video: new Set(["duration"]),
  // Apicity allows duration 0 (full-source) but reference-to-video has no source
  // clip, so the app restricts to >= 2.
  generate_wan27_r2v_fal_video: new Set(["duration"]),
  // Apicity routes ref-to-video through xAI, whose duration is an unbounded
  // number; the real endpoint only accepts 6 or 10 (kie's GrokImagineDuration).
  generate_grok_imagine_ref_video: new Set(["duration"]),
};

function rangeToStringEnum(min: number, max: number): string[] {
  const values: string[] = [];
  for (let n = min; n <= max; n++) values.push(String(n));
  return values;
}

// Apply enum options / numeric range / string length read from an Apicity field
// schema onto a ParamSchema. An enum wins; otherwise a numeric range maps to
// either integer min/max (when the param is already numeric) or, for
// string-typed duration-style params, an expanded string enum to preserve the
// existing wire shape.
function applyApicityConstraints(prop: ParamSchema, schema: ZodLike): void {
  const enumOpts = zodEnumOptionsOrNull(schema);
  if (enumOpts) {
    prop.enum = [...enumOpts];
  } else {
    const range = zodNumberRange(schema);
    if (range && (range.min !== undefined || range.max !== undefined)) {
      if (prop.type === "integer" || prop.type === "number") {
        prop.type = range.int ? "integer" : "number";
        if (range.min !== undefined) prop.minimum = range.min;
        if (range.max !== undefined) prop.maximum = range.max;
        prop.enum = undefined;
      } else if (range.int && range.min !== undefined && range.max !== undefined) {
        prop.enum = rangeToStringEnum(range.min, range.max);
      }
    }
  }
  // NOTE: string min/max length is intentionally NOT derived here. Prompt caps
  // are hand-tuned and diverge from Apicity in places (e.g. grok i2v hardcodes
  // 4096 where Apicity says 5000) — see docs/apicity-gaps.md.
}

function getVideoToolSchema(toolName: string): ToolSchema | null {
  const model = Object.values(VIDEO_MODELS).find((m) => m.tool_name === toolName);
  if (!model) return null;

  const properties: Record<string, ParamSchema> = {};
  const required = new Set<string>();
  const defaults: Record<string, unknown> = {};
  const zodSchemas = VIDEO_PARAM_ZOD_SCHEMAS[toolName] ?? {};

  for (const param of model.params) {
    const base = PARAM_SCHEMAS[param];
    if (!base) continue;

    const prop = { ...base };

    // Tool-specific enum/description overrides
    if (toolName === "generate_kling30_video") {
      if (param === "prompt") prop.description = "Video description";
      if (param === "mode") prop.description = "Resolution mode: std (standard) / pro (professional) / 4K";
      if (param === "duration") prop.description = "Video duration: 3s-15s";
      if (param === "aspect_ratio") prop.description = "Video aspect ratio";
      if (param === "sound") prop.description = "Generate audio for the video";
      if (param === "image_slugs") prop.description = "Reference image assets for start/end frames (0-2 slugs like @img-sunset)";
    }
    if (toolName === "generate_kling30_motion_control_video") {
      if (param === "prompt") prop.description = "Optional motion description";
      if (param === "character_image_slugs") prop.description = "Character image @slugs (input_urls)";
      if (param === "motion_video_slugs") prop.description = "Motion reference video @slugs (video_urls)";
      if (param === "mode") prop.description = "Output resolution: 720p / 1080p";
      if (param === "character_orientation") prop.description = "Character orientation source: video / image";
      if (param === "background_source") prop.description = "Background source: input_video / input_image";
    }
    if (SEEDANCE2_TOOL_NAMES.includes(toolName)) {
      if (param === "prompt") { prop.description = "Video description (3-20000 characters)"; prop.minLength = 3; prop.maxLength = 20000; }
      if (param === "aspect_ratio") prop.description = "Frame dimensions (adaptive auto-fits to content)";
      if (param === "duration") prop.description = "Video duration: 4-15 seconds";
      if (param === "resolution") {
        const isFast = toolName === "generate_seedance2_fast_video";
        prop.description = isFast
          ? "Output resolution: 480p / 720p"
          : "Output resolution: 480p / 720p / 1080p";
      }
      if (param === "first_frame_slug") prop.description = "Optional first frame image asset (e.g., @img-start)";
      if (param === "last_frame_slug") prop.description = "Optional last frame image asset (e.g., @img-end)";
      if (param === "image_slugs") prop.description = "Reference image assets (0-9, e.g., @img-style)";
      if (param === "video_slugs") prop.description = "Reference video assets (0-3, total ≤15s, e.g., @vid-motion)";
      if (param === "audio_slugs") prop.description = "Reference audio assets (0-3, total ≤15s, e.g., @aud-music)";
      if (param === "nsfw_checker") prop.description = "Content safety filter (default false)";
    }
    if (toolName === "generate_seedance2_mini_video") {
      if (param === "prompt") { prop.description = "Video description (optional, max 20000 characters)"; prop.maxLength = 20000; }
      if (param === "aspect_ratio") prop.description = "Frame dimensions (adaptive auto-fits to content)";
      if (param === "resolution") prop.description = "Output resolution: 480p / 720p";
      if (param === "duration") prop.description = "Video duration: 4-15 seconds (default 15)";
      if (param === "image_slugs") prop.description = "Reference image assets (e.g., @img-style)";
      if (param === "video_slugs") prop.description = "Reference video assets (0-3, total ≤15s, e.g., @vid-motion)";
      if (param === "audio_slugs") prop.description = "Reference audio assets (0-3, total ≤15s, e.g., @aud-music)";
      if (param === "nsfw_checker") prop.description = "Content safety filter (default true)";
    }
    if (toolName === "generate_gemini_omni_video") {
      // Enum/range/default for prompt, duration, aspect_ratio, resolution, seed
      // auto-derive from VIDEO_PARAM_ZOD_SCHEMAS; only descriptions are set here.
      if (param === "prompt") { prop.description = "Multimodal video generation prompt (max 20000 characters)"; prop.maxLength = 20000; }
      if (param === "image_slugs") { prop.description = "Reference image assets (0-7, each ≤20MB, e.g., @img-style)"; prop.maxItems = 7; }
      if (param === "video_slug") prop.description = "Reference video clip asset (one clip, e.g., @vid-motion)";
      if (param === "video_clip_start") prop.description = "Reference clip start time in seconds (requires video_slug)";
      if (param === "video_clip_ends") prop.description = "Reference clip end time in seconds; must be > start and < start+10s (requires video_slug)";
      if (param === "duration") prop.description = "Output duration: 4 / 6 / 8 / 10 seconds (ignored when a reference video clip is supplied)";
      if (param === "aspect_ratio") prop.description = "Output aspect ratio: 16:9 / 9:16";
      if (param === "resolution") prop.description = "Output resolution: 720p / 1080p / 4k (default 720p)";
      if (param === "seed") prop.description = "Random seed (0-2147483647)";
    }
    if (toolName === "generate_wan27_t2v_video") {
      if (param === "prompt") { prop.description = "Video description (max 5000 chars)"; prop.maxLength = 5000; }
      if (param === "audio_slug") prop.description = "Optional custom audio asset (e.g., @aud-music)";
      if (param === "resolution") prop.description = "Video resolution: 720p / 1080p";
      if (param === "aspect_ratio") prop.description = "Video aspect ratio";
      if (param === "duration") prop.description = "Video duration: 2-15 seconds";
    }
    if (toolName === "generate_wan27_i2v_video") {
      if (param === "prompt") { prop.description = "Video description (max 5000 chars)"; prop.maxLength = 5000; }
      if (param === "resolution") prop.description = "Video resolution: 720p / 1080p";
      if (param === "duration") prop.description = "Video duration: 2-15 seconds";
    }
    if (toolName === "generate_wan27_videoedit_video") {
      if (param === "prompt") { prop.description = "Edit description (max 5000 chars)"; prop.maxLength = 5000; }
      if (param === "video_slug") prop.description = "Source video asset to edit (e.g., @vid-scene)";
      if (param === "image_slug") prop.description = "Reference image for character/style guidance (e.g., @img-outfit)";
      if (param === "resolution") prop.description = "Video resolution: 720p / 1080p";
      if (param === "aspect_ratio") prop.description = "Video aspect ratio (omit to match source)";
      // Apicity types this duration as an unbounded int; the "0"/2-10 set is provider knowledge (APICITY_DERIVE_SKIP).
      if (param === "duration") { prop.enum = ["0", "2", "3", "4", "5", "6", "7", "8", "9", "10"]; prop.description = "Video duration: 0 (full source) or 2-10 seconds"; }
      if (param === "audio_setting") prop.description = "Audio: auto (model decides) or origin (keep original)";
      if (param === "watermark") { prop.type = "boolean"; prop.description = "Add 'AI generated' watermark to lower-right corner (default false)"; }
    }
    if (toolName === "generate_wan27_r2v_video") {
      if (param === "prompt") { prop.description = "Video description (max 5000 chars)"; prop.maxLength = 5000; }
      if (param === "image_slugs") prop.description = "Reference image assets (max 5 total with videos, e.g., @img-style)";
      if (param === "video_slugs") prop.description = "Reference video assets (max 5 total with images, e.g., @vid-motion)";
      if (param === "aspect_ratio") prop.description = "Video aspect ratio (ignored if first_frame_slug set)";
      if (param === "resolution") prop.description = "Video resolution: 720p / 1080p";
      if (param === "duration") prop.description = "Video duration: 2-10 seconds";
    }
    if (toolName === "extend_wan27_video") {
      if (param === "video_slug") { prop.description = "Video asset to extend (e.g., @vid-scene)"; }
      if (param === "prompt") { prop.description = "Video description (max 5000 chars)"; prop.maxLength = 5000; }
      if (param === "resolution") prop.description = "Video resolution: 720p / 1080p";
      if (param === "duration") prop.description = "Video duration: 2-15 seconds";
    }
    if (toolName === "generate_grok_imagine_video") {
      if (param === "prompt") { prop.description = "Video motion description (optional, max 4096 chars)"; prop.maxLength = 4096; }
      // Apicity mode enum includes "spicy" which this i2v endpoint rejects (APICITY_DERIVE_SKIP).
      if (param === "mode") { prop.enum = GROK_IMAGE_TO_VIDEO_MODES; prop.description = "Generation mode: fun / normal"; }
      if (param === "duration") { prop.type = "integer"; prop.description = "Video duration in seconds (6-30)"; }
      if (param === "resolution") prop.description = "Video resolution: 480p / 720p";
      if (param === "aspect_ratio") prop.description = "Video aspect ratio";
      if (param === "nsfw_checker") { prop.description = "Enable NSFW content safety filter (default false)"; }
      if (param === "image_slugs") {
        prop.description = "1-7 reference image assets (required, e.g., @img-sunset)";
        prop.minItems = 1;
        prop.maxItems = 7;
      }
    }
    if (toolName === "generate_grok_imagine_t2v_video") {
      if (param === "prompt") { prop.description = "Video description (max 5000 chars)"; prop.maxLength = 5000; }
      if (param === "mode") prop.description = "Generation mode: fun / normal / spicy";
      if (param === "duration") { prop.type = "integer"; prop.description = "Video duration in seconds (6-30)"; }
      if (param === "resolution") prop.description = "Output resolution: 480p / 720p";
      if (param === "aspect_ratio") prop.description = "Output aspect ratio";
      if (param === "nsfw_checker") { prop.description = "Enable NSFW content safety filter (default false)"; }
    }
    if (toolName === "generate_grok_imagine_ref_video") {
      if (param === "prompt") { prop.description = "Video description"; }
      // Apicity routes this through xAI whose duration is unbounded; the real endpoint only accepts 6/10 (APICITY_DERIVE_SKIP).
      if (param === "duration") { prop.enum = GROK_IMAGINE_DURATIONS; prop.description = "Video duration: 6s / 10s"; }
      if (param === "resolution") prop.description = "Video resolution: 480p / 720p";
      if (param === "aspect_ratio") prop.description = "Video aspect ratio";
      if (param === "image_slugs") prop.description = "Reference images (0-4 optional, guide style/content)";
    }
    if (toolName === "extend_grok_imagine_video") {
      if (param === "prompt") { prop.description = "Describe how to extend the video (actions, scenes, style)"; prop.maxLength = 5000; }
      if (param === "extend_at") { prop.description = "Seconds into the source video to start extending from"; }
      if (param === "extend_times") prop.description = "Extension duration: 6s / 10s";
      if (param === "video_slug") { prop.description = "Video asset to extend (e.g., @vid-sunset-drone)"; }
    }
    if (toolName === "generate_wan27_r2v_fal_video") {
      if (param === "prompt") { prop.description = "Video description (max 5000 chars)"; prop.maxLength = 5000; }
      if (param === "image_slugs") prop.description = "Reference image assets (max 4, e.g., @img-style)";
      if (param === "video_slugs") prop.description = "Reference video assets (max 4, e.g., @vid-motion)";
      if (param === "aspect_ratio") prop.description = "Video aspect ratio";
      if (param === "resolution") prop.description = "Video resolution: 720p / 1080p";
      // Apicity allows duration 0 (full-source) but ref-to-video has no source clip (APICITY_DERIVE_SKIP).
      if (param === "duration") { prop.type = "integer"; prop.enum = undefined; prop.minimum = 2; prop.maximum = 10; prop.description = "Video duration in seconds (2-10)"; }
      if (param === "multi_shots") prop.description = "Enable multi-shot mode";
      if (param === "negative_prompt") { prop.description = "Things to avoid (max 500 chars)"; prop.maxLength = 500; }
      if (param === "enable_safety_checker") { prop.description = "Content safety filter"; }
    }
    if (toolName === "generate_seedance2_r2v_fal_video" || toolName === "generate_seedance2_fast_r2v_fal_video") {
      if (param === "prompt") prop.description = "Video description (reference items can be mentioned as @Image1, @Video1, @Audio1, etc.)";
      if (param === "image_slugs") prop.description = "Reference image assets (0-9)";
      if (param === "video_slugs") prop.description = "Reference video assets (0-3, combined 2-15s)";
      if (param === "audio_slugs") prop.description = "Reference audio assets (0-3, combined ≤15s)";
      if (param === "resolution") prop.description = "Output resolution: 480p / 720p";
      if (param === "duration") prop.description = "Duration in seconds or 'auto'";
      if (param === "aspect_ratio") prop.description = "Output aspect ratio";
      if (param === "generate_audio") { prop.description = "Generate synchronized audio"; }
    }
    if (toolName === "generate_grok_imagine_r2v_fal_video") {
      if (param === "prompt") prop.description = "Video description";
      if (param === "image_slugs") prop.description = "Reference image assets (1-7 required, e.g., @img-style)";
      // duration is not present in VIDEO_PARAM_ZOD_SCHEMAS for this tool — kept hardcoded.
      if (param === "duration") { prop.type = "integer"; prop.enum = undefined; prop.minimum = 1; prop.maximum = 10; prop.description = "Video duration in seconds (1-10)"; }
      if (param === "aspect_ratio") prop.description = "Output aspect ratio";
      if (param === "resolution") prop.description = "Output resolution: 480p / 720p";
    }
    if (toolName === "generate_grok_imagine_extend_fal_video") {
      if (param === "prompt") prop.description = "Describe how to extend the video";
      if (param === "video_slug") prop.description = "Source video asset to extend (e.g., @vid-scene)";
      // duration is not present in VIDEO_PARAM_ZOD_SCHEMAS for this tool — kept hardcoded.
      if (param === "duration") { prop.type = "integer"; prop.enum = undefined; prop.minimum = 2; prop.maximum = 10; prop.description = "Extension duration in seconds (2-10)"; }
    }
    if (toolName === "generate_grok_imagine_edit_fal_video") {
      if (param === "prompt") prop.description = "Edit instruction";
      if (param === "video_slug") prop.description = "Source video asset to edit (e.g., @vid-scene)";
      if (param === "resolution") prop.description = "Output resolution: auto / 480p / 720p";
    }
    if (toolName === "generate_wan27_videoedit_fal_video") {
      if (param === "prompt") { prop.description = "Edit instruction (max 5000 chars)"; prop.maxLength = 5000; }
      if (param === "video_slug") prop.description = "Source video asset to edit (e.g., @vid-scene)";
      if (param === "image_slug") prop.description = "Optional reference image for character/style guidance";
      if (param === "aspect_ratio") prop.description = "Video aspect ratio (omit to match source)";
      if (param === "resolution") prop.description = "Video resolution: 720p / 1080p";
      if (param === "duration") { prop.type = "integer"; prop.description = "Video duration in seconds (0 = full source, otherwise 2-10)"; }
      if (param === "audio_setting") prop.description = "Audio: auto (model decides) or origin (keep original)";
      if (param === "negative_prompt") { prop.description = "Things to avoid (max 500 chars)"; prop.maxLength = 500; }
      if (param === "enable_safety_checker") { prop.description = "Content safety filter"; }
    }
    if (toolName === "generate_happyhorse_t2v_video") {
      if (param === "prompt") { prop.description = "Video description (max 5000 chars / 2500 Chinese chars)"; prop.maxLength = 5000; }
      if (param === "resolution") prop.description = "Output resolution: 720p / 1080p";
      if (param === "aspect_ratio") prop.description = "Output aspect ratio";
      if (param === "duration") prop.description = "Video duration: 3-15 seconds";
    }
    if (toolName === "generate_happyhorse_i2v_video") {
      if (param === "prompt") { prop.description = "Optional video description (max 5000 chars / 2500 Chinese chars)"; prop.maxLength = 5000; }
      if (param === "first_frame_slug") prop.description = "First frame image asset (required, e.g., @img-start)";
      if (param === "resolution") prop.description = "Output resolution: 720p / 1080p";
      if (param === "duration") prop.description = "Video duration: 3-15 seconds";
    }
    if (toolName === "generate_happyhorse_ref_video") {
      if (param === "prompt") { prop.description = "Video description (max 5000 chars / 2500 Chinese chars)"; prop.maxLength = 5000; }
      if (param === "image_slugs") prop.description = "Reference image assets (1-9, order defines character1/character2/...)";
      if (param === "resolution") prop.description = "Output resolution: 720p / 1080p";
      if (param === "aspect_ratio") prop.description = "Output aspect ratio";
      if (param === "duration") prop.description = "Video duration: 3-15 seconds";
    }
    if (toolName === "generate_happyhorse_videoedit_video") {
      if (param === "prompt") { prop.description = "Edit instruction (max 5000 chars / 2500 Chinese chars)"; prop.maxLength = 5000; }
      if (param === "video_slug") prop.description = "Source video asset to edit (3-60s, e.g., @vid-scene)";
      if (param === "image_slugs") prop.description = "0-5 optional reference images for character/style guidance";
      if (param === "resolution") prop.description = "Output resolution: 720p / 1080p";
      if (param === "audio_setting") prop.description = "Audio: auto (model decides) or origin (keep original)";
    }
    if (toolName === "generate_volcengine_lipsync_video") {
      if (param === "video_slug") prop.description = "Source video asset to lip-sync (e.g., @vid-scene)";
      if (param === "audio_slug") prop.description = "Driving audio asset whose speech drives the lips (e.g., @aud-voice)";
      if (param === "mode") prop.description = "Quality mode: lite (faster) or basic";
      if (param === "templ_start_seconds") prop.description = "Template start offset in seconds (default 0)";
    }
    if (toolName === "generate_omnihuman_video") {
      if (param === "image_slug") prop.description = "Portrait image asset to animate (required, e.g., @img-face)";
      if (param === "audio_slug") prop.description = "Driving audio asset whose speech/song drives the avatar (required, max 60s, e.g., @aud-voice)";
      if (param === "prompt") { prop.description = "Optional motion/expression description (e.g. 'speaking naturally with gentle expressions')"; prop.maxLength = 5000; }
      if (param === "output_resolution") prop.description = "Output resolution: 720 / 1080 (default 1080)";
      if (param === "pe_fast_mode") prop.description = "Prompt-enhance fast mode — faster, lower-fidelity (default false)";
      if (param === "seed") prop.description = "Random seed for reproducibility (-1 = random)";
    }
    if (toolName === "generate_alibaba_video") {
      if (param === "prompt") { prop.description = "Video description"; }
      if (param === "negative_prompt") { prop.description = "Negative prompt — things to avoid"; }
      // model is not present in VIDEO_PARAM_ZOD_SCHEMAS; Apicity exposes no standalone model enum (docs/apicity-gaps.md).
      if (param === "model") { prop.enum = ALIBABA_VIDEO_MODELS; prop.description = "DashScope video model: wan2.7-i2v (image-to-video) or wan2.7-videoedit (video editing)"; }
      if (param === "first_frame_slug") { prop.description = "First frame image asset (e.g., @img-start)"; }
      if (param === "last_frame_slug") { prop.description = "Last frame image asset (e.g., @img-end)"; }
      if (param === "first_clip_slug") { prop.description = "Video asset for clip continuation (e.g., @vid-scene)"; }
      if (param === "driving_audio_slug") { prop.description = "Audio asset for audio-driven motion (e.g., @aud-music)"; }
      if (param === "video_slug") { prop.description = "Reference video asset (e.g., @vid-ref)"; }
      if (param === "resolution") prop.description = "Output resolution";
      if (param === "duration") { prop.type = "integer"; prop.description = "Video duration in seconds (2-15)"; }
      if (param === "prompt_extend") { prop.description = "Intelligent prompt rewriting (default true)"; }
      if (param === "watermark") { prop.description = "Add watermark to output video (default false)"; }
      if (param === "audio_setting") prop.description = "Driving-audio behavior: auto (model decides) or origin (keep original)";
      if (param === "seed") { prop.description = "Random seed for reproducibility"; }
    }

    const providerSchema = zodSchemas[param];
    if (providerSchema) {
      if (!APICITY_DERIVE_SKIP[toolName]?.has(param)) {
        applyApicityConstraints(prop, providerSchema);
      }
      const result = zodDefault(providerSchema);
      if (result.hasDefault) {
        const value = normalizeDefaultForParam(prop, result.value);
        prop.default = value;
        defaults[param] = value;
      } else {
        delete prop.default;
      }
      if (zodIsRequired(providerSchema)) required.add(param);
    }

    properties[param] = prop;

    // Required fields
    if (
      param === "prompt"
      && toolName !== "generate_grok_imagine_video"
      && toolName !== "generate_wan27_videoedit_video"
      && toolName !== "generate_kling30_motion_control_video"
      && toolName !== "generate_omnihuman_video"
    ) required.add(param);
    if (toolName === "generate_grok_imagine_video" && param === "image_slugs") required.add(param);
    if (param === "image_slug" && toolName === "generate_omnihuman_video") required.add(param);
    if (param === "model" && toolName === "generate_alibaba_video") required.add(param);
    if (param === "video_slug" && (toolName === "extend_grok_imagine_video" || toolName === "extend_wan27_video" || toolName === "generate_wan27_videoedit_video" || toolName === "generate_wan27_videoedit_fal_video" || toolName === "generate_grok_imagine_extend_fal_video" || toolName === "generate_grok_imagine_edit_fal_video" || toolName === "generate_volcengine_lipsync_video")) required.add(param);
    if (param === "audio_slug" && (toolName === "generate_volcengine_lipsync_video" || toolName === "generate_omnihuman_video")) required.add(param);
    if (
      toolName === "generate_kling30_motion_control_video"
      && (param === "character_image_slugs" || param === "motion_video_slugs")
    ) required.add(param);
  }

  return { type: "object", properties, required: Array.from(required), defaults };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

type ValidationResult = {
  valid: boolean;
  missing_required: string[];
  warnings: string[];
  image_slots: SlotConstraints | null;
  multi_prompt_slots: number | null;
};

function validateVideoParams(toolName: string, params: Record<string, unknown>): ValidationResult {
  const schema = getVideoToolSchema(toolName);
  if (!schema) return { valid: false, missing_required: [], warnings: ["Unknown tool"], image_slots: null, multi_prompt_slots: null };

  const missing: string[] = [];
  const warnings: string[] = [];

  for (const req of schema.required) {
    if (!(req in params) || params[req] === null || params[req] === undefined) {
      missing.push(req);
    }
  }

  // Check enum constraints
  for (const [key, value] of Object.entries(params)) {
    const prop = schema.properties[key];
    if (!prop) continue;
    if (prop.enum && value !== null && value !== undefined) {
      if (!prop.enum.includes(value as string | number | boolean)) {
        warnings.push(`${key}: '${String(value)}' not in allowed values [${prop.enum.join(", ")}]`);
      }
    }
  }

  // Tool-specific validation
  const imageSlugs = params.image_slugs as string[] | undefined;
  const totalImages = imageSlugs?.length ?? 0;

  if (toolName === "generate_grok_imagine_video" && totalImages > 7) {
    warnings.push(`Grok Imagine 1.5 supports up to 7 reference images (got ${totalImages})`);
  }

  if (toolName === "generate_kling30_video") {
    const multiPrompt = params.multi_prompt as unknown[] | undefined;
    if (multiPrompt && totalImages > 1) warnings.push(`Kling 3.0 multi-shot mode allows max 1 reference image (got ${totalImages})`);
  }

  if (toolName === "generate_seedance2_fast_video") {
    const resolution = params.resolution as string | undefined;
    if (resolution === "1080p") {
      warnings.push("Seedance 2 Fast caps at 720p — use generate_seedance2_video for 1080p");
    }
  }

  if (toolName === "generate_gemini_omni_video") {
    if (totalImages > 7) {
      warnings.push(`Gemini Omni supports up to 7 reference images (got ${totalImages})`);
    }
    const videoSlug = params.video_slug as string | undefined;
    const clipStart = params.video_clip_start as number | undefined;
    const clipEnds = params.video_clip_ends as number | undefined;
    if (!videoSlug && (clipStart !== undefined || clipEnds !== undefined)) {
      warnings.push("video_clip_start/video_clip_ends require a video_slug");
    }
    if (videoSlug) {
      const start = clipStart ?? 0;
      const ends = clipEnds ?? 0;
      if (!(ends > start) || ends - start >= 10) {
        warnings.push("Gemini Omni reference clip must satisfy video_clip_ends > video_clip_start and < start+10s");
      }
    }
  }

  if (toolName === "generate_seedance2_video" || toolName === "generate_seedance2_fast_video") {
    const audioSlugs = params.audio_slugs as string[] | undefined;
    const firstFrame = params.first_frame_slug as string | undefined;
    const lastFrame = params.last_frame_slug as string | undefined;
    const hasAudio = (audioSlugs?.filter(Boolean).length ?? 0) > 0;
    const hasFrame = !!firstFrame || !!lastFrame;
    if (hasAudio && hasFrame) {
      warnings.push("Seedance 2 does not support reference audio combined with first/last frame — pick one or the other");
    }
  }

  if (toolName === "generate_wan27_i2v_video") {
    const firstFrame = params.first_frame_slug as string | undefined;
    const lastFrame = params.last_frame_slug as string | undefined;
    const firstClip = params.first_clip_slug as string | undefined;
    if (!firstFrame && !lastFrame && !firstClip) {
      warnings.push("Wan 2.7 Image to Video needs at least first_frame_slug, last_frame_slug, or first_clip_slug");
    }
    if (firstClip && firstFrame && lastFrame) {
      warnings.push("Wan 2.7 Image to Video does not support first_clip combined with both first_frame and last_frame");
    }
  }

  if (toolName === "generate_wan27_videoedit_video") {
    const videoSlug = params.video_slug as string | undefined;
    if (!videoSlug) {
      warnings.push("Wan 2.7 Video Edit requires video_slug");
    }
  }

  if (toolName === "extend_wan27_video") {
    const videoSlug = params.video_slug as string | undefined;
    if (!videoSlug) {
      warnings.push("Wan 2.7 Extend requires video_slug");
    }
  }

  if (toolName === "generate_alibaba_video") {
    const firstFrame = params.first_frame_slug as string | undefined;
    const lastFrame = params.last_frame_slug as string | undefined;
    const firstClip = params.first_clip_slug as string | undefined;
    const drivingAudio = params.driving_audio_slug as string | undefined;
    const videoSlug = params.video_slug as string | undefined;
    if (!firstFrame && !lastFrame && !firstClip && !drivingAudio && !videoSlug) {
      warnings.push("Alibaba Video Synthesis requires at least one media input (first_frame_slug, last_frame_slug, first_clip_slug, driving_audio_slug, or video_slug)");
    }
  }

  const imageSlots = IMAGE_SLOT_OVERRIDES[toolName] ?? readSlotConstraints(IMAGE_FIELD_SCHEMAS[toolName]);

  const multiPromptSlots = toolName === "generate_kling30_video" ? 5 : null;

  return { valid: missing.length === 0, missing_required: missing, warnings, image_slots: imageSlots, multi_prompt_slots: multiPromptSlots };
}

// ---------------------------------------------------------------------------
// Tool constraints (mutative)
// ---------------------------------------------------------------------------

function applyVideoToolConstraints(
  toolName: string,
  schema: ToolSchema,
  params: Record<string, unknown>,
): void {
  void schema;
  if (toolName === "generate_grok_imagine_video") {
    if (params.mode === "spicy") params.mode = "normal";
    if (params.aspect_ratio === "auto") params.aspect_ratio = "16:9";
  }
}

// ---------------------------------------------------------------------------
// Routing prompt for GPT-4o-mini
// ---------------------------------------------------------------------------

const VIDEO_TOOL_NAMES = Object.values(VIDEO_MODELS).map((m) => m.tool_name);

function buildVideoRoutingPrompt(): string {
  const toolLines: string[] = [];
  for (const model of Object.values(VIDEO_MODELS)) {
    const paramStr = model.params.filter((p) => p !== "project_slug").join(", ");
    const defaults = getVideoToolSchema(model.tool_name)?.defaults ?? {};
    const defaultStr = Object.entries(defaults).map(([k, v]) => `${k}=${String(v)}`).join(", ");
    toolLines.push(`- ${model.tool_name}: ${model.description}`);
    toolLines.push(`  Parameters: ${paramStr}`);
    if (defaultStr) toolLines.push(`  Defaults: ${defaultStr}`);
  }

  return `You are a routing assistant for a video generation system.
You ONLY route to these video generation tools:

${toolLines.join("\n")}

Given a user query (possibly with @asset references), determine:
1. tool: Which tool to use (MUST be one of: ${VIDEO_TOOL_NAMES.join(", ")})
2. params: Parameters to pass to the tool

ROUTING PREFERENCES:
- PREFER generate_kling30_video as the DEFAULT for ALL video generation requests
- Use generate_grok_imagine_video ONLY when user explicitly mentions "grok" for video
- Use generate_seedance2_video when user mentions "seedance" or "bytedance" and wants 1080p, or just defaults to the higher-quality variant. Accepts any input combination: text-only, first/last frame, reference images/videos/audio
- Use generate_seedance2_fast_video when user mentions "seedance fast" or 480p/720p is acceptable (faster/cheaper). Same input flexibility as the full variant
- Use generate_seedance2_mini_video when user mentions "seedance mini". Text prompt plus optional reference images/videos/audio; no first/last frame; 480p/720p
- Use generate_gemini_omni_video ONLY when user explicitly mentions "gemini" or "omni" for video. Multimodal text prompt plus optional reference images (0-7) and one reference video clip with in/out timecodes
- Use generate_wan27_i2v_video ONLY when user mentions "wan" with first/last frame or clip continuation
- Use generate_wan27_videoedit_video ONLY when user mentions "wan" with video editing or modifying an existing video
- Use generate_wan27_r2v_video ONLY when user mentions "wan" with reference images, reference videos, or voice
- Use extend_wan27_video ONLY when user explicitly wants to extend an existing Wan 2.7 video
- Use extend_grok_imagine_video ONLY when user explicitly wants to extend an existing video with Grok Imagine
- Use generate_alibaba_video ONLY when user explicitly mentions "alibaba", "dashscope", or "qwen" for video generation
- Use generate_volcengine_lipsync_video ONLY when user explicitly mentions "volcengine" or wants to lip-sync / dub an existing video to a separate audio track
- Use generate_omnihuman_video ONLY when user explicitly mentions "omnihuman" or wants to animate a portrait/photo with a voice or audio track (talking/singing avatar from a still image)

KEY CONSTRAINTS:
- For generate_kling30_video: mode "std"/"pro", duration "3"-"15", aspect_ratio "16:9"/"9:16"/"1:1", sound boolean
- For generate_seedance2_video and generate_seedance2_fast_video: duration "4"-"15", aspect_ratio includes "adaptive"; full variant accepts "480p"/"720p"/"1080p", fast variant accepts "480p"/"720p" only. Inputs are all optional and free to mix: first_frame_slug, last_frame_slug, image_slugs (0-9), video_slugs (0-3, total ≤15s), audio_slugs (0-3, total ≤15s). Pure text prompt is fine too
- For generate_seedance2_mini_video: duration "4"-"15" (default 15), aspect_ratio includes "adaptive", resolution "480p"/"720p". No first/last frame; mix prompt with image_slugs, video_slugs (0-3, total ≤15s), audio_slugs (0-3, total ≤15s). Prompt is optional when references are supplied
- For generate_gemini_omni_video: REQUIRES prompt and duration "4"/"6"/"8"/"10"; aspect_ratio "16:9"/"9:16"; resolution "720p"/"1080p"/"4k" (default 720p); seed integer. Optional image_slugs (0-7) and one video_slug with video_clip_start/video_clip_ends (ends > start and < start+10s)
- For generate_grok_imagine_video: REQUIRES at least one image, mode "fun"/"normal", duration 6-30 (integer seconds), aspect_ratio "2:3"/"3:2"/"1:1"/"16:9"/"9:16"
- For extend_grok_imagine_video: REQUIRES video_slug, prompt, extend_at, and extend_times "6"/"10"
- For generate_wan27_i2v_video: REQUIRES at least one of first_frame_slug / last_frame_slug / first_clip_slug, duration "2"-"15", resolution "720p"/"1080p"
- For generate_wan27_videoedit_video: REQUIRES video_slug (source video must be ≤10s), optional image_slug for reference, duration "0" (full source) or "2"-"10", resolution "720p"/"1080p", audio_setting "auto"/"origin"
- For generate_wan27_r2v_video: max 5 combined image_slugs + video_slugs, duration "2"-"10", resolution "720p"/"1080p"
- For extend_wan27_video: REQUIRES video_slug and prompt, duration "2"-"15", resolution "720p"/"1080p"
- For generate_alibaba_video: REQUIRES at least one media input (first_frame_slug / last_frame_slug / first_clip_slug / driving_audio_slug / video_slug), resolution "720P"/"1080P", duration 2-15 (integer seconds), audio_setting "auto"/"origin"
- For generate_volcengine_lipsync_video: REQUIRES video_slug (source video) and audio_slug (driving audio); mode "lite"/"basic"
- For generate_omnihuman_video: REQUIRES image_slug (portrait) and audio_slug (driving audio ≤60s); output_resolution "720"/"1080", pe_fast_mode boolean, optional prompt

PROMPT FIELD: Do NOT include "prompt" in params. Only return tool selection and non-prompt parameters.
DO NOT include project_slug in params.

If the user's intent doesn't match a video generation tool, respond with:
{"tool": null, "params": {}, "error": "Query does not match a video generation tool"}

Respond with JSON only:
{"tool": "tool_name", "params": {"param1": "value1", ...}}`;
}

// ---------------------------------------------------------------------------
// Extract last-used settings per model from action log
// ---------------------------------------------------------------------------

type ActionLogEntry = {
  hash: string;
  action: string;
  payload: string | Record<string, unknown>;
  date: string;
};

function actionNameToToolName(action: string): string | null {
  if (!action.startsWith("tool-")) return null;
  const toolName = action.slice(5).replace(/-/g, "_");
  return Object.values(VIDEO_MODELS).some((m) => m.tool_name === toolName) ? toolName : null;
}

const NON_PARAM_KEYS = new Set(["project_slug"]);

function buildProvidersForModel(info: VideoModelInfo): ProviderRoute[] {
  if (!info.falToolNames) return info.providers;
  return [
    ...info.providers,
    { key: "fal", label: "Fal", provider_path: "fal.post.v1.queue.submit()", envKey: "FAL_API_KEY" },
  ];
}

function resolveFalVideoToolName(info: VideoModelInfo, imageSlugCount: number): string | null {
  const names = info.falToolNames;
  if (!names) return null;
  if (imageSlugCount > 0 && names.withRefs) return names.withRefs;
  if (imageSlugCount === 0 && names.noRefs) return names.noRefs;
  return names.withRefs ?? names.noRefs ?? null;
}

function extractLastSettingsPerModel(
  log: ActionLogEntry[],
): Map<string, Record<string, unknown>> {
  const result = new Map<string, Record<string, unknown>>();
  for (const entry of log) {
    const toolName = actionNameToToolName(entry.action);
    if (!toolName || result.has(toolName)) continue;
    if (typeof entry.payload === "string") continue;
    const params: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(entry.payload)) {
      if (!NON_PARAM_KEYS.has(k)) params[k] = v;
    }
    result.set(toolName, params);
  }
  return result;
}

/**
 * Return the model key of the most recently used video generation tool,
 * or null if the log contains no video tool entries.
 */
function extractLastUsedModel(log: ActionLogEntry[]): string | null {
  for (const entry of log) {
    const toolName = actionNameToToolName(entry.action);
    if (!toolName) continue;
    if (typeof entry.payload === "string") continue;
    for (const [key, info] of Object.entries(VIDEO_MODELS)) {
      if (info.tool_name === toolName) return key;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Model option builder
// ---------------------------------------------------------------------------

type ModelOption = {
  key: string;
  label: string;
  tool_name: string;
  description: string;
  schema: ToolSchema | null;
  prefilled_values: Record<string, unknown>;
  validation: ValidationResult;
  image_slots: SlotConstraints | null;
  multi_prompt_slots: number | null;
  providers: Array<{ key: string; label: string }>;
  selected_provider: string;
};

function filterInvalidSlugs(
  params: Record<string, unknown>,
  validTags: Set<string>,
): void {
  for (const [k, v] of Object.entries(params)) {
    if (k.endsWith("_slug") && typeof v === "string" && v.startsWith("@") && !validTags.has(v)) {
      params[k] = "";
    }
    if (k.endsWith("_slugs") && Array.isArray(v)) {
      params[k] = v.filter(
        (s) => typeof s === "string" && (!s.startsWith("@") || validTags.has(s)),
      );
    }
  }
}

function buildModelOption(
  modelKey: string,
  modelInfo: VideoModelInfo,
  baseParams: Record<string, unknown>,
  resolvedAssets: ResolvedAsset[],
  historyEntries?: ActionLogEntry[],
  providerOverride?: string,
  projectAssetTags?: Set<string>,
): ModelOption {
  const toolName = modelInfo.tool_name;
  // Only carry over base params that belong to this model's param list
  const allowedParams = new Set(modelInfo.params);
  const params: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(baseParams)) {
    if (allowedParams.has(k)) params[k] = v;
  }

  // Prefill from most recent historical usage of this tool —
  // historical settings OVERRIDE router params so the user's last-used
  // settings persist as defaults across sessions.
  let historicalProvider: string | undefined;
  if (historyEntries) {
    const settingsMap = extractLastSettingsPerModel(historyEntries);
    const historical = settingsMap.get(toolName);
    if (historical) {
      historicalProvider = historical._provider as string | undefined;
      for (const [k, v] of Object.entries(historical)) {
        if (allowedParams.has(k)) {
          params[k] = v;
        }
      }
    }
  }

  // Fill image_slugs from resolved assets
  const imageTags = resolvedAssets
    .filter((a) => a.asset_type === "image" && a.file_path)
    .map((a) => a.tag);
  params.image_slugs = imageTags.length > 0 ? imageTags : [];

  // Ensure Kling 3.0 element/multi-shot defaults
  if (toolName === "generate_kling30_video") {
    for (let slot = 1; slot <= 3; slot++) {
      params[`element${slot}_slugs`] ??= [];
      params[`element${slot}_name`] ??= "";
      params[`element${slot}_desc`] ??= "";
    }
    params.multi_prompt ??= [];
    params.multi_shots ??= false;
  }

  // For video extension tools, prefill video_slug from video assets
  if (toolName === "extend_grok_imagine_video" || toolName === "extend_wan27_video") {
    const videoAssets = resolvedAssets.filter((a) => a.asset_type === "video");
    if (videoAssets.length > 0) {
      params.video_slug = videoAssets[0].tag;
    }
  }

  // For Alibaba video, prefill first_frame_slug from image assets
  if (toolName === "generate_alibaba_video") {
    const imageAssets = resolvedAssets.filter((a) => a.asset_type === "image" && a.file_path);
    if (imageAssets.length > 0) {
      params.first_frame_slug ??= imageAssets[0].tag;
    }
  }

  // For OmniHuman, prefill the portrait from image assets and the driving
  // track from audio assets so the panel is immediately runnable.
  if (toolName === "generate_omnihuman_video") {
    const imageAssets = resolvedAssets.filter((a) => a.asset_type === "image" && a.file_path);
    if (imageAssets.length > 0) {
      params.image_slug ??= imageAssets[0].tag;
    }
    const audioAssets = resolvedAssets.filter((a) => a.asset_type === "audio");
    if (audioAssets.length > 0) {
      params.audio_slug ??= audioAssets[0].tag;
    }
  }

  const schema = getVideoToolSchema(toolName);

  // Apply model defaults where not already set
  for (const [k, v] of Object.entries(schema?.defaults ?? {})) {
    params[k] ??= v;
  }

  // Strip slug references that don't exist in the current project
  if (projectAssetTags) {
    filterInvalidSlugs(params, projectAssetTags);
  }

  // Coerce numeric values to strings for params with string enums
  if (schema) {
    for (const [k, v] of Object.entries(params)) {
      const prop = schema.properties[k];
      if (prop?.type === "string" && prop.enum && typeof v === "number") {
        params[k] = String(v);
      }
    }
    applyVideoToolConstraints(toolName, schema, params);
  }

  const validation = validateVideoParams(toolName, params);

  // Filter providers to those with available API keys
  const allProviders = buildProvidersForModel(modelInfo);
  const availableProviders = allProviders.filter((p) => process.env[p.envKey]);
  const providerList = availableProviders.length > 0 ? availableProviders : allProviders;
  const selectedProvider = (providerOverride && providerList.some((p) => p.key === providerOverride))
    ? providerOverride
    : (historicalProvider && providerList.some((p) => p.key === historicalProvider))
      ? historicalProvider
      : providerList[0].key;

  let effectiveToolName = toolName;
  if (selectedProvider === "fal") {
    const slugCount = Array.isArray(params.image_slugs)
      ? (params.image_slugs as unknown[]).length
      : (typeof params.first_frame_slug === "string" && params.first_frame_slug !== "" ? 1 : 0);
    const falName = resolveFalVideoToolName(modelInfo, slugCount);
    if (falName) effectiveToolName = falName;
  }

  return {
    key: modelKey,
    label: modelInfo.label,
    tool_name: effectiveToolName,
    description: modelInfo.description,
    schema,
    prefilled_values: params,
    validation,
    image_slots: validation.image_slots,
    multi_prompt_slots: validation.multi_prompt_slots,
    providers: providerList.map((p) => ({ key: p.key, label: p.label })),
    selected_provider: selectedProvider,
  };
}

export {
  VIDEO_MODELS,
  IMAGE_FIELD_SCHEMAS,
  PARAM_SCHEMAS,
  getVideoToolSchema,
  validateVideoParams,
  applyVideoToolConstraints,
  buildVideoRoutingPrompt,
  buildModelOption,
  extractLastSettingsPerModel,
  extractLastUsedModel,
};
export type { VideoModelInfo, ToolSchema, ValidationResult, ModelOption, ActionLogEntry, ProviderRoute };
