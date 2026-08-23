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
  qrPath?: string;
  handlePath: string;
  corner: OsgPosition;
  opacity: number;
  userScale: number;
  startSeconds?: number;
  endSeconds?: number;
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

export function burnWatermarkEnable(
  startSeconds?: number,
  endSeconds?: number,
): string {
  if (startSeconds === undefined && endSeconds === undefined) return "";
  const start = startSeconds ?? 0;
  return endSeconds === undefined
    ? `:enable='gte(t,${start})'`
    : `:enable='between(t,${start},${endSeconds})'`;
}

export function buildBurnWatermarkFilter(options: {
  width: number;
  height: number;
  corner: OsgPosition;
  opacity: number;
  userScale: number;
  includeQr: boolean;
  startSeconds?: number;
  endSeconds?: number;
}): string {
  const minDim = Math.min(options.width, options.height);
  const badgeHeight = Math.max(
    2,
    2 * Math.round((minDim * WATERMARK_MIN_DIM_FRACTION * options.userScale) / 2),
  );
  const padding = Math.round(options.width * 0.02);
  const { x, y } = burnOverlayPosition(options.corner, padding);
  const enable = burnWatermarkEnable(options.startSeconds, options.endSeconds);
  const handleInput = options.includeQr ? 2 : 1;
  const filters = options.includeQr
    ? [
        `[1:v]scale=-2:${badgeHeight},format=rgba,colorchannelmixer=aa=${options.opacity}[qr]`,
        `[${handleInput}:v]scale=-2:${badgeHeight},format=rgba,colorchannelmixer=aa=${options.opacity}[handle]`,
        `[0:v][qr]overlay=${x}:${y}:format=auto${enable}[withqr]`,
      ]
    : [
        `[${handleInput}:v]scale=-2:${badgeHeight},format=rgba,colorchannelmixer=aa=${options.opacity}[handle]`,
      ];
  const base = options.includeQr ? "withqr" : "0:v";
  filters.push(
    `[${base}][handle]overlay=(main_w-overlay_w)/2:main_h/3-overlay_h/2:format=auto${enable}[vout]`,
  );
  return filters.join(";");
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
      assetId, assetDir, bookId, videoPath, qrPath, handlePath, corner, opacity, userScale,
      startSeconds, endSeconds,
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
        const effectiveStart = startSeconds ?? 0;
        if (effectiveStart < 0 || effectiveStart >= probe.duration) {
          throw new Error(`Watermark start must be before the ${probe.duration.toFixed(2)}s clip end`);
        }
        const effectiveEnd = endSeconds === undefined
          ? undefined
          : Math.min(endSeconds, probe.duration);
        if (effectiveEnd !== undefined && effectiveEnd <= effectiveStart) {
          throw new Error("Watermark end must be after its start");
        }

        const outputPath = join(assetDir, "original_watermarked.mp4");
        const filter = buildBurnWatermarkFilter({
          width: probe.width,
          height: probe.height,
          corner,
          opacity,
          userScale,
          includeQr: qrPath !== undefined,
          ...(startSeconds !== undefined ? { startSeconds } : {}),
          ...(effectiveEnd !== undefined ? { endSeconds: effectiveEnd } : {}),
        });
        const watermarkInputs = qrPath
          ? ["-i", qrPath, "-i", handlePath]
          : ["-i", handlePath];
        try {
          await runFfmpeg([
            "-y",
            "-i", videoPath,
            ...watermarkInputs,
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
