import type { EstimateRequest } from "@apicity/cost";
import {
  GeminiOmniVideoRequestSchema,
  GptImage2ImageToImageRequestSchema,
  GptImage2TextToImageRequestSchema,
  GrokImageToVideoRequestSchema,
  HappyHorse11ImageToVideoRequestSchema,
  HappyHorse11ReferenceToVideoRequestSchema,
  HappyHorse11TextToVideoRequestSchema,
  KlingV3TurboTextToVideoRequestSchema,
  NanoBananaProRequestSchema,
  Seedance2FastInputSchema,
  Seedance2InputSchema,
  Seedance2MiniInputSchema,
  Wan27ImageProRequestSchema,
  Wan27ImageRequestSchema,
} from "@apicity/kie/zod";

export type CostAdapter = (input: Record<string, unknown>) => EstimateRequest | null;

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number | undefined => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
};

type DefaultSchema = {
  safeParse: (value: undefined) =>
    | { success: true; data: unknown }
    | { success: false };
};

function apicityDefault<T>(schema: DefaultSchema, field: string): T {
  const result = schema.safeParse(undefined);
  if (!result.success) throw new Error(`@apicity schema has no default for ${field}`);
  return result.data as T;
}

const SEEDANCE2_DURATION = apicityDefault<number>(Seedance2InputSchema.shape.duration, "Seedance 2 duration");
const SEEDANCE2_FAST_DURATION = apicityDefault<number>(Seedance2FastInputSchema.shape.duration, "Seedance 2 Fast duration");
const SEEDANCE2_MINI_DURATION = apicityDefault<number>(Seedance2MiniInputSchema.shape.duration, "Seedance 2 Mini duration");
const SEEDANCE2_MINI_RESOLUTION = apicityDefault<string>(Seedance2MiniInputSchema.shape.resolution, "Seedance 2 Mini resolution");
const GROK_I2V_DURATION = apicityDefault<number>(GrokImageToVideoRequestSchema.shape.input.shape.duration, "Grok image-to-video duration");
const GROK_I2V_RESOLUTION = apicityDefault<string>(GrokImageToVideoRequestSchema.shape.input.shape.resolution, "Grok image-to-video resolution");
const KLING_TURBO_DURATION = apicityDefault<string>(KlingV3TurboTextToVideoRequestSchema.shape.input.shape.duration, "Kling Turbo duration");
const KLING_TURBO_RESOLUTION = apicityDefault<string>(KlingV3TurboTextToVideoRequestSchema.shape.input.shape.resolution, "Kling Turbo resolution");
const HAPPYHORSE_T2V_DURATION = apicityDefault<number>(HappyHorse11TextToVideoRequestSchema.shape.input.shape.duration, "HappyHorse text-to-video duration");
const HAPPYHORSE_T2V_RESOLUTION = apicityDefault<string>(HappyHorse11TextToVideoRequestSchema.shape.input.shape.resolution, "HappyHorse text-to-video resolution");
const HAPPYHORSE_I2V_DURATION = apicityDefault<number>(HappyHorse11ImageToVideoRequestSchema.shape.input.shape.duration, "HappyHorse image-to-video duration");
const HAPPYHORSE_I2V_RESOLUTION = apicityDefault<string>(HappyHorse11ImageToVideoRequestSchema.shape.input.shape.resolution, "HappyHorse image-to-video resolution");
const HAPPYHORSE_R2V_DURATION = apicityDefault<number>(HappyHorse11ReferenceToVideoRequestSchema.shape.input.shape.duration, "HappyHorse reference-to-video duration");
const HAPPYHORSE_R2V_RESOLUTION = apicityDefault<string>(HappyHorse11ReferenceToVideoRequestSchema.shape.input.shape.resolution, "HappyHorse reference-to-video resolution");
const GPT_IMAGE_I2I_RESOLUTION = apicityDefault<string>(GptImage2ImageToImageRequestSchema.shape.input.shape.resolution, "GPT Image image-to-image resolution");
const GPT_IMAGE_T2I_RESOLUTION = apicityDefault<string>(GptImage2TextToImageRequestSchema.shape.input.shape.resolution, "GPT Image text-to-image resolution");
const NANO_BANANA_PRO_RESOLUTION = apicityDefault<string>(NanoBananaProRequestSchema.shape.input.shape.resolution, "Nano Banana Pro resolution");
const WAN27_IMAGE_RESOLUTION = apicityDefault<string>(Wan27ImageRequestSchema.shape.input.shape.resolution, "Wan 2.7 Image resolution");
const WAN27_IMAGE_PRO_RESOLUTION = apicityDefault<string>(Wan27ImageProRequestSchema.shape.input.shape.resolution, "Wan 2.7 Image Pro resolution");
const GEMINI_OMNI_RESOLUTION = apicityDefault<string>(GeminiOmniVideoRequestSchema.shape.input.shape.resolution, "Gemini Omni resolution");

