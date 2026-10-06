/**
 * Video model registry, schemas, validation, and routing prompt.
 */
import type { ResolvedArtifactRef } from "./artifact-refs.js";
import { geminiOmniClipInputError } from "./gemini-omni-clip.js";
import { seedance25FrameAspectRatio, SEEDANCE25_FRAME_ASPECT_DESCRIPTION } from "./seedance25.js";
import {
  GrokImageToVideoRequestSchema,
  GrokTextToVideoRequestSchema,
  GrokVideoExtendRequestSchema,
  GrokImagineModeSchema,
  KlingMotionControlRequestSchema,
  KlingOmniImageToVideoInputSchema,
  KlingOmniReferenceToVideoInputSchema,
  KlingOmniTextToVideoInputSchema,
  KlingOmniTransformationInputSchema,
  Seedance25InputSchema,
  HappyHorseDurationSchema,
  HappyHorse11ImageToVideoRequestSchema,
  HappyHorse11ReferenceToVideoRequestSchema,
  HappyHorse11TextToVideoRequestSchema,
  HappyHorseVideoEditRequestSchema,
  MiniMaxH3DurationSchema,
  MiniMaxH3ImageToVideoRequestSchema,
  MiniMaxH3ReferenceToVideoRequestSchema,
  MiniMaxH3TextToVideoRequestSchema,
  VolcengineVideoToVideoLipSyncRequestSchema,
  Omnihuman15RequestSchema,
  GeminiOmniVideoRequestSchema,
  VeoGenerateRequestSchema,
  Wan30VideoPrimeRequestSchema,
  Wan30VideoRequestSchema,
} from "@apicity/kie/zod";
import { XaiVideoGenerateRequestSchema } from "@apicity/xai/zod";
import {
  FalWan3p0ImageToVideoRequestSchema,
  FalWan3p0TextToVideoRequestSchema,
  FalXaiGrokImagineVideoExtendVideoRequestSchema,
  FalXaiGrokImagineVideoReferenceToVideoRequestSchema,
  FalXaiGrokImagineVideoEditVideoRequestSchema,
} from "@apicity/fal/zod";
import {
  readSlotConstraints,
  enumOptions,
  zodDefault,
  zodEnumOptionsOrNull,
  zodFiniteNumberOptions,
  zodIsRequired,
  zodNumberRange,
  zodStringMaxLength,
  zodStringMinLength,
  zodUnionEnumOptions,
  type SlotConstraints,
} from "./zod-slots.js";
import { totalOmniReferenceSlots } from "./google-flow-refs.js";
import { grokImagine1080pImageCountError } from "./grok-imagine-video-contract.js";
import { getCanonicalName, isGenerationAction } from "./generation-registry.js";
import {
  APICITY_014_VIDEO_IMAGE_FIELDS,
  APICITY_014_VIDEO_MODELS,
  APICITY_014_VIDEO_PARAM_ZOD,
} from "./apicity-014-media.js";
import {
  isKlingOmniTool,
  KLING_OMNI_IMAGE_TO_VIDEO_TOOL,
  KLING_OMNI_REFERENCE_TO_VIDEO_TOOL,
  KLING_OMNI_TEXT_TO_VIDEO_TOOL,
  KLING_OMNI_TOOL_PARAMS,
  KLING_OMNI_TOOLS,
  KLING_OMNI_TRANSFORMATION_TOOL,
  klingOmniToolForParams,
} from "./kling-omni.js";

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
  /** When set, exposes "google" (Google Flow via useapi.net) as a provider
   *  option; selecting it swaps the effective tool to this name. */
  googleToolName?: string;
};

