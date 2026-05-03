import type { ClipfirstFs } from "clipfirst-engine";
import { rm } from "node:fs/promises";
import { registerJobHandler, queue } from "../queue.js";
import { trimRange, assertSaneTrimOutput } from "./trim-video.js";

type EvenSplitChunkPayload = {
  assetId: string;
  assetDir: string;
  outputPath: string;
  start: number;
  end: number;
  duration: number;
};

type EvenSplitPayload = {
  type: "even_split";
  sourcePath: string;
  sourceAssetId: string;
  chunks: EvenSplitChunkPayload[];
  projectSlug: string;
};

async function buildChunk(
  fs: ClipfirstFs,
  args: {
    sourcePath: string;
    outputPath: string;
    start: number;
    end: number;
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

export function registerEvenSplitJob(fs: ClipfirstFs): void {
  registerJobHandler("even_split", async (payload) => {
    const { sourcePath, sourceAssetId, chunks, projectSlug } = payload as EvenSplitPayload;
    const splitAtIso = new Date().toISOString();

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
      return buildChunk(fs, {
        sourcePath,
        outputPath: chunk.outputPath,
        start: chunk.start,
        end: chunk.end,
        assetId: chunk.assetId,
        projectSlug,
        provenance,
      });
    });
    await Promise.all(buildPromises);

    await Promise.all(chunks.map((chunk, i) =>
      queue.enqueue(`process-video-${chunk.assetId}-${Date.now() + i}`, {
        type: "process_video",
        videoPath: chunk.outputPath,
        assetId: chunk.assetId,
        assetDir: chunk.assetDir,
        projectSlug,
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
