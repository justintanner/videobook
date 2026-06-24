import { describe, expect, it } from "vitest";
import { Seedance2MiniRequestSchema } from "@apicity/kie/zod";
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
});