// OpenAI text payloads mirror the upstream API body. The cost lib's
// extractor flattens chat/responses payloads to a single string for the
// chars/4 token heuristic, then prices via the bundled rate table.
const openaiText = (model: string, defaultMaxOut?: number): CostAdapter => (input) => {
  const max = num(input.max_output_tokens) ?? defaultMaxOut;
  return {
    provider: "openai",
    payload: {
      model,
      input: str(input.prompt) || str(input.text) || "",
      ...(max !== undefined ? { max_output_tokens: max } : {}),
    },
  };
};

// Kie seedance: the cost lib reads payload.input.{resolution, duration} and
// uses payload.input.first_frame_url to discriminate i2v vs t2v. Each unified
// tool entry locks the apiModel; we surface i2v pricing when any first/last
// frame or reference input is present, else t2v.
const kieSeedance = (
  apiModel: "bytedance/seedance-2" | "bytedance/seedance-2-fast",
  defaultDuration: number,
): CostAdapter => (input) => {
  const hasInput =
    Boolean(str(input.first_frame_slug)) ||
    Boolean(str(input.last_frame_slug)) ||
    (Array.isArray(input.image_slugs) && input.image_slugs.length > 0) ||
    (Array.isArray(input.video_slugs) && input.video_slugs.length > 0) ||
    (Array.isArray(input.audio_slugs) && input.audio_slugs.length > 0);
  return {
    provider: "kie",
    payload: {
      model: apiModel,
      input: {
        resolution: str(input.resolution) || "720p",
        duration: num(input.duration) ?? num(input.seconds) ?? defaultDuration,
        ...(hasInput ? { first_frame_url: "stub" } : {}),
      },
    },
  };
};

// kling-3.0/video keys by mode + sound (sound===true selects "|sound").
const kieKling30Video: CostAdapter = (input) => ({
  provider: "kie",
  payload: {
    model: "kling-3.0/video",
    input: {
      mode: str(input.mode) || "std",
      sound: input.sound !== false,
      duration: num(input.duration) ?? 5,
    },
  },
});

// kling-3.0/motion-control keys by mode ("720p" | "1080p"). Audio is not
// separately priced for motion-control.
const kieKling30MotionControl: CostAdapter = (input) => ({
  provider: "kie",
  payload: {
    model: "kling-3.0/motion-control",
    input: {
      mode: str(input.mode) || "720p",
      duration: num(input.duration) ?? 5,
    },
  },
});

// kie image-tier adapter: prices keyed by input.resolution ("1K"|"2K"|"4K").
// gpt-image-2, nano-banana-pro, and wan/2-7-image{,-pro} all accept resolution
// upstream — forward when present, else fall back to the default tier so an
// unconfigured request still returns a price.
const kieTieredImage = (model: string, defaultResolution: string): CostAdapter => (input) => ({
  provider: "kie",
  payload: {
    model,
    input: {
      resolution: str(input.resolution) || defaultResolution,
    },
  },
});

