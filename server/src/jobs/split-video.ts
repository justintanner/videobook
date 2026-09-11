import type { Engine } from "videobook-engine";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerJobHandler, queue } from "../queue.js";
import { assertSaneTrimOutput } from "./trim-video.js";
import { AUDIO_OPTS, H264_MEDIUM, probeVideo, runFfmpeg } from "../ffmpeg.js";

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
  bookId: string;
};

async function buildChunk(
  engine: Engine,
  args: {
    sourcePath: string;
    outputPath: string;
    start: number | undefined;
    end: number | undefined;
    assetId: string;
    provenance: Record<string, unknown>;
  },
): Promise<void> {
  const { sourcePath, outputPath, start, end, assetId, provenance } = args;
  const workspace = await mkdtemp(join(tmpdir(), "videobook-split-video-"));
  const tempPath = join(workspace, "output.mp4");
  try {
    const startTime = start ?? 0;
    const endTime = end ?? (await probeVideo(sourcePath)).videoDuration;
    await runFfmpeg([
      "-y", "-ss", String(startTime), "-i", sourcePath,
      "-t", String(endTime - startTime),
      "-map", "0:v:0", "-map", "0:a:0?",
      ...H264_MEDIUM, ...AUDIO_OPTS, "-movflags", "+faststart", tempPath,
    ]);
    await assertSaneTrimOutput(sourcePath, tempPath);
    const written = await engine.files.writeFromPath(assetId, outputPath.split("/").pop()!, tempPath);
    if (!written.ok) throw new Error(written.error.message);
    const recorded = await engine.history.recordOperation("split_video", assetId, provenance);
    if (!recorded.ok) throw new Error(recorded.error.message);
    const metadata = await engine.metadata.artifacts.write(assetId, "original", provenance);
    if (!metadata.ok) throw new Error(metadata.error.message);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

export function registerSplitVideoJob(engine: Engine): void {
  // The destination assets are brand-new, so no other job can hold a lease on
  // them; we run the two chunks in parallel against the read-only source.
  registerJobHandler("split_video", async (payload) => {
    const {
      sourcePath, sourceAssetId,
      chunkAEnd, chunkBStart,
      assetIdA, assetDirA, outputPathA,
      assetIdB, assetDirB, outputPathB,
      bookId,
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
      buildChunk(engine, {
        sourcePath, outputPath: outputPathA,
        start: undefined, end: chunkAEnd,
        assetId: assetIdA,
        provenance: provenanceA,
      }),
      buildChunk(engine, {
        sourcePath, outputPath: outputPathB,
        start: chunkBStart, end: undefined,
        assetId: assetIdB,
        provenance: provenanceB,
      }),
    ]);

    // Both chunk media files already exist on disk at this point. Enqueue each
    // process_video job independently (allSettled, not all): if one enqueue
    // fails we must not abandon the other chunk's already-built media. Any
    // chunk whose job fails to land is flagged as a recoverable error instead
    // of being silently orphaned.
    const chunks = [
      {
        label: "a",
        jobId: `process-video-${assetIdA}-${Date.now()}`,
        assetId: assetIdA,
        assetDir: assetDirA,
        videoPath: outputPathA,
        provenance: provenanceA,
      },
      {
        label: "b",
        jobId: `process-video-${assetIdB}-${Date.now() + 1}`,
        assetId: assetIdB,
        assetDir: assetDirB,
        videoPath: outputPathB,
        provenance: provenanceB,
      },
    ];

    const results = await Promise.allSettled(
      chunks.map((c) =>
        queue.enqueue(c.jobId, {
          type: "process_video",
          videoPath: c.videoPath,
          assetId: c.assetId,
          assetDir: c.assetDir,
          bookId,
          provenance: c.provenance,
        } as unknown as Record<string, unknown>),
      ),
    );

    const failed: string[] = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === "rejected") {
        const c = chunks[i];
        const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
        await engine.jobs.failures.write(c.assetId, {
          message: `split chunk ${c.label} was built but could not be queued for processing: ${reason}`,
          failCode: "split_enqueue_failed",
        });
        failed.push(`chunk ${c.label} (${c.assetId})`);
      }
    }

    if (failed.length > 0) {
      throw new Error(
        `split_video: failed to enqueue ${failed.join(", ")} for processing; ` +
          `affected chunk(s) flagged as recoverable`,
      );
    }

    return { success: true, chunk_a: assetIdA, chunk_b: assetIdB };
  });
}
