import { describe, expect, it } from "vitest";
import {
  applyPreviewPlaceholderUrls,
  isPreviewPlaceholderUrl,
  previewPlaceholderUrl,
} from "./preview-payload.js";

describe("preview payload URLs", () => {
  it("converts local refs only in URL-shaped fields", () => {
    const result = applyPreviewPlaceholderUrls({
      input: {
        prompt: "use @img-hero",
        input_urls: ["@img-hero"],
        video_urls: ["@vid-yt-3h3i_td5kce"],
        callback_url: "https://example.test/callback",
      },
    });
    expect(result.payload).toEqual({
      input: {
        prompt: "use @img-hero",
        input_urls: ["http://url.resolved.later.for/img-hero"],
        video_urls: ["http://url.resolved.later.for/vid-yt-3h3i_td5kce"],
        callback_url: "https://example.test/callback",
      },
    });
    expect(result.placeholders).toMatchObject([
      { path: "input.input_urls[0]", reference: "@img-hero" },
      { path: "input.video_urls[0]", reference: "@vid-yt-3h3i_td5kce" },
    ]);
  });

  it("produces valid recognizable URLs", () => {
    const url = previewPlaceholderUrl("@img-hero");
    expect(() => new URL(url)).not.toThrow();
    expect(isPreviewPlaceholderUrl(url)).toBe(true);
    expect(isPreviewPlaceholderUrl("https://example.test/img.png")).toBe(false);
  });
});
