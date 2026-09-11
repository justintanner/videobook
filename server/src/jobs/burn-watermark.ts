import { rm } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Engine } from "videobook-engine";
import { AUDIO_OPTS, H264_MEDIUM, probeVideo, runFfmpeg } from "../ffmpeg.js";
import type { ProbeResult } from "../ffmpeg.js";
import { logger } from "../logger.js";
import { queue, registerJobHandler } from "../queue.js";
import {
  scoreWatermarkCornersForCanvas,
  WATERMARK_MIN_DIM_FRACTION,
  WATERMARK_OPACITY,
} from "../remotion/osg-spec.js";
import type { OsgPosition } from "../remotion/subtitles/types.js";
import {
  BADGE_WIDTH,
  DEFAULT_HANDLE_PADDING,
  HANDLE_ONLY_BADGE_HEIGHT,
  handlePillHeight,
} from "../watermark-badge.js";
import {
  DEFAULT_HANDLE_VERTICAL_PERCENT,
  watermarkHandleOverlayPosition,
} from "../watermark-handle-position.js";
import type { WatermarkHandlePlacement } from "../watermark-handle-position.js";
import { analyzeOsgPlacement } from "./osg-placement.js";
import { replaceArtifactFileFromPath } from "./_persist-output.js";
import { withLockedLocalLease } from "./_lease.js";
import { effectiveWatermarkTiming } from "../watermark-timing.js";

const LOCK_DURATION_MS = 600_000;

/** Fade applied at a watermark edge that falls inside the clip. */
export const DEFAULT_WATERMARK_FADE_SECONDS = 0.5;
export const MAX_WATERMARK_FADE_SECONDS = 2;
/** Extra looped badge frames past the last fade so overlay never runs dry mid-ramp. */
const LOOP_MARGIN_SECONDS = 0.25;
/** Ends this close to the clip end count as "whole clip": no fade out. */
const CLIP_END_TOLERANCE_SECONDS = 0.001;

export type WatermarkPlacementSource =
  | "cached"
  | "vision"
  | "analysis"
  | "default"
  | "explicit"
  | "fixed";

/** Frame-aware corner pick deferred into the job so the tool can return early. */
export type BurnWatermarkPlacementRequest = {
  fingerprint: string;
  badgeAspect: number;
};

export type BurnWatermarkPayload = {
  type: "burn_watermark";
  assetId: string;
  assetDir: string;
  bookId: string;
  videoPath: string;
  qrPath?: string;
  handlePath?: string;
  corner: OsgPosition;
  placementSource?: WatermarkPlacementSource;
  placement?: BurnWatermarkPlacementRequest;
  opacity?: number;
  qrOpacity?: number;
  handleOpacity?: number;
  userScale: number;
  handleVerticalPercent?: number;
  handlePlacement?: WatermarkHandlePlacement;
  handlePaddingY?: number;
  fadeSeconds?: number;
  startSeconds?: number;
  endSeconds?: number;
  qrStartSeconds?: number;
  qrEndSeconds?: number;
  handleStartSeconds?: number;
  handleEndSeconds?: number;
};

export type BurnWatermarkResult = {
  success: true;
  corner: OsgPosition;
  placementSource: WatermarkPlacementSource;
};

type BurnWatermarkFades = {
  fadeIn: number;
  fadeOut: number;
};

const NO_FADES: BurnWatermarkFades = { fadeIn: 0, fadeOut: 0 };

function roundSeconds(value: number): number {
  return Math.round(value * 1000) / 1000;
}

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

/**
 * Fade lengths for one watermark window. A watermark fades in only when it
 * starts after the clip start and out only when it ends before the clip end,
 * so a whole-clip watermark keeps hard edges. Fades shrink to half the window
 * so a short window still reaches full opacity in the middle.
 */
export function burnWatermarkFades(
  startSeconds: number | undefined,
  endSeconds: number | undefined,
  durationSeconds: number,
  fadeSeconds: number,
): BurnWatermarkFades {
  const start = Math.max(0, startSeconds ?? 0);
  const clipEnd = endSeconds === undefined
    ? durationSeconds
    : Math.min(endSeconds, durationSeconds);
  const window = clipEnd - start;
  if (!(fadeSeconds > 0) || !(window > 0)) return NO_FADES;
  const fade = roundSeconds(Math.min(fadeSeconds, window / 2));
  const endsEarly = endSeconds !== undefined
    && endSeconds < durationSeconds - CLIP_END_TOLERANCE_SECONDS;
  return {
    fadeIn: start > 0 ? fade : 0,
    fadeOut: endsEarly ? fade : 0,
  };
}

