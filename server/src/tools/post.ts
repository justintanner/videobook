import { randomUUID } from "node:crypto";
import { z } from "zod";
import { POST_PLATFORMS } from "../posts/post-contract.js";
import type { PostPlatform, PostView } from "../posts/post-contract.js";
import type { PostDownload } from "../posts/post-folder.js";
import type { PostDeliverJob } from "../jobs/post-record.js";
import { queue } from "../queue.js";
import { schedulePost } from "../scheduled-posts.js";
import type { PostToXResult, XPostFollowup } from "../x/post-contract.js";
import { X_PREMIUM_POST_MAX_CHARACTERS } from "../x/account.js";
import type { ToolDef, ToolResult } from "./tool-def.js";

const SCHEDULE_LEAD_MS = 5_000;

function postToolResultMessage(result: PostToXResult): string {
  const posted = result.status === "partially_posted"
    ? `Root post published, but follow-up ${result.followup_error?.reply_number ?? ""} failed: ${result.followup_error?.message ?? "unknown error"}`
    : `Posted to X${result.replies.length > 0 ? ` with ${result.replies.length} follow-up replies` : ""}`;
  if (result.cell_address) {
    return result.status === "partially_posted"
      ? `Root post published as ${result.cell_address}, but follow-up ${result.followup_error?.reply_number ?? ""} failed: ${result.followup_error?.message ?? "unknown error"}`
      : `${posted} as ${result.cell_address}`;
  }
  if (result.cell_error) {
    return `${posted}; notebook cell could not be created: ${result.cell_error}`;
  }
  return posted;
}

export function postToolResultPayload(
  result: PostToXResult,
  platform: "x",
): Record<string, unknown> {
  return {
    status: result.status,
    platform,
    tweet_id: result.tweet_id,
    tweet_url: result.tweet_url,
    replies: result.replies,
    followup_error: result.followup_error,
    ...(result.cell_id ? { cell_id: result.cell_id } : {}),
    ...(result.cell_address ? { cell_address: result.cell_address } : {}),
    message: postToolResultMessage(result),
  };
}

const followupSchema = z.object({
  text: z.string().max(X_PREMIUM_POST_MAX_CHARACTERS).optional(),
  image_asset_ids: z.array(z.string()).max(4).optional(),
}).refine(
  (value) => Boolean(value.text?.length || value.image_asset_ids?.length),
  { message: "A follow-up needs text or at least one image" },
);

const POST_DESTINATIONS = ["icloud", "download", "x", "draft"] as const;
type PostDestination = typeof POST_DESTINATIONS[number];

interface PostArgs {
  book_id: string;
  to: PostDestination;
  asset_id?: string;
  post_cell_id?: string;
  source_cell_id?: string;
  notebook_id?: string;
  text?: string;
  platform?: PostPlatform;
  folder?: string;
  orientation?: "portrait" | "landscape";
  scheduled_for?: string;
  followups?: XPostFollowup[];
}

interface DeliveredPost {
  post: PostView;
  download?: PostDownload;
}

