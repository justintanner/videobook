import type { Engine } from "videobook-engine";
import { z } from "zod";
import { join } from "node:path";
import { queue } from "../queue.js";
import { findVideoFile } from "videobook-engine";
import { probeVideo, type ProbeResult } from "../ffmpeg.js";
import type { ToolDef } from "./tool-def.js";

async function extractFrame(
  videoAssetId: string,
  bookId: string,
  mode: "first" | "last" | "custom",
  engine: Engine,
  customTimestamp?: number,
): Promise<{ isError?: true; content: Array<{ type: "text"; text: string }> }> {
  const sourceArtifact = engine.artifacts.get(videoAssetId);
  if (!sourceArtifact.ok) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: sourceArtifact.error.message }],
    };
  }
  const manifestResult = await engine.files.manifest(videoAssetId);
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

  if (!Number.isFinite(probe.videoDuration) || probe.videoDuration <= 0 || probe.width <= 0 || probe.height <= 0) {
    return {
      isError: true,
      content: [{ type: "text", text: "Source has no decodable video duration" }],
    };
  }
  const frameSeconds = probe.fps > 0 ? 1 / probe.fps : 0.1;
  const lastTimestamp = Math.max(0, probe.videoDuration - frameSeconds - 0.000001);
  const requestedTimestamp = mode === "custom"
    ? customTimestamp ?? 0
    : mode === "first" ? 0.1 : probe.videoDuration - 0.1;
  const timestamp = Math.max(0, Math.min(requestedTimestamp, lastTimestamp));

  const baseName = sourceArtifact.value.label ?? sourceArtifact.value.artifactId;
  const imageName = mode === "custom"
    ? `${baseName}-frame-${String(Math.round(timestamp * 100) / 100).replace(".", "-")}s`
    : `${baseName}-${mode}-frame`;

  const assetResult = await engine.artifacts.create("image", imageName);
  if (!assetResult.ok) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: `Failed to create image asset: ${assetResult.error.message}` }],
    };
  }

  const { artifactId: imageAssetId, path: imageAssetDir } = assetResult.value;

  const jobId = `extract-frame-${imageAssetId}-${Date.now()}`;

  await queue.enqueue(jobId, {
    type: "extract_frame",
    inputPath: videoPath,
    timestamp,
    imageAssetId,
    imageAssetDir,
    sourceVideoId: videoAssetId,
    bookId,
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
  asset_id: z.string().describe("Video artifact id"),
  book_id: z.string().describe("Book UUID"),
};

export function extractFrameDefs(engine: Engine): ToolDef[] {
  return [
    {
      name: "extract_first_frame",
      description: "Extract the first frame of a video asset as a new image asset (JPEG). Uses 0.1s offset to avoid black frames.",
      schema: extractFrameSchema,
      handler: async (args) => {
        const { asset_id, book_id } = args as { asset_id: string; book_id: string };
        return extractFrame(asset_id, book_id, "first", engine);
      },
    },
    {
      name: "extract_last_frame",
      description: "Extract the last frame of a video asset as a new image asset (JPEG). Uses duration-0.1s to avoid fade-out.",
      schema: extractFrameSchema,
      handler: async (args) => {
        const { asset_id, book_id } = args as { asset_id: string; book_id: string };
        return extractFrame(asset_id, book_id, "last", engine);
      },
    },
    {
      name: "extract_frame",
      description: "Extract a frame at a specific timestamp from a video asset as a new image asset (JPEG).",
      schema: {
        asset_id: z.string().describe("Video artifact id"),
        book_id: z.string().describe("Book UUID"),
        timestamp: z.number().describe("Timestamp in seconds to extract the frame from"),
      },
      handler: async (args) => {
        const { asset_id, book_id, timestamp } = args as {
          asset_id: string;
          book_id: string;
          timestamp: number;
        };
        return extractFrame(asset_id, book_id, "custom", engine, timestamp);
      },
    },
  ];
}