/**
 * Alpha fades appended to a badge input chain. The badge input must be a
 * timed stream (see `burnWatermarkInputArgs`) for the fade timestamps to
 * line up with the main video.
 */
function burnWatermarkFadeFilters(
  fades: BurnWatermarkFades,
  startSeconds: number | undefined,
  endSeconds: number | undefined,
): string {
  const parts: string[] = [];
  if (fades.fadeIn > 0) {
    parts.push(`fade=t=in:st=${startSeconds ?? 0}:d=${fades.fadeIn}:alpha=1`);
  }
  if (fades.fadeOut > 0 && endSeconds !== undefined) {
    parts.push(`fade=t=out:st=${roundSeconds(endSeconds - fades.fadeOut)}:d=${fades.fadeOut}:alpha=1`);
  }
  return parts.map((part) => `,${part}`).join("");
}

/**
 * How long the looped badge stream must run for its fades to complete: past
 * the last ramp the badge is static, and overlay repeats the final frame for
 * the rest of the clip. Null when the badge needs no fades and a single still
 * frame does.
 */
export function burnWatermarkLoopSeconds(
  fades: BurnWatermarkFades,
  startSeconds: number | undefined,
  endSeconds: number | undefined,
  durationSeconds: number,
): number | null {
  if (fades.fadeIn === 0 && fades.fadeOut === 0) return null;
  const settledAt = fades.fadeOut > 0 && endSeconds !== undefined
    ? endSeconds
    : (startSeconds ?? 0) + fades.fadeIn;
  return roundSeconds(Math.min(durationSeconds, settledAt + LOOP_MARGIN_SECONDS));
}

/** Input args for one badge image: a still frame, or a timed loop when it fades. */
export function burnWatermarkInputArgs(
  path: string,
  loopSeconds: number | null,
  frameRate: string,
): string[] {
  return loopSeconds === null
    ? ["-i", path]
    : ["-loop", "1", "-framerate", frameRate, "-t", String(loopSeconds), "-i", path];
}

function burnWatermarkFrameRate(probe: ProbeResult): string {
  const nominal = probe.videoStream?.video?.nominalFrameRate;
  if (nominal && nominal.numerator > 0 && nominal.denominator > 0) {
    return `${nominal.numerator}/${nominal.denominator}`;
  }
  return String(roundSeconds(probe.fps > 0 ? probe.fps : 30));
}

