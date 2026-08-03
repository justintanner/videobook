import { findVideoFile, type Engine } from "videobook-engine";
import { z } from "zod";
import { join } from "node:path";
import { queue } from "../queue.js";
import { probeVideo } from "../ffmpeg.js";
import type { ToolDef } from "./tool-def.js";
import { resolveVideoAssetReference } from "./video-source-reference.js";
import { parseVideoTimestamp, videoTimestampSchema } from "./video-time-input.js";

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

// slugifyName in videobook-engine truncates to 4 words AND filters stop words
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

export function splitVideoDef(fs: Engine): ToolDef {
  return {
    name: "split_video",
    description:
      "Create two new clips from one video while preserving the source. Use for requests such as 'trim @a1 15s and remaining'. chunk_a_end accepts seconds or timestamps such as 15s or 1:30; omit chunk_b_start for a clean split.",
    annotations: {
      title: "Split video into clips",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    schema: {
      asset_id: z.string().describe("Source video asset ID or notebook reference such as @a1"),
      book_id: z.string().describe("Project slug"),
      notebook_id: z.string().uuid().optional().describe("Notebook UUID when asset_id is a grid reference and the book has multiple matching notebooks"),
      chunk_a_end: videoTimestampSchema.describe("End of the first clip in seconds or a timestamp such as 15s or 1:30"),
      chunk_b_start: videoTimestampSchema.optional().describe("Start of the remaining clip; defaults to chunk_a_end for a clean split"),
    },
    handler: async (args) => {
      const { asset_id, book_id, notebook_id, chunk_a_end, chunk_b_start } = args as {
        asset_id: string;
        book_id: string;
        notebook_id?: string;
        chunk_a_end: string | number;
        chunk_b_start?: string | number;
      };

      let assetId: string;
      let chunkAEnd: number;
      let chunkBStart: number;
      try {
        assetId = resolveVideoAssetReference(fs, asset_id, notebook_id);
        chunkAEnd = parseVideoTimestamp(chunk_a_end, "chunk_a_end")!;
        chunkBStart = parseVideoTimestamp(chunk_b_start, "chunk_b_start") ?? chunkAEnd;
      } catch (err) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
        };
      }

      const validated = validateSplitParams(chunkAEnd, chunkBStart);
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

      const prefix = assetId.split("-")[0];
      const nameA = deriveChunkName(assetId, "1");
      const nameB = deriveChunkName(assetId, "2");

      const createA = await fs.artifacts.create(prefix, nameA);
      if (!createA.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to create chunk A asset: ${createA.error.message}` }],
        };
      }
      const createB = await fs.artifacts.create(prefix, nameB);
      if (!createB.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to create chunk B asset: ${createB.error.message}` }],
        };
      }

      const assetIdA = createA.value.slug;
      const assetIdB = createB.value.slug;
      const assetDirA = createA.value.path;
      const assetDirB = createB.value.path;
      const outputPathA = join(assetDirA, "original.mp4");
      const outputPathB = join(assetDirB, "original.mp4");

      const jobId = `split-${assetId}-${Date.now()}`;
      try {
        await queue.enqueueAndWait(jobId, {
          type: "split_video",
          sourcePath,
          sourceAssetId: assetId,
          chunkAEnd: validated.chunkAEnd,
          chunkBStart: validated.chunkBStart,
          assetIdA,
          assetDirA,
          outputPathA,
          assetIdB,
          assetDirB,
          outputPathB,
          bookId: book_id,
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
            source_asset_id: assetId,
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
