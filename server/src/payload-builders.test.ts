import { describe, expect, it } from "vitest";
import { computeEstimate } from "@apicity/cost";
import {
  GeminiOmniVideoRequestSchema,
  GptImage2ImageToImageRequestSchema,
  GptImage2TextToImageRequestSchema,
  GptImage25FlareTextToImageRequestSchema,
  GptImage25FlareImageToImageRequestSchema,
  GptImage25SunburstTextToImageRequestSchema,
  GptImage25SunburstImageToImageRequestSchema,
  GrokImageToImageRequestSchema,
  GrokImageToVideoRequestSchema,
  GrokTextToImageRequestSchema,
  GrokTextToVideoRequestSchema,
  GrokVideoExtendRequestSchema,
  HappyHorse11ImageToVideoRequestSchema,
  HappyHorse11ReferenceToVideoRequestSchema,
  HappyHorse11TextToVideoRequestSchema,
  HappyHorseVideoEditRequestSchema,
  KlingMotionControlRequestSchema,
  KlingV3TurboImageToVideoRequestSchema,
  KlingV3TurboTextToVideoRequestSchema,
  KlingOmniImageToVideoRequestSchema,
  KlingOmniReferenceToVideoRequestSchema,
  KlingOmniTextToVideoRequestSchema,
  KlingOmniTransformationRequestSchema,
  KlingVideoRequestSchema,
  MiniMaxH3ImageToVideoRequestSchema,
  MiniMaxH3ReferenceToVideoRequestSchema,
  MiniMaxH3TextToVideoRequestSchema,
  NanoBananaProRequestSchema,
  Omnihuman15RequestSchema,
  Qwen2ImageEditRequestSchema,
  Qwen3ImageToImageRequestSchema,
  Seedance2FastRequestSchema,
  Seedance2MiniRequestSchema,
  Seedance2RequestSchema,
  Seedance25RequestSchema,
  SeedreamImageToImageRequestSchema,
  SeedreamTextToImageRequestSchema,
  VolcengineVideoToVideoLipSyncRequestSchema,
} from "@apicity/kie/zod";
import { GoogleFlowVideosRequestSchema } from "@apicity/googleflow/zod";
import {
  buildMiniMaxH3I2vPayload,
  buildMiniMaxH3R2vPayload,
  buildMiniMaxH3T2vPayload,
  translateToolPayload,
} from "./payload-builders.js";
import {
  inspectProviderPayload,
  ProviderMentionError,
} from "./provider-prompt-transform.js";

const payloadCases: Array<{ tool: string; provider?: string }> = [
  { tool: "generate_kie_kling_3_0_omni_text_to_video" },
  { tool: "generate_kie_kling_3_0_omni_image_to_video" },
  { tool: "generate_kie_kling_3_0_omni_reference_to_video" },
  { tool: "generate_kie_kling_3_0_omni_transformation" },
  { tool: "generate_kie_kling_3_0_video" },
  { tool: "generate_kie_kling_3_0_motion_control" },
  { tool: "generate_kie_kling_3_0_turbo_video" },
  { tool: "generate_kie_grok_imagine_image_to_video" },
  { tool: "generate_kie_grok_imagine_image_to_video", provider: "xai" },
  { tool: "generate_kie_grok_imagine_text_to_video" },
  { tool: "generate_kie_grok_imagine_image_to_image" },
  { tool: "generate_kie_grok_imagine_image_to_image", provider: "xai" },
  { tool: "generate_kie_seedance_2_5_video" },
  { tool: "generate_kie_seedance_2_0_video" },
  { tool: "generate_kie_seedance_2_0_fast_video" },
  { tool: "generate_kie_seedance_2_0_mini_video" },
  { tool: "generate_kie_gemini_omni_video" },
  { tool: "generate_google_flow_veo_3_1_quality_video" },
  { tool: "generate_google_flow_veo_3_1_fast_video" },
  { tool: "generate_google_flow_veo_3_1_lite_video" },
  { tool: "generate_google_flow_veo_3_1_lite_low_priority_video" },
  { tool: "generate_google_flow_omni_flash_video" },
  { tool: "generate_google_flow_nano_banana_pro_image" },
  { tool: "generate_kie_grok_imagine_text_to_image" },
  { tool: "generate_kie_grok_imagine_text_to_image", provider: "xai" },
  { tool: "generate_xai_grok_imagine_video" },
  { tool: "generate_kie_nano_banana_pro_text_to_image" },
  { tool: "generate_kie_seedream_v5_lite_text_to_image" },
  { tool: "generate_kie_seedream_v5_lite_image_to_image" },
  { tool: "generate_kie_qwen_2_0_edit_image" },
  { tool: "generate_kie_qwen_3_0_edit_image" },
  { tool: "generate_kie_gpt_image_2_image_to_image" },
  { tool: "generate_kie_gpt_image_2_text_to_image" },
  { tool: "generate_kie_gpt_image_2_5_flare_image" },
  { tool: "generate_kie_gpt_image_2_5_sunburst_image" },
  { tool: "extend_kie_grok_imagine_video" },
  { tool: "generate_kie_volcengine_video_to_video_lip_sync" },
  { tool: "generate_kie_omnihuman_1_5_video" },
  { tool: "generate_kie_happyhorse_1_1_text_to_video" },
  { tool: "generate_kie_happyhorse_1_1_image_to_video" },
  { tool: "generate_kie_happyhorse_1_1_reference_to_video" },
  { tool: "generate_kie_happyhorse_1_1_edit_video" },
  { tool: "generate_kie_minimax_h3_text_to_video" },
  { tool: "generate_kie_minimax_h3_image_to_video" },
  { tool: "generate_kie_minimax_h3_reference_to_video" },
];

const payloadCaseArgs: Record<string, unknown> = {
  prompt: "plain prompt",
  image_refs: ["https://example.test/image.png"],
  character_image_refs: ["https://example.test/character.png"],
  motion_video_refs: ["https://example.test/motion.mp4"],
  video_refs: ["https://example.test/video.mp4"],
  audio_refs: ["https://example.test/audio.mp3"],
  character_refs: [],
  voice_refs: [],
  first_frame_ref: "https://example.test/first.png",
  last_frame_ref: "https://example.test/last.png",
  first_clip_ref: "https://example.test/clip.mp4",
  driving_audio_ref: "https://example.test/driving.mp3",
  video_ref: "https://example.test/source.mp4",
  image_ref: "https://example.test/source.png",
  audio_ref: "https://example.test/source.mp3",
  extend_at: 0,
  extend_times: 1,
};