export function buildBurnWatermarkFilter(options: {
  width: number;
  height: number;
  corner: OsgPosition;
  opacity?: number;
  qrOpacity?: number;
  handleOpacity?: number;
  userScale: number;
  includeQr: boolean;
  includeHandle: boolean;
  handleVerticalPercent?: number;
  handlePlacement?: WatermarkHandlePlacement;
  handlePaddingY?: number;
  durationSeconds?: number;
  fadeSeconds?: number;
  startSeconds?: number;
  endSeconds?: number;
  qrStartSeconds?: number;
  qrEndSeconds?: number;
  handleStartSeconds?: number;
  handleEndSeconds?: number;
}): string {
  const minDim = Math.min(options.width, options.height);
  const badgeHeight = Math.max(
    2,
    2 * Math.round((minDim * WATERMARK_MIN_DIM_FRACTION * options.userScale) / 2),
  );
  const padding = Math.round(options.width * 0.02);
  const { x, y } = burnOverlayPosition(options.corner, padding);
  const handlePlacement = options.includeQr && options.handlePlacement
    ? options.handlePlacement
    : "center";
  const attachedToQr = handlePlacement !== "center";
  const handleBadgeHeight = handlePillHeight(options.handlePaddingY ?? DEFAULT_HANDLE_PADDING);
  const independentHandleHeight = Math.max(
    2,
    2 * Math.round((badgeHeight * handleBadgeHeight / HANDLE_ONLY_BADGE_HEIGHT) / 2),
  );
  const attachedHandleHeight = Math.max(
    2,
    Math.round(badgeHeight * handleBadgeHeight / BADGE_WIDTH),
  );
  const handleScale = attachedToQr
    ? `${badgeHeight}:-2`
    : `-2:${independentHandleHeight}`;
  const handleOverlay = watermarkHandleOverlayPosition({
    placement: handlePlacement,
    corner: options.corner,
    canvasWidth: options.width,
    canvasHeight: options.height,
    qrSize: badgeHeight,
    handleWidth: attachedToQr
      ? badgeHeight
      : Math.round(independentHandleHeight * BADGE_WIDTH / handleBadgeHeight),
    handleHeight: attachedToQr ? attachedHandleHeight : independentHandleHeight,
    padding,
    handleVerticalPercent: options.handleVerticalPercent ?? DEFAULT_HANDLE_VERTICAL_PERCENT,
  });
  const sharedOpacity = options.opacity ?? WATERMARK_OPACITY;
  const qrOpacity = options.qrOpacity ?? sharedOpacity;
  const handleOpacity = options.handleOpacity ?? sharedOpacity;
  const qrStart = options.qrStartSeconds ?? options.startSeconds;
  const qrEnd = options.qrEndSeconds ?? options.endSeconds;
  const handleStart = options.handleStartSeconds ?? options.startSeconds;
  const handleEnd = options.handleEndSeconds ?? options.endSeconds;
  const fadesFor = (start?: number, end?: number): BurnWatermarkFades =>
    options.durationSeconds !== undefined && options.fadeSeconds !== undefined
      ? burnWatermarkFades(start, end, options.durationSeconds, options.fadeSeconds)
      : NO_FADES;
  const qrFade = burnWatermarkFadeFilters(fadesFor(qrStart, qrEnd), qrStart, qrEnd);
  const handleFade = burnWatermarkFadeFilters(
    fadesFor(handleStart, handleEnd),
    handleStart,
    handleEnd,
  );
  const qrEnable = burnWatermarkEnable(qrStart, qrEnd);
  const handleEnable = burnWatermarkEnable(handleStart, handleEnd);
  const handleInput = options.includeQr ? 2 : 1;
  if (!options.includeQr && !options.includeHandle) {
    throw new Error("QR or handle watermark input is required");
  }
  const filters: string[] = [];
  if (options.includeQr) {
    filters.push(`[1:v]scale=-2:${badgeHeight},format=rgba,colorchannelmixer=aa=${qrOpacity}${qrFade}[qr]`);
  }
  if (options.includeHandle) {
    filters.push(`[${handleInput}:v]scale=${handleScale},format=rgba,colorchannelmixer=aa=${handleOpacity}${handleFade}[handle]`);
  }
  if (options.includeQr) {
    const output = options.includeHandle ? "withqr" : "vout";
    filters.push(`[0:v][qr]overlay=${x}:${y}:format=auto${qrEnable}[${output}]`);
  }
  if (options.includeHandle) {
    const base = options.includeQr ? "withqr" : "0:v";
    filters.push(
      `[${base}][handle]overlay=${handleOverlay.x}:${handleOverlay.y}:format=auto${handleEnable}[vout]`,
    );
  }
  return filters.join(";");
}

function badgeInputArgs(
  path: string,
  timing: ReturnType<typeof effectiveWatermarkTiming>,
  probe: ProbeResult,
  fadeSeconds: number,
): string[] {
  const fades = burnWatermarkFades(
    timing.startSeconds,
    timing.endSeconds,
    probe.videoDuration,
    fadeSeconds,
  );
  const loopSeconds = burnWatermarkLoopSeconds(
    fades,
    timing.startSeconds,
    timing.endSeconds,
    probe.videoDuration,
  );
  return burnWatermarkInputArgs(path, loopSeconds, burnWatermarkFrameRate(probe));
}

/**
 * Resolve the QR corner inside the job: a deferred vision pass when the tool
 * asked for one, otherwise the corner the tool already settled on. Vision
 * failures degrade to the tool's fallback rather than failing the burn.
 */
async function resolveBurnCorner(
  engine: Engine,
  payload: BurnWatermarkPayload,
  probe: ProbeResult,
  signal: AbortSignal,
): Promise<{ corner: OsgPosition; placementSource: WatermarkPlacementSource }> {
  const fallback = {
    corner: payload.corner,
    placementSource: payload.placementSource ?? "explicit",
  };
  if (!payload.placement) return fallback;
  try {
    const analysis = await analyzeOsgPlacement(engine, {
      assetId: payload.assetId,
      fingerprint: payload.placement.fingerprint,
      userScale: payload.userScale,
      badgeAspect: payload.placement.badgeAspect,
      signal,
    });
    // Score corners against the source frame itself — a burned watermark
    // lives in source pixels, so one corner serves every orientation.
    const corner = scoreWatermarkCornersForCanvas(probe.width, probe.height, analysis.regions, {
      aspect: payload.placement.badgeAspect,
      userScale: payload.userScale,
    }).position;
    return { corner, placementSource: "vision" };
  } catch (err) {
    signal.throwIfAborted();
    logger.warn("watermark-placement-fallback", { assetId: payload.assetId, error: err });
    return fallback;
  }
}

