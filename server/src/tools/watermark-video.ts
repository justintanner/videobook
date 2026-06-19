import type { VideocityFs } from "videocity-engine";
import { z } from "zod";
import { join } from "node:path";
import { queue } from "../queue.js";
import { findVideoFile } from "videocity-engine";
import type { ToolDef } from "./tool-def.js";
import type { WatermarkPosition } from "../jobs/watermark-video.js";

const DEFAULT_HANDLE = "justinwtanner";

const WATERMARK_POSITIONS = [
  "top-left", "top-center", "top-right",
  "middle-left", "middle-center", "middle-right",
  "bottom-left", "bottom-center", "bottom-right",
] as const satisfies readonly WatermarkPosition[];

function defaultUrl(handle: string): string {
  return `https://x.com/${handle}`;
}

function defaultLabel(handle: string): string {
  return `X: ${handle}`;
}

export function watermarkVideoDef(fs: VideocityFs): ToolDef {
  return {
    name: "watermark_video",
    description: "Overlay a black-and-white QR code plus 'X: <handle>' text in a chosen position (default bottom-right) at a chosen size during the last 2 seconds of a video. Operates in-place with git versioning.",
    schema: {
      asset_id: z.string().describe("Asset ID (e.g. vid-my-video)"),
      project_slug: z.string().describe("Project slug"),
      handle: z.string().optional().describe(`X handle without @ (default: ${DEFAULT_HANDLE})`),
      url: z.string().optional().describe("URL the QR code resolves to (default: https://x.com/<handle>)"),
      position: z.enum(WATERMARK_POSITIONS).optional().describe("Where to place the watermark (default: bottom-right)"),
      scale: z.number().min(0.1).max(2).optional().describe("Size multiplier relative to the default card (default: 1, e.g. 0.5 = half)"),
    },
    handler: async (args) => {
      const { asset_id, project_slug, handle, url, position, scale } = args as {
        asset_id: string; project_slug: string; handle?: string; url?: string;
        position?: WatermarkPosition; scale?: number;
      };

      const resolvedPosition = position ?? "bottom-right";
      const resolvedScale = scale ?? 1;
      const resolvedHandle = (handle ?? DEFAULT_HANDLE).replace(/^@/, "").trim();
      if (!resolvedHandle) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "handle must be a non-empty string" }],
        };
      }
      const resolvedUrl = url ?? defaultUrl(resolvedHandle);
      const resolvedLabel = defaultLabel(resolvedHandle);

      const manifestResult = await fs.getManifest(asset_id, project_slug);
      if (!manifestResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: manifestResult.error.message }],
        };
      }

      const manifest = manifestResult.value;
      const videoFile = findVideoFile(manifest.files);
      if (!videoFile) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `No video file found in asset ${asset_id}` }],
        };
      }

      const assetDir = manifest.path;
      const videoPath = join(assetDir, videoFile.name);
      const tempPath = join(assetDir, "original_watermarked.mp4");
      const jobId = `watermark-${asset_id}-${Date.now()}`;

      const jobPayload: Record<string, unknown> = {
        type: "watermark_video",
        inputPath: videoPath,
        outputPath: tempPath,
        url: resolvedUrl,
        label: resolvedLabel,
        assetId: asset_id,
        assetDir,
        projectSlug: project_slug,
        position: resolvedPosition,
        scale: resolvedScale,
      };

      try {
        await queue.enqueueAndWait(jobId, jobPayload);
      } catch (err) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Watermark failed: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ asset_id, job_id: jobId, status: "completed", url: resolvedUrl, label: resolvedLabel }),
        }],
      };
    },
  };
}

