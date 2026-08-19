import type { Engine } from "videobook-engine";
import { z } from "zod";
import { join, extname } from "node:path";
import { queue } from "../queue.js";
import { findAudioFile } from "videobook-engine";
import type { ToolDef } from "./tool-def.js";

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

export function trimAudioDef(engine: Engine): ToolDef {
  return {
    name: "trim_audio",
    description: "Trim an audio asset: keep a time range (trim_start/trim_end) or cut out a section (cut_start/cut_end). Use trim_video for video assets so picture and sound remain synchronized. Operates in-place with git versioning.",
    schema: {
      asset_id: z.string().describe("Audio artifact id"),
      book_id: z.string().describe("Book UUID"),
      trim_start: z.number().optional().describe("Start of range to keep (seconds)"),
      trim_end: z.number().optional().describe("End of range to keep (seconds)"),
      cut_start: z.number().optional().describe("Start of chunk to remove (seconds)"),
      cut_end: z.number().optional().describe("End of chunk to remove (seconds)"),
    },
    handler: async (args) => {
      const { asset_id, book_id, trim_start, trim_end, cut_start, cut_end } = args as {
        asset_id: string; book_id: string;
        trim_start?: number; trim_end?: number; cut_start?: number; cut_end?: number;
      };
      const validated = validateTrimParams(trim_start, trim_end, cut_start, cut_end);
      if ("error" in validated) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: validated.error }],
        };
      }

      const assetId = asset_id.replace(/^@/, "");
      const artifact = engine.artifacts.get(assetId);
      if (!artifact.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: artifact.error.message }],
        };
      }
      if (artifact.value.kind !== "audio") {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "trim_audio requires an audio artifact. Use trim_video for video artifacts." }],
        };
      }

      const manifestResult = await engine.files.manifest(assetId);
      if (!manifestResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: manifestResult.error.message }],
        };
      }

      const manifest = manifestResult.value;
      const files = manifest.files || [];
      const mediaFile = findAudioFile(files, artifact.value.kind);
      if (!mediaFile) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `No audio file found in artifact ${assetId}` }],
        };
      }

      const assetDir = manifest.path;
      const mediaPath = join(assetDir, mediaFile.name);
      const ext = extname(mediaFile.name);
      const jobId = `trim-audio-${assetId}-${Date.now()}`;
      const tempPath = join(assetDir, `${jobId}${ext}`);

      const jobPayload: Record<string, unknown> = {
        type: "trim_audio",
        inputPath: mediaPath,
        outputPath: tempPath,
        mode: validated.mode,
        assetId,
        assetDir,
        bookId: book_id,
        commitParams: { trim_start, trim_end, cut_start, cut_end, mode: validated.mode },
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
      } catch (err) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Trim audio failed: ${err instanceof Error ? err.message : String(err)}` }],
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