function argsForPayloadCase(
  tool: string,
  prompt: string,
): Record<string, unknown> {
  return {
    ...payloadCaseArgs,
    prompt,
    ...(tool === "generate_kie_volcengine_video_to_video_lip_sync"
      ? { mode: "lite" }
      : {}),
  };
}

// Every ref param the dispatcher reads. Swapping the URL fixtures for
// artifact ids makes each ref traceable through the built payload, so a tool
// that carries a ref but forgets its prompt dialect is detectable instead of
// surfacing as an opaque ProviderMentionError at submit.
const MENTION_REF_PARAMS = [
  "image_refs",
  "character_image_refs",
  "motion_video_refs",
  "video_refs",
  "audio_refs",
  "first_frame_ref",
  "last_frame_ref",
  "first_clip_ref",
  "driving_audio_ref",
  "video_ref",
  "image_ref",
  "audio_ref",
] as const;

function refIdForParam(index: number): string {
  return `01890f1c-0000-7000-8000-0000000${String(index + 1).padStart(5, "0")}`;
}

function mentionArgsForPayloadCase(
  tool: string,
  prompt: string,
): Record<string, unknown> {
  const args = argsForPayloadCase(tool, prompt);
  MENTION_REF_PARAMS.forEach((param, index) => {
    const current = args[param];
    if (Array.isArray(current)) {
      args[param] = current.length > 0 ? [refIdForParam(index)] : [];
    } else if (typeof current === "string") {
      args[param] = refIdForParam(index);
    }
  });
  return args;
}

// kie 0.8.6 CREATE_TASK_GUARDS: submitMediaJob safeParses every createTask
// request against the per-model schema before anything leaves the process.
// One representative valid call per kie case of the dispatcher (both modes of
// dual-mode tools) so a builder drift fails here instead of at submit time.
type KieGuardCase = {
  tool: string;
  schema: {
    safeParse: (payload: unknown) =>
      | { success: true; data: unknown }
      | { success: false; error: { issues: Array<{ message: string }> } };
  };
  args: Record<string, unknown>;
};

