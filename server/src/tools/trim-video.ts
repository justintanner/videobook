import type { Engine } from "videobook-engine";
import { z } from "zod";
import { join } from "node:path";
import { queue } from "../queue.js";
import { findVideoFile } from "videobook-engine";
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

export function trimVideoDef(fs: Engine): ToolDef {
  return {
    name: "trim_video",
    description: "Trim a video asset: keep a time range (trim_start/trim_end) or cut out a middle section (cut_start/cut_end). Operates in-place with git versioning.",
    schema: {
      asset_id: z.string().describe("Asset ID (e.g. vid-my-video)"),
      project_slug: z.string().describe("Project slug"),
      trim_start: z.number().optional().describe("Start of range to keep (seconds)"),
      trim_end: z.number().optional().describe("End of range to keep (seconds)"),
      cut_start: z.number().optional().describe("Start of chunk to remove (seconds)"),
      cut_end: z.number().optional().describe("End of chunk to remove (seconds)"),
    },
    handler: async (args) => {
      const { asset_id, project_slug, trim_start, trim_end, cut_start, cut_end } = args as {
        asset_id: string; project_slug: string;
        trim_start?: number; trim_end?: number; cut_start?: number; cut_end?: number;
      };
      const validated = validateTrimParams(trim_start, trim_end, cut_start, cut_end);
      if ("error" in validated) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: validated.error }],
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
      const tempPath = join(assetDir, "original_trimmed.mp4");
      const jobId = `trim-${asset_id}-${Date.now()}`;

      const jobPayload: Record<string, unknown> = {
        type: "trim_video",
        inputPath: videoPath,
        outputPath: tempPath,
        mode: validated.mode,
        assetId: asset_id,
        assetDir,
        projectSlug: project_slug,
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
          content: [{ type: "text" as const, text: `Trim failed: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ asset_id, job_id: jobId, status: "completed" }),
        }],
      };
    },
  };
}

