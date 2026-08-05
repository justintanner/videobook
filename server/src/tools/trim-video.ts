import { findVideoFile, type Engine } from "videobook-engine";
import { z } from "zod";
import { join } from "node:path";
import { queue } from "../queue.js";
import type { ToolDef } from "./tool-def.js";
import { resolveVideoAssetReference } from "./video-source-reference.js";
import { parseVideoTimestamp, videoTimestampSchema } from "./video-time-input.js";
import { sleepDef } from "./sleep.js";

type ValidatedParams =
  | { mode: "keep"; trimStart: number | undefined; trimEnd: number | undefined }
  | { mode: "cut"; cutStart: number; cutEnd: number }
  | { error: string };

function validateTrimParams(
  trimStart: number | undefined,
  trimEnd: number | undefined,
  cutStart: number | undefined,
  cutEnd: number | undefined,
): ValidatedParams {
  const hasKeep = trimStart !== undefined || trimEnd !== undefined;
  const hasCut = cutStart !== undefined || cutEnd !== undefined;

  if (hasKeep && hasCut) {
    return { error: "Cannot specify both trim (keep) and cut (remove) parameters. Use one mode at a time." };
  }
  if (!hasKeep && !hasCut) {
    return { error: "Must specify trim_start/trim_end (keep range) or cut_start/cut_end (remove range)." };
  }

  if (hasCut) {
    if (cutStart === undefined || cutEnd === undefined) {
      return { error: "Both cut_start and cut_end are required for cut mode." };
    }
    if (cutStart >= cutEnd) {
      return { error: "cut_start must be less than cut_end." };
    }
    if (cutStart < 0 || cutEnd < 0) {
      return { error: "cut_start and cut_end must be >= 0." };
    }
    return { mode: "cut", cutStart, cutEnd };
  }

  if (trimStart !== undefined && trimStart < 0) {
    return { error: "trim_start must be >= 0." };
  }
  if (trimEnd !== undefined && trimEnd < 0) {
    return { error: "trim_end must be >= 0." };
  }
  if (trimStart !== undefined && trimEnd !== undefined && trimStart >= trimEnd) {
    return { error: "trim_start must be less than trim_end." };
  }
  return { mode: "keep", trimStart, trimEnd };
}

export function trimVideoDef(fs: Engine): ToolDef {
  return {
    name: "trim_video",
    description: "Modify an existing video in place by keeping a range or removing a middle section. Use extract_video_clip instead when the user asks for a new clip and wants the source preserved. Timestamp fields accept numbers or values such as 15s and 1:30.",
    annotations: {
      title: "Trim video in place",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    schema: {
      asset_id: z.string().describe("Source video asset ID or notebook reference such as @a1"),
      book_id: z.string().describe("Book id"),
      notebook_id: z.string().uuid().optional().describe("Notebook UUID when asset_id is a grid reference and the book has multiple matching notebooks"),
      trim_start: videoTimestampSchema.optional().describe("Start of range to keep"),
      trim_end: videoTimestampSchema.optional().describe("End of range to keep"),
      cut_start: videoTimestampSchema.optional().describe("Start of section to remove"),
      cut_end: videoTimestampSchema.optional().describe("End of section to remove"),
    },
    handler: async (args) => {
      const { asset_id, book_id, notebook_id, trim_start, trim_end, cut_start, cut_end } = args as {
        asset_id: string; book_id: string;
        notebook_id?: string;
        trim_start?: string | number;
        trim_end?: string | number;
        cut_start?: string | number;
        cut_end?: string | number;
      };
      let assetId: string;
      let parsedTrimStart: number | undefined;
      let parsedTrimEnd: number | undefined;
      let parsedCutStart: number | undefined;
      let parsedCutEnd: number | undefined;
      try {
        assetId = resolveVideoAssetReference(fs, asset_id, notebook_id);
        parsedTrimStart = parseVideoTimestamp(trim_start, "trim_start");
        parsedTrimEnd = parseVideoTimestamp(trim_end, "trim_end");
        parsedCutStart = parseVideoTimestamp(cut_start, "cut_start");
        parsedCutEnd = parseVideoTimestamp(cut_end, "cut_end");
      } catch (err) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
        };
      }
      const validated = validateTrimParams(
        parsedTrimStart,
        parsedTrimEnd,
        parsedCutStart,
        parsedCutEnd,
      );
      if ("error" in validated) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: validated.error }],
        };
      }

      const manifestResult = await fs.files.manifest(assetId);
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
          content: [{ type: "text" as const, text: `No video file found in asset ${assetId}` }],
        };
      }

      const assetDir = manifest.path;
      const videoPath = join(assetDir, videoFile.name);
      const tempPath = join(assetDir, "original_trimmed.mp4");
      const jobId = `trim-${assetId}-${Date.now()}`;

      const jobPayload: Record<string, unknown> = {
        type: "trim_video",
        inputPath: videoPath,
        outputPath: tempPath,
        mode: validated.mode,
        assetId,
        assetDir,
        bookId: book_id,
        commitParams: {
          trim_start: parsedTrimStart,
          trim_end: parsedTrimEnd,
          cut_start: parsedCutStart,
          cut_end: parsedCutEnd,
          mode: validated.mode,
        },
      };
      if (validated.mode === "keep") {
        jobPayload.trimStart = validated.trimStart;
        jobPayload.trimEnd = validated.trimEnd;
      } else {
        jobPayload.cutStart = validated.cutStart;
        jobPayload.cutEnd = validated.cutEnd;
      }

      try {
        await queue.enqueueAndWait(jobId, jobPayload);
        const readiness = await sleepDef(fs).handler({
          asset_id: assetId,
          book_id,
          timeout_seconds: 300,
        });
        if (readiness.isError) {
          const text = readiness.content.find((entry) => entry.type === "text")?.text;
          let detail = text ?? "Post-trim processing failed";
          if (text) {
            try {
              const parsed = JSON.parse(text) as { error?: unknown; status?: unknown };
              detail = typeof parsed.error === "string"
                ? parsed.error
                : `Post-trim processing ${String(parsed.status ?? "failed")}`;
            } catch {
              detail = text;
            }
          }
          throw new Error(detail);
        }
      } catch (err) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Trim failed: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ asset_id: assetId, job_id: jobId, status: "completed" }),
        }],
      };
    },
  };
}