const kieGuardCases: KieGuardCase[] = [
  {
    tool: "generate_kie_kling_3_0_omni_text_to_video",
    schema: KlingOmniTextToVideoRequestSchema,
    args: { prompt: "plain prompt", customize_multi_shots: false, resolution: "720p" },
  },
  {
    tool: "generate_kie_kling_3_0_omni_image_to_video",
    schema: KlingOmniImageToVideoRequestSchema,
    args: {
      prompt: "plain prompt",
      image_refs: ["https://example.test/image.png"],
    },
  },
  {
    tool: "generate_kie_kling_3_0_omni_reference_to_video",
    schema: KlingOmniReferenceToVideoRequestSchema,
    args: {
      prompt: "plain prompt",
      image_refs: ["https://example.test/image.png"],
    },
  },
  {
    tool: "generate_kie_kling_3_0_omni_transformation",
    schema: KlingOmniTransformationRequestSchema,
    args: {
      prompt: "plain prompt",
      image_refs: ["https://example.test/image.png"],
      video_refs: ["https://example.test/video.mp4"],
      aspect_ratio: "9:16",
    },
  },
  {
    tool: "generate_kie_kling_3_0_video",
    schema: KlingVideoRequestSchema,
    args: {
      prompt: "plain prompt",
      mode: "std",
      duration: "5",
      multi_shots: false,
      aspect_ratio: "16:9",
      image_refs: ["https://example.test/image.png"],
    },
  },
  {
    tool: "generate_kie_kling_3_0_motion_control",
    schema: KlingMotionControlRequestSchema,
    args: {
      character_image_refs: ["https://example.test/character.png"],
      motion_video_refs: ["https://example.test/motion.mp4"],
    },
  },
  {
    tool: "generate_kie_kling_3_0_turbo_video",
    schema: KlingV3TurboTextToVideoRequestSchema,
    args: { prompt: "plain prompt" },
  },
  {
    tool: "generate_kie_kling_3_0_turbo_video",
    schema: KlingV3TurboImageToVideoRequestSchema,
    args: { prompt: "plain prompt", image_refs: ["https://example.test/image.png"] },
  },
  {
    tool: "generate_kie_grok_imagine_image_to_video",
    schema: GrokImageToVideoRequestSchema,
    args: {
      prompt: "plain prompt",
      image_refs: ["https://example.test/image.png"],
      mode: "fun",
      duration: 6,
      resolution: "720p",
      aspect_ratio: "16:9",
    },
  },
  {
    tool: "generate_kie_grok_imagine_text_to_video",
    schema: GrokTextToVideoRequestSchema,
    args: { prompt: "plain prompt", duration: 6, resolution: "720p", aspect_ratio: "16:9" },
  },
  {
    tool: "generate_kie_grok_imagine_image_to_image",
    schema: GrokImageToImageRequestSchema,
    args: { prompt: "plain prompt", image_refs: ["https://example.test/image.png"] },
  },
  {
    tool: "generate_kie_grok_imagine_text_to_image",
    schema: GrokTextToImageRequestSchema,
    args: { prompt: "plain prompt", aspect_ratio: "16:9" },
  },
  {
    tool: "generate_kie_seedance_2_5_video",
    schema: Seedance25RequestSchema,
    args: {
      prompt: "plain prompt",
      image_refs: ["https://example.test/image.png"],
      video_refs: ["https://example.test/video.mp4"],
      audio_refs: ["https://example.test/audio.mp3"],
      duration: "30",
    },
  },
  {
    tool: "generate_kie_seedance_2_0_video",
    schema: Seedance2RequestSchema,
    args: {
      prompt: "plain prompt",
      image_refs: ["https://example.test/image.png"],
      video_refs: ["https://example.test/video.mp4"],
      duration: "5",
    },
  },
  {
    // Frames path: mutually exclusive with reference_* arrays upstream.
    tool: "generate_kie_seedance_2_0_video",
    schema: Seedance2RequestSchema,
    args: {
      prompt: "plain prompt",
      first_frame_ref: "https://example.test/first.png",
      last_frame_ref: "https://example.test/last.png",
    },
  },
  {
    tool: "generate_kie_seedance_2_0_fast_video",
    schema: Seedance2FastRequestSchema,
    args: { prompt: "plain prompt", image_refs: ["https://example.test/image.png"] },
  },
  {
    tool: "generate_kie_seedance_2_0_mini_video",
    schema: Seedance2MiniRequestSchema,
    args: { prompt: "plain prompt", image_refs: ["https://example.test/image.png"] },
  },
  {
    tool: "generate_kie_gemini_omni_video",
    schema: GeminiOmniVideoRequestSchema,
    args: {
      prompt: "plain prompt",
      duration: "8",
      image_refs: ["https://example.test/image.png"],
    },
  },
  {
    tool: "generate_kie_gemini_omni_video",
    schema: GeminiOmniVideoRequestSchema,
    args: {
      prompt: "plain prompt",
      duration: "8",
      video_ref: "https://example.test/source.mp4",
      video_clip_start: 2,
      video_clip_ends: 8,
    },
  },
  {
    tool: "generate_kie_nano_banana_pro_text_to_image",
    schema: NanoBananaProRequestSchema,
    args: { prompt: "plain prompt" },
  },
  {
    tool: "generate_kie_nano_banana_pro_text_to_image",
    schema: NanoBananaProRequestSchema,
    args: { prompt: "plain prompt", image_refs: ["https://example.test/image.png"] },
  },
  {
    // quality is required by the tool contract and deliberately has no schema
    // default upstream (kie 422s when it is omitted).
    tool: "generate_kie_seedream_v5_lite_text_to_image",
    schema: SeedreamTextToImageRequestSchema,
    args: { prompt: "plain prompt", quality: "basic" },
  },
  {
    tool: "generate_kie_seedream_v5_lite_image_to_image",
    schema: SeedreamImageToImageRequestSchema,
    args: { prompt: "plain prompt", quality: "basic", image_refs: ["https://example.test/image.png"] },
  },
  {
    tool: "generate_kie_qwen_2_0_edit_image",
    schema: Qwen2ImageEditRequestSchema,
    args: { prompt: "plain prompt", image_refs: ["https://example.test/image.png"] },
  },
  {
    tool: "generate_kie_qwen_3_0_edit_image",
    schema: Qwen3ImageToImageRequestSchema,
    args: { prompt: "plain prompt", image_refs: ["https://example.test/image.png"] },
  },
  {
    tool: "generate_kie_gpt_image_2_5_flare_image",
    schema: GptImage25FlareTextToImageRequestSchema,
    args: { prompt: "plain prompt", background: "transparent", aspect_ratio: "16:9", resolution: "2K" },
  },
  {
    tool: "generate_kie_gpt_image_2_5_flare_image",
    schema: GptImage25FlareImageToImageRequestSchema,
    args: { prompt: "plain prompt", background: "transparent", aspect_ratio: "16:9", resolution: "2K", image_refs: ["https://example.test/image.png"] },
  },
  {
    tool: "generate_kie_gpt_image_2_5_sunburst_image",
    schema: GptImage25SunburstTextToImageRequestSchema,
    args: { prompt: "plain prompt", background: "transparent", aspect_ratio: "16:9", resolution: "2K" },
  },
  {
    tool: "generate_kie_gpt_image_2_5_sunburst_image",
    schema: GptImage25SunburstImageToImageRequestSchema,
    args: { prompt: "plain prompt", background: "transparent", aspect_ratio: "16:9", resolution: "2K", image_refs: ["https://example.test/image.png"] },
  },
  {
    tool: "generate_kie_gpt_image_2_image_to_image",
    schema: GptImage2ImageToImageRequestSchema,
    args: { prompt: "plain prompt", image_refs: ["https://example.test/image.png"] },
  },
  {
    tool: "generate_kie_gpt_image_2_text_to_image",
    schema: GptImage2TextToImageRequestSchema,
    args: { prompt: "plain prompt" },
  },
  {
    tool: "extend_kie_grok_imagine_video",
    schema: GrokVideoExtendRequestSchema,
    args: { prompt: "plain prompt", extend_at: 3, extend_times: "10" },
  },
  {
    tool: "generate_kie_volcengine_video_to_video_lip_sync",
    schema: VolcengineVideoToVideoLipSyncRequestSchema,
    args: {
      video_ref: "https://example.test/source.mp4",
      audio_ref: "https://example.test/source.mp3",
      mode: "lite",
    },
  },
  {
    tool: "generate_kie_omnihuman_1_5_video",
    schema: Omnihuman15RequestSchema,
    args: {
      image_ref: "https://example.test/source.png",
      audio_ref: "https://example.test/source.mp3",
    },
  },
  {
    tool: "generate_kie_happyhorse_1_1_text_to_video",
    schema: HappyHorse11TextToVideoRequestSchema,
    args: { prompt: "plain prompt", duration: "5", resolution: "1080p", aspect_ratio: "16:9" },
  },
  {
    tool: "generate_kie_happyhorse_1_1_image_to_video",
    schema: HappyHorse11ImageToVideoRequestSchema,
    args: { prompt: "plain prompt", first_frame_ref: "https://example.test/first.png" },
  },
  {
    tool: "generate_kie_happyhorse_1_1_reference_to_video",
    schema: HappyHorse11ReferenceToVideoRequestSchema,
    args: { prompt: "plain prompt", image_refs: ["https://example.test/image.png"] },
  },
  {
    tool: "generate_kie_happyhorse_1_1_edit_video",
    schema: HappyHorseVideoEditRequestSchema,
    args: {
      prompt: "plain prompt",
      video_ref: "https://example.test/source.mp4",
      image_refs: ["https://example.test/image.png"],
    },
  },
  {
    tool: "generate_kie_minimax_h3_text_to_video",
    schema: MiniMaxH3TextToVideoRequestSchema,
    args: { prompt: "plain prompt", aspect_ratio: "16:9", duration: "6", resolution: "768P" },
  },
  {
    tool: "generate_kie_minimax_h3_image_to_video",
    schema: MiniMaxH3ImageToVideoRequestSchema,
    args: { prompt: "plain prompt", duration: "6", first_frame_ref: "https://example.test/first.png" },
  },
  {
    tool: "generate_kie_minimax_h3_reference_to_video",
    schema: MiniMaxH3ReferenceToVideoRequestSchema,
    args: {
      prompt: "plain prompt",
      duration: "6",
      image_refs: ["https://example.test/image.png"],
      aspect_ratio: "adaptive",
    },
  },
];

