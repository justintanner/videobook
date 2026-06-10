import type { VideocityFs } from "vc-engine";
import { z } from "zod";
import { join } from "node:path";
import { queue } from "../queue.js";
import { parseTime } from "../time-parse.js";
import type { ToolDef } from "./tool-def.js";

const SOURCE_PREFIX_MAP: Record<string, string> = {
  "youtube.com": "yt",
  "youtu.be": "yt",
  "twitter.com": "x",
  "x.com": "x",
  "instagram.com": "ig",
  "tiktok.com": "tt",
  "vimeo.com": "vm",
  "reddit.com": "rd",
  "facebook.com": "fb",
  "fb.watch": "fb",
  "twitch.tv": "tw",
  "dailymotion.com": "dm",
};

function sourcePrefix(url: string): string {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "");
    if (SOURCE_PREFIX_MAP[hostname]) return SOURCE_PREFIX_MAP[hostname];
    const base = hostname.split(".").slice(-2, -1)[0];
    return base ? base.slice(0, 3) : "dl";
  } catch {
    return "dl";
  }
}

export function downloadVideoDef(fs: VideocityFs): ToolDef {
  return {
    name: "download_video",
    description: "Download a full video from a URL (YouTube, Twitter/X, etc.) into a videocity project as original.mp4. Supports requested range metadata and auto-exports 16:9 and 9:16 versions.",
    schema: {
      url: z.string().describe("Video URL (YouTube, Twitter/X, Instagram, TikTok, etc.)"),
      start_time: z.string().optional().describe("Requested start time metadata (e.g. '30', '1:30', '2m20s')"),
      end_time: z.string().optional().describe("Requested end time metadata (e.g. '60', '2:00', '3m')"),
      project_slug: z.string().describe("Project slug"),
      export_videos: z.boolean().optional().default(false).describe("Auto-export 16:9 and 9:16 versions (default: off)"),
      full: z.boolean().optional().default(false).describe("Deprecated; downloads are always full"),
    },
    handler: async (args) => {
      const { url, start_time, end_time, project_slug, export_videos } = args as {
        url: string; start_time?: string; end_time?: string;
        project_slug: string; export_videos?: boolean; full?: boolean;
      };
      let startSecs: number | undefined;
      let endSecs: number | undefined;
      try {
        startSecs = parseTime(start_time);
        endSecs = parseTime(end_time);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { isError: true as const, content: [{ type: "text" as const, text: msg }] };
      }

      if (startSecs !== undefined && endSecs !== undefined && startSecs >= endSecs) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "start_time must be less than end_time." }],
        };
      }
      const requestedRange = startSecs !== undefined || endSecs !== undefined
        ? {
            ...(startSecs !== undefined ? { start: startSecs } : {}),
            ...(endSecs !== undefined ? { end: endSecs } : {}),
          }
        : undefined;

      const normalizedUrl = /^https?:\/\//i.test(url) ? url : `https://${url}`;
      const prefix = sourcePrefix(normalizedUrl);
      const title = new URL(normalizedUrl).pathname.split("/").filter(Boolean).pop() ?? "video";
      const assetName = `${prefix} ${title}`;
      const assetResult = await fs.createAsset("vid", assetName, project_slug);
      if (!assetResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Error creating asset: ${assetResult.error.message}` }],
        };
      }

      const { assetId, path: assetDir } = assetResult.value;

      const outputPath = join(assetDir, "original.mp4");
      const jobId = `download-${assetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "download_video",
        url: normalizedUrl,
        outputPath,
        assetId,
        assetDir,
        projectSlug: project_slug,
        exportVideos: export_videos ?? false,
        full: true,
        sourcePrefix: prefix,
        ...(requestedRange ? { requestedRange } : {}),
      } as unknown as Record<string, unknown>);

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ assetId, job_id: jobId, status: "enqueued" }) }],
      };
    },
  };
}
