import type { Engine } from "videobook-engine";
import { join, basename } from "node:path";
import { registerJobHandler, queue } from "../queue.js";
import { probeVideo } from "../ffmpeg.js";
import { cutFrameAlignedRanges } from "../notebook-media-ops.js";
import type { VideoRange } from "../video-cut-ranges.js";
import { withLockedLocalLease } from "./_lease.js";
import { replaceArtifactFileFromPath } from "./_persist-output.js";
import { SOUND_SIDECARS } from "../stale-sidecars.js";

const LOCK_DURATION_MS = 600_000;

type Cut = { cut_start: number; cut_end: number };

type ApplyCutsPayload = {
  type: "apply_cuts";
  inputPath: string;
  outputPath: string;
  cuts: Cut[];
  duration: number;
  assetId: string;
  assetDir: string;
  bookId: string;
};

function buildKeepSegments(cuts: Cut[], duration: number): VideoRange[] {
  const keeps: VideoRange[] = [];
  let cursor = 0;
  for (const c of cuts) {
    if (c.cut_start > cursor) keeps.push({ startSeconds: cursor, endSeconds: c.cut_start });
    cursor = c.cut_end;
  }
  if (cursor < duration) keeps.push({ startSeconds: cursor, endSeconds: duration });
  return keeps;
}

export function registerApplyCutsJob(engine: Engine): void {
  registerJobHandler("apply_cuts", async (payload, ctx) => {
    const {
      inputPath, outputPath, cuts, duration,
      assetId, assetDir, bookId,
    } = payload as ApplyCutsPayload;

    const result = await withLockedLocalLease(
      engine,
      assetId,
      assetDir,
      ctx,
      "apply_cuts",
      { durationMs: LOCK_DURATION_MS, data: { state: "cutting" } },
      async () => {
      const effectiveDuration = duration > 0 ? duration : (await probeVideo(inputPath)).duration;
      const keeps = buildKeepSegments(cuts, effectiveDuration);
      if (keeps.length === 0) {
        throw new Error("Cuts cover entire video — nothing left to keep.");
      }

      await cutFrameAlignedRanges(assetId, inputPath, keeps, outputPath);

      const inputFilename = basename(inputPath);
      await replaceArtifactFileFromPath(
        engine,
        assetId,
        inputFilename,
        outputPath,
      );

      for (const stale of SOUND_SIDECARS) {
        await engine.files.delete(assetId, stale);
      }

      const newVideoPath = join(assetDir, inputFilename);
      return { newVideoPath, keptSegments: keeps.length };
      },
      { durationMs: LOCK_DURATION_MS, waitForActiveMs: 30_000 },
    );

    await queue.enqueue(`process-video-${assetId}-${Date.now()}`, {
      type: "process_video",
      videoPath: result.newVideoPath,
      assetId,
      assetDir,
      bookId,
      provenance: {
        origin: "apply_cuts",
        cuts,
        applied_at: new Date().toISOString(),
      },
      force: true,
    } as unknown as Record<string, unknown>);

    return { success: true, kept_segments: result.keptSegments };
  });
}
