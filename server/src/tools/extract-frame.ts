import type { VideocityFs } from "videobook-engine";
import { z } from "zod";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { queue } from "../queue.js";
import { findVideoFile } from "videobook-engine";
import type { ToolDef } from "./tool-def.js";

const execFileAsync = promisify(execFile);

const require = createRequire(import.meta.url);
const FFPROBE: string = require("ffprobe-static").path;

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
  // Use the video stream's own duration so "last frame" never seeks past the
  // last decodable video PTS — the format/container duration can include a
  // longer audio tail and produce an empty output.
  const streamDuration = Number(videoStream?.duration ?? 0);
  const formatDuration = Number(data.format?.duration ?? 0);
  const duration = streamDuration > 0 ? streamDuration : formatDuration;
  return { width, height, duration };
}

async function extractFrame(
  videoAssetId: string,
  projectSlug: string,
  mode: "first" | "last" | "custom",
  fs: VideocityFs,
  customTimestamp?: number,
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

  const videoPath = join(manifest.path, videoFile.name);

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

  const timestamp = mode === "custom"
    ? Math.max(0, Math.min(customTimestamp ?? 0, probe.duration))
    : mode === "first" ? 0.1 : Math.max(0, probe.duration - 0.1);

  const baseName = videoAssetId.startsWith("vid-") ? videoAssetId.slice(4) : videoAssetId;
  const imageName = mode === "custom"
    ? `${baseName}-frame-${String(Math.round((customTimestamp ?? 0) * 100) / 100).replace(".", "-")}s`
    : `${baseName}-${mode}-frame`;

  const assetResult = await fs.createAsset("img", imageName, projectSlug);
  if (!assetResult.ok) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: `Failed to create image asset: ${assetResult.error.message}` }],
    };
  }

  const { assetId: imageAssetId, path: imageAssetDir } = assetResult.value;

  const jobId = `extract-frame-${imageAssetId}-${Date.now()}`;

  await queue.enqueue(jobId, {
    type: "extract_frame",
    inputPath: videoPath,
    timestamp,
    imageAssetId,
    imageAssetDir,
    sourceVideoId: videoAssetId,
    projectSlug,
    width: probe.width,
    height: probe.height,
    mode,
  } as unknown as Record<string, unknown>);

  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({ image_asset_id: imageAssetId, source_video: videoAssetId, job_id: jobId, status: "enqueued" }),
    }],
  };
}

const extractFrameSchema = {
  asset_id: z.string().describe("Video asset ID (e.g. vid-my-video)"),
  project_slug: z.string().describe("Project slug"),
};

export function extractFrameDefs(fs: VideocityFs): ToolDef[] {
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
    {
      name: "extract_frame",
      description: "Extract a frame at a specific timestamp from a video asset as a new image asset (JPEG).",
      schema: {
        asset_id: z.string().describe("Video asset ID (e.g. vid-my-video)"),
        project_slug: z.string().describe("Project slug"),
        timestamp: z.number().describe("Timestamp in seconds to extract the frame from"),
      },
      handler: async (args) => {
        const { asset_id, project_slug, timestamp } = args as {
          asset_id: string;
          project_slug: string;
          timestamp: number;
        };
        return extractFrame(asset_id, project_slug, "custom", fs, timestamp);
      },
    },
  ];
}

