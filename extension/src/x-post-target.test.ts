import { describe, expect, it } from "vitest";
import { normalizeXStatusUrl, selectXPostUrl } from "./x-post-target.js";

describe("X post URL targeting", () => {
  it("normalizes X status URLs and removes suffix paths", () => {
    expect(normalizeXStatusUrl(
      "https://x.com/user/status/12345/video/1",
      "https://x.com/home",
    )).toBe("https://x.com/user/status/12345");
  });

  it("normalizes relative Twitter status URLs", () => {
    expect(normalizeXStatusUrl(
      "/user/status/67890/photo/1",
      "https://twitter.com/home",
    )).toBe("https://twitter.com/user/status/67890");
  });

  it("rejects non-status and non-X URLs", () => {
    expect(normalizeXStatusUrl("https://example.com/user/status/1", "https://x.com/home")).toBeNull();
    expect(normalizeXStatusUrl("https://x.com/user", "https://x.com/home")).toBeNull();
  });

  it("prefers article status anchors before falling back to the page URL", () => {
    expect(selectXPostUrl(
      ["https://x.com/first/status/111", "https://x.com/second/status/222"],
      "https://x.com/current/status/333",
    )).toBe("https://x.com/first/status/111");

    expect(selectXPostUrl(
      [],
      "https://x.com/current/status/333",
    )).toBe("https://x.com/current/status/333");
  });
});
