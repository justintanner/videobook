import type { VideocityFs } from "vc-engine";
import { z } from "zod";
import { join } from "node:path";
import { queue } from "../queue.js";
import { findVideoFile } from "vc-engine";
import { probeVideo } from "../ffmpeg.js";
import type { ToolDef } from "./tool-def.js";

// Each chunk must be at least this long, otherwise downstream process_video
// can't extract frames / probe meaningfully and the asset gets stuck.
const MIN_CHUNK_SEC = 0.5;

type ValidatedSplit =
  | { chunkAEnd: number; chunkBStart: number }
  | { error: string };

function validateSplitParams(
  chunkAEnd: number,
  chunkBStart: number,
): ValidatedSplit {
  if (!Number.isFinite(chunkAEnd) || !Number.isFinite(chunkBStart)) {
    return { error: "chunk_a_end and chunk_b_start must be finite numbers." };
  }
  if (chunkAEnd <= 0) {
    return { error: "chunk_a_end must be > 0." };
  }
  if (chunkBStart < 0) {
    return { error: "chunk_b_start must be >= 0." };
  }
  // Overlap is allowed (chunkBStart <= chunkAEnd) but not fully reversed.
  if (chunkBStart > chunkAEnd) {
    return {
      error: `chunk_b_start (${chunkBStart}) must be <= chunk_a_end (${chunkAEnd}). Gaps are not supported; use trim_video instead.`,
    };
  }
  return { chunkAEnd, chunkBStart };
}

// slugifyName in vc-engine truncates to 4 words AND filters stop words
// (which include "a"), so naming chunks "...-a" and "...-b" loses the suffix
// asymmetrically. Use numeric suffixes 1/2 — they survive both filters — and
// trim the source name to its last 2 words so the suffix fits in the cap.
function deriveChunkName(originalAssetId: string, suffix: "1" | "2"): string {
  const dashIdx = originalAssetId.indexOf("-");
  const base = dashIdx >= 0 ? originalAssetId.slice(dashIdx + 1) : originalAssetId;
  const words = base.split("-").filter((w) => w.length > 0);
  const tail = words.slice(-2).join("-") || base;
  return `${tail}-${suffix}`;
}

export function splitVideoDef(fs: VideocityFs): ToolDef {
  return {
    name: "split_video",
    description:
      "Split a video asset into two new assets at chunk_a_end / chunk_b_start. Setting chunk_b_start < chunk_a_end produces an overlap window; equal values produce a clean split. The original asset is preserved.",
    schema: {
      asset_id: z.string().describe("Source video asset ID (e.g. vid-my-clip)"),
      project_slug: z.string().describe("Project slug"),
      chunk_a_end: z.number().describe("End of the first chunk in seconds"),
      chunk_b_start: z.number().describe("Start of the second chunk in seconds (<= chunk_a_end for overlap, equal for clean split)"),
    },
    handler: async (args) => {
      const { asset_id, project_slug, chunk_a_end, chunk_b_start } = args as {
        asset_id: string;
        project_slug: string;
        chunk_a_end: number;
        chunk_b_start: number;
      };

      const validated = validateSplitParams(chunk_a_end, chunk_b_start);
      if ("error" in validated) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: validated.error }],
        };
      }

      const manifestResult = await fs.getManifest(asset_id, project_slug);
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

      const sourcePath = join(manifest.path, videoFile.name);

      let sourceDurationSec: number;
      try {
        sourceDurationSec = (await probeVideo(sourcePath)).duration;
      } catch (err) {
        return {
          isError: true as const,
          content: [{
            type: "text" as const,
            text: `Failed to probe source duration: ${err instanceof Error ? err.message : String(err)}`,
          }],
        };
      }
      if (validated.chunkAEnd > sourceDurationSec + 0.05) {
        return {
          isError: true as const,
          content: [{
            type: "text" as const,
            text: `chunk_a_end (${validated.chunkAEnd.toFixed(2)}s) exceeds source duration (${sourceDurationSec.toFixed(2)}s).`,
          }],
        };
      }
      const chunkADur = validated.chunkAEnd;
      const chunkBDur = sourceDurationSec - validated.chunkBStart;
      if (chunkADur < MIN_CHUNK_SEC || chunkBDur < MIN_CHUNK_SEC) {
        return {
          isError: true as const,
          content: [{
            type: "text" as const,
            text: `Chunks would be too short: A=${chunkADur.toFixed(2)}s, B=${chunkBDur.toFixed(2)}s (min ${MIN_CHUNK_SEC}s each). Source is ${sourceDurationSec.toFixed(2)}s — pick a split point further from the ends.`,
          }],
        };
      }

      const prefix = asset_id.split("-")[0];
      const nameA = deriveChunkName(asset_id, "1");
      const nameB = deriveChunkName(asset_id, "2");

      const createA = await fs.createAsset(prefix, nameA, project_slug);
      if (!createA.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to create chunk A asset: ${createA.error.message}` }],
        };
      }
      const createB = await fs.createAsset(prefix, nameB, project_slug);
      if (!createB.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to create chunk B asset: ${createB.error.message}` }],
        };
      }

      const assetIdA = createA.value.assetId;
      const assetIdB = createB.value.assetId;
      const assetDirA = createA.value.path;
      const assetDirB = createB.value.path;
      const outputPathA = join(assetDirA, "original.mp4");
      const outputPathB = join(assetDirB, "original.mp4");

      const jobId = `split-${asset_id}-${Date.now()}`;
      try {
        await queue.enqueueAndWait(jobId, {
          type: "split_video",
          sourcePath,
          sourceAssetId: asset_id,
          chunkAEnd: validated.chunkAEnd,
          chunkBStart: validated.chunkBStart,
          assetIdA,
          assetDirA,
          outputPathA,
          assetIdB,
          assetDirB,
          outputPathB,
          projectSlug: project_slug,
        });
      } catch (err) {
        return {
          isError: true as const,
          content: [{
            type: "text" as const,
            text: `Split failed: ${err instanceof Error ? err.message : String(err)}`,
          }],
        };
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            source_asset_id: asset_id,
            chunk_a_asset_id: assetIdA,
            chunk_b_asset_id: assetIdB,
            chunk_a_end: validated.chunkAEnd,
            chunk_b_start: validated.chunkBStart,
            overlap_sec: Math.max(0, validated.chunkAEnd - validated.chunkBStart),
            job_id: jobId,
            status: "completed",
          }),
        }],
      };
    },
  };
}