function textResult(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function toolError(message: string): ToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function deliveredMessage(to: Exclude<PostDestination, "x">, result: DeliveredPost): string {
  const address = result.post.address;
  if (to === "icloud") return `Saved ${address} to iCloud · Videobook/${result.post.runtime.icloud?.folder ?? ""}`;
  if (to === "download") return `${address} is ready to download as ${result.download?.filename ?? "a clip"} with its caption`;
  return `Saved ${address} as a draft`;
}

async function deliverPost(args: PostArgs & { to: Exclude<PostDestination, "x"> }): Promise<ToolResult> {
  const job: PostDeliverJob = {
    to: args.to,
    postCellId: args.post_cell_id,
    create: args.post_cell_id ? undefined : { assetId: args.asset_id, notebookId: args.notebook_id, sourceCellId: args.source_cell_id, platform: args.platform, caption: args.text },
    caption: args.text,
    platform: args.platform,
    folder: args.folder,
  };
  try {
    const result = await queue.enqueueAndWait<DeliveredPost>(`post-${args.to}-${args.post_cell_id ?? randomUUID()}-${randomUUID()}`, { type: "post_deliver", bookId: args.book_id, ...job });
    return textResult({ ...result, message: deliveredMessage(args.to, result) });
  } catch (error) {
    return toolError(errorMessage(error));
  }
}

async function scheduleXPost(args: PostArgs, prepared: PostView, scheduledFor: string): Promise<ToolResult> {
  try {
    const result = await schedulePost(
      { asset_id: prepared.definition.source!.snapshotArtifactId!, book_id: args.book_id, platform: "x", text: args.text, post_cell_id: prepared.id },
      scheduledFor,
    );
    return textResult({
      status: "scheduled",
      schedule_id: result.schedule_id,
      scheduled_for: result.scheduled_for,
      platform: "x",
      cell_id: prepared.id,
      cell_address: prepared.address,
      message: `Scheduled ${prepared.address} for ${result.scheduled_for}`,
    });
  } catch (error) {
    return toolError(`Failed to schedule post: ${errorMessage(error)}`);
  }
}

async function publishToX(args: PostArgs): Promise<ToolResult> {
  if (!args.text?.trim() && !args.post_cell_id) return toolError("A post title is required");
  let prepared: PostView;
  try {
    prepared = await queue.enqueueAndWait<PostView>(`post-prepare-${args.post_cell_id ?? args.asset_id}-${Date.now()}`, { type: "post_prepare_x", bookId: args.book_id, assetId: args.asset_id, postCellId: args.post_cell_id, text: args.text, orientation: args.orientation, followups: args.followups });
  } catch (error) {
    return toolError(errorMessage(error));
  }
  if (args.scheduled_for) {
    const when = new Date(args.scheduled_for).getTime();
    if (Number.isNaN(when)) return toolError(`Invalid scheduled_for: ${args.scheduled_for}`);
    if (when - Date.now() > SCHEDULE_LEAD_MS) return scheduleXPost(args, prepared, args.scheduled_for);
  }
  try {
    const result = await queue.enqueueAndWait<PostToXResult>(`post-x-${prepared.id}`, {
      type: "post_to_x",
      assetId: prepared.definition.source!.snapshotArtifactId!,
      postCellId: prepared.id,
      bookId: args.book_id,
      text: args.text,
      orientation: args.orientation,
      followups: args.followups,
    });
    return textResult(postToolResultPayload(result, "x"));
  } catch (error) {
    return toolError(`Post failed: ${errorMessage(error)}`);
  }
}

export function postDef(): ToolDef {
  return {
    name: "post",
    description:
      "Post a clip or image in one step. to: icloud saves the clip and caption.txt to iCloud Drive › Videobook for the phones; download freezes them and returns download links for a manual upload; x publishes to X now or at scheduled_for, with optional thread replies; draft only saves the Post. Pass asset_id for a new Post or post_cell_id to send an existing one.",
    schema: {
      book_id: z.string().describe("Book id containing the asset"),
      to: z.enum(POST_DESTINATIONS).describe("Where the post goes: icloud, download, x or draft"),
      asset_id: z.string().optional().describe("Clip or image to post; creates a new Post beside its cell"),
      post_cell_id: z.string().uuid().optional().describe("Existing Post to send; uses its frozen media and caption"),
      source_cell_id: z.string().uuid().optional().describe("Notebook cell to post when it is known; creates a new Post beside it"),
      notebook_id: z.string().uuid().optional().describe("draft only: notebook for a Post that has no clip yet"),
      text: z
        .string()
        .trim()
        .max(X_PREMIUM_POST_MAX_CHARACTERS)
        .optional()
        .describe(
          "Caption saved with the clip, or the X post title (X limit 280 chars, or 25000 when the connected account has X Premium; service_status with service x reports post_max_characters). Pass it only when the user supplied it; the review sheet asks for a missing X title.",
        ),
      platform: z.enum(POST_PLATFORMS).optional().describe("icloud, download and draft: where the clip will be posted by hand, for the caption and link checks; defaults to tiktok"),
      folder: z.string().max(500).optional().describe("icloud only: folder inside iCloud Drive › Videobook"),
      orientation: z
        .enum(["portrait", "landscape"])
        .optional()
        .describe(
          "x only: pad the video with black bars to 1080x1920 (portrait) or 1920x1080 (landscape) before upload. Skipped when the source already matches.",
        ),
      scheduled_for: z
        .string()
        .datetime()
        .optional()
        .describe("x only: ISO 8601 time to publish at. Omit to post immediately; list_posts with status scheduled shows pending posts and update_post with cancel_schedule cancels one."),
      followups: z
        .array(followupSchema)
        .max(25)
        .optional()
        .describe("x only: ordered replies to publish as a thread after the root post."),
    },
    handler: async (args) => {
      const input = args as unknown as PostArgs;
      if (input.to === "x") return publishToX(input);
      return deliverPost({ ...input, to: input.to });
    },
  };
}
