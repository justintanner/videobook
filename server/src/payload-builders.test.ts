import { describe, expect, it } from "vitest";
import { Seedance2MiniRequestSchema } from "@apicity/kie/zod";
import { GoogleFlowVideosRequestSchema } from "@apicity/googleflow/zod";
import { translateToolPayload } from "./payload-builders.js";

describe("translateToolPayload", () => {
  it("builds current Kie Grok image-to-video payload with mode", () => {
    const result = translateToolPayload("generate_grok_imagine_video", {
      image_slugs: ["https://example.test/input.png"],
      prompt: "wave at camera",
      mode: "fun",
      duration: 8,
      resolution: "720p",
      aspect_ratio: "16:9",
      nsfw_checker: true,
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
        nsfw_checker: true,
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

  it("builds a schema-valid Seedance 2 Mini payload (refs, no first/last frame)", () => {
    const result = translateToolPayload("generate_seedance2_mini_video", {
      prompt: "a tiny horse trotting",
      image_slugs: ["https://example.test/ref.png"],
      video_slugs: ["https://example.test/motion.mp4"],
      aspect_ratio: "adaptive",
      resolution: "720p",
      duration: "12",
      generate_audio: true,
      nsfw_checker: true,
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
        nsfw_checker: true,
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
});
