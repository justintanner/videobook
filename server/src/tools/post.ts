import { z } from "zod";
import { queue } from "../queue.js";
import { schedulePost } from "../scheduled-posts.js";
import type { ToolDef } from "./tool-def.js";

const SCHEDULE_LEAD_MS = 5_000;

export function postDef(): ToolDef {
  return {
    name: "post",
    description:
      "Publish a video or image asset to a social platform. Currently supports X (Twitter); Instagram is planned. Scheduled posts persist across server restarts.",
    schema: {
      asset_id: z.string().describe("Asset to post (e.g. vid-clip-name, img-photo-name)"),
      project_slug: z.string().describe("Project slug containing the asset"),
      platform: z.enum(["x"]).default("x").describe("Target platform; defaults to 'x'"),
      text: z
        .string()
        .max(280)
        .optional()
        .describe("Post text (X limit 280 chars). Optional when media is attached."),
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
    },
    handler: async (args) => {
      const { asset_id, project_slug, platform = "x", text, orientation, scheduled_for } =
        args as {
          asset_id: string;
          project_slug: string;
          platform?: "x";
          text?: string;
          orientation?: "portrait" | "landscape";
          scheduled_for?: string;
        };

      if (platform !== "x") {
        return {
          isError: true as const,
          content: [
            { type: "text" as const, text: `Unsupported platform: ${platform}` },
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
              { asset_id, project_slug, platform, text, orientation },
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
        const result = await queue.enqueueAndWait<{
          tweet_id: string;
          tweet_url: string;
        }>(jobId, {
          type: "post_to_x",
          assetId: asset_id,
          projectSlug: project_slug,
          text,
          orientation,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                status: "posted",
                platform,
                tweet_id: result.tweet_id,
                tweet_url: result.tweet_url,
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