const VIDEO_MODELS: Record<string, VideoModelInfo> = {
  kling30: {
    label: "Kling 3.0 Omni",
    tool_name: KLING_OMNI_TEXT_TO_VIDEO_TOOL,
    description: "Kling 3.0 Omni text, image, reference, and transformation video at 720p, 1080p, or 4k",
    params: [
      "prompt", "image_refs", "video_refs",
      "audio", "resolution", "aspect_ratio", "duration",
      "customize_multi_shots", "prefer_multi_shots", "multi_prompt",
    ],
    defaults: {},
    providers: [
      { key: "kie", label: "Kie", provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", envKey: "KIE_API_KEY" },
    ],
  },
  kling30_motion_control: {
    label: "Kling 3.0 Motion Control",
    tool_name: "generate_kie_kling_3_0_motion_control",
    description: "Apply motion from reference videos to character images using Kling 3.0 motion-control",
    params: [
      "prompt", "character_image_refs", "motion_video_refs",
      "mode", "character_orientation", "background_source",
    ],
    defaults: {},
    providers: [
      { key: "kie", label: "Kie", provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", envKey: "KIE_API_KEY" },
    ],
  },
  seedance25: {
    label: "Seedance 2.5",
    tool_name: "generate_kie_seedance_2_5_video",
    description: "ByteDance Seedance 2.5 — text, first/last-frame, or multimodal reference-to-video with up to 30-second output and synchronized audio",
    params: [
      "prompt",
      "first_frame_ref", "last_frame_ref",
      "image_refs", "video_refs", "audio_refs",
      "return_last_frame", "generate_audio",
      "resolution", "aspect_ratio", "duration", "output_format",
      "web_search", "nsfw_checker",
    ],
    defaults: {},
    providers: [
      { key: "kie", label: "Kie", provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", envKey: "KIE_API_KEY" },
    ],
  },
  gemini_omni: {
    label: "Gemini Omni Video",
    tool_name: "generate_kie_gemini_omni_video",
    description: "Google Gemini Omni — multimodal text/image/clip-to-video. A prompt plus optional reference images (0-7) and one reference video clip with in/out timecodes",
    params: [
      "prompt",
      "image_refs", "video_ref", "video_clip_start", "video_clip_ends",
      "duration", "aspect_ratio", "resolution", "seed",
    ],
    defaults: {},
    providers: [
      { key: "kie", label: "Kie", provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", envKey: "KIE_API_KEY" },
    ],
    googleToolName: "generate_google_flow_omni_flash_video",
  },
  veo3: {
    label: "Veo 3",
    tool_name: "generate_kie_veo_3_0_video",
    description: "Google Veo 3 — text-to-video or image-to-video from reference images (kie veo namespace)",
    params: ["prompt", "image_refs", "aspect_ratio", "seed"],
    defaults: {},
    providers: [
      { key: "kie", label: "Kie", provider_path: "kie.veo.post.api.v1.veo.generate(request, { otp })", envKey: "KIE_API_KEY" },
    ],
  },
  veo3_fast: {
    label: "Veo 3 Fast",
    tool_name: "generate_kie_veo_3_0_fast_video",
    description: "Google Veo 3 Fast — text-to-video or image-to-video from reference images (kie veo namespace)",
    params: ["prompt", "image_refs", "aspect_ratio", "seed"],
    defaults: {},
    providers: [
      { key: "kie", label: "Kie", provider_path: "kie.veo.post.api.v1.veo.generate(request, { otp })", envKey: "KIE_API_KEY" },
    ],
  },
  veo31: {
    label: "Veo 3.1",
    tool_name: "generate_google_flow_veo_3_1_quality_video",
    description: "Google Veo 3.1 quality tier — text-to-video or image-to-video from start/end frames, 8s output (Google Flow)",
    params: ["prompt", "first_frame_ref", "last_frame_ref", "aspect_ratio", "seed"],
    defaults: {},
    providers: [
      { key: "google", label: "Google Flow", provider_path: "googleflow.v1.videos({ async: true })", envKey: "GOOGLE_FLOW_API_KEY" },
    ],
  },
  veo31_fast: {
    label: "Veo 3.1 Fast",
    tool_name: "generate_google_flow_veo_3_1_fast_video",
    description: "Google Veo 3.1 Fast — text-to-video, start/end-frame image-to-video, or reference images (Google Flow)",
    params: ["prompt", "first_frame_ref", "last_frame_ref", "image_refs", "aspect_ratio", "duration", "seed"],
    defaults: {},
    providers: [
      { key: "google", label: "Google Flow", provider_path: "googleflow.v1.videos({ async: true })", envKey: "GOOGLE_FLOW_API_KEY" },
    ],
  },
  veo31_lite: {
    label: "Veo 3.1 Lite",
    tool_name: "generate_google_flow_veo_3_1_lite_video",
    description: "Google Veo 3.1 Lite — cheapest Veo 3.1 tier: text-to-video, start/end frames, or reference images (Google Flow)",
    params: ["prompt", "first_frame_ref", "last_frame_ref", "image_refs", "aspect_ratio", "duration", "seed"],
    defaults: {},
    providers: [
      { key: "google", label: "Google Flow", provider_path: "googleflow.v1.videos({ async: true })", envKey: "GOOGLE_FLOW_API_KEY" },
    ],
  },
  veo31_lite_low_priority: {
    label: "Veo 3.1 Lite LP",
    tool_name: "generate_google_flow_veo_3_1_lite_low_priority_video",
    description: "Google Veo 3.1 Lite Lower Priority — Ultra $199 only, 0 credits, lower queue priority (Google Flow)",
    params: ["prompt", "first_frame_ref", "last_frame_ref", "image_refs", "aspect_ratio", "duration", "seed"],
    defaults: {},
    providers: [
      { key: "google", label: "Google Flow", provider_path: "googleflow.v1.videos({ async: true })", envKey: "GOOGLE_FLOW_API_KEY" },
    ],
  },
  grok_imagine: {
    label: "Grok Imagine 1.5 — Kie",
    tool_name: "generate_kie_grok_imagine_image_to_video",
    description: "Kie Grok Imagine Video 1.5 image-to-video",
    params: ["prompt", "image_refs", "mode", "duration", "resolution", "aspect_ratio", "nsfw_checker"],
    defaults: {},
    providers: [
      { key: "kie", label: "Kie", provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", envKey: "KIE_API_KEY" },
    ],
    falToolNames: { noRefs: "generate_fal_grok_imagine_video_image_to_video", withRefs: "generate_fal_grok_imagine_video_image_to_video" },
  },
  grok_imagine_t2v: {
    label: "Grok Imagine — Text",
    tool_name: "generate_kie_grok_imagine_text_to_video",
    description: "Grok Imagine text-to-video (no reference images, kie)",
    params: ["prompt", "mode", "duration", "resolution", "aspect_ratio", "nsfw_checker"],
    defaults: {},
    providers: [
      { key: "kie", label: "Kie", provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", envKey: "KIE_API_KEY" },
    ],
  },
  grok_imagine_ref: {
    label: "Grok Imagine Reference",
    tool_name: "generate_xai_grok_imagine_video",
    description: "Video generation guided by reference images (0-7 optional)",
    params: ["prompt", "image_refs", "duration", "resolution", "aspect_ratio"],
    defaults: {},
    providers: [
      { key: "xai", label: "xAI", provider_path: "xai.post.v1.videos.generations(request, { otp })", envKey: "XAI_API_KEY" },
    ],
    falToolNames: { withRefs: "generate_fal_grok_imagine_video_reference_to_video" },
  },
  grok_imagine_extend: {
    label: "Grok Imagine Extend",
    tool_name: "extend_kie_grok_imagine_video",
    description: "Extend an existing video into a longer video using Grok Imagine",
    params: ["video_ref", "prompt", "extend_at", "extend_times", "duration"],
    defaults: {},
    providers: [
      { key: "kie", label: "Kie", provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", envKey: "KIE_API_KEY" },
    ],
    falToolNames: { withRefs: "extend_fal_grok_imagine_video" },
  },
  happyhorse_t2v: {
    label: "HappyHorse 1.1 — Text",
    tool_name: "generate_kie_happyhorse_1_1_text_to_video",
    description: "HappyHorse 1.1 text-to-video (kie)",
    params: ["prompt", "resolution", "aspect_ratio", "duration"],
    defaults: {},
    providers: [
      { key: "kie", label: "Kie", provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", envKey: "KIE_API_KEY" },
    ],
  },
  happyhorse_i2v: {
    label: "HappyHorse 1.1 — First Frame",
    tool_name: "generate_kie_happyhorse_1_1_image_to_video",
    description: "HappyHorse 1.1 image-to-video from a single first-frame image (kie)",
    params: ["prompt", "first_frame_ref", "resolution", "duration"],
    defaults: {},
    providers: [
      { key: "kie", label: "Kie", provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", envKey: "KIE_API_KEY" },
    ],
  },
  happyhorse_ref: {
    label: "HappyHorse 1.1 — Reference",
    tool_name: "generate_kie_happyhorse_1_1_reference_to_video",
    description: "HappyHorse 1.1 reference-to-video for multi-character scenes (1-9 reference images)",
    params: ["prompt", "image_refs", "resolution", "aspect_ratio", "duration"],
    defaults: {},
    providers: [
      { key: "kie", label: "Kie", provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", envKey: "KIE_API_KEY" },
    ],
  },
  happyhorse_videoedit: {
    label: "HappyHorse — Video Edit",
    tool_name: "generate_kie_happyhorse_1_1_edit_video",
    description: "HappyHorse video editing with optional reference images for character/style guidance (kie)",
    params: ["prompt", "video_ref", "image_refs", "resolution", "audio_setting", "seed"],
    defaults: {},
    providers: [
      { key: "kie", label: "Kie", provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", envKey: "KIE_API_KEY" },
    ],
  },
  minimax_h3_t2v: {
    label: "MiniMax H3 — Text",
    tool_name: "generate_kie_minimax_h3_text_to_video",
    description: "MiniMax H3 text-to-video (kie)",
    params: ["prompt", "aspect_ratio", "duration", "resolution"],
    defaults: {},
    providers: [
      { key: "kie", label: "Kie", provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", envKey: "KIE_API_KEY" },
    ],
  },
  minimax_h3_i2v: {
    label: "MiniMax H3 — Frames",
    tool_name: "generate_kie_minimax_h3_image_to_video",
    description: "MiniMax H3 image-to-video from a first and/or last frame (kie)",
    params: ["prompt", "first_frame_ref", "last_frame_ref", "duration", "resolution"],
    defaults: {},
    providers: [
      { key: "kie", label: "Kie", provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", envKey: "KIE_API_KEY" },
    ],
  },
  minimax_h3_r2v: {
    label: "MiniMax H3 — Reference",
    tool_name: "generate_kie_minimax_h3_reference_to_video",
    description: "MiniMax H3 reference-to-video with image, video, and/or audio references (kie)",
    params: ["prompt", "image_refs", "video_refs", "audio_refs", "aspect_ratio", "duration", "resolution"],
    defaults: {},
    providers: [
      { key: "kie", label: "Kie", provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", envKey: "KIE_API_KEY" },
    ],
  },
  volcengine_lipsync: {
    label: "Volcengine Lip-Sync",
    tool_name: "generate_kie_volcengine_video_to_video_lip_sync",
    description: "Volcengine video-to-video lip-sync — drive a source video's lips from a separate audio track (kie)",
    params: [
      "video_ref", "audio_ref", "mode",
      "separate_vocal", "open_scenedet", "align_audio", "align_audio_reverse", "templ_start_seconds",
    ],
    defaults: {},
    providers: [
      { key: "kie", label: "Kie", provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", envKey: "KIE_API_KEY" },
    ],
  },
  omnihuman: {
    label: "OmniHuman 1.5",
    tool_name: "generate_kie_omnihuman_1_5_video",
    description: "ByteDance OmniHuman 1.5 — animate a portrait image with a driving audio track into a talking/singing avatar video (kie)",
    params: ["image_ref", "audio_ref", "prompt", "output_resolution", "pe_fast_mode", "seed"],
    defaults: {},
    providers: [
      { key: "kie", label: "Kie", provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", envKey: "KIE_API_KEY" },
    ],
  },
  grok_imagine_r2v_fal: {
    label: "Grok Imagine — Reference (fal)",
    tool_name: "generate_fal_grok_imagine_video_reference_to_video",
    description: "xAI Grok Imagine reference-to-video via fal.ai",
    params: ["prompt", "image_refs", "duration", "aspect_ratio", "resolution"],
    defaults: {},
    providers: [],
    falToolNames: { noRefs: "generate_fal_grok_imagine_video_reference_to_video", withRefs: "generate_fal_grok_imagine_video_reference_to_video" },
  },
  grok_imagine_extend_fal: {
    label: "Grok Imagine — Extend (fal)",
    tool_name: "extend_fal_grok_imagine_video",
    description: "xAI Grok Imagine extend-video via fal.ai, continues an existing video",
    params: ["prompt", "video_ref", "duration"],
    defaults: {},
    providers: [],
    falToolNames: { noRefs: "extend_fal_grok_imagine_video", withRefs: "extend_fal_grok_imagine_video" },
  },
  grok_imagine_edit_fal: {
    label: "Grok Imagine — Video Edit (fal)",
    tool_name: "generate_fal_grok_imagine_video_edit_video",
    description: "xAI Grok Imagine edit-video via fal.ai, re-renders a source video",
    params: ["prompt", "video_ref", "resolution"],
    defaults: {},
    providers: [],
    falToolNames: { noRefs: "generate_fal_grok_imagine_video_edit_video", withRefs: "generate_fal_grok_imagine_video_edit_video" },
  },
  wan30: {
    label: "Wan 3.0",
    tool_name: "generate_kie_wan_3_0_video",
    description: "Alibaba Wan 3.0 — text-to-video, first/last-frame, or reference-to-video with image, video, and audio references (kie)",
    params: [
      "prompt", "first_frame_ref", "last_frame_ref",
      "image_refs", "video_refs", "audio_refs",
      "resolution", "aspect_ratio", "duration",
      "audio", "seed", "nsfw_checker",
    ],
    defaults: {},
    providers: [
      { key: "kie", label: "Kie", provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", envKey: "KIE_API_KEY" },
    ],
    falToolNames: { noRefs: "generate_fal_wan_3_0_text_to_video", withRefs: "generate_fal_wan_3_0_image_to_video" },
  },
  wan30_prime: {
    label: "Wan 3.0 Prime",
    tool_name: "generate_kie_wan_3_0_prime_video",
    description: "Alibaba Wan 3.0 Prime (high-speed tier) — text-to-video, first/last-frame, or reference-to-video with image, video, and audio references (kie)",
    params: [
      "prompt", "first_frame_ref", "last_frame_ref",
      "image_refs", "video_refs", "audio_refs",
      "resolution", "aspect_ratio", "duration",
      "audio", "seed", "nsfw_checker",
    ],
    defaults: {},
    providers: [
      { key: "kie", label: "Kie", provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })", envKey: "KIE_API_KEY" },
    ],
    falToolNames: { noRefs: "generate_fal_wan_3_0_prime_text_to_video", withRefs: "generate_fal_wan_3_0_prime_image_to_video" },
  },
  ...APICITY_014_VIDEO_MODELS,
};

const DEFAULT_VIDEO_MODEL_KEY = "seedance25";

// Google Flow provider aliases: a base video tool can expose a "google"
// provider (see VideoModelInfo.googleToolName) whose effective tool name and
// param surface differ from the base. These aliases let getVideoToolSchema,
// validateVideoParams, history extraction, and buildModelOption treat the
// google tool name as a first-class entry while routing/selection still keys
// off the single base model.
const GOOGLE_VIDEO_ALIASES: Record<string, string> = {
  generate_google_flow_omni_flash_video: "generate_kie_gemini_omni_video",
};

// Google Omni ("Omni Flash") drops the Kie-only `resolution` and adds an I2V
// `first_frame_ref` (mapped to the provider's startImage) ahead of the
// reference images. R2V reference images cap at 7 (5 alongside a clip).
const GOOGLE_VIDEO_PARAMS: Record<string, readonly string[]> = {
  generate_google_flow_omni_flash_video: [
    "prompt",
    "first_frame_ref",
    "image_refs", "video_ref", "video_clip_start", "video_clip_ends",
    "voice_refs", "character_refs",
    "duration", "aspect_ratio", "seed",
  ],
};

const GOOGLE_OMNI_DURATIONS = ["4", "6", "8", "10"];
const GOOGLE_OMNI_ASPECT_RATIOS = ["16:9", "9:16"];

// ---------------------------------------------------------------------------
// Generation modes — a server-defined, client-generic contract that lets one
// tool expose several mutually-exclusive input modes as UI tabs. Delivered as
// optional data on ModelOption; only tools listed in VIDEO_TOOL_MODES ship
// modes, and the client renders exactly as before for every option without
// them. This encodes a tool's exclusivity matrix STRUCTURALLY (params that
// can't co-exist never share a mode) instead of policing it with warnings.
//
// Params not owned by any mode's `params` come from `shared_params` (visible
// in every mode). `asset_slots` carry the slot metadata the client would
// otherwise infer from field-name heuristics; `param_overrides` express
// per-mode budget/description tweaks (e.g. tighter caps alongside a clip).

// ---------------------------------------------------------------------------

type ModeAssetSlotKind = "image" | "video" | "audio";

type ModeAssetSlot = {
  param: string;
  kind: ModeAssetSlotKind;
  label: string;
  min?: number;
  max?: number | null;
};

type ModeSpec = {
  key: string;
  label: string;
  description?: string;
  /** Mode-owned params, beyond the shared set. Only these drive mode
   *  inference, so keep pure settings (duration, seed) in shared_params. */
  params: string[];
  /** Shared params suppressed in this mode (e.g. duration in a V2V edit,
   *  whose output length is fixed by the clip window). */
  hidden_shared_params?: string[];
  required?: string[];
  asset_slots?: ModeAssetSlot[];
  param_overrides?: Record<string, { maxItems?: number; description?: string }>;
  tool_name?: string;
};

type ModelModes = {
  shared_params: string[];
  default_mode: string;
  modes: ModeSpec[];
};

// Keyed by EFFECTIVE tool name. Google Omni's four modes mirror the
// exclusivity matrix in tools/generate-google-omni-video.ts: first_frame_ref
// (I2V) never shares a tab with reference images, a clip, or characters;
// duration is absent from "edit" (the builder derives output length from the
// clip window); voice_refs is legal in every mode (shared) but capped at 3
// alongside a clip; image_refs caps at 7 for pure references and 5 alongside
// a clip. The kie sibling generate_kie_gemini_omni_video is deliberately NOT here
// (it legally combines image_refs + a clip, which tabs would misrepresent).
const SEEDANCE25_SHARED_PARAMS = [
  "prompt", "return_last_frame", "generate_audio",
  "resolution", "aspect_ratio", "duration", "output_format",
  "web_search", "nsfw_checker",
];

const SEEDANCE25_REFS_MODE: ModeSpec = {
  key: "refs",
  label: "refs",
  description: "Reference images (≤30), videos (≤10), and/or audio (≤10)",
  params: ["image_refs", "video_refs", "audio_refs"],
  asset_slots: [
    { param: "image_refs", kind: "image", label: "Images", min: 0, max: 30 },
    { param: "video_refs", kind: "video", label: "Videos", min: 0, max: 10 },
    { param: "audio_refs", kind: "audio", label: "Audio", min: 0, max: 10 },
  ],
};

const SEEDANCE25_MODES: ModelModes = {
  shared_params: SEEDANCE25_SHARED_PARAMS,
  default_mode: "text",
  modes: [
    {
      key: "text",
      label: "text",
      description: "Prompt-only generation",
      params: [],
    },
    {
      key: "frames",
      label: "frames",
      description: `Animate from a first frame and optional last frame. ${SEEDANCE25_FRAME_ASPECT_DESCRIPTION}`,
      params: ["first_frame_ref", "last_frame_ref"],
      hidden_shared_params: ["aspect_ratio"],
      asset_slots: [
        { param: "first_frame_ref", kind: "image", label: "First Frame" },
        { param: "last_frame_ref", kind: "image", label: "Last Frame" },
      ],
    },
    SEEDANCE25_REFS_MODE,
  ],
};

const KLING_OMNI_MODES: ModelModes = {
  shared_params: [
    "prompt", "audio", "resolution", "aspect_ratio", "duration",
    "customize_multi_shots", "prefer_multi_shots", "multi_prompt",
  ],
  default_mode: "text",
  modes: [
    {
      key: "text",
      label: "text",
      description: "Prompt-only generation",
      params: [],
      tool_name: KLING_OMNI_TEXT_TO_VIDEO_TOOL,
    },
    {
      key: "image",
      label: "image",
      description: "Animate a first frame, or first and last frames",
      params: ["image_refs"],
      required: ["image_refs"],
      tool_name: KLING_OMNI_IMAGE_TO_VIDEO_TOOL,
      asset_slots: [
        { param: "image_refs", kind: "image", label: "Frames", min: 1, max: 2 },
      ],
    },
    {
      key: "reference",
      label: "reference",
      description: "Guide with reference images and/or one reference video",
      params: ["image_refs", "video_refs"],
      tool_name: KLING_OMNI_REFERENCE_TO_VIDEO_TOOL,
      asset_slots: [
        { param: "image_refs", kind: "image", label: "Images", min: 0, max: 7 },
        { param: "video_refs", kind: "video", label: "Video", min: 0, max: 1 },
      ],
    },
    {
      key: "transformation",
      label: "transformation",
      description: "Transfer motion from a source video onto optional character images",
      params: ["image_refs", "video_refs"],
      required: ["video_refs"],
      tool_name: KLING_OMNI_TRANSFORMATION_TOOL,
      hidden_shared_params: ["customize_multi_shots", "prefer_multi_shots", "multi_prompt"],
      asset_slots: [
        { param: "image_refs", kind: "image", label: "Images", min: 0, max: 4 },
        { param: "video_refs", kind: "video", label: "Motion", min: 1, max: 1 },
      ],
    },
  ],
};

const VIDEO_TOOL_MODES: Record<string, ModelModes> = {
  generate_google_flow_omni_flash_video: {
    shared_params: ["prompt", "aspect_ratio", "seed", "voice_refs", "duration"],
    default_mode: "t2v",
    modes: [
      {
        key: "t2v",
        label: "text",
        description: "Prompt-only generation",
        params: [],
      },
      {
        key: "i2v",
        label: "first-frame",
        description: "Animate a start image (no references, characters, or clip)",
        params: ["first_frame_ref"],
        required: ["first_frame_ref"],
        asset_slots: [{ param: "first_frame_ref", kind: "image", label: "First Frame" }],
      },
      {
        key: "r2v",
        label: "refs",
        description: "Guide with reference images and characters (7-slot shared budget; a character costs 2 slots)",
        params: ["image_refs", "character_refs"],
        asset_slots: [{ param: "image_refs", kind: "image", label: "References", min: 0, max: 7 }],
      },
      {
        key: "edit",
        label: "video-edit",
        description: "Re-render or extend a source clip window (output length = the clip window)",
        params: ["video_ref", "video_clip_start", "video_clip_ends", "image_refs", "character_refs"],
        hidden_shared_params: ["duration"],
        required: ["video_ref"],
        asset_slots: [
          { param: "video_ref", kind: "video", label: "Source Clip" },
          { param: "image_refs", kind: "image", label: "References", min: 0, max: 5 },
        ],
        param_overrides: { voice_refs: { maxItems: 3, description: "Up to 3 voice refs alongside a clip" } },
      },
    ],
  },
  generate_kie_seedance_2_5_video: SEEDANCE25_MODES,
  [KLING_OMNI_TEXT_TO_VIDEO_TOOL]: KLING_OMNI_MODES,
};

// ---------------------------------------------------------------------------
// Image slot schemas — source of truth is the Apicity Zod request schema.
// Tools absent from this map have no image-array field; their `image_slots`
// resolves to null and the UI omits the /images panel.
// ---------------------------------------------------------------------------

type ZodLike = { _def?: unknown; unwrap?: () => unknown };

const IMAGE_FIELD_SCHEMAS: Record<string, ZodLike> = {
  [KLING_OMNI_IMAGE_TO_VIDEO_TOOL]: KlingOmniImageToVideoInputSchema.shape.image_urls,
  [KLING_OMNI_REFERENCE_TO_VIDEO_TOOL]: KlingOmniReferenceToVideoInputSchema.shape.image_urls,
  [KLING_OMNI_TRANSFORMATION_TOOL]: KlingOmniTransformationInputSchema.shape.image_urls,
  generate_kie_kling_3_0_motion_control: KlingMotionControlRequestSchema.shape.input.shape.input_urls,
  generate_kie_seedance_2_5_video: Seedance25InputSchema.shape.reference_image_urls,
  generate_kie_gemini_omni_video: GeminiOmniVideoRequestSchema.shape.input.shape.image_urls,
  generate_kie_grok_imagine_image_to_video: GrokImageToVideoRequestSchema.shape.input.shape.image_urls,
  generate_kie_veo_3_0_video: VeoGenerateRequestSchema.shape.imageUrls,
  generate_kie_veo_3_0_fast_video: VeoGenerateRequestSchema.shape.imageUrls,

  generate_xai_grok_imagine_video: XaiVideoGenerateRequestSchema.shape.reference_images,
  generate_kie_happyhorse_1_1_reference_to_video: HappyHorse11ReferenceToVideoRequestSchema.shape.input.shape.reference_image,
  generate_kie_minimax_h3_reference_to_video: MiniMaxH3ReferenceToVideoRequestSchema.shape.input.shape.reference_image_urls,
  ...APICITY_014_VIDEO_IMAGE_FIELDS,
};

const IMAGE_SLOT_OVERRIDES: Record<string, SlotConstraints> = {
  generate_kie_grok_imagine_image_to_video: { min: 1, max: 7 },
  generate_xai_grok_imagine_video: { min: 0, max: 7 },
  // Google Flow veo 3.1 reference slots are positional referenceImage_1..3
  // keys with no array field in @apicity/googleflow to read (gaps doc §14).
  generate_google_flow_omni_flash_video: { min: 0, max: 7 },
  generate_google_flow_veo_3_1_fast_video: { min: 0, max: 3 },
  generate_google_flow_veo_3_1_lite_video: { min: 0, max: 3 },
  generate_google_flow_veo_3_1_lite_low_priority_video: { min: 0, max: 3 },
};

const VIDEO_PARAM_ZOD_SCHEMAS: Record<string, Record<string, ZodLike>> = {
  [KLING_OMNI_TEXT_TO_VIDEO_TOOL]: {
    prompt: KlingOmniTextToVideoInputSchema.shape.prompt,
    audio: KlingOmniTextToVideoInputSchema.shape.audio,
    resolution: KlingOmniTextToVideoInputSchema.shape.resolution,
    aspect_ratio: KlingOmniTextToVideoInputSchema.shape.aspect_ratio,
    duration: KlingOmniTextToVideoInputSchema.shape.duration,
    customize_multi_shots: KlingOmniTextToVideoInputSchema.shape.customize_multi_shots,
    prefer_multi_shots: KlingOmniTextToVideoInputSchema.shape.prefer_multi_shots,
    multi_prompt: KlingOmniTextToVideoInputSchema.shape.multi_prompt,
  },
  [KLING_OMNI_IMAGE_TO_VIDEO_TOOL]: {
    prompt: KlingOmniImageToVideoInputSchema.shape.prompt,
    image_refs: KlingOmniImageToVideoInputSchema.shape.image_urls,
    audio: KlingOmniImageToVideoInputSchema.shape.audio,
    resolution: KlingOmniImageToVideoInputSchema.shape.resolution,
    aspect_ratio: KlingOmniImageToVideoInputSchema.shape.aspect_ratio,
    duration: KlingOmniImageToVideoInputSchema.shape.duration,
    customize_multi_shots: KlingOmniImageToVideoInputSchema.shape.customize_multi_shots,
    prefer_multi_shots: KlingOmniImageToVideoInputSchema.shape.prefer_multi_shots,
    multi_prompt: KlingOmniImageToVideoInputSchema.shape.multi_prompt,
  },
  [KLING_OMNI_REFERENCE_TO_VIDEO_TOOL]: {
    prompt: KlingOmniReferenceToVideoInputSchema.shape.prompt,
    image_refs: KlingOmniReferenceToVideoInputSchema.shape.image_urls,
    video_refs: KlingOmniReferenceToVideoInputSchema.shape.video_urls,
    audio: KlingOmniReferenceToVideoInputSchema.shape.audio,
    resolution: KlingOmniReferenceToVideoInputSchema.shape.resolution,
    aspect_ratio: KlingOmniReferenceToVideoInputSchema.shape.aspect_ratio,
    duration: KlingOmniReferenceToVideoInputSchema.shape.duration,
    customize_multi_shots: KlingOmniReferenceToVideoInputSchema.shape.customize_multi_shots,
    prefer_multi_shots: KlingOmniReferenceToVideoInputSchema.shape.prefer_multi_shots,
    multi_prompt: KlingOmniReferenceToVideoInputSchema.shape.multi_prompt,
  },
  [KLING_OMNI_TRANSFORMATION_TOOL]: {
    prompt: KlingOmniTransformationInputSchema.shape.prompt,
    image_refs: KlingOmniTransformationInputSchema.shape.image_urls,
    video_refs: KlingOmniTransformationInputSchema.shape.video_urls,
    audio: KlingOmniTransformationInputSchema.shape.audio,
    resolution: KlingOmniTransformationInputSchema.shape.resolution,
    aspect_ratio: KlingOmniTransformationInputSchema.shape.aspect_ratio,
    duration: KlingOmniTransformationInputSchema.shape.duration,
  },
  generate_kie_kling_3_0_motion_control: {
    prompt: KlingMotionControlRequestSchema.shape.input.shape.prompt,
    mode: KlingMotionControlRequestSchema.shape.input.shape.mode,
    character_orientation: KlingMotionControlRequestSchema.shape.input.shape.character_orientation,
    background_source: KlingMotionControlRequestSchema.shape.input.shape.background_source,
  },
  generate_kie_seedance_2_5_video: {
    prompt: Seedance25InputSchema.shape.prompt,
    image_refs: Seedance25InputSchema.shape.reference_image_urls,
    video_refs: Seedance25InputSchema.shape.reference_video_urls,
    audio_refs: Seedance25InputSchema.shape.reference_audio_urls,
    return_last_frame: Seedance25InputSchema.shape.return_last_frame,
    generate_audio: Seedance25InputSchema.shape.generate_audio,
    resolution: Seedance25InputSchema.shape.resolution,
    aspect_ratio: Seedance25InputSchema.shape.aspect_ratio,
    duration: Seedance25InputSchema.shape.duration,
    output_format: Seedance25InputSchema.shape.output_format,
    web_search: Seedance25InputSchema.shape.web_search,
    nsfw_checker: Seedance25InputSchema.shape.nsfw_checker,
  },
  generate_kie_gemini_omni_video: {
    prompt: GeminiOmniVideoRequestSchema.shape.input.shape.prompt,
    duration: GeminiOmniVideoRequestSchema.shape.input.shape.duration,
    aspect_ratio: GeminiOmniVideoRequestSchema.shape.input.shape.aspect_ratio,
    resolution: GeminiOmniVideoRequestSchema.shape.input.shape.resolution,
    seed: GeminiOmniVideoRequestSchema.shape.input.shape.seed,
  },
  generate_kie_grok_imagine_image_to_video: {
    prompt: GrokImageToVideoRequestSchema.shape.input.shape.prompt,
    mode: GrokImageToVideoRequestSchema.shape.input.shape.mode,
    duration: GrokImageToVideoRequestSchema.shape.input.shape.duration,
    resolution: GrokImageToVideoRequestSchema.shape.input.shape.resolution,
    aspect_ratio: GrokImageToVideoRequestSchema.shape.input.shape.aspect_ratio,
    nsfw_checker: GrokImageToVideoRequestSchema.shape.input.shape.nsfw_checker,
  },
  generate_kie_grok_imagine_text_to_video: {
    prompt: GrokTextToVideoRequestSchema.shape.input.shape.prompt,
    mode: GrokTextToVideoRequestSchema.shape.input.shape.mode,
    duration: GrokTextToVideoRequestSchema.shape.input.shape.duration,
    resolution: GrokTextToVideoRequestSchema.shape.input.shape.resolution,
    aspect_ratio: GrokTextToVideoRequestSchema.shape.input.shape.aspect_ratio,
    nsfw_checker: GrokTextToVideoRequestSchema.shape.input.shape.nsfw_checker,
  },
  generate_xai_grok_imagine_video: {
    prompt: XaiVideoGenerateRequestSchema.shape.prompt,
    duration: XaiVideoGenerateRequestSchema.shape.duration,
    resolution: XaiVideoGenerateRequestSchema.shape.resolution,
    aspect_ratio: XaiVideoGenerateRequestSchema.shape.aspect_ratio,
  },
  generate_kie_veo_3_0_video: {
    prompt: VeoGenerateRequestSchema.shape.prompt,
    aspect_ratio: VeoGenerateRequestSchema.shape.aspectRatio,
    seed: VeoGenerateRequestSchema.shape.seeds,
  },
  generate_kie_veo_3_0_fast_video: {
    prompt: VeoGenerateRequestSchema.shape.prompt,
    aspect_ratio: VeoGenerateRequestSchema.shape.aspectRatio,
    seed: VeoGenerateRequestSchema.shape.seeds,
  },
  extend_kie_grok_imagine_video: {
    extend_at: GrokVideoExtendRequestSchema.shape.input.shape.extend_at,
    extend_times: GrokVideoExtendRequestSchema.shape.input.shape.extend_times,
  },
  generate_kie_happyhorse_1_1_text_to_video: {
    prompt: HappyHorse11TextToVideoRequestSchema.shape.input.shape.prompt,
    resolution: HappyHorse11TextToVideoRequestSchema.shape.input.shape.resolution,
    aspect_ratio: HappyHorse11TextToVideoRequestSchema.shape.input.shape.aspect_ratio,
    duration: HappyHorseDurationSchema,
  },
  generate_kie_happyhorse_1_1_image_to_video: {
    prompt: HappyHorse11ImageToVideoRequestSchema.shape.input.shape.prompt,
    resolution: HappyHorse11ImageToVideoRequestSchema.shape.input.shape.resolution,
    duration: HappyHorseDurationSchema,
  },
  generate_kie_happyhorse_1_1_reference_to_video: {
    prompt: HappyHorse11ReferenceToVideoRequestSchema.shape.input.shape.prompt,
    resolution: HappyHorse11ReferenceToVideoRequestSchema.shape.input.shape.resolution,
    aspect_ratio: HappyHorse11ReferenceToVideoRequestSchema.shape.input.shape.aspect_ratio,
    duration: HappyHorseDurationSchema,
  },
  generate_kie_happyhorse_1_1_edit_video: {
    prompt: HappyHorseVideoEditRequestSchema.shape.input.shape.prompt,
    resolution: HappyHorseVideoEditRequestSchema.shape.input.shape.resolution,
    audio_setting: HappyHorseVideoEditRequestSchema.shape.input.shape.audio_setting,
    seed: HappyHorseVideoEditRequestSchema.shape.input.shape.seed,
  },
  generate_kie_minimax_h3_text_to_video: {
    prompt: MiniMaxH3TextToVideoRequestSchema.shape.input.shape.prompt,
    aspect_ratio: MiniMaxH3TextToVideoRequestSchema.shape.input.shape.aspect_ratio,
    duration: MiniMaxH3DurationSchema,
    resolution: MiniMaxH3TextToVideoRequestSchema.shape.input.shape.resolution,
  },
  generate_kie_minimax_h3_image_to_video: {
    prompt: MiniMaxH3ImageToVideoRequestSchema.shape.input.shape.prompt,
    duration: MiniMaxH3DurationSchema,
    resolution: MiniMaxH3ImageToVideoRequestSchema.shape.input.shape.resolution,
  },
  generate_kie_minimax_h3_reference_to_video: {
    prompt: MiniMaxH3ReferenceToVideoRequestSchema.shape.input.shape.prompt,
    aspect_ratio: MiniMaxH3ReferenceToVideoRequestSchema.shape.input.shape.aspect_ratio,
    duration: MiniMaxH3DurationSchema,
    resolution: MiniMaxH3ReferenceToVideoRequestSchema.shape.input.shape.resolution,
  },
  generate_kie_volcengine_video_to_video_lip_sync: {
    mode: VolcengineVideoToVideoLipSyncRequestSchema.shape.input.shape.mode,
    separate_vocal: VolcengineVideoToVideoLipSyncRequestSchema.shape.input.shape.separate_vocal,
    open_scenedet: VolcengineVideoToVideoLipSyncRequestSchema.shape.input.shape.open_scenedet,
    align_audio: VolcengineVideoToVideoLipSyncRequestSchema.shape.input.shape.align_audio,
    align_audio_reverse: VolcengineVideoToVideoLipSyncRequestSchema.shape.input.shape.align_audio_reverse,
    templ_start_seconds: VolcengineVideoToVideoLipSyncRequestSchema.shape.input.shape.templ_start_seconds,
  },
  generate_kie_omnihuman_1_5_video: {
    prompt: Omnihuman15RequestSchema.shape.input.shape.prompt,
    output_resolution: Omnihuman15RequestSchema.shape.input.shape.output_resolution,
    pe_fast_mode: Omnihuman15RequestSchema.shape.input.shape.pe_fast_mode,
    seed: Omnihuman15RequestSchema.shape.input.shape.seed,
  },
  generate_fal_grok_imagine_video_reference_to_video: {
    prompt: FalXaiGrokImagineVideoReferenceToVideoRequestSchema.shape.prompt,
    image_refs: FalXaiGrokImagineVideoReferenceToVideoRequestSchema.shape.reference_image_urls,
    duration: FalXaiGrokImagineVideoReferenceToVideoRequestSchema.shape.duration,
    aspect_ratio: FalXaiGrokImagineVideoReferenceToVideoRequestSchema.shape.aspect_ratio,
    resolution: FalXaiGrokImagineVideoReferenceToVideoRequestSchema.shape.resolution,
  },
  extend_fal_grok_imagine_video: {
    prompt: FalXaiGrokImagineVideoExtendVideoRequestSchema.shape.prompt,
    video_ref: FalXaiGrokImagineVideoExtendVideoRequestSchema.shape.video_url,
    duration: FalXaiGrokImagineVideoExtendVideoRequestSchema.shape.duration,
  },
  generate_fal_grok_imagine_video_edit_video: {
    prompt: FalXaiGrokImagineVideoEditVideoRequestSchema.shape.prompt,
    video_ref: FalXaiGrokImagineVideoEditVideoRequestSchema.shape.video_url,
    resolution: FalXaiGrokImagineVideoEditVideoRequestSchema.shape.resolution,
  },
  generate_fal_wan_3_0_text_to_video: {
    prompt: FalWan3p0TextToVideoRequestSchema.shape.prompt,
    resolution: FalWan3p0TextToVideoRequestSchema.shape.resolution,
    aspect_ratio: FalWan3p0TextToVideoRequestSchema.shape.aspect_ratio,
    duration: FalWan3p0TextToVideoRequestSchema.shape.duration,
  },
  generate_fal_wan_3_0_image_to_video: {
    prompt: FalWan3p0ImageToVideoRequestSchema.shape.prompt,
    first_frame_ref: FalWan3p0ImageToVideoRequestSchema.shape.start_image_url,
    resolution: FalWan3p0ImageToVideoRequestSchema.shape.resolution,
    aspect_ratio: FalWan3p0ImageToVideoRequestSchema.shape.aspect_ratio,
    duration: FalWan3p0ImageToVideoRequestSchema.shape.duration,
  },
  generate_fal_wan_3_0_prime_text_to_video: {
    prompt: FalWan3p0TextToVideoRequestSchema.shape.prompt,
    resolution: FalWan3p0TextToVideoRequestSchema.shape.resolution,
    aspect_ratio: FalWan3p0TextToVideoRequestSchema.shape.aspect_ratio,
    duration: FalWan3p0TextToVideoRequestSchema.shape.duration,
  },
  generate_fal_wan_3_0_prime_image_to_video: {
    prompt: FalWan3p0ImageToVideoRequestSchema.shape.prompt,
    first_frame_ref: FalWan3p0ImageToVideoRequestSchema.shape.start_image_url,
    resolution: FalWan3p0ImageToVideoRequestSchema.shape.resolution,
    aspect_ratio: FalWan3p0ImageToVideoRequestSchema.shape.aspect_ratio,
    duration: FalWan3p0ImageToVideoRequestSchema.shape.duration,
  },
  generate_kie_wan_3_0_video: {
    prompt: Wan30VideoRequestSchema.shape.input.shape.prompt,
    resolution: Wan30VideoRequestSchema.shape.input.shape.resolution,
    aspect_ratio: Wan30VideoRequestSchema.shape.input.shape.aspect_ratio,
    duration: Wan30VideoRequestSchema.shape.input.shape.duration,
    audio: Wan30VideoRequestSchema.shape.input.shape.audio,
    seed: Wan30VideoRequestSchema.shape.input.shape.seed,
    nsfw_checker: Wan30VideoRequestSchema.shape.input.shape.nsfw_checker,
  },
  generate_kie_wan_3_0_prime_video: {
    prompt: Wan30VideoPrimeRequestSchema.shape.input.shape.prompt,
    resolution: Wan30VideoPrimeRequestSchema.shape.input.shape.resolution,
    aspect_ratio: Wan30VideoPrimeRequestSchema.shape.input.shape.aspect_ratio,
    duration: Wan30VideoPrimeRequestSchema.shape.input.shape.duration,
    audio: Wan30VideoPrimeRequestSchema.shape.input.shape.audio,
    seed: Wan30VideoPrimeRequestSchema.shape.input.shape.seed,
    nsfw_checker: Wan30VideoPrimeRequestSchema.shape.input.shape.nsfw_checker,
  },
  ...APICITY_014_VIDEO_PARAM_ZOD,
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
  exclusiveMinimum?: boolean;
  exclusiveMaximum?: boolean;
  minLength?: number;
  maxLength?: number;
};

// Most per-tool enums/ranges are now derived from VIDEO_PARAM_ZOD_SCHEMAS at
// schema-build time (see applyApicityConstraints). Only constants that encode a
// deliberate divergence from Apicity, or that feed PARAM_SCHEMAS, remain here.

const SEEDANCE2_TOOL_NAMES: string[] = [];

// grok image-to-video rejects "spicy" though the Apicity mode enum includes it.
const GROK_IMAGINE_MODES = enumOptions(GrokImagineModeSchema);
const GROK_IMAGE_TO_VIDEO_MODES = GROK_IMAGINE_MODES.filter((mode) => mode !== "spicy");

const PARAM_SCHEMAS: Record<string, ParamSchema> = {
  prompt: { type: "string", description: "Text description of what to generate" },
  image_refs: {
    type: "array",
    items: { type: "string" },
    description: "List of asset slugs (e.g., '@img-sunset') for reference images",
  },
  aspect_ratio: { type: "string", description: "Output aspect ratio" },
  model: { type: "string", description: "Model variant" },
  watermark: { type: "boolean", description: "Add provider watermark to output" },
  video_ref: { type: "string", description: "Video asset to extend (e.g., @vid-sunset-drone)" },
  duration: { type: "string", description: "Video duration in seconds" },
  start_time: {
    type: "number",
    description: "Seconds into the source video where the generated insert starts (1.625–60)",
  },
  resume_time: {
    type: "number",
    description: "Seconds into the source video where the original footage resumes (greater than 1.625, at most 60)",
  },
  mode: { type: "string", description: "Generation mode" },
  resolution: { type: "string", description: "Output resolution" },
  output_format: { type: "string", description: "Output video format" },
  generate_audio: { type: "boolean", description: "Generate sound effects (Seedance)" },
  image_ref: { type: "string", description: "Reference image asset (e.g., @img-outfit)" },
  first_frame_ref: { type: "string", description: "First frame image asset (e.g., @img-sunset)" },
  last_frame_ref: { type: "string", description: "Last frame image asset (e.g., @img-ending)" },
  video_refs: {
    type: "array",
    items: { type: "string" },
    description: "Reference video assets (0-3, total duration ≤15s, e.g., @vid-motion-ref)",
  },
  audio_refs: {
    type: "array",
    items: { type: "string" },
    description: "Reference audio assets (0-3, total duration ≤15s, e.g., @aud-soundtrack)",
  },
  return_last_frame: { type: "boolean", description: "Return final frame as image" },
  web_search: { type: "boolean", description: "Use web search for enhanced grounding" },
  sound: { type: "boolean", description: "Generate audio for the video" },
  audio: { type: "boolean", description: "Generate native audio for the video" },
  customize_multi_shots: { type: "boolean", description: "Enable a custom multi-shot list" },
  prefer_multi_shots: { type: "boolean", description: "Enable intelligent shot planning" },
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
  element1_refs: { type: "array", items: { type: "string" }, description: "1-4 image @slugs or 1 video @slug for element 1" },
  element1_name: { type: "string", description: "Name for element 1 (default: derived from first slug)" },
  element1_desc: { type: "string", description: "Description for element 1 (required when element1_refs set)" },
  element2_refs: { type: "array", items: { type: "string" }, description: "1-4 image @slugs or 1 video @slug for element 2" },
  element2_name: { type: "string", description: "Name for element 2 (default: derived from first slug)" },
  element2_desc: { type: "string", description: "Description for element 2 (required when element2_refs set)" },
  element3_refs: { type: "array", items: { type: "string" }, description: "1-4 image @slugs or 1 video @slug for element 3" },
  element3_name: { type: "string", description: "Name for element 3 (default: derived from first slug)" },
  element3_desc: { type: "string", description: "Description for element 3 (required when element3_refs set)" },
  negative_prompt: { type: "string", description: "Negative prompt — things to avoid (max 500 chars)", maxLength: 500 },
  first_clip_ref: { type: "string", description: "Video asset for continuation (e.g., @vid-scene)" },
  driving_audio_ref: { type: "string", description: "Audio asset for audio-driven motion (e.g., @aud-music)" },
  audio_setting: { type: "string", description: "Audio: auto (model decides) or origin (keep original)" },
  audio_ref: { type: "string", description: "Audio asset for voice timbre reference (e.g., @aud-voice)" },
  prompt_extend: { type: "boolean", description: "Intelligent prompt rewriting" },
  nsfw_checker: { type: "boolean", description: "Content safety filter" },
  seed: { type: "integer", description: "Random seed for reproducibility" },
  extend_at: { type: "number", description: "Seconds into the source video to start extending from" },
  extend_times: { type: "string", description: "Extension duration in seconds" },
  task_id: { type: "string", description: "Reference task ID (kie only, used for Grok spicy mode without external images)" },
  index: { type: "integer", description: "Frame index (0-5) when reusing a prior task_id (kie only)", minimum: 0, maximum: 5 },
  audio_url: { type: "string", description: "Custom audio asset (e.g., @aud-music)" },
  character_image_refs: { type: "array", items: { type: "string" }, description: "Character image @slugs (input_urls)" },
  motion_video_refs: { type: "array", items: { type: "string" }, description: "Motion reference video @slugs (video_urls)" },
  character_orientation: { type: "string", description: "Character orientation source: video / image" },
  background_source: { type: "string", description: "Background source: input_video / input_image" },
  separate_vocal: { type: "boolean", description: "Separate vocals from background audio before reconcile_project_work" },
  open_scenedet: { type: "boolean", description: "Enable scene-cut detection" },
  align_audio: { type: "boolean", description: "Align audio to the video timeline" },
  align_audio_reverse: { type: "boolean", description: "Reverse the audio alignment direction" },
  templ_start_seconds: { type: "number", description: "Template start offset in seconds", minimum: 0 },
  output_resolution: { type: "string", description: "Output resolution" },
  pe_fast_mode: { type: "boolean", description: "Prompt-enhance fast mode" },
  video_clip_start: { type: "number", description: "Reference clip start time in seconds", minimum: 0 },
  video_clip_ends: { type: "number", description: "Reference clip end time in seconds (must be > start and < start+10s)", minimum: 0 },
  voice_refs: { type: "array", items: { type: "string" }, description: "Google Flow voice refs (from create_google_flow_voice)" },
  character_refs: { type: "array", items: { type: "string" }, description: "Google Flow character refs (from create_google_flow_character)" },
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
  generate_kie_grok_imagine_image_to_video: new Set(["mode"]),
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
  const slots = readSlotConstraints(schema);
  if (slots && prop.type === "array") {
    prop.minItems = slots.min;
    if (slots.max === null) delete prop.maxItems;
    else prop.maxItems = slots.max;
  }
  const enumOpts = zodEnumOptionsOrNull(schema)
    ?? zodUnionEnumOptions(schema);
  if (enumOpts) {
    if (enumOpts.every((x) => typeof x === "number" && Number.isInteger(x))) {
      prop.type = "integer";
      prop.enum = enumOpts;
    } else {
      prop.enum = [...enumOpts];
    }
  } else {
    const finiteNumbers = zodFiniteNumberOptions(schema);
    const range = zodNumberRange(schema);
    const isNumericParam = prop.type === "integer" || prop.type === "number";
    const isContiguousRange = finiteNumbers !== null
      && range?.int === true
      && range.min !== undefined
      && range.max !== undefined
      && finiteNumbers.length === range.max - range.min + 1
      && finiteNumbers.every((value, index) => value === range.min! + index);
    if (finiteNumbers && (!isNumericParam || !isContiguousRange)) {
      if (isNumericParam) {
        prop.type = finiteNumbers.every(Number.isInteger) ? "integer" : "number";
        prop.enum = finiteNumbers;
      } else {
        prop.enum = finiteNumbers.map(String);
      }
    } else if (range && (range.min !== undefined || range.max !== undefined)) {
      if (isNumericParam) {
        prop.type = range.int ? "integer" : "number";
        if (range.min !== undefined) prop.minimum = range.min;
        if (range.max !== undefined) prop.maximum = range.max;
        if (range.exclusiveMin) prop.exclusiveMinimum = true;
        else delete prop.exclusiveMinimum;
        if (range.exclusiveMax) prop.exclusiveMaximum = true;
        else delete prop.exclusiveMaximum;
        prop.enum = undefined;
      } else if (range.int && range.min !== undefined && range.max !== undefined) {
        prop.enum = rangeToStringEnum(range.min, range.max);
      }
    }
  }
  const minLength = zodStringMinLength(schema);
  const maxLength = zodStringMaxLength(schema);
  if (minLength !== undefined) prop.minLength = minLength;
  if (maxLength !== undefined) prop.maxLength = maxLength;
}

function resolveVideoSchemaToolName(rawToolName: string): string {
  return getCanonicalName(rawToolName);
}

function getVideoToolSchema(rawToolName: string): ToolSchema | null {
  const canonical = getCanonicalName(rawToolName);
  const toolName = resolveVideoSchemaToolName(rawToolName);
  const isGoogleAlias = canonical === "generate_google_flow_omni_flash_video";
  const baseName = GOOGLE_VIDEO_ALIASES[rawToolName] ?? GOOGLE_VIDEO_ALIASES[canonical] ?? GOOGLE_VIDEO_ALIASES[toolName] ?? toolName;
  const model = Object.values(VIDEO_MODELS).find(
    (m) => m.tool_name === baseName
      || m.tool_name === canonical
      || getCanonicalName(m.tool_name) === canonical
      || ((isKlingOmniTool(baseName) || isKlingOmniTool(canonical))
        && m.tool_name === KLING_OMNI_TEXT_TO_VIDEO_TOOL)
      || (m.falToolNames && Object.values(m.falToolNames).some((n) => n === baseName || n === canonical || getCanonicalName(n!) === canonical)),
  );
  if (!model) return null;

  const properties: Record<string, ParamSchema> = {};
  const required = new Set<string>();
  const defaults: Record<string, unknown> = {};
  const zodSchemas = VIDEO_PARAM_ZOD_SCHEMAS[baseName]
    ?? VIDEO_PARAM_ZOD_SCHEMAS[rawToolName]
    ?? VIDEO_PARAM_ZOD_SCHEMAS[canonical]
    ?? {};

  const paramList = isGoogleAlias
    ? (GOOGLE_VIDEO_PARAMS.generate_google_flow_omni_flash_video ?? model.params)
    : isKlingOmniTool(baseName)
      ? KLING_OMNI_TOOL_PARAMS[baseName]
      : isKlingOmniTool(canonical)
        ? KLING_OMNI_TOOL_PARAMS[canonical]
        : model.params;
  for (const param of paramList) {
    const base = PARAM_SCHEMAS[param];
    if (!base) continue;

    const prop = { ...base };

    // Tool-specific enum/description overrides
    if (toolName === "generate_kie_kling_3_0_motion_control" || canonical === "generate_kie_kling_3_0_motion_control") {
      if (param === "prompt") prop.description = "Optional motion description";
      if (param === "character_image_refs") prop.description = "Character image @slugs (input_urls)";
      if (param === "motion_video_refs") prop.description = "Motion reference video @slugs (video_urls)";
      if (param === "mode") prop.description = "Output resolution: 720p / 1080p";
      if (param === "character_orientation") prop.description = "Character orientation source: video / image";
      if (param === "background_source") prop.description = "Background source: input_video / input_image";
    }
    if (isKlingOmniTool(toolName) || isKlingOmniTool(canonical)) {
      if (param === "prompt") prop.description = "Video description (1-3072 characters)";
      if (param === "image_refs") prop.description = "Reference image assets";
      if (param === "video_refs") prop.description = "Reference or motion video assets";
      if (param === "audio") prop.description = "Generate native audio";
      if (param === "resolution") prop.description = "Output resolution: 720p / 1080p / 4k";
      if (param === "aspect_ratio") prop.description = "Output aspect ratio";
      if (param === "duration") prop.description = "Video duration in seconds (3-15)";
      if (param === "customize_multi_shots") {
        prop.description = "Enable a custom multi-shot list";
        prop.default = false;
        defaults.customize_multi_shots = false;
      }
    }
    if (toolName === "generate_kie_seedance_2_5_video") {
      if (param === "prompt") prop.description = "Video description (optional, max 30000 characters)";
      if (param === "first_frame_ref") prop.description = "First frame image asset";
      if (param === "last_frame_ref") prop.description = "Last frame image asset (requires first frame)";
      if (param === "image_refs") prop.description = "Reference image assets (0-30)";
      if (param === "video_refs") prop.description = "Reference video assets (0-10, total duration up to 30s)";
      if (param === "audio_refs") prop.description = "Reference audio assets (0-10)";
      if (param === "return_last_frame") prop.description = "Return the final generated frame as a secondary image";
      if (param === "generate_audio") prop.description = "Generate synchronized audio";
      if (param === "resolution") prop.description = "Output resolution: 480p / 720p / 1080p";
      if (param === "duration") prop.description = "Video duration: -1 for automatic or 4-30 seconds";
      if (param === "output_format") prop.description = "Output video format: mp4 / mov";
    }
    if (SEEDANCE2_TOOL_NAMES.includes(toolName)) {
      if (param === "prompt") { prop.description = "Video description (3-20000 characters)"; prop.minLength = 3; prop.maxLength = 20000; }
      if (param === "aspect_ratio") prop.description = "Frame dimensions (adaptive auto-fits to content)";
      if (param === "duration") prop.description = "Video duration: 4-15 seconds";
      if (param === "image_refs") prop.description = "Reference image assets (0-9, total ≤15s, e.g., @img-sunset)";
      if (param === "video_refs") prop.description = "Reference video assets (0-3, total ≤15s, e.g., @vid-motion)";
      if (param === "audio_refs") prop.description = "Reference audio assets (0-3, total ≤15s, e.g., @aud-music)";
    }
    if (baseName === "generate_kie_gemini_omni_video") {
      // Enum/range/default for prompt, duration, aspect_ratio, resolution, seed
      // auto-derive from VIDEO_PARAM_ZOD_SCHEMAS; only descriptions are set here.
      if (param === "prompt") { prop.description = "Multimodal video generation prompt (max 20000 characters)"; prop.maxLength = 20000; }
      if (param === "first_frame_ref") prop.description = "First-frame image asset for image-to-video (e.g., @img-start); not combinable with image_refs or video_ref";
      if (param === "image_refs") { prop.description = "Reference image assets (0-7, each ≤20MB, e.g., @img-style)"; prop.maxItems = 7; }
      if (param === "video_ref") prop.description = "Reference video clip asset (one clip, e.g., @vid-motion)";
      if (param === "video_clip_start") {
        prop.description = isGoogleAlias
          ? "Reference clip start time in seconds on a 10s timeline (requires video_ref)"
          : "Reference clip start time in seconds (requires video_ref)";
        if (isGoogleAlias) prop.maximum = 10;
      }
      if (param === "video_clip_ends") {
        prop.description = isGoogleAlias
          ? "Reference clip end time in seconds on a 10s timeline; must be > start (requires video_ref)"
          : "Reference clip end time in seconds; must be > start and < start+10s (requires video_ref)";
        if (isGoogleAlias) prop.maximum = 10;
      }
      if (param === "duration") prop.description = "Output duration: 4 / 6 / 8 / 10 seconds (ignored when a reference video clip is supplied)";
      if (param === "aspect_ratio") prop.description = "Output aspect ratio: 16:9 / 9:16";
      if (!isGoogleAlias && param === "resolution") prop.description = "Output resolution: 720p / 1080p / 4k (default 720p)";
      if (param === "seed") prop.description = "Random seed (0-2147483647)";
      if (isGoogleAlias && param === "duration") {
        prop.enum = [...GOOGLE_OMNI_DURATIONS];
        prop.default = "8";
        defaults[param] = "8";
        prop.description = "Output duration: 4 / 6 / 8 / 10 seconds (default 8; omitted for reference-video V2V)";
      }
      if (isGoogleAlias && param === "aspect_ratio") {
        prop.enum = [...GOOGLE_OMNI_ASPECT_RATIOS];
      }
      if (isGoogleAlias && param === "seed") {
        prop.minimum = 0;
      }
      if (isGoogleAlias && param === "voice_refs") {
        prop.maxItems = 5;
        prop.description = "Google Flow voice refs (0-5; 0-3 with a reference clip), sent as referenceAudio_1..5";
      }
      if (isGoogleAlias && param === "character_refs") {
        prop.maxItems = 3;
        prop.description = "Google Flow character refs (0-3); each costs 2 of the 7 reference slots shared with image_refs (5 with a reference clip)";
      }
    }
    if (
      toolName === "generate_google_flow_veo_3_1_quality_video"
      || toolName === "generate_google_flow_veo_3_1_fast_video"
      || toolName === "generate_google_flow_veo_3_1_lite_video"
      || toolName === "generate_google_flow_veo_3_1_lite_low_priority_video"
    ) {
      // The 0.7.3 @apicity/googleflow schemas carry only loose `.or(z.string())`
      // model/aspect enums, not the per-model restrictions, so allowed values are
      // hand-typed from the useapi.net Google Flow docs (docs/apicity-gaps.md §14).
      if (param === "prompt") prop.description = "Video description";
      if (param === "first_frame_ref") prop.description = "Start frame image asset for image-to-video (e.g., @img-start)";
      if (param === "last_frame_ref") prop.description = "End frame image asset (requires first_frame_ref, e.g., @img-end)";
      if (param === "image_refs") { prop.description = "Reference image assets (0-3; not combinable with first/last frame)"; prop.maxItems = 3; }
      if (param === "aspect_ratio") { prop.enum = ["16:9", "9:16", "1:1", "4:3", "3:4"]; prop.description = "Output aspect ratio (default 16:9)"; }
      if (param === "duration") {
        prop.enum = ["4", "6", "8"];
        prop.default = "8";
        defaults[param] = "8";
        prop.description = "Video duration in seconds (default 8; 4/6 require an Ultra plan)";
      }
      if (param === "seed") prop.description = "Random seed for reproducibility";
    }
    if (toolName === "generate_kie_grok_imagine_image_to_video") {
      if (param === "prompt") prop.description = "Video motion description (optional, max 4096 chars)";
      // Apicity mode enum includes "spicy" which this i2v endpoint rejects (APICITY_DERIVE_SKIP).
      if (param === "mode") { prop.enum = GROK_IMAGE_TO_VIDEO_MODES; prop.description = "Generation mode: fun / normal"; }
      if (param === "duration") { prop.type = "integer"; prop.description = "Video duration in seconds (6-30)"; }
      if (param === "resolution") prop.description = "Video resolution: 480p / 720p / 1080p; 1080p requires exactly one image";
      if (param === "aspect_ratio") prop.description = "Video aspect ratio";
      if (param === "nsfw_checker") { prop.description = "Enable NSFW content safety filter (default false)"; }
      if (param === "image_refs") {
        prop.description = "1-7 reference image assets (required, e.g., @img-sunset); 1080p accepts exactly one image";
        prop.minItems = 1;
        prop.maxItems = 7;
      }
    }
    if (toolName === "generate_kie_grok_imagine_text_to_video") {
      if (param === "prompt") prop.description = "Video description";
      if (param === "mode") prop.description = "Generation mode: fun / normal / spicy";
      if (param === "duration") { prop.type = "integer"; prop.description = "Video duration in seconds (6-30)"; }
      if (param === "resolution") prop.description = "Output resolution: 480p / 720p";
      if (param === "aspect_ratio") prop.description = "Output aspect ratio";
      if (param === "nsfw_checker") { prop.description = "Enable NSFW content safety filter (default false)"; }
    }
    if (toolName === "generate_xai_grok_imagine_video") {
      if (param === "prompt") { prop.description = "Video description"; }
      if (param === "duration") prop.description = "Video duration: 1-15 seconds (max 10 with references)";
      if (param === "resolution") prop.description = "Video resolution: 480p / 720p";
      if (param === "aspect_ratio") prop.description = "Video aspect ratio";
      if (param === "image_refs") {
        prop.description = "Reference images (0-7 optional, guide style/content)";
        prop.maxItems = 7;
      }
    }
    if (toolName === "extend_kie_grok_imagine_video") {
      if (param === "prompt") { prop.description = "Describe how to extend the video (actions, scenes, style)"; prop.maxLength = 5000; }
      if (param === "extend_at") { prop.description = "Seconds into the source video to start extending from"; }
      if (param === "extend_times") prop.description = "Extension duration: 6s / 10s";
      if (param === "video_ref") { prop.description = "Video asset to extend (e.g., @vid-sunset-drone)"; }
    }
    if (toolName === "generate_fal_seedance_2_0_reference_to_video" || toolName === "generate_fal_seedance_2_0_fast_reference_to_video") {
      if (param === "prompt") prop.description = "Video description (reference items can be mentioned as @Image1, @Video1, @Audio1, etc.)";
      if (param === "image_refs") prop.description = "Reference image assets (0-9)";
      if (param === "video_refs") prop.description = "Reference video assets (0-3, combined 2-15s)";
      if (param === "audio_refs") prop.description = "Reference audio assets (0-3, combined ≤15s)";
      if (param === "resolution") prop.description = "Output resolution: 480p / 720p";
      if (param === "duration") prop.description = "Duration in seconds or 'auto'";
      if (param === "aspect_ratio") prop.description = "Output aspect ratio";
      if (param === "generate_audio") { prop.description = "Generate synchronized audio"; }
    }
    if (toolName === "generate_fal_grok_imagine_video_reference_to_video") {
      if (param === "prompt") prop.description = "Video description";
      if (param === "image_refs") prop.description = "Reference image assets (1-7 required, e.g., @img-style)";
      if (param === "duration") { prop.type = "integer"; prop.description = "Video duration in seconds (1-10)"; }
      if (param === "aspect_ratio") prop.description = "Output aspect ratio";
      if (param === "resolution") prop.description = "Output resolution: 480p / 720p";
    }
    if (toolName === "extend_fal_grok_imagine_video") {
      if (param === "prompt") prop.description = "Describe how to extend the video";
      if (param === "video_ref") prop.description = "Source video asset to extend (e.g., @vid-scene)";
      if (param === "duration") { prop.type = "integer"; prop.description = "Extension duration in seconds (2-10)"; }
    }
    if (toolName === "generate_fal_grok_imagine_video_edit_video") {
      if (param === "prompt") prop.description = "Edit instruction";
      if (param === "video_ref") prop.description = "Source video asset to edit (e.g., @vid-scene)";
      if (param === "resolution") prop.description = "Output resolution: auto / 480p / 720p";
    }
    if (toolName === "generate_kie_happyhorse_1_1_text_to_video") {
      if (param === "prompt") prop.description = "Video description (max 5000 chars / 2500 Chinese chars)";
      if (param === "resolution") prop.description = "Output resolution: 720p / 1080p";
      if (param === "aspect_ratio") prop.description = "Output aspect ratio";
      if (param === "duration") prop.description = "Video duration: 3-15 seconds";
    }
    if (toolName === "generate_kie_happyhorse_1_1_image_to_video") {
      if (param === "prompt") prop.description = "Optional video description (max 5000 chars / 2500 Chinese chars)";
      if (param === "first_frame_ref") prop.description = "First frame image asset (required, e.g., @img-start)";
      if (param === "resolution") prop.description = "Output resolution: 720p / 1080p";
      if (param === "duration") prop.description = "Video duration: 3-15 seconds";
    }
    if (toolName === "generate_kie_happyhorse_1_1_reference_to_video") {
      if (param === "prompt") prop.description = "Video description (max 5000 chars / 2500 Chinese chars)";
      if (param === "image_refs") prop.description = "Reference image assets (1-9, order defines character1/character2/...)";
      if (param === "resolution") prop.description = "Output resolution: 720p / 1080p";
      if (param === "aspect_ratio") prop.description = "Output aspect ratio";
      if (param === "duration") prop.description = "Video duration: 3-15 seconds";
    }
    if (toolName === "generate_kie_happyhorse_1_1_edit_video") {
      if (param === "prompt") prop.description = "Edit instruction (max 5000 chars / 2500 Chinese chars)";
      if (param === "video_ref") prop.description = "Source video asset to edit (3-60s, e.g., @vid-scene)";
      if (param === "image_refs") prop.description = "0-5 optional reference images for character/style guidance";
      if (param === "resolution") prop.description = "Output resolution: 720p / 1080p";
      if (param === "audio_setting") prop.description = "Audio: auto (model decides) or origin (keep original)";
    }
    if (toolName === "generate_kie_minimax_h3_text_to_video") {
      if (param === "prompt") prop.description = "Video description (max 7000 chars)";
      if (param === "aspect_ratio") prop.description = "Output aspect ratio (required): 21:9 / 16:9 / 4:3 / 1:1 / 3:4 / 9:16";
      if (param === "duration") prop.description = "Video duration: 4-15 seconds (required)";
      if (param === "resolution") prop.description = "Output resolution: 768P / 2K (default 768P)";
    }
    if (toolName === "generate_kie_minimax_h3_image_to_video") {
      if (param === "prompt") prop.description = "Video description (max 7000 chars)";
      if (param === "first_frame_ref") prop.description = "First frame image asset (at least one of first/last frame required, e.g., @img-start)";
      if (param === "last_frame_ref") prop.description = "Last frame image asset (at least one of first/last frame required, e.g., @img-end)";
      if (param === "duration") prop.description = "Video duration: 4-15 seconds (required)";
      if (param === "resolution") prop.description = "Output resolution: 768P / 2K (default 768P)";
    }
    if (toolName === "generate_kie_minimax_h3_reference_to_video") {
      if (param === "prompt") prop.description = "Video description (max 7000 chars)";
      if (param === "image_refs") prop.description = "Reference image assets (0-9; at least one image or video required)";
      if (param === "video_refs") prop.description = "Reference video assets (0-3; at least one image or video required)";
      if (param === "audio_refs") prop.description = "Reference audio assets (0-3)";
      if (param === "aspect_ratio") prop.description = "Output aspect ratio: adaptive / 21:9 / 16:9 / 4:3 / 1:1 / 3:4 / 9:16";
      if (param === "duration") prop.description = "Video duration: 4-15 seconds (required)";
      if (param === "resolution") prop.description = "Output resolution: 768P / 2K (default 768P)";
    }
    if (toolName === "generate_kie_volcengine_video_to_video_lip_sync") {
      if (param === "video_ref") prop.description = "Source video asset to lip-sync (e.g., @vid-scene)";
      if (param === "audio_ref") prop.description = "Driving audio asset whose speech drives the lips (e.g., @aud-voice)";
      if (param === "mode") prop.description = "Quality mode: lite (faster) or basic";
      if (param === "templ_start_seconds") prop.description = "Template start offset in seconds (default 0)";
    }
    if (toolName === "generate_kie_omnihuman_1_5_video") {
      if (param === "image_ref") prop.description = "Portrait image asset to animate (required, e.g., @img-face)";
      if (param === "audio_ref") prop.description = "Driving audio asset whose speech/song drives the avatar (required, max 60s, e.g., @aud-voice)";
      if (param === "prompt") prop.description = "Optional motion/expression description (e.g. 'speaking naturally with gentle expressions')";
      if (param === "output_resolution") prop.description = "Output resolution: 720 / 1080 (default 1080)";
      if (param === "pe_fast_mode") prop.description = "Prompt-enhance fast mode — faster, lower-fidelity (default false)";
      if (param === "seed") prop.description = "Random seed for reproducibility (-1 = random)";
    }
    const providerSchema = zodSchemas[param];
    if (providerSchema) {
      if (!APICITY_DERIVE_SKIP[toolName]?.has(param)) {
        applyApicityConstraints(prop, providerSchema);
      }
      const result = zodDefault(providerSchema);
      if (isGoogleAlias && param === "duration") {
        prop.default = "8";
        defaults[param] = "8";
      } else if (result.hasDefault) {
        const value = normalizeDefaultForParam(prop, result.value);
        prop.default = value;
        defaults[param] = value;
      } else {
        delete prop.default;
      }
      if (zodIsRequired(providerSchema) && !(isGoogleAlias && param === "duration")) required.add(param);
    }

    if ((isKlingOmniTool(toolName) || isKlingOmniTool(canonical)) && param === "customize_multi_shots") {
      prop.default = false;
      defaults.customize_multi_shots = false;
    }

    if (toolName === "generate_kie_grok_imagine_text_to_video") {
      if (param === "duration") {
        prop.default = 6;
        defaults.duration = 6;
      }
      if (param === "resolution") {
        prop.default = "480p";
        defaults.resolution = "480p";
      }
    }

    properties[param] = prop;

    // Required fields
    if (
      param === "prompt"
      && toolName !== "generate_kie_grok_imagine_image_to_video"
      && canonical !== "generate_fal_grok_imagine_video"
      && toolName !== "generate_kie_seedance_2_5_video"
      && canonical !== "generate_kie_seedance_2_5_video"
      && toolName !== "generate_kie_omnihuman_1_5_video"
      && canonical !== "generate_kie_omnihuman_1_5_video"
      && toolName !== "generate_kie_kling_3_0_motion_control"
      && canonical !== "generate_kie_kling_3_0_motion_control"
    ) required.add(param);
    if ((toolName === "generate_kie_grok_imagine_image_to_video" || canonical === "generate_fal_grok_imagine_video") && param === "image_refs") required.add(param);
    if (param === "image_ref" && (toolName === "generate_kie_omnihuman_1_5_video" || canonical === "generate_kie_omnihuman_1_5_video")) required.add(param);
    if (param === "video_ref" && (
      toolName === "extend_kie_grok_imagine_video" || canonical === "extend_fal_grok_imagine_video" || canonical === "extend_kie_grok_imagine_video" ||
      toolName === "extend_fal_grok_imagine_video" || canonical === "extend_fal_grok_imagine_video" ||
      toolName === "generate_fal_grok_imagine_video_edit_video" || canonical === "generate_fal_grok_imagine_video_edit_video" ||
      toolName === "generate_kie_volcengine_video_to_video_lip_sync" || canonical === "generate_kie_volcengine_video_to_video_lip_sync"
    )) required.add(param);
    if (param === "audio_ref" && (toolName === "generate_kie_volcengine_video_to_video_lip_sync" || toolName === "generate_kie_omnihuman_1_5_video")) required.add(param);
    if (
      (toolName === KLING_OMNI_IMAGE_TO_VIDEO_TOOL || canonical === KLING_OMNI_IMAGE_TO_VIDEO_TOOL)
      && param === "image_refs"
    ) required.add(param);
    if (
      (toolName === KLING_OMNI_TRANSFORMATION_TOOL || canonical === KLING_OMNI_TRANSFORMATION_TOOL)
      && param === "video_refs"
    ) required.add(param);
    if (
      (toolName === "generate_kie_kling_3_0_motion_control" || canonical === "generate_kie_kling_3_0_motion_control")
      && (param === "character_image_refs" || param === "motion_video_refs")
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

function validateVideoParams(rawToolName: string, params: Record<string, unknown>): ValidationResult {
  const schema = getVideoToolSchema(rawToolName);
  if (!schema) return { valid: false, missing_required: [], warnings: ["Unknown tool"], image_slots: null, multi_prompt_slots: null };
  const canonical = getCanonicalName(rawToolName);
  const toolName = resolveVideoSchemaToolName(rawToolName);

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
  const imageRefs = params.image_refs as string[] | undefined;
  const totalImages = imageRefs?.length ?? 0;

  if ((toolName === "generate_kie_grok_imagine_image_to_video" || canonical === "generate_fal_grok_imagine_video") && totalImages > 7) {
    warnings.push(`Grok Imagine 1.5 supports up to 7 reference images (got ${totalImages})`);
  }
  if (toolName === "generate_kie_grok_imagine_image_to_video") {
    const resolutionError = grokImagine1080pImageCountError(
      totalImages,
      params.resolution,
    );
    if (resolutionError) warnings.push(resolutionError);
  }

  if (toolName === "generate_xai_grok_imagine_video" || canonical === "generate_xai_grok_imagine_video") {
    if (totalImages > 7) {
      warnings.push(`xAI reference-to-video supports up to 7 reference images (got ${totalImages})`);
    }
    const duration = Number(params.duration);
    if (totalImages > 0 && Number.isFinite(duration) && duration > 10) {
      warnings.push("xAI reference-to-video supports at most 10 seconds when reference images are supplied");
    }
  }

  if (toolName === "generate_kie_gemini_omni_video" || canonical === "generate_kie_gemini_omni_video") {
    if (totalImages > 7) {
      warnings.push(`Gemini Omni supports up to 7 reference images (got ${totalImages})`);
    }
    const videoRef = params.video_ref as string | undefined;
    const clipStart = params.video_clip_start as number | undefined;
    const clipEnds = params.video_clip_ends as number | undefined;
    if (!videoRef && (clipStart !== undefined || clipEnds !== undefined)) {
      warnings.push("video_clip_start/video_clip_ends require a video_ref");
    }
    if (videoRef) {
      const clipError = geminiOmniClipInputError({
        hasVideo: true,
        start: clipStart,
        ends: clipEnds,
      });
      if (clipError) warnings.push(clipError);
    }
  }

  if (toolName === "generate_google_flow_omni_flash_video") {
    if (totalImages > 7) {
      warnings.push(`Google Omni supports up to 7 reference images (got ${totalImages})`);
    }
    const firstFrame = params.first_frame_ref as string | undefined;
    const videoRef = params.video_ref as string | undefined;
    const clipStart = params.video_clip_start as number | undefined;
    const clipEnds = params.video_clip_ends as number | undefined;
    if (firstFrame && totalImages > 0) {
      warnings.push("Google Omni first_frame_ref cannot be combined with image_refs");
    }
    if (firstFrame && videoRef) {
      warnings.push("Google Omni first_frame_ref cannot be combined with video_ref");
    }
    if (!videoRef && (clipStart !== undefined || clipEnds !== undefined)) {
      warnings.push("video_clip_start/video_clip_ends require a video_ref");
    }
    if (videoRef) {
      if (totalImages > 5) {
        warnings.push(`Google Omni video edit supports up to 5 reference images alongside the clip (got ${totalImages})`);
      }
      if (clipStart !== undefined && clipStart >= 10) {
        warnings.push("Google Omni video_clip_start must be less than 10 seconds");
      }
      const start = clipStart ?? 0;
      if (clipEnds !== undefined && (!(clipEnds > start) || clipEnds > 10)) {
        warnings.push("Google Omni reference clip must satisfy video_clip_ends > video_clip_start and <= 10s");
      }
    }
    const voiceCount = (params.voice_refs as string[] | undefined)?.filter(Boolean).length ?? 0;
    const charRefs = ((params.character_refs as string[] | undefined) ?? []).filter(Boolean);
    const charCount = charRefs.length;
    if (voiceCount > 5) {
      warnings.push(`Google Omni supports up to 5 voice refs (got ${voiceCount})`);
    }
    if (videoRef && voiceCount > 3) {
      warnings.push(`Google Omni video edit supports up to 3 voice refs alongside the clip (got ${voiceCount})`);
    }
    if (charCount > 3) {
      warnings.push(`Google Omni supports up to 3 character refs — each costs 2 of the 7 reference slots (got ${charCount})`);
    }
    if (firstFrame && charCount > 0) {
      warnings.push("Google Omni first_frame_ref cannot be combined with character_refs");
    }
    if (charCount > 0) {
      const slotBudget = videoRef ? 5 : 7;
      const omniSlotTotal = totalOmniReferenceSlots(totalImages, charRefs);
      if (omniSlotTotal > slotBudget) {
        warnings.push(`Google Omni reference budget exceeded: image_refs cost 1 slot each and characters 2 each, at most ${slotBudget}${videoRef ? " alongside a reference clip" : ""} (got ${omniSlotTotal}: ${totalImages} image_refs + ${charCount} character ref${charCount === 1 ? "" : "s"} × 2)`);
      }
      warnings.push("Google may block generations whose character photos depict identifiable real people (PROMINENT_PEOPLE safety filter). Stylized or AI-generated character images are more reliable.");
    }
  }

  if (
    toolName === "generate_google_flow_veo_3_1_quality_video"
    || toolName === "generate_google_flow_veo_3_1_fast_video"
    || toolName === "generate_google_flow_veo_3_1_lite_video"
    || toolName === "generate_google_flow_veo_3_1_lite_low_priority_video"
  ) {
    const firstFrame = params.first_frame_ref as string | undefined;
    const lastFrame = params.last_frame_ref as string | undefined;
    if (lastFrame && !firstFrame) {
      warnings.push("Veo 3.1 last_frame_ref requires first_frame_ref");
    }
    // Only Fast/Lite/Lite-LP expose image_refs; the quality tool auto-populates it
    // from context but never sends it, so ref warnings there would be noise.
    const exposesRefs = toolName !== "generate_google_flow_veo_3_1_quality_video";
    if (exposesRefs) {
      if (totalImages > 0 && firstFrame) {
        warnings.push("Veo 3.1 reference images cannot be combined with a start frame — pick one mode");
      }
      if (totalImages > 3) {
        warnings.push(`Veo 3.1 supports up to 3 reference images (got ${totalImages})`);
      }
    }
  }

  if (
    toolName === "generate_kie_seedance_2_5_video"
    || canonical === "generate_kie_seedance_2_5_video"
  ) {
    const firstFrame = params.first_frame_ref as string | undefined;
    const lastFrame = params.last_frame_ref as string | undefined;
    const videoRefs = (params.video_refs as string[] | undefined)?.filter(Boolean) ?? [];
    const audioRefs = (params.audio_refs as string[] | undefined)?.filter(Boolean) ?? [];
    const hasFrame = Boolean(firstFrame) || Boolean(lastFrame);
    if (lastFrame && !firstFrame) {
      warnings.push("Seedance 2.5 last_frame_ref requires first_frame_ref");
    }
    if (hasFrame && (totalImages > 0 || videoRefs.length > 0 || audioRefs.length > 0)) {
      warnings.push("Seedance 2.5 reference inputs cannot be combined with first/last frame");
    }
    if (totalImages > 30) warnings.push(`Seedance 2.5 supports up to 30 reference images (got ${totalImages})`);
    if (videoRefs.length > 10) warnings.push(`Seedance 2.5 supports up to 10 reference videos (got ${videoRefs.length})`);
    if (audioRefs.length > 10) warnings.push(`Seedance 2.5 supports up to 10 reference audio files (got ${audioRefs.length})`);
  }

  const imageSlots = IMAGE_SLOT_OVERRIDES[toolName] ?? readSlotConstraints(IMAGE_FIELD_SCHEMAS[toolName]);

  const multiPromptSlots = isKlingOmniTool(toolName) ? 6 : null;

  return { valid: missing.length === 0, missing_required: missing, warnings, image_slots: imageSlots, multi_prompt_slots: multiPromptSlots };
}

// ---------------------------------------------------------------------------
// Tool constraints (mutative)
// ---------------------------------------------------------------------------

function applyVideoToolConstraints(
  rawToolName: string,
  schema: ToolSchema,
  params: Record<string, unknown>,
): void {
  void schema;
  const toolName = resolveVideoSchemaToolName(rawToolName);
  if (toolName === "generate_kie_grok_imagine_image_to_video") {
    if (params.mode === "spicy") params.mode = "normal";
    if (params.aspect_ratio === "auto") params.aspect_ratio = "16:9";
  }
  const aspectRatio = seedance25FrameAspectRatio(toolName, params);
  if (aspectRatio) params.aspect_ratio = aspectRatio;
}

// ---------------------------------------------------------------------------
// Routing prompt
// ---------------------------------------------------------------------------

const VIDEO_TOOL_NAMES = [
  ...Object.values(VIDEO_MODELS).map((m) => m.tool_name),
  ...KLING_OMNI_TOOLS.filter((name) => name !== KLING_OMNI_TEXT_TO_VIDEO_TOOL),
];

function buildVideoRoutingPrompt(): string {
  const toolLines: string[] = [];
  for (const model of Object.values(VIDEO_MODELS)) {
    const paramStr = model.params.filter((p) => p !== "book_id").join(", ");
    const defaults = getVideoToolSchema(model.tool_name)?.defaults ?? {};
    const defaultStr = Object.entries(defaults).map(([k, v]) => `${k}=${String(v)}`).join(", ");
    toolLines.push(`- ${model.tool_name}: ${model.description}`);
    toolLines.push(`  Parameters: ${paramStr}`);
    if (defaultStr) toolLines.push(`  Defaults: ${defaultStr}`);
  }
  toolLines.push(`- ${KLING_OMNI_IMAGE_TO_VIDEO_TOOL}: Kling 3.0 Omni image-to-video (1-2 frames)`);
  toolLines.push(`- ${KLING_OMNI_REFERENCE_TO_VIDEO_TOOL}: Kling 3.0 Omni reference-to-video`);
  toolLines.push(`- ${KLING_OMNI_TRANSFORMATION_TOOL}: Kling 3.0 Omni transformation (motion video plus optional images)`);

  return `You are a routing assistant for a video generation system.
You ONLY route to these video generation tools:

${toolLines.join("\n")}

Given a user query (possibly with @asset references), determine:
1. tool: Which tool to use (MUST be one of: ${VIDEO_TOOL_NAMES.join(", ")})
2. params: Parameters to pass to the tool

ROUTING PREFERENCES:
- PREFER ${VIDEO_MODELS[DEFAULT_VIDEO_MODEL_KEY].tool_name} as the DEFAULT for ALL video generation requests
- Use generate_kie_seedance_2_5_video for Seedance, ByteDance, or unspecified video generation. Supports prompt-only, first/last frames, or multimodal references with all KIE options
- Use ${KLING_OMNI_TEXT_TO_VIDEO_TOOL} when the user asks for Kling or Kling Omni text-to-video
- Use ${KLING_OMNI_IMAGE_TO_VIDEO_TOOL} when the user asks for Kling image-to-video or supplies 1-2 frames
- Use ${KLING_OMNI_REFERENCE_TO_VIDEO_TOOL} when the user asks for Kling reference-to-video
- Use ${KLING_OMNI_TRANSFORMATION_TOOL} when the user asks for Kling transformation, motion transfer, or dancing from a motion video plus character images
- Use generate_kie_gemini_omni_video only when the user explicitly asks for Gemini or Google Omni. Multimodal text prompt plus optional reference images (0-7) and one reference video clip with in/out timecodes
- Use generate_google_flow_veo_3_1_fast_video when user mentions "veo" or "veo 3.1"; pick generate_google_flow_veo_3_1_quality_video for "veo quality", generate_google_flow_veo_3_1_lite_video for "veo lite", and generate_google_flow_veo_3_1_lite_low_priority_video for "veo lite low priority" / "veo lp". Text-to-video, first/last frame image-to-video, or reference images (fast/lite/lite-lp only)
- Use extend_kie_grok_imagine_video ONLY when user explicitly wants to extend an existing video with Grok Imagine
- Use generate_kie_volcengine_video_to_video_lip_sync ONLY when user explicitly mentions "volcengine" or wants to lip-sync / dub an existing video to a separate audio track
- Use generate_kie_omnihuman_1_5_video ONLY when user explicitly mentions "omnihuman" or wants to animate a portrait/photo with a voice or audio track (talking/singing avatar from a still image)
- Use generate_kie_wan_3_0_video when the user mentions "Wan" or "Wan 3.0"; pick generate_kie_wan_3_0_prime_video for "Wan 3.0 Prime" / higher quality Wan. Both are omni tools: prompt-only for text-to-video, first_frame_ref/last_frame_ref for frame mode, or image_refs/video_refs/audio_refs for reference mode — never mix frames with references

KEY CONSTRAINTS:
- For Kling 3.0 Omni tools: resolution "720p"/"1080p"/"4k", duration 3-15 seconds, audio boolean. Text-to-video is prompt-only. Image-to-video requires image_refs (1-2). Reference-to-video requires image_refs and/or one video_ref. Transformation requires video_refs and optional image_refs
- For generate_kie_seedance_2_5_video: optional prompt up to 30000 characters; duration "-1" (automatic) or "4"-"30"; resolution "480p"/"720p"/"1080p"; aspect_ratio "1:1"/"4:3"/"3:4"/"16:9"/"9:16"/"21:9"/"adaptive"; output_format "mp4"/"mov"; return_last_frame, generate_audio, web_search, and nsfw_checker booleans. Use either first_frame_ref with optional last_frame_ref, or image_refs (0-30), video_refs (0-10), and audio_refs (0-10), never frames and references together
- For generate_kie_gemini_omni_video: REQUIRES prompt and duration "4"/"6"/"8"/"10"; aspect_ratio "16:9"/"9:16"; resolution "720p"/"1080p"/"4k" (default 720p); seed integer. Optional image_refs (0-7) and one video_ref with video_clip_start/video_clip_ends (ends > start and < start+10s)
- For generate_google_flow_veo_3_1_quality_video: 8s output only; optional first_frame_ref/last_frame_ref (last requires first); aspect_ratio "16:9"/"9:16"/"1:1"/"4:3"/"3:4"; NO reference images
- For generate_google_flow_veo_3_1_fast_video, generate_google_flow_veo_3_1_lite_video, and generate_google_flow_veo_3_1_lite_low_priority_video: duration "4"/"6"/"8" (default "8"); image_refs (0-3) OR first_frame_ref/last_frame_ref, not both; aspect_ratio "16:9"/"9:16"/"1:1"/"4:3"/"3:4"
- For generate_kie_grok_imagine_image_to_video: REQUIRES at least one image, mode "fun"/"normal", duration 6-30 (integer seconds), resolution "480p"/"720p"/"1080p" (1080p requires exactly one image), aspect_ratio "2:3"/"3:2"/"1:1"/"16:9"/"9:16"
- For extend_kie_grok_imagine_video: REQUIRES video_ref, prompt, extend_at, and extend_times "6"/"10"
- For generate_kie_volcengine_video_to_video_lip_sync: REQUIRES video_ref (source video) and audio_ref (driving audio); mode "lite"/"basic"
- For generate_kie_omnihuman_1_5_video: REQUIRES image_ref (portrait) and audio_ref (driving audio ≤60s); output_resolution "720"/"1080", pe_fast_mode boolean, optional prompt
- For generate_kie_wan_3_0_video and generate_kie_wan_3_0_prime_video: prompt optional but required for text-to-video (max 20000 chars; in reference mode address media positionally as Image1/Video1/Audio1); duration "-1" (model-chosen intelligent duration) or "2"-"30" (default 5); resolution "480P"/"720P"/"1080P"; aspect_ratio "adaptive"/"16:9"/"4:3"/"1:1"/"3:4"/"9:16"; audio and nsfw_checker booleans; seed integer. Use either first_frame_ref with optional last_frame_ref, or image_refs (0-10), video_refs (0-5), and audio_refs (0-5), never frames and references together

PROMPT FIELD: Do NOT include "prompt" in params. Only return tool selection and non-prompt parameters.
DO NOT include book_id in params.

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
  const rawName = action.slice(5).replace(/-/g, "_");
  if (isGenerationAction(rawName)) return rawName;
  return null;
}

const NON_PARAM_KEYS = new Set(["book_id"]);

function buildProvidersForModel(info: VideoModelInfo): ProviderRoute[] {
  if (!info.falToolNames && !info.googleToolName) return info.providers;
  return [
    ...(info.googleToolName
      ? [{ key: "google", label: "Google Flow", provider_path: "googleflow.v1.videos({ async: true })", envKey: "GOOGLE_FLOW_API_KEY" }]
      : []),
    ...info.providers,
    ...(info.falToolNames
      ? [{ key: "fal", label: "Fal", provider_path: "fal.post.v1.queue.submit()", envKey: "FAL_API_KEY" }]
      : []),
  ];
}

function resolveFalVideoToolName(info: VideoModelInfo, imageSlugCount: number): string | null {
  const names = info.falToolNames;
  if (!names) return null;
  if (imageSlugCount > 0 && names.withRefs) return names.withRefs;
  if (imageSlugCount === 0 && names.noRefs) return names.noRefs;
  return names.withRefs ?? names.noRefs ?? null;
}

class SettingsMap extends Map<string, Record<string, unknown>> {
  override get(key: string): Record<string, unknown> | undefined {
    const direct = super.get(key);
    if (direct !== undefined) return direct;
    const canonical = getCanonicalName(key);
    if (canonical !== key) {
      const canonicalMatch = super.get(canonical);
      if (canonicalMatch !== undefined) return canonicalMatch;
    }
    for (const [k, v] of this.entries()) {
      if (getCanonicalName(k) === canonical) return v;
    }
    return undefined;
  }
}

function extractLastSettingsPerModel(
  log: ActionLogEntry[],
): Map<string, Record<string, unknown>> {
  const result = new SettingsMap();
  for (const entry of log) {
    const rawName = actionNameToToolName(entry.action);
    if (!rawName) continue;
    const canonicalName = getCanonicalName(rawName);
    if (result.has(canonicalName)) continue;
    if (typeof entry.payload === "string") continue;
    const params: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(entry.payload)) {
      if (!NON_PARAM_KEYS.has(k)) params[k] = v;
    }
    result.set(canonicalName, params);
  }
  return result;
}

/**
 * Return the model key of the most recently used video generation tool,
 * or null if the log contains no video tool entries.
 */
function extractLastUsedModel(log: ActionLogEntry[]): string | null {
  for (const entry of log) {
    const rawToolName = actionNameToToolName(entry.action);
    if (!rawToolName) continue;
    if (typeof entry.payload === "string") continue;
    const canonicalEntryName = getCanonicalName(rawToolName);
    for (const [key, info] of Object.entries(VIDEO_MODELS)) {
      if (
        info.tool_name === rawToolName ||
        getCanonicalName(info.tool_name) === canonicalEntryName ||
        (info.googleToolName && getCanonicalName(info.googleToolName) === canonicalEntryName) ||
        (key === "kling30" && isKlingOmniTool(canonicalEntryName))
      ) return key;
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
  modes: ModelModes | null;
  providers: Array<{ key: string; label: string }>;
  selected_provider: string;
};

function filterInvalidRefs(
  params: Record<string, unknown>,
  validTags: Set<string>,
): void {
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === "string" && v.startsWith("@") && !validTags.has(v)) {
      delete params[k];
    } else if (Array.isArray(v)) {
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
  resolvedAssets: ResolvedArtifactRef[],
  historyEntries?: ActionLogEntry[],
  providerOverride?: string,
  projectAssetTags?: Set<string>,
): ModelOption {
  const toolName = modelInfo.tool_name;
  let historicalProvider: string | undefined;
  let historical: Record<string, unknown> | undefined;
  if (historyEntries) {
    const settingsMap = extractLastSettingsPerModel(historyEntries);
    for (const [key, params] of settingsMap.entries()) {
      if (
        key === toolName ||
        getCanonicalName(key) === getCanonicalName(toolName) ||
        (modelInfo.googleToolName && getCanonicalName(key) === getCanonicalName(modelInfo.googleToolName))
      ) {
        historical = params;
        historicalProvider = params._provider as string | undefined;
        break;
      }
    }
  }

  const allProviders = buildProvidersForModel(modelInfo);
  const availableProviders = allProviders.filter((p) => process.env[p.envKey]);
  const providerList = availableProviders.length > 0 ? availableProviders : allProviders;
  const selectedProvider = (providerOverride && providerList.some((p) => p.key === providerOverride))
    ? providerOverride
    : (historicalProvider && providerList.some((p) => p.key === historicalProvider))
      ? historicalProvider
      : providerList[0].key;

  let effectiveToolName = toolName;
  if (modelKey === "kling30" || isKlingOmniTool(toolName)) {
    const inferredImages = Array.isArray(baseParams.image_refs)
      ? (baseParams.image_refs as unknown[]).filter((item): item is string =>
        typeof item === "string" && item.trim() !== "")
      : resolvedAssets.filter((asset) => asset.artifactType === "image" && asset.filePath).map((asset) => asset.tag);
    const inferredVideos = Array.isArray(baseParams.video_refs)
      ? (baseParams.video_refs as unknown[]).filter((item): item is string =>
        typeof item === "string" && item.trim() !== "")
      : resolvedAssets.filter((asset) => asset.artifactType === "video").map((asset) => asset.tag);
    effectiveToolName = klingOmniToolForParams({
      ...baseParams,
      image_refs: inferredImages,
      video_refs: inferredVideos,
    });
  }
  if (selectedProvider === "fal") {
    const imageSlugCount = Array.isArray(baseParams.image_refs)
      ? (baseParams.image_refs as unknown[]).length
      : resolvedAssets.filter((a) => a.artifactType === "image" && a.filePath).length
        || (typeof baseParams.first_frame_ref === "string" && baseParams.first_frame_ref !== "" ? 1 : 0);
    const falName = resolveFalVideoToolName(modelInfo, imageSlugCount);
    if (falName) effectiveToolName = falName;
  } else if (selectedProvider === "google" && modelInfo.googleToolName) {
    effectiveToolName = modelInfo.googleToolName;
  }

  const schema = getVideoToolSchema(effectiveToolName);
  const allowedParams = new Set(schema ? Object.keys(schema.properties) : modelInfo.params);
  const params: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(baseParams)) {
    if (allowedParams.has(k)) params[k] = v;
  }
  if (historical) {
    for (const [k, v] of Object.entries(historical)) {
      if (allowedParams.has(k) && (k !== "prompt" || !Object.hasOwn(params, k))) {
        params[k] = v;
      }
    }
  }

  // Fill image_refs from resolved assets
  const imageTags = resolvedAssets
    .filter((a) => a.artifactType === "image" && a.filePath)
    .map((a) => a.tag);
  params.image_refs = imageTags.length > 0 ? imageTags : [];

  const canonicalToolName = getCanonicalName(toolName);

  if (
    modelKey === "kling30_motion_control"
    || toolName === "generate_kie_kling_3_0_motion_control"
    || canonicalToolName === "generate_kie_kling_3_0_motion_control"
  ) {
    if (imageTags.length > 0) params.character_image_refs = imageTags;
    const motionTags = resolvedAssets
      .filter((asset) => asset.artifactType === "video")
      .map((asset) => asset.tag);
    if (motionTags.length > 0) params.motion_video_refs = motionTags;
    delete params.image_refs;
    delete params.video_refs;
  }

  if (modelKey === "kling30" || isKlingOmniTool(toolName) || isKlingOmniTool(canonicalToolName)) {
    const videoTags = resolvedAssets
      .filter((asset) => asset.artifactType === "video")
      .map((asset) => asset.tag);
    if (videoTags.length > 0) params.video_refs = videoTags;
    params.multi_prompt ??= [];
    params.customize_multi_shots ??= false;
  }

  // For video extension tools — and Gemini Omni, whose "edit" mode is a V2V
  // extend — prefill video_ref from a prompt-referenced video asset. Omni
  // uses the base tool name so both providers benefit; a fresh panel (no @vid
  // in the prompt) leaves it unset and mode inference stays on t2v.
  if (
    toolName === "extend_kie_grok_imagine_video"
    || canonicalToolName === "extend_fal_grok_imagine_video"
    || toolName === "generate_kie_gemini_omni_video"
    || canonicalToolName === "generate_kie_gemini_omni_video"
  ) {
    const videoAssets = resolvedAssets.filter((a) => a.artifactType === "video");
    if (videoAssets.length > 0) {
      params.video_ref = videoAssets[0].tag;
    }
  }

  // For OmniHuman, prefill the portrait from image assets and the driving
  // track from audio assets so the panel is immediately runnable.
  if (toolName === "generate_kie_omnihuman_1_5_video" || canonicalToolName === "generate_kie_omnihuman_1_5_video") {
    const imageAssets = resolvedAssets.filter((a) => a.artifactType === "image" && a.filePath);
    if (imageAssets.length > 0) {
      params.image_ref ??= imageAssets[0].tag;
    }
    const audioAssets = resolvedAssets.filter((a) => a.artifactType === "audio");
    if (audioAssets.length > 0) {
      params.audio_ref ??= audioAssets[0].tag;
    }
  }

  // Apply model defaults where not already set
  for (const [k, v] of Object.entries(schema?.defaults ?? {})) {
    params[k] ??= v;
  }

  // Strip slug references that don't exist in the current project
  if (projectAssetTags) {
    filterInvalidRefs(params, projectAssetTags);
  }

  // Coerce values to match schema wire types (string enums vs integer ranges)
  if (schema) {
    for (const [k, v] of Object.entries(params)) {
      const prop = schema.properties[k];
      if (!prop) continue;
      const isIntegerProp = prop.type === "integer" || prop.type === "number" || (modelKey === "grok_imagine" && k === "duration");
      if (prop.type === "string" && typeof v === "number" && !(modelKey === "grok_imagine" && k === "duration")) {
        params[k] = String(v);
      } else if (isIntegerProp && typeof v === "string") {
        const n = parseInt(v, 10);
        if (!Number.isNaN(n)) params[k] = n;
      }
    }
    applyVideoToolConstraints(effectiveToolName, schema, params);
  }

  const validation = validateVideoParams(effectiveToolName, params);

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
    modes: VIDEO_TOOL_MODES[effectiveToolName] ?? VIDEO_TOOL_MODES[toolName] ?? VIDEO_TOOL_MODES[getCanonicalName(effectiveToolName)] ?? null,
    providers: providerList.map((p) => ({ key: p.key, label: p.label })),
    selected_provider: selectedProvider,
  };
}

export {
  DEFAULT_VIDEO_MODEL_KEY,
  VIDEO_MODELS,
  IMAGE_FIELD_SCHEMAS,
  PARAM_SCHEMAS,
  VIDEO_TOOL_MODES,
  getVideoToolSchema,
  validateVideoParams,
  applyVideoToolConstraints,
  buildVideoRoutingPrompt,
  buildModelOption,
  extractLastSettingsPerModel,
  extractLastUsedModel,
};
export type {
  ActionLogEntry,
};