// kie flat per-image adapter for models that price one rate regardless of
// shape (qwen2, seedream/5-lite). The rate table reads input.n (defaulting
// to 1) — videocity tools never expose n, so we just leave it out.
const kieFlatImage = (model: string): CostAdapter => () => ({
  provider: "kie",
  payload: { model, input: {} },
});

// kie flat per-second video adapter (wan/2-7-* video family — all priced at
// $0.10/s regardless of resolution). The rate table reads input.duration in
// seconds; videocity tools pass duration as a numeric string we coerce here.
const kieFlatVideo = (model: string, defaultSeconds = 5): CostAdapter => (input) => ({
  provider: "kie",
  payload: {
    model,
    input: {
      duration: num(input.duration) ?? defaultSeconds,
    },
  },
});

// kie resolution-tiered video adapter (grok-imagine + happyhorse). Both
// families key per-second rates off input.resolution. happyhorse/video-edit
// has no duration field upstream — videocity's tool also omits it — so we
// fall back to defaultSeconds for a nonzero estimate.
const kieResolutionVideo = (
  model: string,
  defaultResolution: string,
  defaultSeconds = 5,
): CostAdapter => (input) => ({
  provider: "kie",
  payload: {
    model,
    input: {
      resolution: str(input.resolution) || defaultResolution,
      duration: num(input.duration) ?? defaultSeconds,
    },
  },
});

// kie grok-imagine/text-to-image: 2 rates by enable_pro (false → $0.02,
// true → $0.025). Per-call pricing — input shape is just the toggle.
const kieGrokImagineTextImage: CostAdapter = (input) => ({
  provider: "kie",
  payload: {
    model: "grok-imagine/text-to-image",
    input: {
      ...(input.enable_pro === true ? { enable_pro: true } : {}),
    },
  },
});

// kie grok-imagine/image-to-image: flat $0.02 per call.
const kieGrokImagineImageEdit: CostAdapter = () => ({
  provider: "kie",
  payload: { model: "grok-imagine/image-to-image", input: {} },
});

const kieGrokImagineExtend: CostAdapter = (input) => ({
  provider: "kie",
  payload: {
    model: "grok-imagine/extend",
    resolution: str(input.resolution) || "480p",
    input: {
      extend_times: str(input.extend_times) || "6",
    },
  },
});

const kieGrokImagineUpscale: CostAdapter = () => ({
  provider: "kie",
  payload: { model: "grok-imagine/upscale", input: {} },
});

const elevenLabsTts: CostAdapter = (input) => ({
  provider: "elevenlabs",
  payload: {
    model_id: str(input.model_id) || "eleven_multilingual_v2",
    text: str(input.text),
  },
});

// @apicity/cost@0.8.0 coerces string durations and prices V2V as `v2v|N`.
// Pass duration through as-is (string or number); only default when absent.
const kieGeminiOmniVideo: CostAdapter = (input) => ({
  provider: "kie",
  payload: {
    model: "gemini-omni-video",
    input: {
      duration: input.duration ?? 4,
      resolution: str(input.resolution) || GEMINI_OMNI_RESOLUTION,
      ...(str(input.video_slug) ? { video_list: [{ url: "stub", start: 0, ends: 4 }] } : {}),
    },
  },
});

// Per-request cost hints that the paygate should see but the wire payload
// must not carry. Used for kie models whose input schema has no duration field
// even though they bill per second of source/motion/driving media:
// happyhorse/video-edit, kling-3.0/motion-control, omnihuman-1-5,
// volcengine/video-to-video-lip-sync. Job handlers resolve measured duration
// and pass it here; mintKieOtp feeds it only to computeEstimate.
export type KieCostHints = { duration?: number };

const HINTED_PER_SECOND_MODELS = new Set<string>([
  "happyhorse/video-edit",
  "kling-3.0/motion-control",
  "omnihuman-1-5",
  "volcengine/video-to-video-lip-sync",
]);

