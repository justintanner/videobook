import { describe, expect, it } from "vitest";
import { buildDownloadVideoArguments, isHttpUrl, selectDownloadUrl } from "./url-target.js";

describe("extension URL targeting", () => {
  it("prefers a clicked link URL over the page and tab URLs", () => {
    expect(selectDownloadUrl({
      linkUrl: "https://example.com/link",
      pageUrl: "https://example.com/page",
      tabUrl: "https://example.com/tab",
    })).toBe("https://example.com/link");
  });

  it("falls back to the page URL, then the tab URL", () => {
    expect(selectDownloadUrl({
      pageUrl: "https://example.com/page",
      tabUrl: "https://example.com/tab",
    })).toBe("https://example.com/page");
    expect(selectDownloadUrl({
      tabUrl: "https://example.com/tab",
    })).toBe("https://example.com/tab");
  });

  it("accepts only HTTP URLs", () => {
    expect(isHttpUrl("https://example.com/video")).toBe(true);
    expect(isHttpUrl("http://example.com/video")).toBe(true);
    expect(isHttpUrl("chrome://extensions")).toBe(false);
    expect(isHttpUrl("not a url")).toBe(false);
  });

  it("builds full-source download_video arguments", () => {
    expect(buildDownloadVideoArguments(
      "https://example.com/video",
      "018f47b5-2f5d-7e19-8f0b-123456789abc",
    )).toEqual({
      url: "https://example.com/video",
      book_id: "018f47b5-2f5d-7e19-8f0b-123456789abc",
      full: true,
      export_videos: false,
    });
  });
});
