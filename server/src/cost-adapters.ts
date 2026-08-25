import type { EstimateRequest } from "@apicity/cost";
import {
  GeminiOmniVideoRequestSchema,
  GptImage2ImageToImageRequestSchema,
  GptImage2TextToImageRequestSchema,
  GrokImageToVideoRequestSchema,
  HappyHorse11ImageToVideoRequestSchema,
  HappyHorse11ReferenceToVideoRequestSchema,
  HappyHorse11TextToVideoRequestSchema,
  KlingOmniTextToVideoInputSchema,
  KlingV3TurboTextToVideoRequestSchema,
  NanoBananaProRequestSchema,
  Seedance2FastInputSchema,
  Seedance2InputSchema,
  Seedance2MiniInputSchema,
  Seedance25InputSchema,
} from "@apicity/kie/zod";

type CostAdapter = (input: Record<string, unknown>) => EstimateRequest | null;

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
const SEEDANCE25_DURATION = apicityDefault<number>(Seedance25InputSchema.shape.duration, "Seedance 2.5 duration");
const SEEDANCE25_RESOLUTION = apicityDefault<string>(Seedance25InputSchema.shape.resolution, "Seedance 2.5 resolution");
const SEEDANCE25_GENERATE_AUDIO = apicityDefault<boolean>(Seedance25InputSchema.shape.generate_audio, "Seedance 2.5 generate_audio");
const GROK_I2V_DURATION = apicityDefault<number>(GrokImageToVideoRequestSchema.shape.input.shape.duration, "Grok image-to-video duration");
const GROK_I2V_RESOLUTION = apicityDefault<string>(GrokImageToVideoRequestSchema.shape.input.shape.resolution, "Grok image-to-video resolution");
const KLING_TURBO_DURATION = apicityDefault<string>(KlingV3TurboTextToVideoRequestSchema.shape.input.shape.duration, "Kling Turbo duration");
const KLING_OMNI_DURATION = apicityDefault<number>(KlingOmniTextToVideoInputSchema.shape.duration, "Kling 3.0 Omni duration");
const KLING_OMNI_RESOLUTION = apicityDefault<string>(KlingOmniTextToVideoInputSchema.shape.resolution, "Kling 3.0 Omni resolution");
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
    Boolean(str(input.first_frame_ref)) ||
    Boolean(str(input.last_frame_ref)) ||
    (Array.isArray(input.image_refs) && input.image_refs.length > 0) ||
    (Array.isArray(input.video_refs) && input.video_refs.length > 0) ||
    (Array.isArray(input.audio_refs) && input.audio_refs.length > 0);
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

function seedance25Duration(input: Record<string, unknown>): number {
  const value = num(input.duration) ?? num(input.seconds);
  return value !== undefined && value > 0 ? value : SEEDANCE25_DURATION;
}

const kieSeedance25: CostAdapter = (input) => ({
  provider: "kie",
  payload: {
    model: "bytedance/seedance-2-5",
    input: {
      resolution: str(input.resolution) || SEEDANCE25_RESOLUTION,
      duration: seedance25Duration(input),
      generate_audio: typeof input.generate_audio === "boolean"
        ? input.generate_audio
        : SEEDANCE25_GENERATE_AUDIO,
    },
  },
});

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

function kieKlingOmni(
  model:
    | "kling-3.0-omni/text-to-video"
    | "kling-3.0-omni/image-to-video"
    | "kling-3.0-omni/reference-to-video"
    | "kling-3.0-omni/transformation",
): CostAdapter {
  return (input) => {
    const hasVideo = Array.isArray(input.video_refs) && input.video_refs.length > 0;
    return {
      provider: "kie",
      payload: {
        model,
        input: {
          resolution: str(input.resolution) || KLING_OMNI_RESOLUTION,
          duration: num(input.duration) ?? KLING_OMNI_DURATION,
          ...(input.audio === true ? { audio: true } : {}),
          ...(model === "kling-3.0-omni/reference-to-video" && hasVideo
            ? { video_urls: ["https://example.com/ref.mp4"] }
            : {}),
        },
      },
    };
  };
}

// kie image-tier adapter: prices keyed by input.resolution ("1K"|"2K"|"4K").
// gpt-image-2 and nano-banana-pro both accept resolution upstream — forward
// when present, else fall back to the default tier so an unconfigured request
// still returns a price.
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