export function normalizeKieCostPayload(
  payload: Record<string, unknown>,
  hints: KieCostHints = {},
): Record<string, unknown> {
  // For per-second models whose kie input schema carries no duration field,
  // surface the out-of-band hint so computeEstimate can derive a per-second
  // rate. Prefer top-level `duration` (package seconds picker reads
  // input.duration ?? p.duration). The hint is never serialized into the wire.
  if (
    typeof payload.model === "string"
    && HINTED_PER_SECOND_MODELS.has(payload.model)
    && typeof hints.duration === "number"
    && hints.duration > 0
  ) {
    return { ...payload, duration: hints.duration };
  }

  return payload;
}

// Map MCP tool_name -> EstimateRequest builder. Tools not listed here return
// null from getCostAdapter() and surface in the UI as "—" (no rate available),
// unless a local estimator handles them (see estimateGoogleFlowCost).
// Fal image tools that appear in @apicity/cost@0.8.0 have adapters; Fal video
// and unlisted edit endpoints remain unpriced (docs/apicity-gaps.md §26).
// Google Flow tools keep the local Gemini API list-rate table in
// google-flow-cost.ts — package googleflow rates are credit×Pro, not API USD
// (docs/apicity-gaps.md §15, product choice A).
const KIE_ADAPTERS: Record<string, CostAdapter> = {
  // --- KIE per-second video ---
  generate_seedance2_video: kieSeedance("bytedance/seedance-2", SEEDANCE2_DURATION),
  generate_seedance2_fast_video: kieSeedance("bytedance/seedance-2-fast", SEEDANCE2_FAST_DURATION),
  // Mini prices per-second by resolution (480p / 720p — the only tiers the tool
  // exposes); no first/last-frame split, so kieResolutionVideo is the right
  // shape. @apicity/cost@0.6.1 added this rate (was "—" under 0.6.0). See
  // docs/apicity-gaps.md §10.
  generate_seedance2_mini_video: kieResolutionVideo("bytedance/seedance-2-mini", SEEDANCE2_MINI_RESOLUTION, SEEDANCE2_MINI_DURATION),
  generate_gemini_omni_video: kieGeminiOmniVideo,
  generate_kling30_video: kieKling30Video,
  generate_kling30_motion_control_video: kieKling30MotionControl,
  generate_kling30_turbo_video: (args: Record<string, unknown>) => {
    const imageSlugs = (args.image_slugs as string[] | undefined) ?? [];
    const model = imageSlugs.length > 0 ? "kling/v3-turbo-image-to-video" : "kling/v3-turbo-text-to-video";
    return kieResolutionVideo(model, KLING_TURBO_RESOLUTION, Number(KLING_TURBO_DURATION))(args);
  },

  // --- KIE Veo 3 / Veo 3 Fast (flat per-second, priced in cost@0.7.0) ---
  generate_veo3_video: kieFlatVideo("veo3"),
  generate_veo3_fast_video: kieFlatVideo("veo3_fast"),

  // --- KIE Wan 2.7 video (flat $0.10/s across all four endpoints) ---
  generate_wan27_t2v_video: kieFlatVideo("wan/2-7-text-to-video"),
  generate_wan27_i2v_video: kieFlatVideo("wan/2-7-image-to-video"),
  generate_wan27_r2v_video: kieFlatVideo("wan/2-7-r2v"),
  // videoedit upstream has no duration field (output matches source). Tool
  // default is "0" which would zero out the estimate, so default to 5s.
  generate_wan27_videoedit_video: kieFlatVideo("wan/2-7-videoedit"),
  // extend reuses the i2v rate ($0.10/s). Tool exposes duration; default 5s.
  extend_wan27_video: kieFlatVideo("wan/2-7-image-to-video"),

  // --- KIE Grok Imagine video (resolution-tiered, $0.008/$0.015 per sec) ---
  generate_grok_imagine_video: kieResolutionVideo("grok-imagine/image-to-video", GROK_I2V_RESOLUTION, GROK_I2V_DURATION),
  generate_grok_imagine_t2v_video: kieResolutionVideo("grok-imagine/text-to-video", "480p", 6),
  extend_grok_imagine_video: kieGrokImagineExtend,
  upscale_grok_imagine_video: kieGrokImagineUpscale,

  // --- KIE HappyHorse video (resolution-tiered, per-second) ---
  // t2v/i2v/ref generate against happyhorse-1-1/* (see payload-builders.ts), and
  // @apicity/cost@0.6.1 now prices those 1.1 keys directly. The 1.1 rates differ
  // from 1.0 ($0.165/$0.22 per sec vs $0.155/$0.265), so we key off the actual
  // 1.1 slugs here rather than borrowing 1.0. videoedit stays on the 1.0
  // happyhorse/video-edit slug (no 1.1 video-edit endpoint exists).
  generate_happyhorse_t2v_video: kieResolutionVideo("happyhorse-1-1/text-to-video", HAPPYHORSE_T2V_RESOLUTION, HAPPYHORSE_T2V_DURATION),
  generate_happyhorse_i2v_video: kieResolutionVideo("happyhorse-1-1/image-to-video", HAPPYHORSE_I2V_RESOLUTION, HAPPYHORSE_I2V_DURATION),
  generate_happyhorse_ref_video: kieResolutionVideo("happyhorse-1-1/reference-to-video", HAPPYHORSE_R2V_RESOLUTION, HAPPYHORSE_R2V_DURATION),
  generate_happyhorse_videoedit_video: kieResolutionVideo("happyhorse/video-edit", "1080p"),

  // --- KIE GPT Image 2 (per-image, tiered by resolution) ---
  generate_gpt_image: kieTieredImage("gpt-image-2-image-to-image", GPT_IMAGE_I2I_RESOLUTION),
  generate_gpt_image_text: kieTieredImage("gpt-image-2-text-to-image", GPT_IMAGE_T2I_RESOLUTION),

  // --- KIE Nano Banana Pro (per-image, tiered by resolution) ---
  generate_nano_banana_image: kieTieredImage("nano-banana-pro", NANO_BANANA_PRO_RESOLUTION),

  // --- KIE Wan 2.7 image (per-image, tiered by resolution) ---
  generate_wan27_image: kieTieredImage("wan/2-7-image", WAN27_IMAGE_RESOLUTION),
  generate_wan27_image_pro: kieTieredImage("wan/2-7-image-pro", WAN27_IMAGE_PRO_RESOLUTION),

  // --- KIE flat per-image (qwen2 $0.028, seedream/5-lite $0.0275) ---
  generate_qwen2_image_edit: kieFlatImage("qwen2/image-edit"),
  generate_seedream_text_image: kieFlatImage("seedream/5-lite-text-to-image"),
  generate_seedream_image: kieFlatImage("seedream/5-lite-image-to-image"),

  // --- KIE Grok Imagine images (flat per-call) ---
  generate_grok_imagine_text_image: kieGrokImagineTextImage,
  generate_grok_imagine_image: kieGrokImagineImageEdit,

  // --- KIE OmniHuman / Volcengine (per-second; duration from source media) ---
  // Schema has no duration field; estimate_cost + job handlers inject it via
  // source metadata / KieCostHints (docs/apicity-gaps.md §30).
  generate_omnihuman_video: (input) => ({
    provider: "kie",
    payload: {
      model: "omnihuman-1-5",
      duration: num(input.duration) ?? 5,
      input: {},
    },
  }),
  generate_volcengine_lipsync_video: (input) => ({
    provider: "kie",
    payload: {
      model: "volcengine/video-to-video-lip-sync",
      duration: num(input.duration) ?? 5,
      input: {},
    },
  }),
};

