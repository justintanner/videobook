import type { Engine } from "videobook-engine";
import { findVideoFile } from "videobook-engine";
import { z } from "zod";
import { queue } from "../queue.js";
import type { ToolDef, ToolResult } from "./tool-def.js";

export function detectScenesDef(engine: Engine): ToolDef {
  return {
    name: "detect_scenes",
    description:
      "Find natural visual breaks in a video in a background job: shot cuts and motion-settle moments inside steady shots, each with a time and score. Read-only.",
    schema: {
      source_asset_id: z.string().describe("Video asset id (vid-*) inside the project"),
      book_id: z.string().describe("Book id"),
    },
    handler: async (args): Promise<ToolResult> => {
      const { source_asset_id, book_id } = args as {
        source_asset_id: string;
        book_id: string;
      };
      const sourceAssetId = source_asset_id.replace(/^@/, "");

      const manifestResult = await engine.files.manifest(sourceAssetId);
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