// kie wan/3-0-video[-prime]: resolution-tiered per second with UPPERCASE
// tiers. duration -1 (intelligent) is estimated at the 5s default:
// cost@0.11.0's wan30Seconds fails closed on the sentinel without
// realized-seconds costHints, which would surface "—" for the default flow.
const kieWan30Video = (model: "wan/3-0-video" | "wan/3-0-video-prime"): CostAdapter => (input) => {
  const seconds = num(input.duration);
  return {
    provider: "kie",
    payload: {
      model,
      input: {
        resolution: str(input.resolution) || "1080P",
        duration: seconds !== undefined && seconds > 0 ? seconds : 5,
      },
    },
  };
};

// kie flat per-second video adapter (veo3 family — flat rate regardless of
// resolution). The rate table reads input.duration in seconds; videocity
// tools pass duration as a numeric string we coerce here.
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
      ...(str(input.video_ref) ? { video_list: [{ url: "stub", start: 0, ends: 4 }] } : {}),
    },
  },
});

// Per-request cost hints that the paygate should see but the wire payload
// must not carry. Used for kie models whose input schema has no duration field
// even though they bill per second of source/motion/driving media:
// happyhorse/video-edit, kling-3.0/motion-control, omnihuman-1-5,
// volcengine/video-to-video-lip-sync. Job handlers resolve measured duration
// and pass it here; mintKieOtp maps it to EstimateRequest.costHints.
// durationSeconds, @apicity/cost's formal side channel (docs/apicity-gaps.md
// §30) — it is never serialized into the wire.
export type KieCostHints = { duration?: number };

/** Map videobook's cost hints to @apicity/cost's EstimateRequest.costHints. */
export function toUpstreamCostHints(hints: KieCostHints): { durationSeconds?: number } {
  return typeof hints.duration === "number" && hints.duration > 0
    ? { durationSeconds: hints.duration }
    : {};
}

