import type { Engine } from "videobook-engine";
import { z } from "zod";
import { queue } from "../queue.js";
import type { ToolDef } from "./tool-def.js";
import { resolveVideoAssetReference } from "./video-source-reference.js";
import { parseVideoTimestamp, videoTimestampSchema } from "./video-time-input.js";

const MIN_CLIP_SECONDS = 0.5;

function derivedClipName(
  base: string,
  startTime: number,
  endTime: number,
): string {
  return `${base}-${startTime}s-${endTime}s`;
}

export function extractVideoClipDef(engine: Engine): ToolDef {
  return {
    name: "extract_video_clip",
    description: "Cut or extract a new video clip from a source time range while preserving the original. Use when the user says 'create a new clip from @a1 from 15s to 44s'. start_time and end_time accept seconds or timestamps such as 15s, 1:30, or 2m20s.",
    annotations: {
      title: "Extract new video clip",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    schema: {
      asset_id: z.string().describe("Source video artifact id or notebook reference such as @a1"),
      book_id: z.string().describe("Book UUID"),
      notebook_id: z.string().uuid().optional().describe("Notebook UUID when asset_id is a grid reference and the book has multiple matching notebooks"),
      start_time: videoTimestampSchema.optional().describe("Start of the new clip; defaults to 0 seconds"),
      end_time: videoTimestampSchema.describe("End of the new clip"),
      name: z.string().min(1).optional().describe("Optional name for the new video asset"),
    },
    handler: async (args) => {
      const { asset_id, book_id, notebook_id, start_time, end_time, name } = args as {
        asset_id: string;
        book_id: string;
        notebook_id?: string;
        start_time?: string | number;
        end_time: string | number;
        name?: string;
      };

      let assetId: string;
      let startTime: number;
      let endTime: number;
      try {
        assetId = resolveVideoAssetReference(engine, asset_id, notebook_id);
        startTime = parseVideoTimestamp(start_time, "start_time") ?? 0;
        endTime = parseVideoTimestamp(end_time, "end_time")!;
      } catch (err) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
        };
      }
      if (startTime < 0 || endTime <= startTime) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "The clip range must have a non-negative start_time before end_time." }],
        };
      }
      if (endTime - startTime < MIN_CLIP_SECONDS) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `The new clip must be at least ${MIN_CLIP_SECONDS}s long.` }],
        };
      }

      const sourceArtifact = engine.artifacts.get(assetId);
      if (!sourceArtifact.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: sourceArtifact.error.message }],
        };
      }
      const clipBase = sourceArtifact.value.label ?? sourceArtifact.value.artifactId;

      const jobId = `extract-clip-${assetId}-${Date.now()}`;
      let extracted: { artifactId: string; durationSeconds: number };
      try {
        extracted = await queue.enqueueAndWait(jobId, {
          type: "extract_video_clip",
          sourceAssetId: assetId,
          startTime,
          endTime,
          title: name ?? derivedClipName(clipBase, startTime, endTime),
          bookId: book_id,
        });
      } catch (err) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Clip extraction failed: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
      const outputAssetId = extracted.artifactId;
      const actualEndTime = startTime + extracted.durationSeconds;

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            source_asset_id: assetId,
            output_asset_id: outputAssetId,
            output_artifact_id: extracted.artifactId,
            start_time: startTime,
            end_time: actualEndTime,
            duration: extracted.durationSeconds,
            job_id: jobId,
            status: "completed",
          }),
        }],
      };
    },
  };
}