/**
 * Composite the watermark badge onto the source video: scaled to the min-dim
 * fraction the render-time overlay uses, faded to `opacity`, anchored at
 * `corner` with the standard edge padding, and faded in/out at any edge that
 * falls inside the clip. Mirrors the trim/crop shape: replace the canonical
 * file in place, drop stale visual analysis, reprocess.
 */
export function registerBurnWatermarkJob(engine: Engine): void {
  registerJobHandler("burn_watermark", async (rawPayload, ctx) => {
    const payload = rawPayload as BurnWatermarkPayload;
    const {
      assetId, assetDir, bookId, videoPath, qrPath, handlePath, opacity, userScale,
      qrOpacity, handleOpacity, handleVerticalPercent = DEFAULT_HANDLE_VERTICAL_PERCENT,
      handlePlacement = "center", handlePaddingY = DEFAULT_HANDLE_PADDING,
      fadeSeconds = DEFAULT_WATERMARK_FADE_SECONDS,
      startSeconds, endSeconds, qrStartSeconds, qrEndSeconds,
      handleStartSeconds, handleEndSeconds,
    } = payload;

    const result = await withLockedLocalLease(
      engine,
      assetId,
      assetDir,
      ctx,
      "process",
      { durationMs: LOCK_DURATION_MS, data: { state: "burning-watermark" } },
      async () => {
        const probe = await probeVideo(videoPath, { signal: ctx.signal });
        const handleTiming = handlePath
          ? effectiveWatermarkTiming(
              "Handle watermark",
              probe.videoDuration,
              handleStartSeconds ?? startSeconds,
              handleEndSeconds ?? endSeconds,
            )
          : {};
        const qrTiming = qrPath
          ? effectiveWatermarkTiming(
              "QR watermark",
              probe.videoDuration,
              qrStartSeconds ?? startSeconds,
              qrEndSeconds ?? endSeconds,
            )
          : {};
        const placement = await resolveBurnCorner(engine, payload, probe, ctx.signal);

        const outputPath = join(assetDir, "original_watermarked.mp4");
        const filter = buildBurnWatermarkFilter({
          width: probe.width,
          height: probe.height,
          corner: placement.corner,
          opacity,
          qrOpacity,
          handleOpacity,
          userScale,
          includeQr: qrPath !== undefined,
          includeHandle: handlePath !== undefined,
          handleVerticalPercent,
          handlePlacement,
          handlePaddingY,
          durationSeconds: probe.videoDuration,
          fadeSeconds,
          ...(qrTiming.startSeconds !== undefined
            ? { qrStartSeconds: qrTiming.startSeconds }
            : {}),
          ...(qrTiming.endSeconds !== undefined
            ? { qrEndSeconds: qrTiming.endSeconds }
            : {}),
          ...(handleTiming.startSeconds !== undefined
            ? { handleStartSeconds: handleTiming.startSeconds }
            : {}),
          ...(handleTiming.endSeconds !== undefined
            ? { handleEndSeconds: handleTiming.endSeconds }
            : {}),
        });
        const watermarkInputs = [
          ...(qrPath ? badgeInputArgs(qrPath, qrTiming, probe, fadeSeconds) : []),
          ...(handlePath ? badgeInputArgs(handlePath, handleTiming, probe, fadeSeconds) : []),
        ];
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

        return { videoPath: join(assetDir, inputFilename), placement };
      },
      { durationMs: LOCK_DURATION_MS, waitForActiveMs: 30_000 },
    );

    // The badge now lives in the pixels. The forced reprocess drops every
    // stored render-time overlay setting, so a later render can't stamp it
    // twice.
    await queue.enqueue(`process-video-${assetId}-${Date.now()}`, {
      type: "process_video",
      videoPath: result.videoPath,
      assetId,
      assetDir,
      bookId,
      provenance: { origin: "watermark", watermarked_at: new Date().toISOString() },
      force: true,
    } as unknown as Record<string, unknown>);

    return {
      success: true,
      corner: result.placement.corner,
      placementSource: result.placement.placementSource,
    } satisfies BurnWatermarkResult;
  });
}
