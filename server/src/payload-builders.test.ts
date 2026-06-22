import { describe, expect, it } from "vitest";
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
});
