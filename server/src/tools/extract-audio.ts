import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs, AssetManifestFile } from "clipfirst-fs";
import { z } from "zod";
import { writeFile as fsWriteFile, mkdir } from "node:fs/promises";
import { join, extname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { queue, registerJobHandler } from "../queue.js";

const execFileAsync = promisify(execFile);

const require = createRequire(import.meta.url);
const FFMPEG: string = require("ffmpeg-static");
const FFPROBE: string = require("ffprobe-static").path;

const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "webm", "avi", "mkv"]);
const LOCK_DURATION_MS = 120_000;

function findVideoFile(files: AssetManifestFile[]): AssetManifestFile | null {
  const videos = files.filter((f) => {
    const ext = (f.extension ?? extname(f.name)).replace(/^\./, "").toLowerCase();
    return VIDEO_EXTENSIONS.has(ext);
  });
  return videos.find((f) => f.name.startsWith("original")) ?? videos[0] ?? null;
}

async function hasAudioStream(filePath: string): Promise<boolean> {
  const { stdout } = await execFileAsync(FFPROBE, [
    "-v", "quiet",
    "-print_format", "json",
    "-show_streams",
    filePath,
  ]);
  const data = JSON.parse(stdout);
  return (data.streams as Array<Record<string, unknown>>)?.some(
    (s) => s.codec_type === "audio",
  ) ?? false;
}

async function runFfmpeg(args: string[]): Promise<void> {
  try {
    await execFileAsync(FFMPEG, args);
  } catch (error) {
    const msg = error instanceof Error ? (error as Error & { stderr?: string }).stderr ?? error.message : String(error);
    throw new Error(`ffmpeg failed: ${msg}`);
  }
}

function deriveAudioName(videoAssetId: string): string {
  const baseName = videoAssetId.startsWith("vid-") ? videoAssetId.slice(4) : videoAssetId;
  return `ext-${baseName}`;
}

export function registerExtractAudioTool(server: McpServer, fs: ClipfirstFs): void {
  registerJobHandler("extract_audio", async (payload) => {
    const { inputPath, outputPath } = payload as {
      inputPath: string;
      outputPath: string;
    };

    await runFfmpeg([
      "-y",
      "-i", inputPath,
      "-vn",
      "-acodec", "libmp3lame",
      "-q:a", "2",
      outputPath,
    ]);

    return { success: true };
  });

  server.tool(
    "extract_audio",
    "Extract the audio track from a video asset as a new audio asset (MP3). Creates an aud- asset with original.mp3.",
    {
      asset_id: z.string().describe("Video asset ID (e.g. vid-my-video)"),
      project_slug: z.string().describe("Project slug"),
    },
    async ({ asset_id, project_slug }) => {
      const manifestResult = await fs.getManifest(asset_id, project_slug);
      if (!manifestResult.ok) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: manifestResult.error.message }],
        };
      }

      const manifest = manifestResult.value;
      const videoFile = findVideoFile(manifest.files);
      if (!videoFile) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `No video file found in asset ${asset_id}` }],
        };
      }

      const videoPath = join(manifest.path, videoFile.name);

      let audioPresent: boolean;
      try {
        audioPresent = await hasAudioStream(videoPath);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Failed to probe video: ${msg}` }],
        };
      }

      if (!audioPresent) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Video has no audio stream: ${asset_id}` }],
        };
      }

      const audioName = deriveAudioName(asset_id);
      const assetResult = await fs.createAsset("aud", audioName, project_slug);
      if (!assetResult.ok) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Failed to create audio asset: ${assetResult.error.message}` }],
        };
      }

      const { assetId: audioAssetId, path: audioAssetDir } = assetResult.value;
      await mkdir(audioAssetDir, { recursive: true });

      const lockResult = await fs.acquireLock(audioAssetDir, { durationMs: LOCK_DURATION_MS });
      if (!lockResult.ok) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Asset is locked: ${lockResult.error.message}` }],
        };
      }

      try {
        const outputPath = join(audioAssetDir, "original.mp3");
        const jobId = `extract-audio-${audioAssetId}-${Date.now()}`;

        await queue.enqueueAndWait(jobId, {
          type: "extract_audio",
          inputPath: videoPath,
          outputPath,
        } as unknown as Record<string, unknown>);

        const origin = {
          origin: "extract_audio",
          source_asset: asset_id,
        };
        await fsWriteFile(join(audioAssetDir, ".origin.json"), JSON.stringify(origin, null, 2));

        await fs.commitOperation("extract_audio", audioAssetId, { source: asset_id }, project_slug);

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ audio_asset_id: audioAssetId, source_video: asset_id }),
          }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Extract audio failed: ${msg}` }],
        };
      } finally {
        await fs.releaseLock(audioAssetDir);
      }
    },
  );
}
