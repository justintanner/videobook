import { describe, expect, it } from "vitest";
import { buildSeedance25Schema } from "./generate-seedance25-video.js";

describe("buildSeedance25Schema", () => {
  it("exposes every Apicity 0.10.2 Seedance 2.5 option", () => {
    const schema = buildSeedance25Schema();

    expect(Object.keys(schema)).toEqual([
      "book_id",
      "prompt",
      "first_frame_ref",
      "last_frame_ref",
      "image_refs",
      "video_refs",
      "audio_refs",
      "return_last_frame",
      "generate_audio",
      "resolution",
      "aspect_ratio",
      "duration",
      "output_format",
      "web_search",
      "nsfw_checker",
      "replace_audio_with",
      "_provider",
    ]);
    expect(schema.prompt.safeParse(undefined).success).toBe(true);
    expect(schema.prompt.safeParse("x".repeat(30_000)).success).toBe(true);
    expect(schema.prompt.safeParse("x".repeat(30_001)).success).toBe(false);
    expect(schema.image_refs.safeParse(Array.from({ length: 30 }, (_, index) => `@img-${index}`)).success).toBe(true);
    expect(schema.image_refs.safeParse(Array.from({ length: 31 }, (_, index) => `@img-${index}`)).success).toBe(false);
    expect(schema.video_refs.safeParse(Array.from({ length: 10 }, (_, index) => `@vid-${index}`)).success).toBe(true);
    expect(schema.video_refs.safeParse(Array.from({ length: 11 }, (_, index) => `@vid-${index}`)).success).toBe(false);
    expect(schema.audio_refs.safeParse(Array.from({ length: 10 }, (_, index) => `@aud-${index}`)).success).toBe(true);
    expect(schema.audio_refs.safeParse(Array.from({ length: 11 }, (_, index) => `@aud-${index}`)).success).toBe(false);
    expect(schema.duration.safeParse("-1").success).toBe(true);
    expect(schema.duration.safeParse("4").success).toBe(true);
    expect(schema.duration.safeParse("30").success).toBe(true);
    expect(schema.duration.safeParse("31").success).toBe(false);
    expect(schema.resolution.safeParse("480p").success).toBe(true);
    expect(schema.resolution.safeParse("720p").success).toBe(true);
    expect(schema.resolution.safeParse("1080p").success).toBe(true);
    expect(schema.resolution.safeParse("4k").success).toBe(false);
    expect(schema.aspect_ratio.safeParse("adaptive").success).toBe(true);
    expect(schema.output_format.safeParse("mp4").success).toBe(true);
    expect(schema.output_format.safeParse("mov").success).toBe(true);
    expect(schema.output_format.safeParse("webm").success).toBe(false);
    expect(schema.return_last_frame.safeParse(true).success).toBe(true);
    expect(schema.generate_audio.safeParse(false).success).toBe(true);
    expect(schema.web_search.safeParse(true).success).toBe(true);
    expect(schema.nsfw_checker.safeParse(false).success).toBe(true);
  });
});
