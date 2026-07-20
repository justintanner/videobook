import { describe, expect, it } from "vitest";
import {
  GrokVideoExtendRequestSchema,
  KlingV3TurboImageToVideoRequestSchema,
  KlingV3TurboTextToVideoRequestSchema,
  Seedance2MiniRequestSchema,
  VolcengineVideoToVideoLipSyncRequestSchema,
  Wan27ImageRequestSchema,
} from "@apicity/kie/zod";
import { GoogleFlowVideosRequestSchema } from "@apicity/googleflow/zod";
import { translateToolPayload } from "./payload-builders.js";

describe("translateToolPayload", () => {
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
      image_slugs: ["https://example.test/input.png"],
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

  it("uses Apicity defaults for Wan 2.7 image generation", () => {
    const result = translateToolPayload("generate_wan27_image", {
      prompt: "a quiet lakeside cabin",
    });

    expect(result?.payload).toEqual({
      model: "wan/2-7-image",
      input: {
        prompt: "a quiet lakeside cabin",
        aspect_ratio: "16:9",
        resolution: "2K",
        nsfw_checker: false,
      },
    });
    expect(Wan27ImageRequestSchema.safeParse(result?.payload).success).toBe(true);
  });

  it("uses Apicity defaults for Volcengine lip sync", () => {
    const result = translateToolPayload("generate_volcengine_lipsync_video", {
      video_slug: "https://example.test/input.mp4",
      audio_slug: "https://example.test/input.mp3",
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
      image_slugs: ["https://example.test/input.png"],
      prompt: "wave at camera",
      mode: "fun",
      duration: 8,
      resolution: "720p",
      aspect_ratio: "16:9",
      nsfw_checker: false,
    });

    expect(result?.payload).toEqual({
      model: "grok-imagine/image-to-video",
      input: {
        image_urls: ["https://example.test/input.png"],
        prompt: "wave at camera",
        index: 0,
        mode: "fun",
        aspect_ratio: "16:9",
        resolution: "720p",
        duration: 8,
        nsfw_checker: false,
      },
    });
  });

  it("normalizes spicy mode for uploaded Grok image-to-video inputs", () => {
    const result = translateToolPayload("generate_grok_imagine_video", {
      image_slugs: ["https://example.test/input.png"],
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
        extend_at: "3",
        extend_times: "10",
      },
    });
    expect(GrokVideoExtendRequestSchema.safeParse(result?.payload).success).toBe(true);
  });

  it("builds a schema-valid Seedance 2 Mini payload (refs, no first/last frame)", () => {
    const result = translateToolPayload("generate_seedance2_mini_video", {
      prompt: "a tiny horse trotting",
      image_slugs: ["https://example.test/ref.png"],
      video_slugs: ["https://example.test/motion.mp4"],
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
        nsfw_checker: false,
      },
    });
    expect(Seedance2MiniRequestSchema.safeParse(result?.payload).success).toBe(true);
  });

  it("builds Veo 3.1 lite-low-priority payload with model literal", () => {
    const result = translateToolPayload("generate_veo31_lite_low_priority_video", {
      prompt: "slow clouds",
      duration: "4",
      aspect_ratio: "16:9",
      image_slugs: ["ref-1"],
    });
    expect(result?.provider_path).toBe("googleflow.v1.videos({ async: true })");
    expect(result?.payload).toEqual({
      prompt: "slow clouds",
      model: "veo-3.1-lite-low-priority",
      duration: 4,
      aspectRatio: "landscape",
      referenceImage_1: "ref-1",
    });
    expect(GoogleFlowVideosRequestSchema.safeParse(result?.payload).success).toBe(true);
  });

  it("builds Google Omni I2V payload with startImage", () => {
    const result = translateToolPayload("generate_google_omni_video", {
      prompt: "animate the first frame",
      first_frame_slug: "user:123-email:test-image:start",
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
      image_slugs: ["ref-1", "ref-2"],
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
      video_slug: "user:123-email:test-video:clip",
      image_slugs: ["ref-1"],
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
      video_slug: "user:123-email:test-video:clip",
      image_slugs: ["ref-1"],
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
      video_slug: "user:123-email:test-video:clip",
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
      image_slugs: ["ref-1"],
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
      video_slug: "user:123-email:test-video:clip",
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
      image_slugs: ["@img-shots", "@img-vcprof", "@img-vancat"],
      aspect_ratio: "16:9",
      project_slug: "realcat",
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
      image_slugs: ["img-set"],
      first_frame_slug: "img-open",
      duration: "4",
      aspect_ratio: "16:9",
    });

    expect(result?.payload).toEqual({
      prompt: "pan across @referenceImage_1 starting from",
      model: "veo-3.1-quality",
      duration: 4,
      aspectRatio: "landscape",
      startImage: "img-open",
      referenceImage_1: "img-set",
    });
  });

  it("rewrites @slug mentions and strips the clip mention for Google Omni V2V", () => {
    const result = translateToolPayload("generate_google_omni_video", {
      prompt: "put @img-hat into @vid-clip",
      video_slug: "vid-clip",
      image_slugs: ["img-hat"],
    });

    expect(result?.payload).toEqual({
      prompt: "put @referenceImage_1 into",
      model: "omni-flash",
      referenceImage_1: "img-hat",
      referenceVideo_1: "vid-clip",
    });
  });
});
