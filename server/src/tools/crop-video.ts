import type { Engine } from "videobook-engine";
import { z } from "zod";
import { join } from "node:path";
import { queue } from "../queue.js";
import { findVideoFile } from "videobook-engine";
import type { ToolDef } from "./tool-def.js";

const RECT_EPSILON = 0.001;

type ValidationError = { error: string };

function validateRect(
  x: number,
  y: number,
  w: number,
  h: number,
): ValidationError | null {
  if (w <= 0 || h <= 0) return { error: "Crop width and height must be > 0." };
  if (x < 0 || y < 0) return { error: "Crop x and y must be >= 0." };
  if (x + w > 1 + RECT_EPSILON) return { error: `Crop x + w must be <= 1 (got ${x + w}).` };
  if (y + h > 1 + RECT_EPSILON) return { error: `Crop y + h must be <= 1 (got ${y + h}).` };
  return null;
}

export function cropVideoDef(fs: Engine): ToolDef {
  return {
    name: "crop_video",
    description:
      "Crop a video asset to a 16:9, 9:16, or 1:1 region. Coordinates are normalized fractions of the source frame (0..1). Re-renders in place to canonical dims (1920x1080 / 1080x1920 / 1080x1080) with git versioning.",
    schema: {
      asset_id: z.string().describe("Asset ID (e.g. vid-my-video)"),
      project_slug: z.string().describe("Project slug"),
      ratio: z.enum(["16:9", "9:16", "1:1"]).describe("Target aspect ratio"),
      x: z.number().min(0).max(1).describe("Crop origin X as fraction of source width (0..1)"),
      y: z.number().min(0).max(1).describe("Crop origin Y as fraction of source height (0..1)"),
      w: z.number().min(0).max(1).describe("Crop width as fraction of source width (0..1)"),
      h: z.number().min(0).max(1).describe("Crop height as fraction of source height (0..1)"),
    },
    handler: async (args) => {
      const { asset_id, project_slug, ratio, x, y, w, h } = args as {
        asset_id: string; project_slug: string;
        ratio: "16:9" | "9:16" | "1:1";
        x: number; y: number; w: number; h: number;
      };

      const rectErr = validateRect(x, y, w, h);
      if (rectErr) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: rectErr.error }],
        };
      }

      const manifestResult = await fs.files.manifest(asset_id, project_slug);
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
      const tempPath = join(assetDir, "original_cropped.mp4");
      const jobId = `crop-${asset_id}-${Date.now()}`;

      const jobPayload: Record<string, unknown> = {
        type: "crop_video",
        inputPath: videoPath,
        outputPath: tempPath,
        ratio,
        rect: { x, y, w, h },
        assetId: asset_id,
        assetDir,
        projectSlug: project_slug,
      };

      try {
        await queue.enqueueAndWait(jobId, jobPayload);
      } catch (err) {
        return {
          isError: true as const,
          content: [{
            type: "text" as const,
            text: `Crop failed: ${err instanceof Error ? err.message : String(err)}`,
          }],
        };
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ asset_id, job_id: jobId, ratio, status: "completed" }),
        }],
      };
    },
  };
}

