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
      followups: [{}],
    }).success).toBe(false);
    expect(schema.safeParse({
      asset_id: "video",
      book_id: "book",
      followups: [{ image_asset_ids: ["1", "2", "3", "4", "5"] }],
    }).success).toBe(false);
  });
});
