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

function slugFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    const last = parts.pop() ?? u.hostname;
    return last
      .replace(/[^\w\s-]/g, "")
      .replace(/\s+/g, "-")
      .toLowerCase()
      .slice(0, 60) || "downloaded-video";
  } catch {
    return "downloaded-video";
  }
}

function slugFromTitle(title: string): string {
  const sanitized = title
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .toLowerCase()
    .slice(0, 60);
  return sanitized || "downloaded-video";
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

      // Fetch page HTML + extract OG for naming
      let ogData: IOGResult | null = null;
      let assetName = slugFromUrl(url);

      try {
        const response = await fetch(url, {
          headers: { "User-Agent": "Mozilla/5.0 (compatible; ClipfirstBot/1.0)" },
          signal: AbortSignal.timeout(10_000),
          redirect: "follow",
        });
        const html = await response.text();
        ogData = extractOpenGraph(html);
        if (ogData.ogTitle) {
          assetName = slugFromTitle(ogData.ogTitle);
        }
      } catch {
        // OG fetch failure is non-fatal — fall back to URL-derived slug
      }

      const assetResult = await fs.createAsset("vid", assetName, project_slug);
      if (!assetResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Error creating asset: ${assetResult.error.message}` }],
        };
      }

      const { assetId, path: assetDir } = assetResult.value;
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
        ogData,
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
