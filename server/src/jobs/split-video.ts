import type { VideocityFs } from "videocity-engine";
import { rm } from "node:fs/promises";
import { registerJobHandler, queue } from "../queue.js";
import { trimRange, assertSaneTrimOutput } from "./trim-video.js";

type SplitVideoPayload = {
  type: "split_video";
  sourcePath: string;
  sourceAssetId: string;
  chunkAEnd: number;
  chunkBStart: number;
  assetIdA: string;
  assetDirA: string;
  outputPathA: string;
  assetIdB: string;
  assetDirB: string;
  outputPathB: string;
  projectSlug: string;
};

async function buildChunk(
  fs: VideocityFs,
  args: {
    sourcePath: string;
    outputPath: string;
    start: number | undefined;
    end: number | undefined;
    assetId: string;
    projectSlug: string;
    provenance: Record<string, unknown>;
  },
): Promise<void> {
  const { sourcePath, outputPath, start, end, assetId, projectSlug, provenance } = args;
  try {
    await trimRange(sourcePath, outputPath, start, end);
    await assertSaneTrimOutput(sourcePath, outputPath);
  } catch (err) {
    await rm(outputPath, { force: true });
    throw err;
  }
  await fs.writeMetadata(assetId, "original", provenance, projectSlug);
}

export function registerSplitVideoJob(fs: VideocityFs): void {
  // The destination assets are brand-new, so no other job can hold a lease on
  // them; we run the two chunks in parallel against the read-only source.
  registerJobHandler("split_video", async (payload) => {
    const {
      sourcePath, sourceAssetId,
      chunkAEnd, chunkBStart,
      assetIdA, assetDirA, outputPathA,
      assetIdB, assetDirB, outputPathB,
      projectSlug,
    } = payload as SplitVideoPayload;

    const overlapSec = Math.max(0, chunkAEnd - chunkBStart);
    const splitAt = (chunkAEnd + chunkBStart) / 2;
    const splitAtIso = new Date().toISOString();

    const provenanceA: Record<string, unknown> = {
      origin: "split",
      source_asset_id: sourceAssetId,
      split_at: splitAt,
      overlap_sec: overlapSec,
      chunk: "a",
      chunk_start: 0,
      chunk_end: chunkAEnd,
      split_at_iso: splitAtIso,
    };
    const provenanceB: Record<string, unknown> = {
      origin: "split",
      source_asset_id: sourceAssetId,
      split_at: splitAt,
      overlap_sec: overlapSec,
      chunk: "b",
      chunk_start: chunkBStart,
      chunk_end: null,
      split_at_iso: splitAtIso,
    };

    await Promise.all([
      buildChunk(fs, {
        sourcePath, outputPath: outputPathA,
        start: undefined, end: chunkAEnd,
        assetId: assetIdA, projectSlug,
        provenance: provenanceA,
      }),
      buildChunk(fs, {
        sourcePath, outputPath: outputPathB,
        start: chunkBStart, end: undefined,
        assetId: assetIdB, projectSlug,
        provenance: provenanceB,
      }),
    ]);

    await Promise.all([
      queue.enqueue(`process-video-${assetIdA}-${Date.now()}`, {
        type: "process_video",
        videoPath: outputPathA,
        assetId: assetIdA,
        assetDir: assetDirA,
        projectSlug,
        provenance: provenanceA,
      } as unknown as Record<string, unknown>),
      queue.enqueue(`process-video-${assetIdB}-${Date.now() + 1}`, {
        type: "process_video",
        videoPath: outputPathB,
        assetId: assetIdB,
        assetDir: assetDirB,
        projectSlug,
        provenance: provenanceB,
      } as unknown as Record<string, unknown>),
    ]);

    return { success: true, chunk_a: assetIdA, chunk_b: assetIdB };
  });
}