// Map MCP tool_name -> EstimateRequest builder. Tools not listed here return
// null from getCostAdapter() and surface in the UI as "—" (no rate available),
// unless a local estimator handles them (see estimateGoogleFlowCost).
// Every Fal tool @apicity/cost prices has an adapter; only upstream-declared
// dynamic-pricing endpoints and unpublished rates stay "—" (see FAL_ADAPTERS).
// Google Flow tools keep the local Gemini API list-rate table in
// google-flow-cost.ts — package googleflow rates are credit×Pro, not API USD
// (docs/apicity-gaps.md §15, product choice A).
const KIE_ADAPTERS: Record<string, CostAdapter> = {
  // --- KIE per-second video ---
  generate_kie_seedance_2_0_video: kieSeedance("bytedance/seedance-2", SEEDANCE2_DURATION),
  generate_kie_seedance_2_0_fast_video: kieSeedance("bytedance/seedance-2-fast", SEEDANCE2_FAST_DURATION),
  // Mini prices per-second by resolution (480p / 720p — the only tiers the tool
  // exposes); no first/last-frame split, so kieResolutionVideo is the right
  // shape. @apicity/cost@0.6.1 added this rate (was "—" under 0.6.0). See
  // docs/apicity-gaps.md §10.
  generate_kie_seedance_2_0_mini_video: kieResolutionVideo("bytedance/seedance-2-mini", SEEDANCE2_MINI_RESOLUTION, SEEDANCE2_MINI_DURATION),
  generate_kie_seedance_2_5_video: kieSeedance25,
  generate_kie_gemini_omni_video: kieGeminiOmniVideo,
  generate_kie_kling_3_0_video: kieKling30Video,
  generate_kie_kling_3_0_motion_control: kieKling30MotionControl,
  generate_kie_kling_3_0_omni_text_to_video: kieKlingOmni("kling-3.0-omni/text-to-video"),
  generate_kie_kling_3_0_omni_image_to_video: kieKlingOmni("kling-3.0-omni/image-to-video"),
  generate_kie_kling_3_0_omni_reference_to_video: kieKlingOmni("kling-3.0-omni/reference-to-video"),
  generate_kie_kling_3_0_omni_transformation: kieKlingOmni("kling-3.0-omni/transformation"),
  generate_kie_kling_3_0_turbo_video: (args: Record<string, unknown>) => {
    const imageRefs = (args.image_refs as string[] | undefined) ?? [];
    const model = imageRefs.length > 0 ? "kling/v3-turbo-image-to-video" : "kling/v3-turbo-text-to-video";
    return kieResolutionVideo(model, KLING_TURBO_RESOLUTION, Number(KLING_TURBO_DURATION))(args);
  },
  generate_kie_wan_3_0_video: kieWan30Video("wan/3-0-video"),
  generate_kie_wan_3_0_prime_video: kieWan30Video("wan/3-0-video-prime"),

  // --- KIE Veo 3 / Veo 3 Fast (flat per-second, priced in cost@0.7.0) ---
  generate_kie_veo_3_0_video: kieFlatVideo("veo3"),
  generate_kie_veo_3_0_fast_video: kieFlatVideo("veo3_fast"),

  // --- KIE Grok Imagine video (resolution-tiered, $0.008/$0.015 per sec) ---
  generate_kie_grok_imagine_image_to_video: kieResolutionVideo("grok-imagine/image-to-video", GROK_I2V_RESOLUTION, GROK_I2V_DURATION),
  generate_kie_grok_imagine_text_to_video: kieResolutionVideo("grok-imagine/text-to-video", "480p", 6),
  extend_kie_grok_imagine_video: kieGrokImagineExtend,
  upscale_kie_grok_imagine_video: kieGrokImagineUpscale,

  // --- KIE HappyHorse video (resolution-tiered, per-second) ---
  // t2v/i2v/ref generate against happyhorse-1-1/* (see payload-builders.ts), and
  // @apicity/cost@0.6.1 now prices those 1.1 keys directly. The 1.1 rates differ
  // from 1.0 ($0.165/$0.22 per sec vs $0.155/$0.265), so we key off the actual
  // 1.1 slugs here rather than borrowing 1.0. videoedit stays on the 1.0
  // happyhorse/video-edit slug (no 1.1 video-edit endpoint exists).
  generate_kie_happyhorse_1_1_text_to_video: kieResolutionVideo("happyhorse-1-1/text-to-video", HAPPYHORSE_T2V_RESOLUTION, HAPPYHORSE_T2V_DURATION),
  generate_kie_happyhorse_1_1_image_to_video: kieResolutionVideo("happyhorse-1-1/image-to-video", HAPPYHORSE_I2V_RESOLUTION, HAPPYHORSE_I2V_DURATION),
  generate_kie_happyhorse_1_1_reference_to_video: kieResolutionVideo("happyhorse-1-1/reference-to-video", HAPPYHORSE_R2V_RESOLUTION, HAPPYHORSE_R2V_DURATION),
  generate_kie_happyhorse_1_1_edit_video: kieResolutionVideo("happyhorse/video-edit", "1080p"),

  // --- KIE MiniMax H3 (resolution-tiered per second: 768P $0.1125, 2K
  // $0.1825) — rates landed in @apicity/cost@0.8.8. Resolution defaults to 2K,
  // the tier the published rate table keys off when the request omits it.
  // Duration is schema-required with no default, so the adapter states 6s. ---
  generate_kie_minimax_h3_text_to_video: kieResolutionVideo("minimax-h3/text-to-video", "2K", 6),
  generate_kie_minimax_h3_image_to_video: kieResolutionVideo("minimax-h3/image-to-video", "2K", 6),
  generate_kie_minimax_h3_reference_to_video: kieResolutionVideo("minimax-h3/reference-to-video", "2K", 6),

  // --- KIE GPT Image 2 (per-image, tiered by resolution) ---
  generate_kie_gpt_image_2_image_to_image: kieTieredImage("gpt-image-2-image-to-image", GPT_IMAGE_I2I_RESOLUTION),
  generate_kie_gpt_image_2_text_to_image: kieTieredImage("gpt-image-2-text-to-image", GPT_IMAGE_T2I_RESOLUTION),

  // --- KIE Nano Banana Pro (per-image, tiered by resolution) ---
  generate_kie_nano_banana_pro_text_to_image: kieTieredImage("nano-banana-pro", NANO_BANANA_PRO_RESOLUTION),

  // --- KIE flat per-image (qwen2 $0.028, seedream/5-lite $0.0275) ---
  generate_kie_qwen_2_0_edit_image: kieFlatImage("qwen2/image-edit"),
  generate_kie_seedream_v5_lite_text_to_image: kieFlatImage("seedream/5-lite-text-to-image"),
  generate_kie_seedream_v5_lite_image_to_image: kieFlatImage("seedream/5-lite-image-to-image"),

  // --- KIE Grok Imagine images (flat per-call) ---
  generate_kie_grok_imagine_text_to_image: kieGrokImagineTextImage,
  generate_kie_grok_imagine_image_to_image: kieGrokImagineImageEdit,

  // --- KIE OmniHuman / Volcengine (per-second; duration from source media) ---
  // Schema has no duration field; estimate_cost + job handlers inject it via
  // source metadata / KieCostHints (docs/apicity-gaps.md §30).
  generate_kie_omnihuman_1_5_video: (input) => ({
    provider: "kie",
    payload: {
      model: "omnihuman-1-5",
      duration: num(input.duration) ?? 5,
      input: {},
    },
  }),
  generate_kie_volcengine_video_to_video_lip_sync: (input) => ({
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
  generate_kie_grok_imagine_text_to_image: xaiGrokImagineImage,
  generate_kie_grok_imagine_image_to_image: xaiGrokImagineImage,
  generate_kie_grok_imagine_image_to_video: xaiGrokImagineVideo,
  generate_kie_grok_imagine_text_to_video: xaiGrokImagineVideo,
  generate_xai_grok_imagine_video: xaiGrokImagineVideo,
  extend_kie_grok_imagine_video: xaiGrokImagineVideo,
};

// Fal bills by endpoint id; @apicity/cost prices image endpoints per image or
// per megapixel and video endpoints per second.
const falImage = (endpoint: string): CostAdapter => (input) => ({
  provider: "fal",
  endpoint,
  payload: {
    ...(num(input.num_images) !== undefined ? { num_images: num(input.num_images) } : {}),
    ...(num(input.max_images) !== undefined ? { max_images: num(input.max_images) } : {}),
    ...(str(input.resolution) ? { resolution: str(input.resolution) } : {}),
    ...(str(input.image_size) ? { image_size: str(input.image_size) } : {}),
  },
});

// Fal per-second video (numeric duration): grok-imagine-video. The table
// reads top-level duration/resolution.
const falVideo = (endpoint: string): CostAdapter => (input) => ({
  provider: "fal",
  endpoint,
  payload: {
    ...(num(input.duration) !== undefined ? { duration: num(input.duration) } : {}),
    ...(str(input.resolution) ? { resolution: str(input.resolution) } : {}),
  },
});

// Fal Seedance 2.0 video: token-metered per second. duration may be the
// string "auto" on reference-to-video (no billed default — the estimate warns
// honestly); video_urls presence selects the reference rate tier.
const falSeedanceVideo = (endpoint: string, r2v = false): CostAdapter => (input) => ({
  provider: "fal",
  endpoint,
  payload: {
    ...(input.duration !== undefined ? { duration: input.duration } : {}),
    ...(str(input.resolution) ? { resolution: str(input.resolution) } : {}),
    ...(r2v && Array.isArray(input.video_refs) && input.video_refs.length > 0 ? { video_urls: ["stub"] } : {}),
  },
});

// Fal Kling v3 video: audio-tiered per second. duration is a digit string
// upstream (default "5"); generate_audio defaults to true on both sides.
const falKlingV3Video = (endpoint: string): CostAdapter => (input) => ({
  provider: "fal",
  endpoint,
  payload: {
    duration: str(input.duration) || "5",
    generate_audio: input.generate_audio !== false,
  },
});

const FAL_ADAPTERS: Record<string, CostAdapter> = {
  // --- Fal images (per image / per megapixel) ---
  generate_fal_nano_banana_text_to_image: falImage("fal-ai/nano-banana"),
  generate_fal_nano_banana_edit_image: falImage("fal-ai/nano-banana/edit"),
  generate_fal_nano_banana_2_text_to_image: falImage("fal-ai/nano-banana-2"),
  generate_fal_nano_banana_2_edit_image: falImage("fal-ai/nano-banana-2/edit"),
  generate_fal_nano_banana_pro_text_to_image: falImage("fal-ai/nano-banana-pro"),
  generate_fal_nano_banana_pro_edit_image: falImage("fal-ai/nano-banana-pro/edit"),
  generate_fal_seedream_v5_lite_text_to_image: falImage("fal-ai/bytedance/seedream/v5/lite/text-to-image"),
  generate_fal_seedream_v5_lite_edit_image: falImage("fal-ai/bytedance/seedream/v5/lite/edit"),
  generate_fal_grok_imagine_text_to_image: falImage("xai/grok-imagine-image"),
  generate_fal_grok_imagine_edit_image: falImage("xai/grok-imagine-image/edit"),
  // The cost table keys Qwen edit off its pricing-page slug, not the wire
  // endpoint ("fal-ai/qwen-image/edit").
  generate_fal_qwen_2_0_text_to_image: falImage("fal-ai/qwen-image"),
  generate_fal_qwen_2_0_edit_image: falImage("fal-ai/qwen-image-edit"),
  // nano-banana-2-lite stays unpriced: upstream declares it dynamic-pricing.

  // --- Fal video (per second) ---
  generate_fal_seedance_2_0_text_to_video: falSeedanceVideo("bytedance/seedance-2.0/text-to-video"),
  generate_fal_seedance_2_0_image_to_video: falSeedanceVideo("bytedance/seedance-2.0/image-to-video"),
  generate_fal_seedance_2_0_reference_to_video: falSeedanceVideo("bytedance/seedance-2.0/reference-to-video", true),
  generate_fal_seedance_2_0_fast_text_to_video: falSeedanceVideo("bytedance/seedance-2.0/fast/text-to-video"),
  generate_fal_seedance_2_0_fast_image_to_video: falSeedanceVideo("bytedance/seedance-2.0/fast/image-to-video"),
  generate_fal_seedance_2_0_fast_reference_to_video: falSeedanceVideo("bytedance/seedance-2.0/fast/reference-to-video", true),
  generate_fal_grok_imagine_video_image_to_video: falVideo("xai/grok-imagine-video/image-to-video"),
  generate_fal_grok_imagine_video_reference_to_video: falVideo("xai/grok-imagine-video/reference-to-video"),
  extend_fal_grok_imagine_video: falVideo("xai/grok-imagine-video/extend-video"),
  generate_fal_kling_video_v3_pro_text_to_video: falKlingV3Video("fal-ai/kling-video/v3/pro/text-to-video"),
  generate_fal_kling_video_v3_pro_image_to_video: falKlingV3Video("fal-ai/kling-video/v3/pro/image-to-video"),
  generate_fal_kling_video_v3_standard_text_to_video: falKlingV3Video("fal-ai/kling-video/v3/standard/text-to-video"),
  generate_fal_kling_video_v3_standard_image_to_video: falKlingV3Video("fal-ai/kling-video/v3/standard/image-to-video"),
  // Wan 3.0 Prime bills a flat $0.05 per output second (numeric duration,
  // schema default 5) — the falVideo shape fits. The base alibaba/wan-3.0/*
  // family stays unpriced: cost@0.11.0 declares all three endpoints
  // dynamic-pricing (per compute second; FAL_DYNAMIC_PRICING_ENDPOINTS).
  generate_fal_wan_3_0_prime_text_to_video: falVideo("alibaba/wan-3.0-prime/text-to-video"),
  generate_fal_wan_3_0_prime_image_to_video: falVideo("alibaba/wan-3.0-prime/image-to-video"),
  generate_fal_wan_3_0_prime_reference_to_video: falVideo("alibaba/wan-3.0-prime/reference-to-video"),
  // xai/grok-imagine-video/edit-video has no published rate — stays "—".
};

// Alibaba media rates: qwen landed in cost@0.8.0.
const alibabaImage = (model: string): CostAdapter => () => ({
  provider: "alibaba",
  payload: { model, input: {} },
});

const ALIBABA_ADAPTERS: Record<string, CostAdapter> = {
  generate_alibaba_qwen_2_0_text_to_image: alibabaImage("qwen-image-2.0"),
  generate_alibaba_qwen_2_0_edit_image: alibabaImage("qwen-image-edit"),
};

const ADAPTERS: Record<string, CostAdapter> = {
  rewrite_prompt: openaiText("gpt-5.6-sol", 1000),
  generate_elevenlabs_text_to_audio: elevenLabsTts,
  ...KIE_ADAPTERS,
  ...FAL_ADAPTERS,
  ...ALIBABA_ADAPTERS,
};

import { getActionSpec, getCanonicalName } from "./generation-registry.js";

export function getCostAdapter(rawToolName: string): CostAdapter | null {
  const spec = getActionSpec(rawToolName);
  const toolName = getCanonicalName(rawToolName);
  const providerHintTools = new Set([
    ...Object.keys(KIE_ADAPTERS),
    ...Object.keys(XAI_ADAPTERS),
  ]);

  if (providerHintTools.has(toolName)) {
    return (input) => {
      const provider = str(input._provider) || (spec?.provider === "xai" ? "xai" : spec?.provider === "kie" ? "kie" : "");
      if (provider.startsWith("xai")) {
        const xai = XAI_ADAPTERS[toolName];
        return xai ? xai(input) : null;
      }
      if (provider && provider !== "kie") return null;
      const kie = KIE_ADAPTERS[toolName];
      return kie ? kie(input) : null;
    };
  }

  return ADAPTERS[toolName] ?? null;
}
