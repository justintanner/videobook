import type { EstimateRequest } from "@apicity/cost";

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
const kieSeedance = (apiModel: "bytedance/seedance-2" | "bytedance/seedance-2-fast"): CostAdapter => (input) => {
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
        duration: num(input.duration) ?? num(input.seconds) ?? 5,
        ...(hasInput ? { first_frame_url: "stub" } : {}),
      },
    },
  };
};

// kling-3.0/video keys by mode + sound (sound===true selects "|sound").
// Defaults match buildKling30VideoPayload in payload-builders.ts.
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

// Map MCP tool_name -> EstimateRequest builder. Tools not listed here return
// null from getCostAdapter() and surface in the UI as "—" (no rate available).
// Fal-backed tools have no entry: @apicity/cost dropped fal coverage when it
// switched to a pure-local pricing table.
const ADAPTERS: Record<string, CostAdapter> = {
  // --- text rewrites / chat ---
  rewrite_prompt: openaiText("gpt-5.2", 1000),

  // --- KIE per-second video ---
  generate_seedance2_video: kieSeedance("bytedance/seedance-2"),
  generate_seedance2_fast_video: kieSeedance("bytedance/seedance-2-fast"),
  // Mini prices per-second by resolution (480p / 720p — the only tiers the tool
  // exposes); no first/last-frame split, so kieResolutionVideo is the right
  // shape. @apicity/cost@0.6.1 added this rate (was "—" under 0.6.0). See
  // docs/apicity-gaps.md §10.
  generate_seedance2_mini_video: kieResolutionVideo("bytedance/seedance-2-mini", "720p"),
  // generate_gemini_omni_video has no entry: @apicity/cost@0.6.1 prices no
  // gemini-omni-video rate, so it surfaces as "—" in the UI and is admitted by
  // the paygate via COST_TABLE_PENDING_MODELS. See docs/apicity-gaps.md §12.
  generate_kling30_video: kieKling30Video,
  generate_kling30_motion_control_video: kieKling30MotionControl,
  generate_kling30_turbo_video: (args: Record<string, unknown>) => {
    const imageSlugs = (args.image_slugs as string[] | undefined) ?? [];
    const model = imageSlugs.length > 0 ? "kling/v3-turbo-image-to-video" : "kling/v3-turbo-text-to-video";
    return kieResolutionVideo(model, "720p")(args);
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
  generate_grok_imagine_video: kieResolutionVideo("grok-imagine/image-to-video", "480p", 8),
  generate_grok_imagine_t2v_video: kieResolutionVideo("grok-imagine/text-to-video", "480p", 6),

  // --- KIE HappyHorse video (resolution-tiered, per-second) ---
  // t2v/i2v/ref generate against happyhorse-1-1/* (see payload-builders.ts), and
  // @apicity/cost@0.6.1 now prices those 1.1 keys directly. The 1.1 rates differ
  // from 1.0 ($0.165/$0.22 per sec vs $0.155/$0.265), so we key off the actual
  // 1.1 slugs here rather than borrowing 1.0. videoedit stays on the 1.0
  // happyhorse/video-edit slug (no 1.1 video-edit endpoint exists).
  generate_happyhorse_t2v_video: kieResolutionVideo("happyhorse-1-1/text-to-video", "1080p"),
  generate_happyhorse_i2v_video: kieResolutionVideo("happyhorse-1-1/image-to-video", "1080p"),
  generate_happyhorse_ref_video: kieResolutionVideo("happyhorse-1-1/reference-to-video", "1080p"),
  generate_happyhorse_videoedit_video: kieResolutionVideo("happyhorse/video-edit", "1080p"),

  // --- KIE GPT Image 2 (per-image, tiered by resolution) ---
  generate_gpt_image: kieTieredImage("gpt-image-2-image-to-image", "1K"),
  generate_gpt_image_text: kieTieredImage("gpt-image-2-text-to-image", "1K"),

  // --- KIE Nano Banana Pro (per-image, tiered by resolution) ---
  generate_nano_banana_image: kieTieredImage("nano-banana-pro", "2K"),

  // --- KIE Wan 2.7 image (per-image, tiered by resolution) ---
  generate_wan27_image: kieTieredImage("wan/2-7-image", "2K"),
  generate_wan27_image_pro: kieTieredImage("wan/2-7-image-pro", "2K"),

  // --- KIE flat per-image (qwen2 $0.028, seedream/5-lite $0.0275) ---
  generate_qwen2_image_edit: kieFlatImage("qwen2/image-edit"),
  generate_seedream_text_image: kieFlatImage("seedream/5-lite-text-to-image"),
  generate_seedream_image: kieFlatImage("seedream/5-lite-image-to-image"),

  // --- KIE Grok Imagine images (flat per-call) ---
  generate_grok_imagine_text_image: kieGrokImagineTextImage,
  generate_grok_imagine_image: kieGrokImagineImageEdit,
};

export function getCostAdapter(toolName: string): CostAdapter | null {
  return ADAPTERS[toolName] ?? null;
}
