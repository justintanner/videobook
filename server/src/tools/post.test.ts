import { describe, expect, it } from "vitest";
import { z } from "zod";
import { postDef } from "./post.js";

describe("post tool schema", () => {
  const schema = z.object(postDef().schema);

  it("accepts ordered text and image follow-ups", () => {
    const parsed = schema.parse({
      asset_id: "video",
      book_id: "book",
      platform: "x",
      text: "Title",
      followups: [
        { text: "Exact prompt", image_asset_ids: ["image-1", "image-2"] },
        { text: "@source https://x.com/source/status/123" },
      ],
    });
    expect(parsed.followups).toEqual([
      { text: "Exact prompt", image_asset_ids: ["image-1", "image-2"] },
      { text: "@source https://x.com/source/status/123" },
    ]);
  });

  it("rejects empty replies and more than four attachments", () => {
    expect(schema.safeParse({
      asset_id: "video",
      book_id: "book",
      text: "Title",
      followups: [{}],
    }).success).toBe(false);
    expect(schema.safeParse({
      asset_id: "video",
      book_id: "book",
      text: "Title",
      followups: [{ image_asset_ids: ["1", "2", "3", "4", "5"] }],
    }).success).toBe(false);
  });

  it("requires a non-blank title on the root post", () => {
    expect(schema.safeParse({ asset_id: "video", book_id: "book" }).success).toBe(false);
    expect(schema.safeParse({
      asset_id: "video",
      book_id: "book",
      text: "   ",
    }).success).toBe(false);
    expect(schema.parse({
      asset_id: "video",
      book_id: "book",
      text: "  Title  ",
    }).text).toBe("Title");
  });
});
