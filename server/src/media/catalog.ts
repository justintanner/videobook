import { MiniMaxH3ReferenceClipDurationMs } from "@apicity/kie/zod";
import { LIGHTNING_SCENE_OPTIONS, LIGHTNING_VIDEO_OPTIONS } from "../lightning-defaults.js";
import type { InputRules, ModeSpec, ModelEntry, RefRole } from "./types.js";

const SEEDANCE_MODES: readonly ModeSpec[] = [
  { id: "t2v", label: "Text to video", roles: [] },
  { id: "i2v", label: "Frames", roles: ["first_frame", "last_frame"], requireAny: ["first_frame", "last_frame"] },
  { id: "r2v", label: "References", roles: ["image", "video", "audio"], requireAny: ["image", "video", "audio"] },
];

const FRAME_MODES: readonly ModeSpec[] = [
  { id: "i2v", label: "Frames", roles: ["first_frame", "last_frame"] },
];

const FLUX_3_MAX_DEFAULTS: Record<string, unknown> = {
  aspect_ratio: "auto",
  duration: 5,
  generate_audio: true,
  resolution: "720p",
  reasoning_level: "high",
};

const SEEDANCE_US_REFERENCE_MODES: readonly ModeSpec[] = [
  { id: "r2v", label: "References", roles: ["image", "video", "audio"], requireAny: ["image", "video", "audio"] },
  { id: "v2v", label: "Edit video", roles: ["video", "image", "audio"], requireAny: ["video"], defaults: { task: "editing" } },
  { id: "extend", label: "Extend video", roles: ["video", "image", "audio"], requireAny: ["video"], defaults: { task: "extension" } },
];

const XAI_MODES: readonly ModeSpec[] = [
  { id: "i2v", label: "Image to video", roles: ["first_frame"] },
  { id: "r2v", label: "References", roles: ["image"], defaults: { duration: 10 } },
  { id: "v2v", label: "Edit video", roles: ["video"], requireAny: ["video"] },
];

const MACHGEN_FRAMES: ModeSpec = { id: "i2v", label: "Frames", roles: ["first_frame", "last_frame"], requireAny: ["first_frame"] };
const MACHGEN_MEDIA: readonly RefRole[] = ["image", "video", "audio"];

function machgenModes(frames: ModeSpec, references: readonly RefRole[], requireAny: readonly RefRole[] = references): readonly ModeSpec[] {
  return [
    { id: "t2v", label: "Text to video", roles: [] },
    frames,
    { id: "r2v", label: "References", roles: references, requireAny },
  ];
}

function machgenClips(maximumSeconds: number): InputRules {
  const window = { minimum: 2000, maximum: maximumSeconds * 1000, maximumTotal: maximumSeconds * 1000 };
  return { refDurationMs: { video: window, audio: window } };
}

const MACHGEN_VIDEO = ["text_to_video", "image_to_video", "reference_to_video"] as const;

const SPEAKER = "Speaker 1";

function kieGeminiClassicTts(id: string, title: string): ModelEntry {
  return {
    id,
    media: "audio",
    operations: ["speech"],
    title,
    prompt: "dialogue_turns.0.text",
    aliases: {
      voice: "speakers.0.voice_name",
      accent: "speakers.0.accent",
      style: "speakers.0.style",
      pace: "speakers.0.pace",
    },
    defaults: {
      speakers: [{ speaker_id: SPEAKER, voice_name: "Kore", accent: "Neutral" }],
      dialogue_turns: [{ speaker_id: SPEAKER }],
    },
  };
}

function kieGemini38Tts(id: string, title: string): ModelEntry {
  return {
    id,
    media: "audio",
    operations: ["speech"],
    title,
    prompt: "dialogue_turns.0.text",
    aliases: { voice: "speakers.0.voice_name", style: "dialogue_turns.0.style" },
    defaults: {
      speakers: [{ speaker_id: SPEAKER, voice_name: "Fola" }],
      dialogue_turns: [{ speaker_id: SPEAKER }],
    },
  };
}

function kieElevenLabsTts(id: string, title: string): ModelEntry {
  return { id, media: "audio", operations: ["speech"], title, defaults: { voice: "Rachel" } };
}

