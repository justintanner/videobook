import type { VideocityFs } from "videocity-engine";
import { findVideoFile } from "videocity-engine";
import { z } from "zod";
import { queue } from "../queue.js";
import type { ToolDef, ToolResult } from "./tool-def.js";

export function detectScenesDef(fs: VideocityFs): ToolDef {
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
      project_slug: z.string().describe("Project slug"),
    },
    handler: async (args): Promise<ToolResult> => {
      const { source_asset_id, project_slug } = args as {
        source_asset_id: string;
        project_slug: string;
      };
      const sourceAssetId = source_asset_id.replace(/^@/, "");

      const manifestResult = await fs.getManifest(sourceAssetId, project_slug, { includeDotfiles: false });
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
        projectSlug: project_slug,
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
