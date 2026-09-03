import { z } from "zod";
import { queue } from "../queue.js";
import { schedulePost } from "../scheduled-posts.js";
import type { PostToXResult, XPostFollowup } from "../x/post-contract.js";
import type { ToolDef } from "./tool-def.js";

const SCHEDULE_LEAD_MS = 5_000;
const followupSchema = z.object({
  text: z.string().max(280).optional(),
  image_asset_ids: z.array(z.string()).max(4).optional(),
}).refine(
  (value) => Boolean(value.text?.length || value.image_asset_ids?.length),
  { message: "A follow-up needs text or at least one image" },
);

export function postDef(): ToolDef {
  return {
    name: "post",
    description:
      "Publish a video or image asset to a social platform. Currently supports X (Twitter); Instagram is planned. Scheduled posts persist across server restarts.",
    schema: {
      asset_id: z.string().describe("Asset to post (e.g. vid-clip-name, img-photo-name)"),
      book_id: z.string().describe("Book id containing the asset"),
      platform: z.enum(["x"]).default("x").describe("Target platform; defaults to 'x'"),
      text: z
        .string()
        .trim()
        .max(280)
        .optional()
        .describe(
          "Title of the root post (X limit 280 chars). Publishing requires one; pass it only when the user supplied it, since the confirm sheet asks for a missing title before applying.",
        ),
      orientation: z
        .enum(["portrait", "landscape"])
        .optional()
        .describe(
          "Force a target video orientation. Pads with black bars to 1080x1920 (portrait) or 1920x1080 (landscape) before upload. Skipped when source already matches.",
        ),
      scheduled_for: z
        .string()
        .datetime()
        .optional()
        .describe("ISO 8601 timestamp to publish at. Omit to post immediately."),
      followups: z
        .array(followupSchema)
        .max(25)
        .optional()
        .describe("Ordered replies to publish as a thread after the root post."),
    },
    handler: async (args) => {
      const {
        asset_id,
        book_id,
        platform = "x",
        text,
        orientation,
        scheduled_for,
        followups,
      } =
        args as {
          asset_id: string;
          book_id: string;
          platform?: "x";
          text?: string;
          orientation?: "portrait" | "landscape";
          scheduled_for?: string;
          followups?: XPostFollowup[];
        };

      if (platform !== "x") {
        return {
          isError: true as const,
          content: [
            { type: "text" as const, text: `Unsupported platform: ${platform}` },
          ],
        };
      }

      if (!text?.trim()) {
        return {
          isError: true as const,
          content: [
            { type: "text" as const, text: "A post title is required" },
          ],
        };
      }

      if (scheduled_for) {
        const when = new Date(scheduled_for).getTime();
        if (Number.isNaN(when)) {
          return {
            isError: true as const,
            content: [
              { type: "text" as const, text: `Invalid scheduled_for: ${scheduled_for}` },
            ],
          };
        }
        if (when - Date.now() > SCHEDULE_LEAD_MS) {
          try {
            const result = await schedulePost(
              { asset_id, book_id, platform, text, orientation, followups },
              scheduled_for,
            );
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    status: "scheduled",
                    schedule_id: result.schedule_id,
                    scheduled_for: result.scheduled_for,
                    platform,
                  }),
                },
              ],
            };
          } catch (err) {
            return {
              isError: true as const,
              content: [
                {
                  type: "text" as const,
                  text: `Failed to schedule post: ${err instanceof Error ? err.message : String(err)}`,
                },
              ],
            };
          }
        }
      }

      const jobId = `post-x-${asset_id}-${Date.now()}`;
      try {
        const result = await queue.enqueueAndWait<PostToXResult>(jobId, {
          type: "post_to_x",
          assetId: asset_id,
          bookId: book_id,
          text,
          orientation,
          followups,
        });
        const message = result.status === "partially_posted"
          ? `Root post published, but follow-up ${result.followup_error?.reply_number ?? ""} failed: ${result.followup_error?.message ?? "unknown error"}`
          : `Posted to X${result.replies.length > 0 ? ` with ${result.replies.length} follow-up replies` : ""}`;
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                status: result.status,
                platform,
                tweet_id: result.tweet_id,
                tweet_url: result.tweet_url,
                replies: result.replies,
                followup_error: result.followup_error,
                message,
              }),
            },
          ],
        };
      } catch (err) {
        return {
          isError: true as const,
          content: [
            {
              type: "text" as const,
              text: `Post failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  };
}
