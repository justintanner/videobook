import { rm } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Engine } from "videobook-engine";
import { AUDIO_OPTS, H264_MEDIUM, probeVideo, runFfmpeg } from "../ffmpeg.js";
import { queue, registerJobHandler } from "../queue.js";
import { WATERMARK_MIN_DIM_FRACTION } from "../remotion/osg-spec.js";
import type { OsgPosition } from "../remotion/subtitles/types.js";
import { replaceArtifactFileFromPath } from "./_persist-output.js";
import { withLockedLocalLease } from "./_lease.js";

const LOCK_DURATION_MS = 600_000;

type BurnWatermarkPayload = {
  type: "burn_watermark";
  assetId: string;
  assetDir: string;
  bookId: string;
  videoPath: string;
  badgePath: string;
  corner: OsgPosition;
  opacity: number;
  userScale: number;
};

/** ffmpeg overlay x/y expressions for a corner, inset by `padding` pixels. */
function burnOverlayPosition(corner: OsgPosition, padding: number): { x: string; y: string } {
  const [vertical, horizontal] = corner.split("-");
  const x = horizontal === "left"
    ? String(padding)
    : horizontal === "right"
      ? `main_w-overlay_w-${padding}`
      : "(main_w-overlay_w)/2";
  const y = vertical === "top"
    ? String(padding)
    : vertical === "bottom"
      ? `main_h-overlay_h-${padding}`
      : "(main_h-overlay_h)/2";
  return { x, y };
}

/**
 * Composite the watermark badge onto the source video: scaled to the min-dim
 * fraction the render-time overlay uses, faded to `opacity`, anchored at
 * `corner` with the standard edge padding. Mirrors the trim/crop shape:
 * replace the canonical file in place, drop stale visual analysis, reprocess.
 */
export function registerBurnWatermarkJob(engine: Engine): void {
  registerJobHandler("burn_watermark", async (payload, ctx) => {
    const {
      assetId, assetDir, bookId, videoPath, badgePath, corner, opacity, userScale,
    } = payload as BurnWatermarkPayload;

    const result = await withLockedLocalLease(
      engine,
      assetId,
      assetDir,
      ctx,
      "process",
      { durationMs: LOCK_DURATION_MS, data: { state: "burning-watermark" } },
      async () => {
        const probe = await probeVideo(videoPath, { signal: ctx.signal });
        const minDim = Math.min(probe.width, probe.height);
        // Even height keeps libx264-friendly dimensions on the scaled badge.
        const badgeHeight = Math.max(2, 2 * Math.round((minDim * WATERMARK_MIN_DIM_FRACTION * userScale) / 2));
        const padding = Math.round(probe.width * 0.02);
        const { x, y } = burnOverlayPosition(corner, padding);

        const outputPath = join(assetDir, "original_watermarked.mp4");
        const filter = [
          `[1:v]scale=-2:${badgeHeight},format=rgba,colorchannelmixer=aa=${opacity}[wm]`,
          `[0:v][wm]overlay=${x}:${y}:format=auto[vout]`,
        ].join(";");
        try {
          await runFfmpeg([
            "-y",
            "-i", videoPath,
            "-i", badgePath,
            "-filter_complex", filter,
            "-map", "[vout]",
            "-map", "0:a?",
            ...H264_MEDIUM,
            "-pix_fmt", "yuv420p",
            ...AUDIO_OPTS,
            outputPath,
          ], { signal: ctx.signal });

          const check = await probeVideo(outputPath, { signal: ctx.signal });
          if (check.width !== probe.width || check.height !== probe.height
            || Math.abs(check.duration - probe.duration) > 0.5) {
            throw new Error(
              `Watermarked output looks wrong: ${check.width}x${check.height} ${check.duration.toFixed(2)}s`
              + ` from ${probe.width}x${probe.height} ${probe.duration.toFixed(2)}s`,
            );
          }
        } catch (err) {
          await rm(outputPath, { force: true });
          throw err;
        }

        const inputFilename = basename(videoPath);
        await replaceArtifactFileFromPath(engine, assetId, inputFilename, outputPath);

        // Visual analysis now describes the un-watermarked frames; transcripts
        // stay valid (audio and timing are untouched).
        await engine.files.delete(assetId, ".original.analysis.json");

        return { videoPath: join(assetDir, inputFilename) };
      },
      { durationMs: LOCK_DURATION_MS, waitForActiveMs: 30_000 },
    );

    await queue.enqueue(`process-video-${assetId}-${Date.now()}`, {
      type: "process_video",
      videoPath: result.videoPath,
      assetId,
      assetDir,
      bookId,
      provenance: { origin: "watermark", watermarked_at: new Date().toISOString() },
      force: true,
    } as unknown as Record<string, unknown>);

    return { success: true };
  });
}