describe("translateToolPayload", () => {
  it("builds a schema-valid Qwen 3 image edit payload with provider defaults", () => {
    const result = translateToolPayload("generate_kie_qwen_3_0_edit_image", {
      prompt: "combine the references",
      image_refs: [
        "https://example.test/first.png",
        "https://example.test/second.png",
        "https://example.test/third.png",
      ],
    });

    expect(result?.payload).toEqual({
      model: "qwen3/image-to-image",
      input: {
        prompt: "combine the references",
        image_urls: [
          "https://example.test/first.png",
          "https://example.test/second.png",
          "https://example.test/third.png",
        ],
        image_size: "16:9",
        output_format: "png",
        prompt_extend: true,
        nsfw_checker: false,
        seed: 1,
        resolution: "1K",
      },
    });
    expect(Qwen3ImageToImageRequestSchema.safeParse(result?.payload).success).toBe(true);
  });

  it("safeParses against the kie createTask guard schema for every kie model", () => {
    for (const entry of kieGuardCases) {
      const result = translateToolPayload(entry.tool, entry.args);
      expect(result, entry.tool).not.toBeNull();
      if (!result) continue;
      const parsed = entry.schema.safeParse(result.payload);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((issue) => issue.message).join("; ");
        expect.unreachable(`${entry.tool} rejected by guard: ${issues}`);
      }
    }
  });

  it("enforces the mention leak gate across every provider payload case", () => {
    for (const entry of payloadCases) {
      const clean = translateToolPayload(
        entry.tool,
        argsForPayloadCase(entry.tool, "plain prompt"),
        entry.provider,
      );
      expect(clean, entry.tool).not.toBeNull();
      if (!clean) continue;
      expect(inspectProviderPayload(clean.payload).promptLeaks, entry.tool)
        .toEqual([]);
      if (!JSON.stringify(clean.payload).includes("plain prompt")) continue;
      expect(() => translateToolPayload(
        entry.tool,
        argsForPayloadCase(entry.tool, "leaked @a2"),
        entry.provider,
      ), entry.tool).toThrow(ProviderMentionError);
      expect(() => translateToolPayload(
        entry.tool,
        argsForPayloadCase(
          entry.tool,
          "leaked @01890f1c-0000-7000-8000-0000000000aa",
        ),
        entry.provider,
      ), entry.tool).toThrow(ProviderMentionError);
    }
  });

  it("rewrites prompt mentions of every ref a tool carries into its payload", () => {
    for (const entry of payloadCases) {
      const baseline = translateToolPayload(
        entry.tool,
        mentionArgsForPayloadCase(entry.tool, "plain prompt"),
        entry.provider,
      );
      expect(baseline, entry.tool).not.toBeNull();
      if (!baseline) continue;
      const wire = JSON.stringify(baseline.payload);
      if (!wire.includes("plain prompt")) continue;
      const carried = MENTION_REF_PARAMS
        .map((_, index) => refIdForParam(index))
        .filter((refId) => wire.includes(refId));
      if (carried.length === 0) continue;
      const prompt = carried.map((refId) => `@${refId}`).join(" then ");
      expect(() => translateToolPayload(
        entry.tool,
        mentionArgsForPayloadCase(entry.tool, prompt),
        entry.provider,
      ), entry.tool).not.toThrow();
    }
  });

  it("materializes Kling motion-control defaults when controls are Auto", () => {
    const result = translateToolPayload("generate_kie_kling_3_0_motion_control", {
      character_image_refs: ["@img-character"],
      motion_video_refs: ["@vid-motion"],
      mode: "",
      character_orientation: "",
      background_source: "",
    });

    expect(result?.payload).toEqual({
      model: "kling-3.0/motion-control",
      input: {
        input_urls: ["@img-character"],
        video_urls: ["@vid-motion"],
        mode: "720p",
        character_orientation: "video",
        background_source: "input_video",
      },
    });
    expect(KlingMotionControlRequestSchema.safeParse(result?.payload).success).toBe(true);
    if (!result) throw new Error("Expected Kling motion-control payload");
    const estimate = computeEstimate({
      provider: "kie",
      payload: result.payload,
      costHints: { durationSeconds: 6 },
    });
    expect(estimate.warnings).toEqual([]);
  });

  it("preserves explicit Kling motion-control settings", () => {
    const result = translateToolPayload("generate_kie_kling_3_0_motion_control", {
      character_image_refs: ["@img-character"],
      motion_video_refs: ["@vid-motion"],
      mode: "1080p",
      character_orientation: "image",
      background_source: "input_image",
    });

    expect(result?.payload.input).toMatchObject({
      mode: "1080p",
      character_orientation: "image",
      background_source: "input_image",
    });
    expect(KlingMotionControlRequestSchema.safeParse(result?.payload).success).toBe(true);
  });

  it("uses Apicity defaults for Kling Turbo text-to-video", () => {
    const result = translateToolPayload("generate_kling30_turbo_video", {
      prompt: "clouds crossing a mountain",
    });

    expect(result?.payload).toEqual({
      model: "kling/v3-turbo-text-to-video",
      input: {
        prompt: "clouds crossing a mountain",
        duration: "5",
        aspect_ratio: "16:9",
        resolution: "720p",
      },
    });
    expect(KlingV3TurboTextToVideoRequestSchema.safeParse(result?.payload).success).toBe(true);
  });

  it("honors Kling Turbo image-to-video resolution and applies shared defaults", () => {
    const result = translateToolPayload("generate_kling30_turbo_video", {
      prompt: "turn toward the camera",
      image_refs: ["https://example.test/input.png"],
      resolution: "1080p",
    });

    expect(result?.payload).toEqual({
      model: "kling/v3-turbo-image-to-video",
      input: {
        prompt: "turn toward the camera",
        image_urls: ["https://example.test/input.png"],
        duration: "5",
        resolution: "1080p",
      },
    });
    expect(KlingV3TurboImageToVideoRequestSchema.safeParse(result?.payload).success).toBe(true);
  });

  it("uses Apicity defaults for Volcengine lip sync", () => {
    const result = translateToolPayload("generate_volcengine_lipsync_video", {
      video_ref: "https://example.test/input.mp4",
      audio_ref: "https://example.test/input.mp3",
      mode: "lite",
    });

    expect(result?.payload).toEqual({
      model: "volcengine/video-to-video-lip-sync",
      input: {
        mode: "lite",
        video_url: "https://example.test/input.mp4",
        audio_url: "https://example.test/input.mp3",
        separate_vocal: false,
        open_scenedet: false,
        align_audio: true,
        align_audio_reverse: false,
        templ_start_seconds: 0,
      },
    });
    expect(VolcengineVideoToVideoLipSyncRequestSchema.safeParse(result?.payload).success).toBe(true);
  });

  it("builds current Kie Grok image-to-video payload with mode", () => {
    const result = translateToolPayload("generate_grok_imagine_video", {
      image_refs: ["https://example.test/input.png"],
      prompt: "wave at camera",
      mode: "fun",
      duration: 8,
      resolution: "720p",
      aspect_ratio: "16:9",
      nsfw_checker: false,
    });

    // image_urls path: no index (index is task_id-only per Kie docs)
    expect(result?.payload).toEqual({
      model: "grok-imagine/image-to-video",
      input: {
        image_urls: ["https://example.test/input.png"],
        prompt: "wave at camera",
        mode: "fun",
        aspect_ratio: "16:9",
        resolution: "720p",
        duration: 8,
        nsfw_checker: false,
      },
    });
    expect(result?.payload.input).not.toHaveProperty("index");
    expect(result?.payload.input).not.toHaveProperty("task_id");
  });

  it("materializes all Kie Grok image-to-video defaults in previews", () => {
    const result = translateToolPayload("generate_grok_imagine_video", {
      image_refs: ["@img-input"],
      prompt: "wave at camera",
      aspect_ratio: "9:16",
    });

    expect(result?.payload).toEqual({
      model: "grok-imagine/image-to-video",
      input: {
        image_urls: ["@img-input"],
        prompt: "wave at camera",
        mode: "normal",
        aspect_ratio: "9:16",
        resolution: "480p",
        duration: 6,
        nsfw_checker: false,
      },
    });
  });

  it("rejects Kie Grok 1080p payloads with multiple image inputs", () => {
    expect(() => translateToolPayload("generate_grok_imagine_video", {
      image_refs: [
        "https://example.test/first.png",
        "https://example.test/second.png",
      ],
      resolution: "1080p",
    })).toThrow("accepts exactly 1 image at 1080p (got 2)");
  });

  it("rewrites @<artifact-id> prompt mentions to Kie @imageN form", () => {
    const IMG = "01890f1c-0000-7000-8000-0000000000aa";
    const result = translateToolPayload("generate_grok_imagine_video", {
      image_refs: [`@${IMG}`],
      prompt: `@${IMG} in bangkok high on shrooms`,
      mode: "fun",
      duration: 6,
      resolution: "720p",
      aspect_ratio: "1:1",
    });

    expect(result?.payload).toMatchObject({
      model: "grok-imagine/image-to-video",
      input: {
        image_urls: [`@${IMG}`],
        prompt: "@image1 in bangkok high on shrooms",
        mode: "fun",
        duration: 6,
        resolution: "720p",
        aspect_ratio: "1:1",
      },
    });
    expect(result?.payload.input).not.toHaveProperty("index");
  });

  it("orders image_urls by first prompt mention so @image1 is the first named image", () => {
    // Tool-call list order is [lay, catblack] but the prompt names catblack
    // first. Kie @imageN is the Nth entry of image_urls — reorder so
    // mentions stay natural: "@image1 morphs into @image2".
    const LAY = "01890f1c-0000-7000-8000-00000000ce11";
    const CATBLACK = "01890f1c-0000-7000-8000-00000000cafe";
    const result = translateToolPayload("generate_grok_imagine_video", {
      image_refs: [`@${LAY}`, `@${CATBLACK}`],
      prompt: `@${CATBLACK} morphs into @${LAY}`,
      mode: "normal",
      duration: 6,
      resolution: "720p",
      aspect_ratio: "1:1",
      nsfw_checker: false,
    });

    expect(result?.payload).toEqual({
      model: "grok-imagine/image-to-video",
      input: {
        image_urls: [`@${CATBLACK}`, `@${LAY}`],
        prompt: "@image1 morphs into @image2",
        mode: "normal",
        aspect_ratio: "1:1",
        resolution: "720p",
        duration: 6,
        nsfw_checker: false,
      },
    });
  });

  it("normalizes spicy mode for uploaded Grok image-to-video inputs", () => {
    const result = translateToolPayload("generate_grok_imagine_video", {
      image_refs: ["https://example.test/input.png"],
      mode: "spicy",
    });

    expect(result?.payload.input).toMatchObject({
      mode: "normal",
    });
  });

  it("builds a schema-valid Grok video extension payload", () => {
    const result = translateToolPayload("extend_grok_imagine_video", {
      prompt: "continue through the doorway",
      extend_at: 3,
      extend_times: "10",
    });

    expect(result?.payload).toEqual({
      model: "grok-imagine/extend",
      input: {
        task_id: "<task_id_from_source_video_metadata>",
        prompt: "continue through the doorway",
        extend_at: 3,
        extend_times: "10",
      },
    });
    expect(GrokVideoExtendRequestSchema.safeParse(result?.payload).success).toBe(true);
  });

  it("builds a schema-valid Seedance 2.5 payload with every option", () => {
    const result = translateToolPayload("generate_kie_seedance_2_5_video", {
      prompt: "a continuous tracking shot",
      image_refs: ["https://example.test/ref.png"],
      video_refs: ["https://example.test/motion.mp4"],
      audio_refs: ["https://example.test/score.mp3"],
      return_last_frame: true,
      generate_audio: false,
      resolution: "480p",
      aspect_ratio: "21:9",
      duration: "-1",
      output_format: "mov",
      web_search: true,
      nsfw_checker: true,
    });

    expect(result?.payload).toEqual({
      model: "bytedance/seedance-2-5",
      input: {
        prompt: "a continuous tracking shot",
        reference_image_urls: ["https://example.test/ref.png"],
        reference_video_urls: ["https://example.test/motion.mp4"],
        reference_audio_urls: ["https://example.test/score.mp3"],
        return_last_frame: true,
        generate_audio: false,
        resolution: "480p",
        aspect_ratio: "21:9",
        duration: -1,
        output_format: "mov",
        web_search: true,
        nsfw_checker: true,
      },
    });
    expect(Seedance25RequestSchema.safeParse(result?.payload).success).toBe(true);
  });

  it("applies every Seedance 2.5 default to translated payloads", () => {
    const result = translateToolPayload("generate_seedance25_video", {
      prompt: "a quiet landscape",
    });

    expect(result?.payload).toEqual({
      model: "bytedance/seedance-2-5",
      input: {
        prompt: "a quiet landscape",
        return_last_frame: false,
        generate_audio: true,
        resolution: "720p",
        aspect_ratio: "adaptive",
        duration: 5,
        output_format: "mp4",
        nsfw_checker: false,
      },
    });
    expect(Seedance25RequestSchema.safeParse(result?.payload).success).toBe(true);
  });

  it("builds a schema-valid Seedance 2 Mini payload (refs, no first/last frame)", () => {
    const result = translateToolPayload("generate_seedance2_mini_video", {
      prompt: "a tiny horse trotting",
      image_refs: ["https://example.test/ref.png"],
      video_refs: ["https://example.test/motion.mp4"],
      aspect_ratio: "adaptive",
      resolution: "720p",
      duration: "12",
      generate_audio: true,
      nsfw_checker: false,
    });

    expect(result?.payload).toEqual({
      model: "bytedance/seedance-2-mini",
      input: {
        prompt: "a tiny horse trotting",
        reference_image_urls: ["https://example.test/ref.png"],
        reference_video_urls: ["https://example.test/motion.mp4"],
        aspect_ratio: "adaptive",
        resolution: "720p",
        duration: 12,
        generate_audio: true,
        // Schema defaults still fill omitted optional toggles (web_search).
        web_search: false,
        nsfw_checker: false,
      },
    });
    expect(Seedance2MiniRequestSchema.safeParse(result?.payload).success).toBe(true);
  });

  // vc-3vn2: omitting resolution with reference_video_urls used to mint an
  // unbounded cost key (variant 'video' instead of '720p|video').
  it("defaults Seedance 2 Mini resolution/duration so cost can key video rates", () => {
    const result = translateToolPayload("generate_seedance2_mini_video", {
      prompt: "scene continuity",
      video_refs: ["https://example.test/scene.mp4"],
    });

    expect(result?.payload).toMatchObject({
      model: "bytedance/seedance-2-mini",
      input: {
        prompt: "scene continuity",
        reference_video_urls: ["https://example.test/scene.mp4"],
        resolution: "720p",
        duration: 5,
      },
    });
    expect(Seedance2MiniRequestSchema.safeParse(result?.payload).success).toBe(true);
  });

  it("defaults Grok text-to-video duration and resolution on the wire", () => {
    const result = translateToolPayload("generate_kie_grok_imagine_text_to_video", {
      prompt: "a quiet skyline",
    });

    expect(result?.payload).toMatchObject({
      model: "grok-imagine/text-to-video",
      input: {
        prompt: "a quiet skyline",
        duration: 6,
        resolution: "480p",
      },
    });
    expect(GrokTextToVideoRequestSchema.safeParse(result?.payload).success).toBe(true);
  });

  it("builds Veo 3.1 lite-low-priority payload with model literal", () => {
    const result = translateToolPayload("generate_google_flow_veo_3_1_lite_low_priority_video", {
      prompt: "slow clouds",
      duration: "4",
      aspect_ratio: "16:9",
      image_refs: ["ref-1"],
    });
    expect(result?.provider_path).toBe("googleflow.v1.videos({ async: true })");
    // Reference-to-video requires duration 8 under the current Google Flow schema.
    expect(result?.payload).toEqual({
      prompt: "slow clouds",
      model: "veo-3.1-lite-low-priority",
      duration: 8,
      aspectRatio: "landscape",
      referenceImage_1: "ref-1",
    });
    expect(GoogleFlowVideosRequestSchema.safeParse(result?.payload).success).toBe(true);
  });

  it("builds Google Omni I2V payload with startImage", () => {
    const result = translateToolPayload("generate_google_omni_video", {
      prompt: "animate the first frame",
      first_frame_ref: "user:123-email:test-image:start",
      duration: "6",
      aspect_ratio: "9:16",
    });

    expect(result?.provider_path).toBe("googleflow.v1.videos({ async: true })");
    expect(result?.payload).toEqual({
      prompt: "animate the first frame",
      model: "omni-flash",
      duration: 6,
      aspectRatio: "portrait",
      startImage: "user:123-email:test-image:start",
    });
  });

  it("builds Google Omni R2V payload with reference images and default duration", () => {
    const result = translateToolPayload("generate_google_omni_video", {
      prompt: "use these references",
      image_refs: ["ref-1", "ref-2"],
      aspect_ratio: "16:9",
    });

    expect(result?.payload).toEqual({
      prompt: "use these references",
      model: "omni-flash",
      duration: 8,
      aspectRatio: "landscape",
      referenceImage_1: "ref-1",
      referenceImage_2: "ref-2",
    });
  });

  it("builds Google Omni V2V payload without duration and with explicit frame indexes", () => {
    const result = translateToolPayload("generate_google_omni_video", {
      prompt: "edit the clip",
      video_ref: "user:123-email:test-video:clip",
      image_refs: ["ref-1"],
      duration: "10",
      video_clip_start: 2,
      video_clip_ends: 10,
    });

    expect(result?.payload).toEqual({
      prompt: "edit the clip",
      model: "omni-flash",
      referenceImage_1: "ref-1",
      referenceVideo_1: "user:123-email:test-video:clip",
      startFrameIndex_1: 48,
      endFrameIndex_1: 240,
    });
  });

  it("edit-mode-filtered args (no duration key) produce the same V2V wire as duration-present", () => {
    // The client's mode filter OMITS duration in edit mode; the builder drops
    // it anyway when a clip is present. Both must yield the identical payload.
    const result = translateToolPayload("generate_google_omni_video", {
      prompt: "edit the clip",
      video_ref: "user:123-email:test-video:clip",
      image_refs: ["ref-1"],
      video_clip_start: 2,
      video_clip_ends: 10,
    });

    expect(result?.payload).toEqual({
      prompt: "edit the clip",
      model: "omni-flash",
      referenceImage_1: "ref-1",
      referenceVideo_1: "user:123-email:test-video:clip",
      startFrameIndex_1: 48,
      endFrameIndex_1: 240,
    });
  });

  it("builds Google Omni V2V payload without fabricated trim indexes", () => {
    const result = translateToolPayload("generate_google_omni_video", {
      prompt: "edit the clip",
      video_ref: "user:123-email:test-video:clip",
      duration: "8",
    });

    expect(result?.payload).toEqual({
      prompt: "edit the clip",
      model: "omni-flash",
      referenceVideo_1: "user:123-email:test-video:clip",
    });
  });

  it("builds Google Omni R2V payload with voice refs (referenceAudio_N) and character refs (character_N)", () => {
    const result = translateToolPayload("generate_google_omni_video", {
      prompt: "cast these",
      image_refs: ["ref-1"],
      voice_refs: ["voice:aaa", "voice:bbb"],
      character_refs: ["character:ccc"],
      aspect_ratio: "16:9",
    });

    expect(result?.payload).toEqual({
      prompt: "cast these",
      model: "omni-flash",
      duration: 8,
      aspectRatio: "landscape",
      referenceImage_1: "ref-1",
      referenceAudio_1: "voice:aaa",
      referenceAudio_2: "voice:bbb",
      character_1: "character:ccc",
    });
    // Payload validates against the tightened 0.7.2 videos request schema
    // (numeric-literal duration, named ref slots).
    expect(GoogleFlowVideosRequestSchema.safeParse(result?.payload).success).toBe(true);
  });

  it("builds Google Omni V2V payload with voice refs and no duration", () => {
    const result = translateToolPayload("generate_google_omni_video", {
      prompt: "edit with narration",
      video_ref: "user:123-email:test-video:clip",
      voice_refs: ["voice:aaa"],
      duration: "8",
    });

    expect(result?.payload).toEqual({
      prompt: "edit with narration",
      model: "omni-flash",
      referenceVideo_1: "user:123-email:test-video:clip",
      referenceAudio_1: "voice:aaa",
    });
    expect(GoogleFlowVideosRequestSchema.safeParse(result?.payload).success).toBe(true);
  });

  it("rewrites @slug prompt mentions to @reference_N for Nano Banana Pro (Google)", () => {
    const result = translateToolPayload("generate_nano_banana_pro_google", {
      prompt: "@img-vancat in multiple poses like @img-shots in the purple nebula",
      image_refs: ["@img-shots", "@img-vcprof", "@img-vancat"],
      aspect_ratio: "16:9",
      book_id: "realcat",
    }, "google");

    expect(result?.provider_path).toBe("googleflow.v1.images()");
    expect(result?.payload).toEqual({
      prompt: "@reference_3 in multiple poses like @reference_1 in the purple nebula",
      model: "nano-banana-pro",
      count: 1,
      aspectRatio: "16:9",
      reference_1: "@img-shots",
      reference_2: "@img-vcprof",
      reference_3: "@img-vancat",
    });
  });

  it("rewrites @slug mentions to @referenceImage_N and strips frame mentions for Veo 3.1", () => {
    const result = translateToolPayload("generate_veo31_video", {
      prompt: "pan across @img-set starting from @img-open",
      image_refs: ["img-set"],
      first_frame_ref: "img-open",
      duration: "4",
      aspect_ratio: "16:9",
    });

    expect(result?.payload).toEqual({
      prompt: "pan across @referenceImage_1 starting from",
      model: "veo-3.1-quality",
      // Reference-image R2V only accepts duration 8 under current schema.
      duration: 8,
      aspectRatio: "landscape",
      startImage: "img-open",
      referenceImage_1: "img-set",
    });
  });

  it("rewrites @slug mentions and strips the clip mention for Google Omni V2V", () => {
    const result = translateToolPayload("generate_google_omni_video", {
      prompt: "put @img-hat into @vid-clip",
      video_ref: "vid-clip",
      image_refs: ["img-hat"],
    });

    expect(result?.payload).toEqual({
      prompt: "put @referenceImage_1 into",
      model: "omni-flash",
      referenceImage_1: "img-hat",
      referenceVideo_1: "vid-clip",
    });
  });

  it("normalizes @slug mentions in HappyHorse video-edit prompts for the preview", () => {
    // happyhorse/video-edit (1.0) has no inline marker syntax, so the preview
    // rewrites @<slug> mentions to natural-language noun phrases — the user
    // sees exactly what will hit the wire (no local asset IDs, references
    // still unambiguous by position).
    const result = translateToolPayload("generate_happyhorse_videoedit_video", {
      prompt: "Replace the boy in @vid-scene-1 with the character in @img-spongebob, then add @img-extra style",
      video_ref: "@vid-scene-1",
      image_refs: ["@img-spongebob", "img-extra"],
      resolution: "1080p",
    });

    expect(result?.payload).toEqual({
      model: "happyhorse/video-edit",
      input: {
        prompt: "Replace the boy in the source video with the character in reference image 1, then add reference image 2 style",
        video_url: "@vid-scene-1",
        reference_image: ["@img-spongebob", "img-extra"],
        resolution: "1080p",
      },
    });
  });

  it("strips @slugs from the exact vc-4oab repro prompt", () => {
    // Observed in production: video-edit step submitted prompt
    // 'scene @vid-full-notats replace attress with @img-nbp-scene-reference-1-5'
    // and the provider payload carried that exact string, leaking local asset
    // IDs to HappyHorse. Both the preview and the runtime path now rewrite.
    const result = translateToolPayload("generate_happyhorse_videoedit_video", {
      prompt: "scene @vid-full-notats replace attress with @img-nbp-scene-reference-1-5",
      video_ref: "vid-full-notats",
      image_refs: ["img-nbp-scene-reference-1-5"],
    });

    const prompt = (result?.payload as { input: { prompt: string } }).input.prompt;
    expect(prompt).not.toMatch(/@vid-/);
    expect(prompt).not.toMatch(/@img-/);
    expect(prompt).toBe("scene the source video replace attress with reference image 1");
  });

  it("leaves non-asset @text untouched in HappyHorse video-edit prompts", () => {
    // Stray @tokens that aren't in video_ref/image_refs stay literal — only
    // confirmed asset slugs are rewritten.
    const result = translateToolPayload("generate_happyhorse_videoedit_video", {
      prompt: "@notify support about @vid-clip and @img-char",
      video_ref: "vid-clip",
      image_refs: ["img-char"],
    });

    expect((result?.payload as { input: { prompt: string } }).input.prompt).toBe(
      "@notify support about the source video and reference image 1",
    );
  });

  it("passes HappyHorse video-edit prompts that already read naturally", () => {
    const result = translateToolPayload("generate_happyhorse_videoedit_video", {
      prompt: "Replace the teenage boy in the video with SpongeBob SquarePants.",
      video_ref: "vid-clip",
      image_refs: ["img-char"],
    });

    expect((result?.payload as { input: { prompt: string } }).input.prompt).toBe(
      "Replace the teenage boy in the video with SpongeBob SquarePants.",
    );
  });

  it("rewrites HappyHorse ref prompts to [Image N] markers", () => {
    const result = translateToolPayload("generate_happyhorse_ref_video", {
      prompt: "the woman in @img-char waves at the camera",
      image_refs: ["img-char", "img-bg"],
    });

    expect((result?.payload as { input: { prompt: string } }).input.prompt).toBe(
      "the woman in [Image 1] waves at the camera",
    );
  });

  it("rewrites Seedance @slug mentions to @ImageN/@VideoN/@AudioN", () => {
    const result = translateToolPayload("generate_seedance2_video", {
      prompt: "animate @img-hero like @vid-motion with @aud-score",
      image_refs: ["img-hero"],
      video_refs: ["vid-motion"],
      audio_refs: ["aud-score"],
    });

    expect((result?.payload as { input: { prompt: string } }).input.prompt).toBe(
      "animate @Image1 like @Video1 with @Audio1",
    );
  });

  it("rewrites the Seedance 2 Mini sidebar repro prompt (vc-gb9g)", () => {
    // GEN VIDEO /provider-payload showed:
    //   prompt: "scene @vid-full-notats replace attress with @img-actress"
    // Wire form must use Seedance markers so the user can visually verify the
    // outbound text; URL fields may still show local slugs as placeholders.
    const result = translateToolPayload("generate_seedance2_mini_video", {
      prompt: "scene @vid-full-notats replace attress with @img-actress",
      image_refs: ["@img-actress"],
      video_refs: ["@vid-full-notats"],
      aspect_ratio: "16:9",
      resolution: "720p",
      duration: "15",
      generate_audio: true,
      web_search: false,
    });

    const input = (result?.payload as {
      model: string;
      input: {
        prompt: string;
        reference_image_urls: string[];
        reference_video_urls: string[];
      };
    }).input;
    expect(result?.payload).toMatchObject({ model: "bytedance/seedance-2-mini" });
    expect(input.prompt).toBe("scene @Video1 replace attress with @Image1");
    expect(input.prompt).not.toMatch(/@vid-/);
    expect(input.prompt).not.toMatch(/@img-/);
    expect(input.reference_image_urls).toEqual(["@img-actress"]);
    expect(input.reference_video_urls).toEqual(["@vid-full-notats"]);
  });

});

