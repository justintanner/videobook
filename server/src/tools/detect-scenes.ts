import type { Engine } from "videobook-engine";
import { findVideoFile } from "videobook-engine";
import { z } from "zod";
import { readArtifactJson, requestSidecarAnalysis } from "../analysis-sidecars.js";
import { SCENE_DETECTION, sceneDetectionRecord } from "../vision-components.js";
import type { ToolDef, ToolResult } from "./tool-def.js";

function summary(document: unknown): Record<string, unknown> {
  if (typeof document !== "object" || document === null) return {};
  const { count, shots, settles } = document as Record<string, unknown>;
  return { count, shots, settles };
}

export function detectScenesDef(engine: Engine): ToolDef {
  return {
    name: "detect_scenes",
    description:
      "Find natural visual breaks in a video in a background job: shot cuts and motion-settle moments inside steady shots, each with a time and score. Read-only. Returns status cached with the counts when the current video was already scanned.",
    schema: {
      source_asset_id: z.string().describe("Video asset id (vid-*) inside the project"),
      book_id: z.string().describe("Book id"),
      force: z.boolean().optional().default(false).describe("Scan again even when the current video was already scanned"),
    },
    handler: async (args): Promise<ToolResult> => {
      const { source_asset_id, book_id, force } = args as {
        source_asset_id: string;
        book_id: string;
        force: boolean;
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

      const requested = await requestSidecarAnalysis(engine, SCENE_DETECTION, {
        ...sceneDetectionRecord(sourceAssetId, videoFile.objectHash),
        force,
        payload: { assetId: sourceAssetId, assetDir: manifestResult.value.path, bookId: book_id },
      });
      const counts = requested.status === "cached"
        ? summary(await readArtifactJson(engine, sourceAssetId, SCENE_DETECTION.sidecar))
        : {};

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ asset_id: sourceAssetId, job_id: requested.jobId, status: requested.status, ...counts }),
        }],
      };
    },
  };
}
