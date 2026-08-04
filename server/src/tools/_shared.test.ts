import { describe, expect, it } from "vitest";
import { Qwen2ImageEditRequestSchema } from "@apicity/kie/zod";
import { requireAtLeastOne, refAsPlaceholderUrl, toolError, zodErrorToToolResult } from "./_shared.js";

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
      { name: "image_refs", value: undefined },
    ])).toBeNull();
  });

  it("returns null when at least one array field has a non-blank entry", () => {
    expect(requireAtLeastOne("Tool", [
      { name: "image_refs", value: ["@img-1"] },
      { name: "video_refs", value: [] },
    ])).toBeNull();
  });

  it("errors naming every candidate when all fields are absent", () => {
    const result = requireAtLeastOne("Alibaba Video", [
      { name: "first_frame_ref", value: undefined },
      { name: "last_frame_ref", value: null },
      { name: "video_ref", value: "" },
    ]);
    expect(result?.isError).toBe(true);
    expect(result?.content[0].text).toBe(
      "Alibaba Video requires at least one of: first_frame_ref, last_frame_ref, video_ref",
    );
  });

  it("treats whitespace-only strings as absent", () => {
    const result = requireAtLeastOne("Tool", [{ name: "asset_id", value: "   " }]);
    expect(result?.isError).toBe(true);
  });

  it("treats an array of blanks as absent", () => {
    const result = requireAtLeastOne("Tool", [{ name: "image_refs", value: ["", "  "] }]);
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

describe("refAsPlaceholderUrl", () => {
  it("produces a URL that satisfies apicity image_url .url() checks", () => {
    const slug = "@img-nbp-scene-reference-2-3";
    const placeholder = refAsPlaceholderUrl(slug);
    expect(placeholder).toBe("https://placeholder.local/img-nbp-scene-reference-2-3");

    const withSlug = Qwen2ImageEditRequestSchema.safeParse({
      model: "qwen2/image-edit",
      input: { prompt: "exactly the same remove game", image_url: slug.replace(/^@/, "") },
    });
    expect(withSlug.success).toBe(true);

    const withPlaceholder = Qwen2ImageEditRequestSchema.safeParse({
      model: "qwen2/image-edit",
      input: { prompt: "exactly the same remove game", image_url: placeholder },
    });
    expect(withPlaceholder.success).toBe(true);
  });
});
