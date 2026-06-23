import { describe, expect, it } from "vitest";
import { requireAtLeastOne, toolError, zodErrorToToolResult } from "./_shared.js";

describe("toolError", () => {
  it("wraps a message in the MCP isError envelope", () => {
    expect(toolError("boom")).toEqual({
      isError: true,
      content: [{ type: "text", text: "boom" }],
    });
  });
});

describe("requireAtLeastOne", () => {
  it("returns null when at least one string field is provided", () => {
    expect(requireAtLeastOne("Tool", [
      { name: "asset_id", value: "img-1" },
      { name: "image_slugs", value: undefined },
    ])).toBeNull();
  });

  it("returns null when at least one array field has a non-blank entry", () => {
    expect(requireAtLeastOne("Tool", [
      { name: "image_slugs", value: ["@img-1"] },
      { name: "video_slugs", value: [] },
    ])).toBeNull();
  });

  it("errors naming every candidate when all fields are absent", () => {
    const result = requireAtLeastOne("Alibaba Video", [
      { name: "first_frame_slug", value: undefined },
      { name: "last_frame_slug", value: null },
      { name: "video_slug", value: "" },
    ]);
    expect(result?.isError).toBe(true);
    expect(result?.content[0].text).toBe(
      "Alibaba Video requires at least one of: first_frame_slug, last_frame_slug, video_slug",
    );
  });

  it("treats whitespace-only strings as absent", () => {
    const result = requireAtLeastOne("Tool", [{ name: "asset_id", value: "   " }]);
    expect(result?.isError).toBe(true);
  });

  it("treats an array of blanks as absent", () => {
    const result = requireAtLeastOne("Tool", [{ name: "image_slugs", value: ["", "  "] }]);
    expect(result?.isError).toBe(true);
  });
});

describe("zodErrorToToolResult", () => {
  it("strips the leading input segment from issue paths", () => {
    const result = zodErrorToToolResult({
      issues: [{ path: ["input", "image_url"], message: "Required" }],
    });
    expect(result.content[0].text).toBe("image_url: Required");
  });
});