describe("MiniMax H3 payload builders", () => {
  it("builds a schema-valid text-to-video payload with an int duration", () => {
    const payload = buildMiniMaxH3T2vPayload({
      prompt: "a crane over still water",
      aspect_ratio: "16:9",
      duration: "6",
      resolution: "2K",
    });

    expect(payload).toEqual({
      model: "minimax-h3/text-to-video",
      input: {
        prompt: "a crane over still water",
        aspect_ratio: "16:9",
        duration: 6,
        resolution: "2K",
      },
    });
    expect(MiniMaxH3TextToVideoRequestSchema.safeParse(payload).success).toBe(true);
  });

  it("builds a schema-valid image-to-video payload from a single frame", () => {
    const payload = buildMiniMaxH3I2vPayload(
      { prompt: "slow push in", duration: "8" },
      { firstFrameUrl: "https://example.test/first.png" },
    );

    expect(payload).toEqual({
      model: "minimax-h3/image-to-video",
      input: {
        prompt: "slow push in",
        duration: 8,
        first_frame_url: "https://example.test/first.png",
      },
    });
    expect(MiniMaxH3ImageToVideoRequestSchema.safeParse(payload).success).toBe(true);
  });

  it("builds a schema-valid image-to-video payload with both frames and resolution", () => {
    const payload = buildMiniMaxH3I2vPayload(
      { prompt: "slow push in", duration: "8", resolution: "768P" },
      {
        firstFrameUrl: "https://example.test/first.png",
        lastFrameUrl: "https://example.test/last.png",
      },
    );

    expect(payload.input).toMatchObject({
      first_frame_url: "https://example.test/first.png",
      last_frame_url: "https://example.test/last.png",
      duration: 8,
      resolution: "768P",
    });
    expect(MiniMaxH3ImageToVideoRequestSchema.safeParse(payload).success).toBe(true);
  });

  it("builds a schema-valid reference-to-video payload with image, oss video, and audio refs", () => {
    const payload = buildMiniMaxH3R2vPayload(
      { prompt: "blend these", duration: "10", aspect_ratio: "adaptive" },
      {
        referenceImageUrls: ["https://example.test/a.png"],
        referenceVideoUrls: ["oss://bucket/clip.mp4"],
        referenceAudioUrls: ["https://example.test/a.mp3"],
      },
    );

    expect(payload).toEqual({
      model: "minimax-h3/reference-to-video",
      input: {
        prompt: "blend these",
        duration: 10,
        reference_image_urls: ["https://example.test/a.png"],
        reference_video_urls: ["oss://bucket/clip.mp4"],
        reference_audio_urls: ["https://example.test/a.mp3"],
        aspect_ratio: "adaptive",
      },
    });
    expect(MiniMaxH3ReferenceToVideoRequestSchema.safeParse(payload).success).toBe(true);
  });

  it("rejects image-to-video with neither a first nor a last frame URL", () => {
    const payload = buildMiniMaxH3I2vPayload({ prompt: "slow push in", duration: "8" }, {});

    const parsed = MiniMaxH3ImageToVideoRequestSchema.safeParse(payload);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((issue) => issue.message).join(" ")).toContain("first_frame_url");
    }
  });

  it("rejects reference-to-video with audio-only references", () => {
    const payload = buildMiniMaxH3R2vPayload(
      { prompt: "blend these", duration: "6" },
      { referenceAudioUrls: ["https://example.test/a.mp3"] },
    );

    const parsed = MiniMaxH3ReferenceToVideoRequestSchema.safeParse(payload);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((issue) => issue.message).join(" ")).toContain("reference_image_urls");
    }
  });

  it("rejects reference-to-video with more than 9 reference images", () => {
    const tenImages = Array.from({ length: 10 }, (_, i) => `https://example.test/img-${i}.png`);
    const payload = buildMiniMaxH3R2vPayload(
      { prompt: "blend these", duration: "6" },
      { referenceImageUrls: tenImages },
    );

    expect(MiniMaxH3ReferenceToVideoRequestSchema.safeParse(payload).success).toBe(false);
  });

  it("rejects durations outside the 4-15 second range", () => {
    for (const duration of ["3", "16"]) {
      const payload = buildMiniMaxH3T2vPayload({
        prompt: "a crane over still water",
        aspect_ratio: "16:9",
        duration,
      });
      expect(MiniMaxH3TextToVideoRequestSchema.safeParse(payload).success).toBe(false);
    }
  });

  it("rejects non-http/https/oss media addresses", () => {
    const i2v = buildMiniMaxH3I2vPayload(
      { prompt: "slow push in", duration: "8" },
      { firstFrameUrl: "file:///tmp/x.png" },
    );
    expect(MiniMaxH3ImageToVideoRequestSchema.safeParse(i2v).success).toBe(false);

    const r2v = buildMiniMaxH3R2vPayload(
      { prompt: "blend these", duration: "6" },
      { referenceVideoUrls: ["ftp://example.test/clip.mp4"] },
    );
    expect(MiniMaxH3ReferenceToVideoRequestSchema.safeParse(r2v).success).toBe(false);
  });
});
