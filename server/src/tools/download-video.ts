import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs } from "clipfirst-fs";
import { z } from "zod";
import { join } from "node:path";
import { YtDlp } from "ytdlp-nodejs";
import { queue } from "../queue.js";
import { parseTime } from "../time-parse.js";
import type { ToolDef } from "./tool-def.js";

const DEFAULT_MAX_DURATION = 180;

export function downloadVideoDef(fs: ClipfirstFs): ToolDef {
  const ytdlp = new YtDlp();

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

      // Fetch metadata
      type InfoResult = {
        _type?: string;
        title?: string;
        uploader?: string;
        description?: string;
        thumbnail?: string;
        webpage_url?: string;
        extractor?: string;
        entries?: InfoResult[];
      };

      let info: InfoResult;
      try {
        info = await ytdlp.getInfoAsync(url) as unknown as InfoResult;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { isError: true as const, content: [{ type: "text" as const, text: `Failed to fetch video info: ${msg}` }] };
      }

      // Detect multi-video (Twitter quoted tweets)
      type VideoEntry = { title: string; playlistItem?: number };
      const entries: VideoEntry[] = [];

      if (info._type === "playlist" && Array.isArray(info.entries) && info.entries.length > 0) {
        for (let i = 0; i < info.entries.length; i++) {
          entries.push({
            title: info.entries[i].title ?? `video-${i + 1}`,
            playlistItem: i + 1,
          });
        }
      } else {
        entries.push({ title: info.title ?? "downloaded-video" });
      }

      const results: string[] = [];

      for (const entry of entries) {
        const sanitized = entry.title
          .replace(/[^\w\s-]/g, "")
          .replace(/\s+/g, "-")
          .toLowerCase()
          .slice(0, 60);
        const assetName = sanitized || "downloaded-video";

        const projectSlug = project_slug;

        const assetResult = await fs.createAsset("vid", assetName, projectSlug);
        if (!assetResult.ok) {
          results.push(`Error creating asset for "${entry.title}": ${assetResult.error.message}`);
          continue;
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
          playlistItem: entry.playlistItem,
          assetId,
          assetDir,
          projectSlug,
          exportVideos: export_videos ?? false,
          full: full ?? false,
          title: entry.title,
          uploader: info.uploader ?? "",
          description: info.description ?? "",
          webpageUrl: info.webpage_url ?? "",
          platform: info.extractor ?? "",
          thumbnail: info.thumbnail ?? "",
        } as unknown as Record<string, unknown>);

        results.push(JSON.stringify({ assetId, job_id: jobId, status: "enqueued" }));
      }

      return {
        content: [{ type: "text" as const, text: results.join("\n") }],
      };
    },
  };
}

export function registerDownloadVideoTool(server: McpServer, fs: ClipfirstFs): void {
  const def = downloadVideoDef(fs);
  server.tool(def.name, def.description, def.schema, def.handler);
}
