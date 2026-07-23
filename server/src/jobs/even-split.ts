import type { VideocityFs } from "videobook-engine";
import { rm } from "node:fs/promises";
import { registerJobHandler, queue } from "../queue.js";
import { trimRange, trimRangeExact, assertSaneTrimOutput } from "./trim-video.js";

type EvenSplitChunkPayload = {
  assetId: string;
  assetDir: string;
  outputPath: string;
  start: number;
  end: number;
  duration: number;
  /** When true, encode with exact-second container duration. False for the trailing leftover. */
  exact: boolean;
};

type EvenSplitPayload = {
  type: "even_split";
  sourcePath: string;
  sourceAssetId: string;
  chunks: EvenSplitChunkPayload[];
  projectSlug: string;
  /**
   * When set, every chunk in `chunks` shares this destination asset and was
   * written into it as a sibling file (no per-chunk asset minted). The job
   * skips per-chunk metadata + process_video enqueue and emits a single
   * commitOperation on the destination asset after all writes finish.
   */
  destination?: { assetId: string };
};

async function buildChunk(
  fs: VideocityFs,
  args: {
    sourcePath: string;
    outputPath: string;
    start: number;
    end: number;
    assetId: string;
    projectSlug: string;
    provenance: Record<string, unknown>;
    /**
     * If true, encode with `trimRangeExact` so the container duration reads
     * as the integer second value (e.g. exactly 10.000s). Set on every
     * targeted chunk; false on the trailing leftover.
     */
    exact?: boolean;
    /**
     * Destination-mode chunks share their asset with siblings, so don't
     * stamp `original.json` provenance — that file is per-asset, not
     * per-file, and would clobber across chunks.
     */
    skipMetadata?: boolean;
  },
): Promise<void> {
  const { sourcePath, outputPath, start, end, assetId, projectSlug, provenance, exact, skipMetadata } = args;
  try {
    if (exact) {
      await trimRangeExact(sourcePath, outputPath, start, end - start);
    } else {
      await trimRange(sourcePath, outputPath, start, end);
    }
    await assertSaneTrimOutput(sourcePath, outputPath);
  } catch (err) {
    await rm(outputPath, { force: true });
    throw err;
  }
  if (!skipMetadata) {
    await fs.writeMetadata(assetId, "original", provenance, projectSlug);
  }
}

export function registerEvenSplitJob(fs: VideocityFs): void {
  registerJobHandler("even_split", async (payload) => {
    const { sourcePath, sourceAssetId, chunks, projectSlug, destination } = payload as EvenSplitPayload;
    const splitAtIso = new Date().toISOString();
    const destinationMode = destination !== undefined;

    const buildPromises = chunks.map((chunk, i) => {
      const provenance: Record<string, unknown> = {
        origin: "even_split",
        source_asset_id: sourceAssetId,
        chunk_index: i,
        chunk_count: chunks.length,
        chunk_start: chunk.start,
        chunk_end: chunk.end,
        chunk_duration: chunk.duration,
        split_at_iso: splitAtIso,
      };
      // Targeted chunks need exact-second container duration; the trailing
      // leftover does not (and the user explicitly doesn't care).
      return buildChunk(fs, {
        sourcePath,
        outputPath: chunk.outputPath,
        start: chunk.start,
        end: chunk.end,
        assetId: chunk.assetId,
        projectSlug,
        provenance,
        exact: chunk.exact,
        skipMetadata: destinationMode,
      });
    });
    await Promise.all(buildPromises);

    if (destinationMode) {
      // All chunks landed inside the same destination asset as sibling files.
      // One commit captures the whole batch; no process_video pass (those exist
      // to extract per-asset waveform/metadata for standalone vid-* assets,
      // not for scratch siblings inside a shared asset like plan/).
      await fs.commitOperation(
        "even_split",
        destination.assetId,
        {
          source_asset_id: sourceAssetId,
          filenames: chunks.map((c) => c.outputPath.split("/").pop()),
          chunk_count: chunks.length,
          split_at_iso: splitAtIso,
        },
        projectSlug,
      );
      return {
        success: true,
        destination_asset_id: destination.assetId,
        filenames: chunks.map((c) => c.outputPath.split("/").pop()),
      };
    }

    await Promise.all(chunks.map((chunk, i) =>
      queue.enqueueAndWait(`process-video-${chunk.assetId}-${Date.now() + i}`, {
        type: "process_video",
        videoPath: chunk.outputPath,
        assetId: chunk.assetId,
        assetDir: chunk.assetDir,
        projectSlug,
        skipDownstreamJobs: true,
        provenance: {
          origin: "even_split",
          source_asset_id: sourceAssetId,
          chunk_index: i,
          chunk_count: chunks.length,
        },
      } as unknown as Record<string, unknown>),
    ));

    return {
      success: true,
      chunk_asset_ids: chunks.map((c) => c.assetId),
    };
  });
}
