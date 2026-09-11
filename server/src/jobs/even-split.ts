import type { Engine } from "videobook-engine";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { registerJobHandler, queue, type JobHandlerContext } from "../queue.js";
import { trimRange, trimRangeExact, assertSaneTrimOutput } from "./trim-video.js";
import { ingestWorkspaceOutputs } from "./_persist-output.js";
import { validateMediaOutputPaths, withMediaOutputLock } from "../media-output-path.js";

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
  bookId: string;
  /**
   * When set, every chunk in `chunks` shares this destination asset and was
   * written into it as a sibling file (no per-chunk asset minted). The job
   * skips per-chunk metadata + process_video enqueue and emits a single
   * commitOperation on the destination asset after all writes finish.
   */
  destination?: { assetId: string };
};

async function buildChunk(
  engine: Engine,
  args: {
    sourcePath: string;
    outputPath: string;
    start: number;
    end: number;
    assetId: string;
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
  const { sourcePath, outputPath, start, end, assetId, provenance, exact, skipMetadata } = args;
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
    await ingestWorkspaceOutputs(
      engine,
      assetId,
      [outputPath.split("/").pop()!],
      "even_split_chunk",
      provenance,
    );
    await engine.metadata.artifacts.write(assetId, "original", provenance);
  }
}

async function splitIntoDestination(
  engine: Engine,
  payload: EvenSplitPayload,
  ctx: JobHandlerContext,
) {
  const assetId = payload.destination!.assetId;
  const manifest = await engine.files.manifest(assetId);
  if (!manifest.ok) throw new Error(manifest.error.message);
  const assetDir = manifest.value.path;
  return withMediaOutputLock(engine, assetDir, ctx.signal, async () => {
    const filenames = await validateMediaOutputPaths(engine, assetId, payload.chunks.map((chunk) => relative(assetDir, chunk.outputPath)), ".mp4");
    const workspace = await mkdtemp(join(tmpdir(), "videobook-split-destination-"));
    try {
      const outputs = payload.chunks.map((_, index) => join(workspace, `${index}.mp4`));
      const built = await Promise.allSettled(payload.chunks.map((chunk, index) => buildChunk(engine, {
        sourcePath: payload.sourcePath,
        outputPath: outputs[index],
        start: chunk.start,
        end: chunk.end,
        assetId,
        provenance: {},
        exact: chunk.exact,
        skipMetadata: true,
      })));
      const failed = built.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
      ctx.signal?.throwIfAborted();
      for (const [index, filename] of filenames.entries()) {
        const written = await engine.files.writeFromPath(assetId, filename, outputs[index]);
        if (!written.ok) throw new Error(written.error.message);
      }
      const recorded = await engine.history.recordOperation("even_split", assetId, {
        source_asset_id: payload.sourceAssetId,
        filenames,
        chunk_count: payload.chunks.length,
        split_at_iso: new Date().toISOString(),
      });
      if (!recorded.ok) throw new Error(recorded.error.message);
      return { success: true, destination_asset_id: assetId, filenames };
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
}

export function registerEvenSplitJob(engine: Engine): void {
  registerJobHandler("even_split", async (payload, ctx) => {
    const { sourcePath, sourceAssetId, chunks, bookId, destination } = payload as EvenSplitPayload;
    if (destination) return splitIntoDestination(engine, payload as EvenSplitPayload, ctx);
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
      // Targeted chunks need exact-second container duration; the trailing
      // leftover does not (and the user explicitly doesn't care).
      return buildChunk(engine, {
        sourcePath,
        outputPath: chunk.outputPath,
        start: chunk.start,
        end: chunk.end,
        assetId: chunk.assetId,
        provenance,
        exact: chunk.exact,
      });
    });
    await Promise.all(buildPromises);

    await Promise.all(chunks.map((chunk, i) =>
      queue.enqueueAndWait(`process-video-${chunk.assetId}-${Date.now() + i}`, {
        type: "process_video",
        videoPath: chunk.outputPath,
        assetId: chunk.assetId,
        assetDir: chunk.assetDir,
        bookId,
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