function h3MaxStyle(style: string): ModelEntry {
  return { id: `fal:minimax/h3-max/styles/${style}`, media: "video", operations: ["text_to_video", "image_to_video"], dialect: "strip_frames" };
}

export const MODEL_ENTRIES: readonly ModelEntry[] = [
  { id: "kie:nano-banana-2-1", media: "image", operations: ["text_to_image", "edit_image"], dialect: "natural_numbered", defaults: { ...LIGHTNING_SCENE_OPTIONS } },
  { id: "kie:flux-3/klein-text-to-image", media: "image", operations: ["text_to_image"], dialect: "natural", defaults: { resolution: "1K" } },
  { id: "kie:flux-3/klein-edit-image", media: "image", operations: ["edit_image"], dialect: "natural", defaults: { resolution: "1K" } },
  { id: "kie:nano-banana-pro", media: "image", operations: ["text_to_image", "edit_image"], guide: "nano_banana", dialect: "natural" },
  { id: "kie:gpt-image-2-5-flare-text-to-image", media: "image", operations: ["text_to_image"], guide: "gpt_image", dialect: "natural", defaults: { resolution: "2K" } },
  { id: "kie:gpt-image-2-5-flare-image-to-image", media: "image", operations: ["edit_image"], guide: "gpt_image", dialect: "natural", defaults: { resolution: "2K" } },
  { id: "kie:gpt-image-2-5-sunburst-text-to-image", media: "image", operations: ["text_to_image"], guide: "gpt_image", dialect: "natural", defaults: { resolution: "2K" } },
  { id: "kie:gpt-image-2-5-sunburst-image-to-image", media: "image", operations: ["edit_image"], guide: "gpt_image", dialect: "natural", defaults: { resolution: "2K" } },
  { id: "kie:gpt-image-2-image-to-image", media: "image", operations: ["edit_image"], title: "GPT Image 2 Edit", dialect: "natural", hidden: true },
  { id: "kie:seedream/5-pro-image-to-image", media: "image", operations: ["edit_image"], dialect: "natural", hidden: true },
  { id: "kie:grok-imagine/text-to-image", media: "image", operations: ["text_to_image"], guide: "grok_image" },
  { id: "kie:grok-imagine/image-to-image", media: "image", operations: ["edit_image"], guide: "grok_image", dialect: "natural" },
  { id: "kie:qwen2/image-edit", media: "image", operations: ["edit_image"], dialect: "natural" },
  { id: "kie:qwen3/image-to-image", media: "image", operations: ["edit_image"], dialect: "natural" },
  { id: "kie:qwen2-1/text-to-image", media: "image", operations: ["text_to_image"], dialect: "natural" },
  { id: "kie:qwen2-1/image-to-image", media: "image", operations: ["edit_image"], dialect: "natural" },
  { id: "kie:seedream/5-lite-text-to-image", media: "image", operations: ["text_to_image"] },
  { id: "kie:seedream/5-lite-image-to-image", media: "image", operations: ["edit_image"], dialect: "natural" },
  { id: "kie:seedream/5-flash-text-to-image", media: "image", operations: ["text_to_image"] },
  { id: "kie:seedream/5-flash-image-to-image", media: "image", operations: ["edit_image"] },
  { id: "kie:seedream/5-flash-layer-decomposition", media: "image", operations: ["layer_image"] },
  { id: "alibaba:qwen-image-2.0-pro", media: "image", operations: ["text_to_image"], title: "Qwen Image 2.0 Pro (Alibaba)" },
  { id: "alibaba:qwen-image-edit-plus", media: "image", operations: ["edit_image"], title: "Qwen Image Edit Plus (Alibaba)" },
  { id: "fal:fal-ai/nano-banana", media: "image", operations: ["text_to_image"], guide: "nano_banana", hidden: true },
  { id: "fal:fal-ai/nano-banana/edit", media: "image", operations: ["edit_image"], guide: "nano_banana", hidden: true },
  { id: "fal:fal-ai/nano-banana-2", media: "image", operations: ["text_to_image"], guide: "nano_banana", hidden: true },
  { id: "fal:fal-ai/nano-banana-2/edit", media: "image", operations: ["edit_image"], guide: "nano_banana", hidden: true },
  { id: "fal:google/nano-banana-2-lite", media: "image", operations: ["text_to_image"], guide: "nano_banana", hidden: true },
  { id: "fal:google/nano-banana-lite/edit", media: "image", operations: ["edit_image"], guide: "nano_banana", hidden: true },
  { id: "fal:fal-ai/nano-banana-pro", media: "image", operations: ["text_to_image"], guide: "nano_banana", hidden: true },
  { id: "fal:fal-ai/nano-banana-pro/edit", media: "image", operations: ["edit_image"], guide: "nano_banana", hidden: true },
  { id: "fal:google/nano-banana-2.1", media: "image", operations: ["text_to_image"], guide: "nano_banana", hidden: true },
  { id: "fal:google/nano-banana-2.1/edit", media: "image", operations: ["edit_image"], guide: "nano_banana", hidden: true },
  { id: "fal:fal-ai/bytedance/seedream/v5/lite/text-to-image", media: "image", operations: ["text_to_image"], hidden: true },
  { id: "fal:fal-ai/bytedance/seedream/v5/lite/edit", media: "image", operations: ["edit_image"], hidden: true },
  { id: "fal:xai/grok-imagine-image", media: "image", operations: ["text_to_image"], guide: "grok_image", hidden: true },
  { id: "fal:xai/grok-imagine-image/edit", media: "image", operations: ["edit_image"], guide: "grok_image", hidden: true },
  { id: "fal:fal-ai/qwen-image", media: "image", operations: ["text_to_image"], hidden: true },
  { id: "fal:fal-ai/qwen-image-edit", media: "image", operations: ["edit_image"], hidden: true },
  { id: "fal:alibaba/qwen-image-3/edit", media: "image", operations: ["edit_image"] },
  { id: "fal:fal-ai/wan/v2.7/edit", media: "image", operations: ["edit_image"], rules: { maxPromptChars: 500 }, hidden: true },
  { id: "fal:bria/fibo-edit-1.5/product-holding", media: "image", operations: ["edit_image"], prompt: "instruction", refs: { image: ["person_image_url", "product_image_urls"] } },
  { id: "fal:bria/fibo-edit-1.5/virtual-try-on", media: "image", operations: ["edit_image"], prompt: "instruction", refs: { image: ["person_image_url", "garment_image_urls"] } },
  { id: "fal:recraft/v4.1/flash/text-to-image", media: "image", operations: ["text_to_image"] },
  { id: "fal:bytedance/seedream/v5/flash/text-to-image", media: "image", operations: ["text_to_image"] },
  { id: "fal:bytedance/seedream/v5/flash/edit", media: "image", operations: ["edit_image"] },
  { id: "fal:bytedance/seedream/v5/flash/layerize", media: "image", operations: ["layer_image"] },
  { id: "fal:ideogram/v4.5", media: "image", operations: ["text_to_image"] },
  { id: "fal:ideogram/v4.5/edit", media: "image", operations: ["edit_image"], refs: { image: ["image_url", "reference_image_urls"] } },
  { id: "fal:blackforestlabs/flux-3/text-to-image", media: "image", operations: ["text_to_image"] },
  { id: "fal:blackforestlabs/flux-3/edit-image", media: "image", operations: ["edit_image"] },
  { id: "fal:bria/fibo-2/generate", media: "image", operations: ["text_to_image"] },
  { id: "fal:bria/fibo-2/edit", media: "image", operations: ["edit_image"], prompt: "instruction" },
  { id: "fal:fal-ai/flux-2-flex", media: "image", operations: ["text_to_image"] },
  { id: "fal:bria/guided-remove-background", media: "image", operations: ["edit_image"] },
  { id: "fal:bria/fibo-edit-1.5/expand", media: "image", operations: ["edit_image"] },
  { id: "fal:fal-ai/marigold-v2", media: "image", operations: ["edit_image"] },

  {
    id: "kie:bytedance/seedance-2-5",
    media: "video",
    operations: ["text_to_video", "image_to_video", "reference_to_video", "edit_video"],
    guide: "seedance25",
    dialect: "seedance",
    modes: [...SEEDANCE_MODES, { id: "v2v", label: "Edit video", roles: ["video", "image", "audio"], requireAny: ["video"] }],
    defaults: { ...LIGHTNING_VIDEO_OPTIONS },
    frameOptions: { aspect_ratio: "adaptive" },
  },
  {
    id: "kie:bytedance/seedance-2-5-draft",
    media: "video",
    operations: ["upscale_video"],
    title: "Seedance 2.5 Draft Complete",
    description: "Render the 1080p final of a Seedance 2.5 draft: a 480p kie:bytedance/seedance-2-5 run with draft on. Pass that run's Kie task id as draft_task_id.",
    defaults: { resolution: "1080p" },
  },
  { id: "kie:grok-imagine/image-to-video", media: "video", operations: ["image_to_video"], guide: "grok_imagine" },
  { id: "kie:grok-imagine/text-to-video", media: "video", operations: ["text_to_video"], guide: "grok_imagine", defaults: { duration: 6, resolution: "480p" } },
  { id: "kie:grok-imagine-video-1-5-preview", media: "video", operations: ["image_to_video"], title: "Grok Imagine Video 1.5 Preview (Kie)", guide: "grok_imagine", dialect: "natural_strip_frames" },
  { id: "kie:grok-imagine/extend", media: "video", operations: ["extend_video"], hidden: true },
  { id: "kie:grok-imagine/upscale", media: "video", operations: ["upscale_video"], hidden: true },
  { id: "kie:kling-3.0-omni/text-to-video", media: "video", operations: ["text_to_video"], guide: "kling30", dialect: "natural", defaults: { customize_multi_shots: false } },
  { id: "kie:kling-3.0-omni/image-to-video", media: "video", operations: ["image_to_video"], guide: "kling30", dialect: "natural", defaults: { aspect_ratio: "auto" }, pinnedDefaults: ["aspect_ratio"] },
  { id: "kie:kling-3.0-omni/reference-to-video", media: "video", operations: ["reference_to_video"], guide: "kling30", dialect: "natural", defaults: { audio: false } },
  {
    id: "kie:kling-3.0-omni/transformation",
    media: "video",
    operations: ["edit_video"],
    guide: "kling30",
    dialect: "natural",
    modes: [
      { id: "v2v", label: "Edit video", roles: ["video"], requireAny: ["video"], defaults: { aspect_ratio: "auto" } },
      { id: "v2v_refs", label: "Edit with references", roles: ["video", "image"], requireAny: ["video"] },
    ],
  },
  { id: "kie:kling-3.0/motion-control", media: "video", operations: ["motion_control"], guide: "kling30", dialect: "natural", defaults: { mode: "720p" } },
  { id: "kie:kling-4.0/reference-to-video", media: "video", operations: ["reference_to_video"], dialect: "kling4" },
  { id: "kie:kling-4.0/keyframe-to-video", media: "video", operations: ["image_to_video"], dialect: "kling4_keyframes", refs: { image: "keyframe_urls" } },
  { id: "kie:gemini-omni-video", media: "video", operations: ["image_to_video", "edit_video"], dialect: "natural_source_video", defaults: { duration: "8" }, modes: [{ id: "i2v", label: "Image to video", roles: ["image"] }, { id: "v2v", label: "Edit video", roles: ["video", "image"], requireAny: ["video"] }], refItem: { video: { start: 0, ends: 8 } }, aliases: { clip_start: "video_list.0.start", clip_end: "video_list.0.ends" } },
  { id: "kie:wan/3-0-video", media: "video", operations: ["text_to_video", "image_to_video", "reference_to_video"], dialect: "seedance", modes: SEEDANCE_MODES },
  { id: "kie:wan/3-0-video-prime", media: "video", operations: ["text_to_video", "image_to_video", "reference_to_video"], dialect: "seedance", modes: SEEDANCE_MODES },
  { id: "kie:happyhorse-1-1/text-to-video", media: "video", operations: ["text_to_video"] },
  { id: "kie:happyhorse-1-1/image-to-video", media: "video", operations: ["image_to_video"], dialect: "strip_frames" },
  { id: "kie:happyhorse-1-1/reference-to-video", media: "video", operations: ["reference_to_video"], dialect: "brackets" },
  { id: "kie:happyhorse/video-edit", media: "video", operations: ["edit_video"], dialect: "happyhorse_edit" },
  { id: "kie:minimax-h3/text-to-video", media: "video", operations: ["text_to_video"] },
  { id: "kie:minimax-h3/image-to-video", media: "video", operations: ["image_to_video"], dialect: "strip_frames" },
  { id: "kie:minimax-h3/reference-to-video", media: "video", operations: ["reference_to_video"], dialect: "natural", rules: { refDurationMs: MiniMaxH3ReferenceClipDurationMs } },
  { id: "kie:volcengine/video-to-video-lip-sync", media: "video", operations: ["lip_sync"] },
  { id: "kie:omnihuman-1-5", media: "video", operations: ["image_to_video", "lip_sync"], dialect: "natural" },
  { id: "kie:omnihuman-2-0", media: "video", operations: ["image_to_video", "lip_sync"], dialect: "natural" },
  { id: "kie:vidu-q4/image-to-video", media: "video", operations: ["image_to_video"], dialect: "natural_kinds" },
  { id: "kie:vidu-q4/reference-to-video", media: "video", operations: ["reference_to_video"], dialect: "natural_kinds" },
  { id: "kie:pixverse-v6-max/text-to-video", media: "video", operations: ["text_to_video"], defaults: { quality: "1080p" } },
  { id: "kie:pixverse-v6-max/image-to-video", media: "video", operations: ["image_to_video"], dialect: "strip_frames", defaults: { quality: "1080p" } },
  { id: "kie:veo3", media: "video", operations: ["text_to_video", "image_to_video"], title: "Veo 3 (Kie)" },
  { id: "kie:veo3_fast", media: "video", operations: ["text_to_video", "image_to_video"], title: "Veo 3 Fast (Kie)" },
  { id: "xai:grok-imagine-video", media: "video", operations: ["text_to_video", "image_to_video", "reference_to_video", "edit_video"], guide: "grok_imagine", title: "Grok Imagine Video (xAI)", dialect: "natural", refs: { first_frame: "image", audio: null }, modes: XAI_MODES },
  { id: "fal:xai/grok-imagine-video/image-to-video", media: "video", operations: ["image_to_video"], guide: "grok_imagine", hidden: true },
  { id: "fal:xai/grok-imagine-video/reference-to-video", media: "video", operations: ["reference_to_video"], guide: "grok_imagine", hidden: true },
  { id: "fal:xai/grok-imagine-video/extend-video", media: "video", operations: ["extend_video"], hidden: true },
  { id: "fal:xai/grok-imagine-video/edit-video", media: "video", operations: ["edit_video"], guide: "grok_imagine", hidden: true },
  { id: "fal:xai/grok-imagine-video/v1.5/lite/image-to-video", media: "video", operations: ["image_to_video"] },
  { id: "fal:xai/grok-imagine-video/v1.5/lite/text-to-video", media: "video", operations: ["text_to_video"] },
  { id: "fal:alibaba/wan-3.0/text-to-video", media: "video", operations: ["text_to_video"], hidden: true },
  { id: "fal:alibaba/wan-3.0/image-to-video", media: "video", operations: ["image_to_video"], hidden: true },
  { id: "fal:alibaba/wan-3.0/reference-to-video", media: "video", operations: ["reference_to_video"], hidden: true },
  { id: "fal:alibaba/wan-3.0-prime/text-to-video", media: "video", operations: ["text_to_video"], hidden: true },
  { id: "fal:alibaba/wan-3.0-prime/image-to-video", media: "video", operations: ["image_to_video"], hidden: true },
  { id: "fal:alibaba/wan-3.0-prime/reference-to-video", media: "video", operations: ["reference_to_video"], hidden: true },
  { id: "fal:kling/v4/text-to-video", media: "video", operations: ["text_to_video"], dialect: "seedance" },
  { id: "fal:kling/v4/image-to-video", media: "video", operations: ["image_to_video"], dialect: "seedance", modes: FRAME_MODES },
  { id: "fal:kling/v4/reference-to-video", media: "video", operations: ["reference_to_video"], dialect: "seedance" },
  { id: "fal:kling/v4/video-to-video/edit", media: "video", operations: ["edit_video"], dialect: "seedance" },
  { id: "fal:heygen/heygen-video/text-to-video", media: "video", operations: ["text_to_video"], dialect: "natural" },
  { id: "fal:heygen/heygen-video/image-to-video", media: "video", operations: ["image_to_video"], dialect: "strip_frames", refs: { first_frame: "image_url" } },
  { id: "fal:heygen/heygen-video/reference-to-video", media: "video", operations: ["reference_to_video"], dialect: "natural", modes: [{ id: "r2v", label: "References", roles: ["image", "video", "audio"], requireAny: ["image", "video"] }] },
  ...[3, 4].map((version): ModelEntry => ({
    id: `fal:fal-ai/heygen/avatar${version}/digital-twin`,
    media: "video",
    operations: ["text_to_video"],
    dialect: "plain",
    prompt: "voice.prompt",
    defaults: { character: { avatar: "Abigail Office Front" }, voice: { voice: "Ivy" } },
    aliases: { avatar: "character.avatar", avatar_style: "character.avatar_style", voice: "voice.voice", voice_id: "voice.voice_id", speed: "voice.speed" },
  })),
  { id: "fal:fal-ai/heygen/avatar5/digital-twin", media: "video", operations: ["text_to_video"], dialect: "plain" },
  { id: "fal:fal-ai/heygen/avatar4/image-to-video", media: "video", operations: ["image_to_video"], dialect: "plain", defaults: { voice: "Ivy" } },
  { id: "fal:fal-ai/heygen/v2/video-agent", media: "video", operations: ["text_to_video"], dialect: "plain" },
  { id: "fal:fal-ai/heygen/v3/video-agent", media: "video", operations: ["text_to_video"], dialect: "plain" },
  { id: "fal:blackforestlabs/flux-3-max/text-to-video", media: "video", operations: ["text_to_video"], title: "FLUX 3 Max", defaults: FLUX_3_MAX_DEFAULTS },
  { id: "fal:blackforestlabs/flux-3-max/image-to-video", media: "video", operations: ["image_to_video"], title: "FLUX 3 Max Image", refs: { first_frame: "image_url" }, modes: FRAME_MODES, defaults: FLUX_3_MAX_DEFAULTS },
  { id: "fal:blackforestlabs/flux-3-max/keyframes-to-video", media: "video", operations: ["image_to_video"], title: "FLUX 3 Max Keyframes", refs: { image: "keyframes" }, keyframeFps: 24, defaults: FLUX_3_MAX_DEFAULTS },
  { id: "fal:minimax/h3-max/reframe-video", media: "video", operations: ["edit_video"] },
  { id: "fal:minimax/h3-max/insert-video", media: "video", operations: ["edit_video"], refs: { video: ["video_url", "reference_video_urls"] } },
  { id: "fal:minimax/h3-max/recast", media: "video", operations: ["edit_video"] },
  { id: "fal:minimax/h3-max-turbo/extend-video", media: "video", operations: ["extend_video"] },
  { id: "fal:minimax/h3-max/relight", media: "video", operations: ["edit_video"] },
  h3MaxStyle("16bit-pixel"),
  h3MaxStyle("hand-drawn"),
  h3MaxStyle("low-poly"),
  h3MaxStyle("retro-toon-70s"),
  h3MaxStyle("vhs"),
  { id: "fal:bytedance/seedance-2.5/us/text-to-video", media: "video", operations: ["text_to_video"], guide: "seedance25", dialect: "seedance", hidden: true },
  { id: "fal:bytedance/seedance-2.5/us/image-to-video", media: "video", operations: ["image_to_video"], guide: "seedance25", dialect: "seedance", refs: { first_frame: "image_url" }, modes: FRAME_MODES, hidden: true },
  { id: "fal:bytedance/seedance-2.5/us/reference-to-video", media: "video", operations: ["reference_to_video", "edit_video", "extend_video"], guide: "seedance25", dialect: "seedance", modes: SEEDANCE_US_REFERENCE_MODES, hidden: true },
  { id: "fal:bytedance/seedance-2.5/draft/complete", media: "video", operations: ["upscale_video"], title: "Seedance 2.5 Draft Complete", hidden: true },
  { id: "fal:bytedance/seedance-2.0/us/text-to-video", media: "video", operations: ["text_to_video"], guide: "seedance2", dialect: "seedance" },
  { id: "fal:bytedance/seedance-2.0/us/image-to-video", media: "video", operations: ["image_to_video"], guide: "seedance2", dialect: "seedance", refs: { first_frame: "image_url" }, modes: FRAME_MODES },
  { id: "fal:bytedance/seedance-2.0/us/reference-to-video", media: "video", operations: ["reference_to_video"], guide: "seedance2", dialect: "seedance", modes: [{ id: "r2v", label: "References", roles: ["image", "video", "audio"], requireAny: ["image", "video"] }] },
  { id: "fal:fal-ai/kling-video/o3/standard/image-to-video", media: "video", operations: ["image_to_video"], guide: "kling30", dialect: "strip_frames", refs: { first_frame: "image_url" }, modes: FRAME_MODES },
  { id: "fal:fal-ai/kandinsky6-pro/text-to-video", media: "video", operations: ["text_to_video"] },
  { id: "fal:fal-ai/kandinsky6-pro/image-to-video", media: "video", operations: ["image_to_video"], dialect: "strip_frames" },
  { id: "fal:fal-ai/kandinsky6-lite/text-to-video", media: "video", operations: ["text_to_video"] },
  { id: "fal:fal-ai/kandinsky6-lite/image-to-video", media: "video", operations: ["image_to_video"], dialect: "strip_frames" },
  { id: "fal:fal-ai/kandinsky6-vsr", media: "video", operations: ["upscale_video"] },
  { id: "fal:fal-ai/kandinsky6-vsr/lite", media: "video", operations: ["upscale_video"] },
  { id: "fal:fal-ai/vidu/q4/image-to-video", media: "video", operations: ["image_to_video"], dialect: "natural_kinds", hidden: true },
  { id: "fal:fal-ai/vidu/q4/reference-to-video", media: "video", operations: ["reference_to_video"], dialect: "vidu", hidden: true },
  { id: "fal:pixverse/music-video/vibemv", media: "video", operations: ["reference_to_video"], refs: { image: ["image_url", "style_image_url"] } },
  { id: "fal:pixelcut/looping-video", media: "video", operations: ["image_to_video"], dialect: "strip_frames" },
  { id: "fal:creatify/boreal", media: "video", operations: ["text_to_video", "image_to_video", "lip_sync"] },
  { id: "fal:mirelo-ai/sfx2.0/video-to-video", media: "video", operations: ["edit_video"], prompt: "text_prompt", defaults: { num_samples: 1 } },
  {
    id: "machgen:MiniMax-H3",
    media: "video",
    operations: MACHGEN_VIDEO,
    title: "MiniMax H3 (MachGen)",
    dialect: "natural_strip_frames",
    modes: machgenModes({ ...MACHGEN_FRAMES, requireAny: ["first_frame", "last_frame"] }, MACHGEN_MEDIA),
    rules: machgenClips(15),
  },
  {
    id: "machgen:Seedance-2.5",
    media: "video",
    operations: MACHGEN_VIDEO,
    title: "Seedance 2.5 (MachGen)",
    guide: "seedance25",
    dialect: "natural_strip_frames",
    modes: machgenModes(MACHGEN_FRAMES, MACHGEN_MEDIA),
    frameOptions: { aspect_ratio: "adaptive" },
    rules: machgenClips(30),
  },
  {
    id: "machgen:Seedance-2.0",
    media: "video",
    operations: MACHGEN_VIDEO,
    title: "Seedance 2.0 (MachGen)",
    guide: "seedance2",
    dialect: "natural_strip_frames",
    modes: machgenModes(MACHGEN_FRAMES, MACHGEN_MEDIA, ["image", "video"]),
    rules: machgenClips(15),
  },
  {
    id: "machgen:Alibaba-Wan-3.0",
    media: "video",
    operations: MACHGEN_VIDEO,
    title: "Wan 3.0 (MachGen)",
    dialect: "natural_strip_frames",
    modes: machgenModes(MACHGEN_FRAMES, MACHGEN_MEDIA),
    rules: machgenClips(15),
  },
  {
    id: "machgen:HappyHorse-1.1",
    media: "video",
    operations: MACHGEN_VIDEO,
    title: "HappyHorse 1.1 (MachGen)",
    dialect: "natural_strip_frames",
    modes: machgenModes({ ...MACHGEN_FRAMES, roles: ["first_frame"] }, ["image"]),
  },
  { id: "machgen:Grok-Imagine-Video-1.5", media: "video", operations: ["image_to_video"], title: "Grok Imagine Video 1.5 (MachGen)", guide: "grok_imagine", dialect: "natural_strip_frames" },

  { id: "elevenlabs:text-to-speech", media: "audio", operations: ["speech"], title: "ElevenLabs Text to Speech", defaults: { model_id: "eleven_multilingual_v2" } },
  { id: "elevenlabs:sound-generation", media: "audio", operations: ["sfx"], title: "ElevenLabs Sound Effects" },
  { id: "elevenlabs:music", media: "audio", operations: ["music"], title: "ElevenLabs Music", defaults: { force_instrumental: true } },
  { id: "elevenlabs:video-to-music", media: "audio", operations: ["video_to_music"], title: "ElevenLabs Video to Music" },
  { id: "kie:elevenlabs/sound-effect-v2", media: "audio", operations: ["sfx"] },
  kieElevenLabsTts("kie:elevenlabs/text-to-speech-multilingual-v2", "ElevenLabs Multilingual v2 (Kie)"),
  kieElevenLabsTts("kie:elevenlabs/text-to-speech-turbo-2-5", "ElevenLabs Turbo 2.5 (Kie)"),
  {
    id: "kie:elevenlabs/text-to-dialogue-v3",
    media: "audio",
    operations: ["dialogue"],
    title: "ElevenLabs v3 Dialogue (Kie)",
    prompt: "dialogue.0.text",
    aliases: { voice: "dialogue.0.voice" },
    defaults: { dialogue: [{ voice: "Rachel" }] },
  },
  kieGeminiClassicTts("kie:google/gemini-2-5-pro-tts", "Gemini 2.5 Pro TTS (Kie)"),
  kieGeminiClassicTts("kie:google/gemini-3-1-flash-tts", "Gemini 3.1 Flash TTS (Kie)"),
  kieGemini38Tts("kie:google/gemini-3-8-flash-tts", "Gemini 3.8 Flash TTS (Kie)"),
  kieGemini38Tts("kie:google/gemini-3-8-flash-lite-tts", "Gemini 3.8 Flash Lite TTS (Kie)"),
  { id: "kie:suno/generate", media: "audio", operations: ["music"], title: "Suno (Kie)", defaults: { model: "V5_5", instrumental: true, customMode: false } },
  { id: "kie:suno/sounds-generate", media: "audio", operations: ["sfx"], title: "Suno Sounds (Kie)", defaults: { model: "V5_5" } },
  { id: "fal:elevenlabs/music/v2.5", media: "audio", operations: ["music"], defaults: { force_instrumental: true, output_format: "mp3_48000_192" } },
  { id: "fal:minimax/music-3", media: "audio", operations: ["music"], defaults: { lyrics: "[Instrumental]" } },
  { id: "fal:elevenlabs/tts/eleven-v4", media: "audio", operations: ["speech"], defaults: { voice: "Rachel", output_format: "mp3_44100_128" } },
  { id: "fal:elevenlabs/tts/eleven-v4-turbo", media: "audio", operations: ["speech"], defaults: { voice: "Rachel", output_format: "mp3_44100_128" } },
  { id: "fal:google/gemini-3.8-flash-tts", media: "audio", operations: ["speech"], defaults: { voice: "Kore" } },
  { id: "fal:google/gemini-3.8-flash-lite-tts", media: "audio", operations: ["speech"], defaults: { voice: "Kore" } },
  { id: "fal:alibaba/qwen-audio-3-tts", media: "audio", operations: ["speech"], defaults: { voice: "Cherry", language: "Auto" } },
  { id: "fal:fal-ai/bytedance/seed-speech/tts/v2", media: "audio", operations: ["speech"], defaults: { output_format: "mp3" } },
];

const ENTRIES_BY_ID = new Map(MODEL_ENTRIES.map((entry) => [entry.id, entry]));

export function modelEntry(id: string): ModelEntry | undefined {
  return ENTRIES_BY_ID.get(id);
}
