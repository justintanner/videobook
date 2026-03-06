import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs } from "clipfirst-fs";
import { z } from "zod";
import { writeFile as fsWriteFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { YtDlp } from "ytdlp-nodejs";
import { queue, registerJobHandler } from "../queue.js";
import type { ToolDef } from "./tool-def.js";

const execFileAsync = promisify(execFile);

const require = createRequire(import.meta.url);
const FFMPEG: string = require("ffmpeg-static");
const FFPROBE: string = require("ffprobe-static").path;

const DEFAULT_MAX_DURATION = 180;
const LOCK_DURATION_MS = 600_000;
const H264_MEDIUM = ["-c:v", "libx264", "-preset", "medium", "-crf", "18", "-profile:v", "high", "-level:v", "4.0"];
const AUDIO_OPTS = ["-c:a", "aac", "-b:a", "192k"];

// --- Time parsing (port of ~/clipfirst-mcp/src/time_parse.py) ---

const COLON_SUFFIX_RE = /\s*(?:s|sec|secs|second|seconds)\s*$/i;
const H = "(?:h|hr|hrs|hour|hours)";
const M = "(?:m|min|mins|minute|minutes)";
const S = "(?:s|sec|secs|second|seconds)";
const SHORTHAND_RE = new RegExp(
  `^(?:(\\d+)\\s*${H})?\\s*(?:(\\d+)\\s*${M})?\\s*(?:(\\d+(?:\\.\\d+)?)\\s*${S}?)?\\s*$`,
  "i",
);

function parseBareNumeric(text: string): number | undefined {
  const n = Number(text);
  return Number.isFinite(n) ? n : undefined;
}

function parseColonFormat(text: string): number | undefined {
  if (!text.includes(":")) return undefined;
  const cleaned = text.replace(COLON_SUFFIX_RE, "");
  const parts = cleaned.split(":");
  if (parts.length !== 2 && parts.length !== 3) return undefined;
  if (!parts.every((p) => /^\d+(\.\d+)?$/.test(p))) return undefined;
  if (parts.length === 2) {
    return parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
  }
  return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
}

function parseShorthand(text: string): number | undefined {
  const match = SHORTHAND_RE.exec(text);
  if (!match || !match.slice(1).some(Boolean)) return undefined;
  const hours = parseInt(match[1] || "0", 10);
  const minutes = parseInt(match[2] || "0", 10);
  const seconds = parseFloat(match[3] || "0");
  return hours * 3600 + minutes * 60 + seconds;
}

const PARSERS = [parseBareNumeric, parseColonFormat, parseShorthand];

function parseTime(input: string | undefined): number | undefined {
  if (input === undefined || input === "") return undefined;
  const text = input.trim();
  if (!text) return undefined;
  for (const parser of PARSERS) {
    const result = parser(text);
    if (result !== undefined) return result;
  }
  throw new Error(`Cannot parse timestamp: ${JSON.stringify(input)}`);
}

// --- ffprobe / ffmpeg helpers ---

interface ProbeResult {
  width: number;
  height: number;
  duration: number;
}

async function probeVideo(filePath: string): Promise<ProbeResult> {
  const { stdout } = await execFileAsync(FFPROBE, [
    "-v", "quiet",
    "-print_format", "json",
    "-show_streams",
    "-show_format",
    filePath,
  ]);
  const data = JSON.parse(stdout);
  const videoStream = (data.streams as Array<Record<string, unknown>>)?.find(
    (s) => s.codec_type === "video",
  );
  const width = Number(videoStream?.width ?? 0);
  const height = Number(videoStream?.height ?? 0);
  const duration = Number(data.format?.duration ?? 0);
  return { width, height, duration };
}

async function runFfmpeg(args: string[]): Promise<void> {
  try {
    await execFileAsync(FFMPEG, args);
  } catch (error) {
    const msg = error instanceof Error ? (error as Error & { stderr?: string }).stderr ?? error.message : String(error);
    throw new Error(`ffmpeg failed: ${msg}`);
  }
}

async function blurFillExport(
  inputPath: string,
  outputPath: string,
  targetWidth: number,
  targetHeight: number,
): Promise<void> {
  const filterComplex = [
    `[0:v]scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=increase,crop=${targetWidth}:${targetHeight},boxblur=20:5[bg]`,
    `[0:v]scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease[fg]`,
    `[bg][fg]overlay=(W-w)/2:(H-h)/2`,
  ].join(";");

  await runFfmpeg([
    "-y", "-i", inputPath,
    "-filter_complex", filterComplex,
    ...H264_MEDIUM, ...AUDIO_OPTS,
    outputPath,
  ]);
}

// --- Job handler ---

type DownloadPayload = {
  type: "download_video";
  url: string;
  outputPath: string;
  downloadSections?: string;
  playlistItem?: number;
};

// --- Main registration ---

export function registerDownloadVideoJobHandler(): void {
  const ytdlp = new YtDlp();

  registerJobHandler("download_video", async (payload) => {
    const { url, outputPath, downloadSections, playlistItem } = payload as DownloadPayload;

    const builder = ytdlp
      .download(url)
      .setOutputTemplate(outputPath)
      .addArgs("--merge-output-format", "mp4");

    if (downloadSections) {
      builder.addArgs("--download-sections", downloadSections);
      builder.addArgs("--force-keyframes-at-cuts");
    }
    if (playlistItem !== undefined) {
      builder.addArgs("--playlist-items", String(playlistItem));
    } else {
      builder.addArgs("--no-playlist");
    }

    await builder.run();
    return { success: true };
  });
}

export function downloadVideoDef(fs: ClipfirstFs): ToolDef {
  const ytdlp = new YtDlp();

  return {
    name: "download_video_file",
    description: "Download a video from a URL (YouTube, Twitter/X, etc.) into a clipfirst project as an asset. Supports time ranges and auto-exports 16:9 and 9:16 versions.",
    schema: {
      url: z.string().describe("Video URL (YouTube, Twitter/X, Instagram, TikTok, etc.)"),
      start_time: z.string().optional().describe("Start time (e.g. '30', '1:30', '2m20s')"),
      end_time: z.string().optional().describe("End time (e.g. '60', '2:00', '3m')"),
      project_slug: z.string().optional().describe("Project slug (defaults to active project)"),
      export_videos: z.boolean().optional().default(true).describe("Auto-export 16:9 and 9:16 versions"),
      full: z.boolean().optional().default(false).describe("Download entire video (no 3-min cap)"),
    },
    handler: async (args) => {
      const { url, start_time, end_time, project_slug, export_videos, full } = args as {
        url: string; start_time?: string; end_time?: string;
        project_slug?: string; export_videos?: boolean; full?: boolean;
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
        // Derive asset name
        const sanitized = entry.title
          .replace(/[^\w\s-]/g, "")
          .replace(/\s+/g, "-")
          .toLowerCase()
          .slice(0, 60);
        const assetName = sanitized || "downloaded-video";

        // Resolve project slug
        const projectSlug = project_slug ?? undefined;

        // Create asset
        const assetResult = await fs.createAsset("vid", assetName, projectSlug);
        if (!assetResult.ok) {
          results.push(`Error creating asset for "${entry.title}": ${assetResult.error.message}`);
          continue;
        }

        const { assetId, path: assetDir } = assetResult.value;
        await mkdir(assetDir, { recursive: true });

        const lockResult = await fs.acquireLock(assetDir, { durationMs: LOCK_DURATION_MS });
        if (!lockResult.ok) {
          results.push(`Asset locked for "${entry.title}": ${lockResult.error.message}`);
          continue;
        }

        try {
          const filename = full ? "original_full.mp4" : "original.mp4";
          const outputPath = join(assetDir, filename);
          const jobId = `download-${assetId}-${Date.now()}`;

          const jobPayload: DownloadPayload = {
            type: "download_video",
            url,
            outputPath,
            downloadSections,
            playlistItem: entry.playlistItem,
          };

          await queue.enqueueAndWait(jobId, jobPayload as unknown as Record<string, unknown>);

          // Probe the downloaded video
          let probe: ProbeResult = { width: 0, height: 0, duration: 0 };
          try {
            probe = await probeVideo(outputPath);
          } catch {
            // probe failure is non-fatal
          }

          // Export 16:9 and 9:16 versions
          const exports: string[] = [];
          if (export_videos) {
            try {
              const landscape = join(assetDir, "original_16x9.mp4");
              await blurFillExport(outputPath, landscape, 1920, 1080);
              exports.push("original_16x9.mp4");
            } catch {
              // export failure is non-fatal
            }
            try {
              const portrait = join(assetDir, "original_9x16.mp4");
              await blurFillExport(outputPath, portrait, 1080, 1920);
              exports.push("original_9x16.mp4");
            } catch {
              // export failure is non-fatal
            }
          }

          // Write .origin.json
          const origin = {
            origin: "download",
            source_url: url,
            title: entry.title,
            uploader: info.uploader ?? "",
            description: info.description ?? "",
            webpage_url: info.webpage_url ?? "",
            platform: info.extractor ?? "",
            thumbnail: info.thumbnail ?? "",
            width: probe.width,
            height: probe.height,
            duration: probe.duration,
            full,
            downloaded_at: new Date().toISOString(),
          };
          await fsWriteFile(join(assetDir, ".origin.json"), JSON.stringify(origin, null, 2));

          // Commit
          await fs.commitOperation("download", assetId, { source_url: url }, projectSlug);

          results.push(JSON.stringify({ assetId, path: assetDir, filename, exports }));
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          results.push(`Download failed for "${entry.title}": ${msg}`);
        } finally {
          await fs.releaseLock(assetDir);
        }
      }

      return {
        content: [{ type: "text" as const, text: results.join("\n") }],
      };
    },
  };
}

export function registerDownloadVideoTool(server: McpServer, fs: ClipfirstFs): void {
  registerDownloadVideoJobHandler();
  const def = downloadVideoDef(fs);
  server.tool(def.name, def.description, def.schema, def.handler);
}