// xAI media rates use docs.x.ai model keys (not Kie grok-imagine/* slugs).
// Video units read top-level `duration` only.
const xaiGrokImagineImage: CostAdapter = (input) => ({
  provider: "xai",
  payload: {
    model: "grok-imagine-image",
    n: num(input.n) ?? 1,
  },
});

const xaiGrokImagineVideo: CostAdapter = (input) => ({
  provider: "xai",
  payload: {
    model: "grok-imagine-video",
    duration: num(input.duration) ?? num(input.seconds) ?? 6,
  },
});

const XAI_ADAPTERS: Record<string, CostAdapter> = {
  generate_grok_imagine_text_image: xaiGrokImagineImage,
  generate_grok_imagine_image: xaiGrokImagineImage,
  generate_grok_imagine_video: xaiGrokImagineVideo,
  generate_grok_imagine_t2v_video: xaiGrokImagineVideo,
  generate_grok_imagine_ref_video: xaiGrokImagineVideo,
  extend_grok_imagine_video: xaiGrokImagineVideo,
};

// Fal bills by endpoint id. Only image endpoints priced in @apicity/cost@0.8.0.
const falImage = (endpoint: string): CostAdapter => (input) => ({
  provider: "fal",
  endpoint,
  payload: {
    ...(num(input.num_images) !== undefined ? { num_images: num(input.num_images) } : {}),
    ...(str(input.resolution) ? { resolution: str(input.resolution) } : {}),
    ...(str(input.image_size) ? { image_size: str(input.image_size) } : {}),
  },
});

