import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs } from "clipfirst-fs";
import { z } from "zod";
import { join } from "node:path";
import { extractOpenGraph } from "@devmehq/open-graph-extractor";
import type { IOGResult } from "@devmehq/open-graph-extractor";
import { queue } from "../queue.js";
import { parseTime } from "../time-parse.js";
import type { ToolDef } from "./tool-def.js";

const DEFAULT_MAX_DURATION = 180;

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

const OG_PLATFORM_SUFFIX = / on (?:X|Twitter|Instagram|Facebook|YouTube|TikTok|Vimeo|Reddit|Twitch|Dailymotion)$/i;
const OG_HANDLE_PAREN = / \(@?\w+\)/g;

function cleanOgTitle(raw: string): string {
  return raw.replace(OG_PLATFORM_SUFFIX, "").replace(OG_HANDLE_PAREN, "").trim();
}

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

export function downloadVideoDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "download_video_file",
    description: "Download a video from a URL (YouTube, Twitter/X, etc.) into a clipfirst project as an asset. Supports time ranges and auto-exports 16:9 and 9:16 versions.",
    schema: {
      url: z.string().describe("Video URL (YouTube, Twitter/X, Instagram, TikTok, etc.)"),
      start_time: z.string().optional().describe("Start time (e.g. '30', '1:30', '2m20s')"),
      end_time: z.string().optional().describe("End time (e.g. '60', '2:00', '3m')"),
      project_slug: z.string().describe("Project slug"),
      export_videos: z.boolean().optional().default(false).describe("Auto-export 16:9 and 9:16 versions (default: off)"),
      full: z.boolean().optional().default(false).describe("Download entire video (no 3-min cap)"),
    },
    handler: async (args) => {
      const { url, start_time, end_time, project_slug, export_videos, full } = args as {
        url: string; start_time?: string; end_time?: string;
        project_slug: string; export_videos?: boolean; full?: boolean;
      };
      // Parse times
      let startSecs: number | undefined;
      let endSecs: number | undefined;
      try {
        startSecs = parseTime(start_time);
        endSecs = parseTime(end_time);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { isError: true as const, content: [{ type: "text" as const, text: msg }] };
      }

      // Validate
      if (full && (startSecs !== undefined || endSecs !== undefined)) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "Cannot specify start/end times with full=true." }],
        };
      }
      if (startSecs !== undefined && endSecs !== undefined && startSecs >= endSecs) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "start_time must be less than end_time." }],
        };
      }

      // Build download sections for yt-dlp
      let downloadSections: string | undefined;
      if (!full) {
        const s = startSecs ?? 0;
        const e = endSecs ?? DEFAULT_MAX_DURATION;
        downloadSections = `*${s}-${e}`;
      }

      // 1. Source prefix from URL
      const prefix = sourcePrefix(url);

      // 2. OG extraction — one call
      let ogData: IOGResult | null = null;
      let title = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "video";
      try {
        const response = await fetch(url, {
          headers: { "User-Agent": "Mozilla/5.0 (compatible; ClipfirstBot/1.0)" },
          signal: AbortSignal.timeout(10_000),
          redirect: "follow",
        });
        ogData = extractOpenGraph(await response.text());
        if (ogData.ogTitle) title = cleanOgTitle(ogData.ogTitle);
      } catch {
        // OG fetch failure is non-fatal
      }

      // 3. Name decision (short, source-prefixed)
      const assetName = `${prefix} ${title}`;
      const assetResult = await fs.createAsset("vid", assetName, project_slug);
      if (!assetResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Error creating asset: ${assetResult.error.message}` }],
        };
      }

      const { assetId, path: assetDir } = assetResult.value;

      // 4. Immediately save OG data to hidden file
      if (ogData) {
        await fs.writeFile(assetId, ".opengraph.json", Buffer.from(JSON.stringify(ogData, null, 2)), project_slug);
      }

      // 5. Launch job (no ogData in payload — it's on disk)
      const filename = full ? "original_full.mp4" : "original.mp4";
      const outputPath = join(assetDir, filename);
      const jobId = `download-${assetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "download_video",
        url,
        outputPath,
        downloadSections,
        assetId,
        assetDir,
        projectSlug: project_slug,
        exportVideos: export_videos ?? false,
        full: full ?? false,
        sourcePrefix: prefix,
      } as unknown as Record<string, unknown>);

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ assetId, job_id: jobId, status: "enqueued" }) }],
      };
    },
  };
}

export function registerDownloadVideoTool(server: McpServer, fs: ClipfirstFs): void {
  const def = downloadVideoDef(fs);
  server.tool(def.name, def.description, def.schema, def.handler);
}
