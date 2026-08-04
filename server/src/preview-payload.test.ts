import { describe, expect, it } from "vitest";
import {
  applyPreviewPlaceholderUrls,
  isPreviewPlaceholderUrl,
  previewPlaceholderUrl,
} from "./preview-payload.js";

const IMG_ID = "01890f1c-0000-7000-8000-0000000000aa";
const VID_ID = "01890f1c-0000-7000-8000-0000000000bb";

describe("preview payload URLs", () => {
  it("converts artifact-id and grid refs only in URL-shaped fields", () => {
    const result = applyPreviewPlaceholderUrls({
      input: {
        prompt: `use @${IMG_ID}`,
        input_urls: [`@${IMG_ID}`],
        video_urls: [`@${VID_ID}`, "@b3"],
        callback_url: "https://example.test/callback",
      },
    });
    expect(result.payload).toEqual({
      input: {
        prompt: `use @${IMG_ID}`,
        input_urls: [`http://url.resolved.later.for/${IMG_ID}`],
        video_urls: [
          `http://url.resolved.later.for/${VID_ID}`,
          "http://url.resolved.later.for/b3",
        ],
        callback_url: "https://example.test/callback",
      },
    });
    expect(result.placeholders).toMatchObject([
      { path: "input.input_urls[0]", reference: `@${IMG_ID}` },
      { path: "input.video_urls[0]", reference: `@${VID_ID}` },
      { path: "input.video_urls[1]", reference: "@b3" },
    ]);
  });

  it("leaves non-reference strings in URL fields alone", () => {
    const result = applyPreviewPlaceholderUrls({
      input: { image_urls: ["not-a-reference", "https://cdn.test/a.png"] },
    });
    expect(result.payload).toEqual({
      input: { image_urls: ["not-a-reference", "https://cdn.test/a.png"] },
    });
    expect(result.placeholders).toEqual([]);
  });

  it("produces valid recognizable URLs", () => {
    const url = previewPlaceholderUrl(`@${IMG_ID}`);
    expect(() => new URL(url)).not.toThrow();
    expect(isPreviewPlaceholderUrl(url)).toBe(true);
    expect(isPreviewPlaceholderUrl("https://example.test/img.png")).toBe(false);
  });
});