const FAL_ADAPTERS: Record<string, CostAdapter> = {
  generate_nano_banana_fal: falImage("fal-ai/nano-banana"),
  generate_nano_banana_edit_fal: falImage("fal-ai/nano-banana/edit"),
  generate_nano_banana_2_fal: falImage("fal-ai/nano-banana-2"),
  generate_nano_banana_pro_fal: falImage("fal-ai/nano-banana-pro"),
  generate_seedream_v5_lite_fal: falImage("fal-ai/bytedance/seedream/v5/lite/text-to-image"),
};

// Alibaba media rates landed in cost@0.8.0 for the models below.
const alibabaImage = (model: string): CostAdapter => () => ({
  provider: "alibaba",
  payload: { model, input: {} },
});

const alibabaVideo = (model: string, defaultDuration: number): CostAdapter => (input) => ({
  provider: "alibaba",
  payload: {
    model,
    input: { duration: num(input.duration) ?? num(input.seconds) ?? defaultDuration },
  },
});

const ALIBABA_ADAPTERS: Record<string, CostAdapter> = {
  generate_alibaba_qwen_image: alibabaImage("qwen-image-2.0"),
  generate_alibaba_qwen_image_edit: alibabaImage("qwen-image-edit"),
  generate_alibaba_image_pro: alibabaImage("wan2.7-image-pro"),
  generate_alibaba_video: alibabaVideo("wan2.7-i2v", 5),
};

const ADAPTERS: Record<string, CostAdapter> = {
  rewrite_prompt: openaiText("gpt-5.2", 1000),
  generate_elevenlabs_t2a: elevenLabsTts,
  ...KIE_ADAPTERS,
  ...FAL_ADAPTERS,
  ...ALIBABA_ADAPTERS,
};

import { getCanonicalName } from "./generation-registry.js";

export function getCostAdapter(rawToolName: string): CostAdapter | null {
  const toolName = getCanonicalName(rawToolName);
  const providerHintTools = new Set([
    ...Object.keys(KIE_ADAPTERS),
    ...Object.keys(XAI_ADAPTERS),
  ]);

  if (providerHintTools.has(rawToolName) || providerHintTools.has(toolName)) {
    return (input) => {
      const provider = str(input._provider);
      if (provider.startsWith("xai")) {
        const xai = XAI_ADAPTERS[rawToolName] ?? XAI_ADAPTERS[toolName];
        return xai ? xai(input) : null;
      }
      if (provider && provider !== "kie") return null;
      const kie = KIE_ADAPTERS[rawToolName] ?? KIE_ADAPTERS[toolName];
      return kie ? kie(input) : null;
    };
  }

  return ADAPTERS[rawToolName] ?? ADAPTERS[toolName] ?? null;
}
