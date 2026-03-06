import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs, AssetManifestFile } from "clipfirst-fs";
import { z } from "zod";
import { writeFile as fsWriteFile, mkdir } from "node:fs/promises";
import { join, extname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { queue, registerJobHandler } from "../queue.js";
import type { ToolDef } from "./tool-def.js";

const execFileAsync = promisify(execFile);

const require = createRequire(import.meta.url);
const FFMPEG: string = require("ffmpeg-static");
const FFPROBE: string = require("ffprobe-static").path;

const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "webm", "avi", "mkv"]);
const LOCK_DURATION_MS = 60_000;

function findVideoFile(files: AssetManifestFile[]): AssetManifestFile | null {
  const videos = files.filter((f) => {
    const ext = (f.extension ?? extname(f.name)).replace(/^\./, "").toLowerCase();
    return VIDEO_EXTENSIONS.has(ext);
  });
  return videos.find((f) => f.name.startsWith("original")) ?? videos[0] ?? null;
}

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

type ExtractFramePayload = {
  type: "extract_frame";
  inputPath: string;
  outputPath: string;
  timestamp: number;
};

async function extractFrame(
  videoAssetId: string,
  projectSlug: string,
  mode: "first" | "last",
  fs: ClipfirstFs,
): Promise<{ isError?: true; content: Array<{ type: "text"; text: string }> }> {
  const manifestResult = await fs.getManifest(videoAssetId, projectSlug);
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
      content: [{ type: "text" as const, text: `No video file found in asset ${videoAssetId}` }],
    };
  }

  const assetDir = manifest.path;
  const videoPath = join(assetDir, videoFile.name);

  let probe: ProbeResult;
  try {
    probe = await probeVideo(videoPath);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      isError: true,
      content: [{ type: "text" as const, text: `Failed to probe video: ${msg}` }],
    };
  }

  const timestamp = mode === "first" ? 0.1 : Math.max(0, probe.duration - 0.1);

  // Derive image asset name from video asset ID (strip "vid-" prefix)
  const baseName = videoAssetId.startsWith("vid-") ? videoAssetId.slice(4) : videoAssetId;
  const imageName = `${baseName}-${mode}-frame`;

  const assetResult = await fs.createAsset("img", imageName, projectSlug);
  if (!assetResult.ok) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: `Failed to create image asset: ${assetResult.error.message}` }],
    };
  }

  const { assetId: imageAssetId, path: imageAssetDir } = assetResult.value;
  await mkdir(imageAssetDir, { recursive: true });

  const lockResult = await fs.acquireLock(imageAssetDir, { durationMs: LOCK_DURATION_MS });
  if (!lockResult.ok) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: `Asset is locked: ${lockResult.error.message}` }],
    };
  }

  try {
    const outputPath = join(imageAssetDir, "original.jpg");
    const jobId = `extract-frame-${imageAssetId}-${Date.now()}`;

    await queue.enqueueAndWait(jobId, {
      type: "extract_frame",
      inputPath: videoPath,
      outputPath,
      timestamp,
    } as unknown as Record<string, unknown>);

    const origin = {
      origin: `${mode}_frame`,
      source_asset: videoAssetId,
      timestamp,
      width: probe.width,
      height: probe.height,
    };
    await fsWriteFile(join(imageAssetDir, ".origin.json"), JSON.stringify(origin, null, 2));

    const operationName = `extract_${mode}_frame`;
    await fs.commitOperation(operationName, imageAssetId, { source: videoAssetId }, projectSlug);

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({ image_asset_id: imageAssetId, source_video: videoAssetId, timestamp }),
      }],
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      isError: true,
      content: [{ type: "text" as const, text: `Extract frame failed: ${msg}` }],
    };
  } finally {
    await fs.releaseLock(imageAssetDir);
  }
}

export function registerExtractFrameJobHandler(): void {
  registerJobHandler("extract_frame", async (payload) => {
    const { inputPath, outputPath, timestamp } = payload as ExtractFramePayload;

    await runFfmpeg([
      "-y",
      "-ss", String(timestamp),
      "-i", inputPath,
      "-frames:v", "1",
      "-q:v", "2",
      outputPath,
    ]);

    return { success: true };
  });
}

const extractFrameSchema = {
  asset_id: z.string().describe("Video asset ID (e.g. vid-my-video)"),
  project_slug: z.string().describe("Project slug"),
};

export function extractFrameDefs(fs: ClipfirstFs): ToolDef[] {
  return [
    {
      name: "extract_first_frame",
      description: "Extract the first frame of a video asset as a new image asset (JPEG). Uses 0.1s offset to avoid black frames.",
      schema: extractFrameSchema,
      handler: async (args) => {
        const { asset_id, project_slug } = args as { asset_id: string; project_slug: string };
        return extractFrame(asset_id, project_slug, "first", fs);
      },
    },
    {
      name: "extract_last_frame",
      description: "Extract the last frame of a video asset as a new image asset (JPEG). Uses duration-0.1s to avoid fade-out.",
      schema: extractFrameSchema,
      handler: async (args) => {
        const { asset_id, project_slug } = args as { asset_id: string; project_slug: string };
        return extractFrame(asset_id, project_slug, "last", fs);
      },
    },
  ];
}

export function registerExtractFrameTools(server: McpServer, fs: ClipfirstFs): void {
  registerExtractFrameJobHandler();
  for (const def of extractFrameDefs(fs)) {
    server.tool(def.name, def.description, def.schema, def.handler);
  }
}
