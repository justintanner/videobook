import type { Engine } from "videobook-engine";
import { findVideoFile } from "videobook-engine";
import { z } from "zod";
import { queue } from "../queue.js";
import type { ToolDef, ToolResult } from "./tool-def.js";

export function detectScenesDef(fs: Engine): ToolDef {
  return {
    name: "detect_scenes",
    description:
      "Run ffmpeg scdet over a video asset and return a candidate timeline of natural visual breaks. " +
      "Each candidate is { t, score, kind } where kind=\"shot\" is a camera/cut change (scdet score ≥ 10) " +
      "and kind=\"settle\" is a motion-settle moment inside a steady shot (the falling edge of a sustained " +
      "high-motion run, e.g. \"the man finished standing up\"). Runs in the background and persists to " +
      ".detect-scenes.json and is useful as a standalone read-only diagnostic.",
    schema: {
      source_asset_id: z.string().describe("Video asset id (vid-*) inside the project"),
      book_id: z.string().describe("Project slug"),
    },
    handler: async (args): Promise<ToolResult> => {
      const { source_asset_id, book_id } = args as {
        source_asset_id: string;
        book_id: string;
      };
      const sourceAssetId = source_asset_id.replace(/^@/, "");

      const manifestResult = await fs.files.manifest(sourceAssetId);
      if (!manifestResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: manifestResult.error.message }],
        };
      }
      const videoFile = findVideoFile(manifestResult.value.files);
      if (!videoFile) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `No video file found in asset ${sourceAssetId}` }],
        };
      }

      const jobId = `detect-scenes-${sourceAssetId}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "detect_scenes",
        assetId: sourceAssetId,
        assetDir: manifestResult.value.path,
        bookId: book_id,
      });

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ asset_id: sourceAssetId, job_id: jobId, status: "enqueued" }),
        }],
      };
    },
  };
}
