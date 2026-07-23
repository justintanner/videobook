import type { VideocityFs } from "videobook-engine";
import { z } from "zod";
import { join } from "node:path";
import { queue } from "../queue.js";
import { findVideoFile } from "videobook-engine";
import { probeVideo } from "../ffmpeg.js";
import type { ToolDef } from "./tool-def.js";

export async function resolveHasAudioForCuts(
  metaHasAudio: boolean | undefined,
  inputPath: string,
): Promise<boolean> {
  if (typeof metaHasAudio === "boolean") return metaHasAudio;
  return (await probeVideo(inputPath)).hasAudio;
}

type Cut = { cut_start: number; cut_end: number };

function validateCuts(
  cuts: Cut[],
  duration: number | null,
): { ok: true; sorted: Cut[] } | { ok: false; error: string } {
  if (cuts.length === 0) return { ok: false, error: "cuts must contain at least one entry" };
  const sorted = [...cuts].sort((a, b) => a.cut_start - b.cut_start);
  let lastEnd = -Infinity;
  for (const c of sorted) {
    if (c.cut_start < 0 || c.cut_end < 0) {
      return { ok: false, error: "cut_start and cut_end must be >= 0" };
    }
    if (c.cut_start >= c.cut_end) {
      return { ok: false, error: `cut_start must be < cut_end (got ${c.cut_start} >= ${c.cut_end})` };
    }
    if (c.cut_start < lastEnd) {
      return { ok: false, error: `cuts overlap: ${c.cut_start.toFixed(2)} < previous end ${lastEnd.toFixed(2)}` };
    }
    if (duration !== null && c.cut_end > duration + 0.01) {
      return { ok: false, error: `cut_end ${c.cut_end.toFixed(2)} exceeds video duration ${duration.toFixed(2)}` };
    }
    lastEnd = c.cut_end;
  }
  return { ok: true, sorted };
}

export function applyCutsDef(fs: VideocityFs): ToolDef {
  return {
    name: "apply_cuts",
    description:
      "Splice out one or more time ranges from a video asset in-place. Operates via ffmpeg concat-splice; "
      + "re-runs process_video downstream so frames, transcripts, and analyses are regenerated. "
      + "Pair with /suggest-cuts to source ranges, or hand-pick them.",
    schema: {
      asset_id: z.string().describe("Video asset ID (vid-*)"),
      project_slug: z.string().describe("Project slug"),
      cuts: z
        .array(
          z.object({
            cut_start: z.number().min(0).describe("Start of range to remove (seconds)"),
            cut_end: z.number().min(0).describe("End of range to remove (seconds)"),
          }),
        )
        .min(1)
        .describe("Ranges to remove. Sorted, non-overlapping, within [0, duration]."),
    },
    handler: async (args) => {
      const { asset_id, project_slug, cuts } = args as {
        asset_id: string;
        project_slug: string;
        cuts: Cut[];
      };
      const assetId = asset_id.replace(/^@/, "");

      const manifestResult = await fs.getManifest(assetId, project_slug);
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

      const metaResult = await fs.readMetadata<{ duration?: number; hasAudio?: boolean }>(
        assetId, "original", project_slug,
      );
      const duration = metaResult.ok && typeof metaResult.value.duration === "number"
        ? metaResult.value.duration
        : null;
      const metaHasAudio = metaResult.ok && typeof metaResult.value.hasAudio === "boolean"
        ? metaResult.value.hasAudio
        : undefined;

      const validated = validateCuts(cuts, duration);
      if (!validated.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: validated.error }],
        };
      }

      const assetDir = manifest.path;
      const inputPath = join(assetDir, videoFile.name);
      const hasAudio = await resolveHasAudioForCuts(metaHasAudio, inputPath);
      const outputPath = join(assetDir, "original_cuts.mp4");
      const jobId = `apply-cuts-${assetId}-${Date.now()}`;

      try {
        await queue.enqueueAndWait(jobId, {
          type: "apply_cuts",
          inputPath,
          outputPath,
          cuts: validated.sorted,
          duration: duration ?? 0,
          hasAudio,
          assetId,
          assetDir,
          projectSlug: project_slug,
        });
      } catch (err) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Apply cuts failed: ${err instanceof Error ? err.message : String(err)}` }],
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

