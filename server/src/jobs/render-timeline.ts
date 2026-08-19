import type { Engine } from "videobook-engine";
import { join } from "node:path";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { registerJobHandler } from "../queue.js";
import { runFfmpeg, probeVideo, AUDIO_OPTS, H264_MEDIUM } from "../ffmpeg.js";
import { withLockedLocalLease } from "./_lease.js";
import { ingestWorkspaceOutputs } from "./_persist-output.js";

const LOCK_DURATION_MS = 1_800_000;

const LANDSCAPE_RENDER = "landscape.mp4";
const PORTRAIT_RENDER = "portrait.mp4";
const SQUARE_RENDER = "square.mp4";
const LANDSCAPE_OUTPUT = "timeline_landscape.mp4";
const PORTRAIT_OUTPUT = "timeline_portrait.mp4";
const SQUARE_OUTPUT = "timeline_square.mp4";

type ResolvedSlot = {
  artifactId: string;
  volume: number;
  fadeIn: number;
  fadeOut: number;
  assetDir: string;
};

type ResolvedAudioOverlay = {
  id: string;
  artifactId: string;
  audioPath: string;
  startMs: number;
  durationMs: number;
  volume: number;
  fadeInMs: number;
  fadeOutMs: number;
};

type RenderTimelinePayload = {
  type: "render_timeline";
  bookId: string;
  orientation: "landscape" | "portrait" | "square";
  resolvedSlots: ResolvedSlot[];
  resolvedAudio?: ResolvedAudioOverlay[];
};

export function buildAudioFilter(
  index: number,
  slot: ResolvedSlot,
  duration: number,
  hasAudio = true,
): string {
  const filters: string[] = ["aresample=48000", "aformat=sample_fmts=fltp:channel_layouts=stereo"];
  const vol = slot.volume / 100;
  if (vol !== 1) {
    filters.push(`volume=${vol}`);
  }
  const fadeInSec = slot.fadeIn / 1000;
  if (fadeInSec > 0) {
    filters.push(`afade=t=in:d=${fadeInSec}`);
  }
  const fadeOutSec = slot.fadeOut / 1000;
  if (fadeOutSec > 0) {
    const startTime = Math.max(0, duration - fadeOutSec);
    filters.push(`afade=t=out:st=${startTime}:d=${fadeOutSec}`);
  }
  if (hasAudio) {
    return `[${index}:a:0]${filters.join(",")}[a${index}]`;
  }
  return `anullsrc=channel_layout=stereo:sample_rate=48000,atrim=0:${duration},asetpts=PTS-STARTPTS,${filters.join(",")}[a${index}]`;
}

export type TimelineVideoProbe = {
  fps: number;
  avgFps: number | null;
  width: number;
  height: number;
  videoCodec: string | null;
};

export type TimelineVideoPlan =
  | { mode: "copy" }
  | { mode: "reencode"; targetFps: number; width: number; height: number; reasons: string[] };

// A CFR file's measured average rate matches its nominal rate almost exactly;
// anything beyond this gap means uneven frame timestamps (VFR).
const VFR_TOLERANCE_FPS = 0.1;
const FALLBACK_FPS = 30;

/**
 * Decide whether the timeline concat can stream-copy video. Stream-copying
 * splices packets without touching timestamps, so it is only safe when every
 * input is h264 at the same resolution and the same constant frame rate.
 * Anything else (mixed fps across slots, a VFR input, a stray codec) must be
 * re-encoded to one constant frame rate — otherwise the concatenated output
 * carries uneven timestamps that turn into visible skipping once platforms
 * like X transcode it assuming CFR.
 */
export function planTimelineVideo(probes: TimelineVideoProbe[]): TimelineVideoPlan {
  const first = probes[0];
  const uniformFps = probes.every((p) => Math.round(p.fps) === Math.round(first.fps));
  const reasons: string[] = [];
  if (probes.some((p) => p.videoCodec !== "h264")) reasons.push("non-h264 input");
  if (!uniformFps) reasons.push("mixed frame rates");
  if (probes.some((p) => p.width !== first.width || p.height !== first.height)) {
    reasons.push("mixed resolutions");
  }
  if (probes.some((p) => p.avgFps !== null && Math.abs(p.avgFps - p.fps) > VFR_TOLERANCE_FPS)) {
    reasons.push("variable frame rate input");
  }
  if (reasons.length === 0) return { mode: "copy" };
  return {
    mode: "reencode",
    targetFps: uniformFps ? Math.round(first.fps) || FALLBACK_FPS : FALLBACK_FPS,
    width: first.width,
    height: first.height,
    reasons,
  };
}

function buildReencodeVideoFilter(index: number, plan: { targetFps: number; width: number; height: number }): string {
  const { targetFps, width, height } = plan;
  return (
    `[${index}:v:0]fps=${targetFps},` +
    `scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[v${index}]`
  );
}

/**
 * ffmpeg args for the re-encode path: each slot is its own input, video is
 * normalized to one CFR rate/resolution and concatenated via the concat
 * filter alongside the per-slot audio chains.
 */
export function buildReencodeArgs(opts: {
  inputPaths: string[];
  resolvedSlots: ResolvedSlot[];
  durations: number[];
  hasAudioFlags: boolean[];
  resolvedAudio: ResolvedAudioOverlay[];
  plan: { targetFps: number; width: number; height: number };
  outputPath: string;
}): string[] {
  const { inputPaths, resolvedSlots, durations, hasAudioFlags, resolvedAudio, plan, outputPath } = opts;
  const n = inputPaths.length;
  const hasOverlays = resolvedAudio.length > 0;

  const args: string[] = [];
  for (const p of inputPaths) args.push("-i", p);
  for (const overlay of resolvedAudio) args.push("-i", overlay.audioPath);

  const filterParts: string[] = [];
  for (let i = 0; i < n; i++) {
    filterParts.push(buildReencodeVideoFilter(i, plan));
    filterParts.push(buildAudioFilter(i, resolvedSlots[i], durations[i], hasAudioFlags[i]));
  }
  const concatInputs = Array.from({ length: n }, (_, i) => `[v${i}][a${i}]`).join("");
  const concatAudioLabel = hasOverlays ? "[concatA]" : "[outa]";
  filterParts.push(`${concatInputs}concat=n=${n}:v=1:a=1[outv]${concatAudioLabel}`);

  if (hasOverlays) {
    const overlayLabels: string[] = [];
    resolvedAudio.forEach((overlay, k) => {
      const label = `ov${k}`;
      overlayLabels.push(`[${label}]`);
      filterParts.push(buildOverlayAudioFilter(n + k, overlay, label));
    });
    const mixCount = 1 + overlayLabels.length;
    filterParts.push(
      `[concatA]${overlayLabels.join("")}amix=inputs=${mixCount}:duration=first:dropout_transition=0:normalize=0,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[outa]`,
    );
  }

  args.push(
    "-filter_complex", filterParts.join(";"),
    "-map", "[outv]",
    ...H264_MEDIUM,
    "-pix_fmt", "yuv420p",
    "-map", "[outa]",
    ...AUDIO_OPTS,
    "-movflags", "+faststart",
    "-y", outputPath,
  );
  return args;
}

function buildOverlayAudioFilter(inputIndex: number, overlay: ResolvedAudioOverlay, label: string): string {
  const filters: string[] = ["aresample=48000", "aformat=sample_fmts=fltp:channel_layouts=stereo"];
  const durationSec = overlay.durationMs / 1000;
  if (durationSec > 0) {
    filters.push(`atrim=0:${durationSec}`);
  }
  if (overlay.startMs > 0) {
    filters.push(`adelay=${overlay.startMs}|${overlay.startMs}`);
  }
  if (overlay.volume !== 1) {
    filters.push(`volume=${overlay.volume}`);
  }
  const fadeInSec = overlay.fadeInMs / 1000;
  if (fadeInSec > 0) {
    filters.push(`afade=t=in:st=${overlay.startMs / 1000}:d=${fadeInSec}`);
  }
  const fadeOutSec = overlay.fadeOutMs / 1000;
  if (fadeOutSec > 0) {
    const fadeOutStart = Math.max(0, (overlay.startMs + overlay.durationMs) / 1000 - fadeOutSec);
    filters.push(`afade=t=out:st=${fadeOutStart}:d=${fadeOutSec}`);
  }
  return `[${inputIndex}:a:0]${filters.join(",")}[${label}]`;
}

/**
 * Fast path: video stream-copied via the concat demuxer. Only valid when
 * planTimelineVideo() returned "copy" (uniform CFR h264 inputs). Audio is
 * stream-copied too unless a slot deviates from default volume/fades or
 * overlay clips must be mixed in.
 */
async function runCopyConcat(opts: {
  inputPaths: string[];
  resolvedSlots: ResolvedSlot[];
  durations: number[];
  hasAudioFlags: boolean[];
  resolvedAudio: ResolvedAudioOverlay[];
  outputPath: string;
  signal: AbortSignal;
}): Promise<void> {
  const { inputPaths, resolvedSlots, durations, hasAudioFlags, resolvedAudio, outputPath, signal } = opts;
  const n = resolvedSlots.length;
  const needsSlotAudioFilter = resolvedSlots.some(
    (s) => s.volume !== 100 || s.fadeIn > 0 || s.fadeOut > 0,
  );
  const hasOverlays = resolvedAudio.length > 0;
  const needsAudioFilter = needsSlotAudioFilter || hasOverlays;

  const concatListDir = await mkdtemp(join(tmpdir(), "videocity-concat-"));
  const concatListPath = join(concatListDir, "list.txt");
  try {
    // concat demuxer list: one `file '<path>'` per line, single-quotes
    // escaped by `'\''`.
    const listBody = inputPaths
      .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
      .join("\n");
    await writeFile(concatListPath, listBody + "\n", "utf8");

    const ffmpegArgs: string[] = ["-f", "concat", "-safe", "0", "-i", concatListPath];

    if (needsAudioFilter) {
      // Re-open each slot as its own input so we can apply per-slot audio
      // filters, then concat the audio streams. Video comes from input 0
      // (the concat demuxer) and is stream-copied.
      for (const p of inputPaths) {
        ffmpegArgs.push("-i", p);
      }
      for (const overlay of resolvedAudio) {
        ffmpegArgs.push("-i", overlay.audioPath);
      }

      const filterParts: string[] = [];
      for (let i = 0; i < n; i++) {
        // Input indices for the per-slot reopens start at 1.
        filterParts.push(buildAudioFilter(i + 1, resolvedSlots[i], durations[i], hasAudioFlags[i]));
      }
      const concatInputs = Array.from({ length: n }, (_, i) => `[a${i + 1}]`).join("");
      const concatLabel = hasOverlays ? "[concatA]" : "[outa]";
      filterParts.push(`${concatInputs}concat=n=${n}:v=0:a=1${concatLabel}`);

      if (hasOverlays) {
        const overlayBaseIndex = 1 + n;
        const overlayLabels: string[] = [];
        resolvedAudio.forEach((overlay, k) => {
          const label = `ov${k}`;
          overlayLabels.push(`[${label}]`);
          filterParts.push(buildOverlayAudioFilter(overlayBaseIndex + k, overlay, label));
        });
        const mixInputs = `[concatA]${overlayLabels.join("")}`;
        const mixCount = 1 + overlayLabels.length;
        filterParts.push(
          `${mixInputs}amix=inputs=${mixCount}:duration=first:dropout_transition=0:normalize=0,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[outa]`,
        );
      }

      ffmpegArgs.push(
        "-filter_complex", filterParts.join(";"),
        "-map", "0:v:0",
        "-c:v", "copy",
        "-map", "[outa]",
        ...AUDIO_OPTS,
      );
    } else {
      // No audio adjustments: stream-copy both tracks.
      ffmpegArgs.push(
        "-map", "0:v:0",
        "-map", "0:a:0?",
        "-c", "copy",
      );
    }

    ffmpegArgs.push("-movflags", "+faststart", "-y", outputPath);

    await runFfmpeg(ffmpegArgs, { signal });
  } finally {
    await rm(concatListDir, { recursive: true, force: true });
  }
}

export function registerRenderTimelineJob(engine: Engine): void {
  registerJobHandler("render_timeline", async (payload, ctx) => {
    ctx.signal.throwIfAborted();
    const {
      bookId,
      orientation,
      resolvedSlots,
      resolvedAudio = [],
    } = payload as RenderTimelinePayload;

    const existingFinal = engine.artifacts.list().find((artifact) =>
      artifact.kind === "final" && artifact.label === "final");
    const finalResult = existingFinal !== undefined
      ? { ok: true as const, value: existingFinal }
      : await engine.artifacts.create({ kind: "final", label: "final" });
    if (!finalResult.ok) throw new Error(finalResult.error.message);
    const finalId = finalResult.value.artifactId;
    const finalDir = finalResult.value.path;
    await mkdir(finalDir, { recursive: true });

    return withLockedLocalLease(
      engine,
      finalId,
      finalDir,
      ctx,
      "final",
      { durationMs: LOCK_DURATION_MS },
      async () => {
      const renderFilename = orientation === "portrait" ? PORTRAIT_RENDER : orientation === "square" ? SQUARE_RENDER : LANDSCAPE_RENDER;
      const outputFilename = orientation === "portrait" ? PORTRAIT_OUTPUT : orientation === "square" ? SQUARE_OUTPUT : LANDSCAPE_OUTPUT;
      const outputPath = join(finalDir, outputFilename);

      const inputPaths: string[] = [];
      const durations: number[] = [];
      const hasAudioFlags: boolean[] = [];
      const videoProbes: TimelineVideoProbe[] = [];

      for (const slot of resolvedSlots) {
        ctx.signal.throwIfAborted();
        const inputPath = join(slot.assetDir, renderFilename);
        inputPaths.push(inputPath);
        const probe = await probeVideo(inputPath, { signal: ctx.signal });
        durations.push(probe.duration);
        hasAudioFlags.push(probe.hasAudio);
        videoProbes.push({
          fps: probe.fps,
          avgFps: probe.avgFps,
          width: probe.width,
          height: probe.height,
          videoCodec: probe.videoCodec,
        });
      }

      const n = resolvedSlots.length;

      // Slot renders normally share codec/resolution/fps (same Remotion
      // pipeline), in which case video is stream-copied via the concat
      // demuxer. But /render keeps each source clip's native frame rate, so
      // a timeline mixing e.g. 24fps generated clips with 30fps footage —
      // or containing any VFR input — must be re-encoded to one constant
      // frame rate, or the spliced timestamps stutter after platforms
      // (X, etc.) transcode the upload assuming CFR.
      const plan = planTimelineVideo(videoProbes);

      if (plan.mode === "reencode") {
        console.warn(
          `[render-timeline] ${bookId}: re-encoding video to ${plan.targetFps}fps CFR (${plan.reasons.join(", ")})`,
        );
        await runFfmpeg(
          buildReencodeArgs({
            inputPaths,
            resolvedSlots,
            durations,
            hasAudioFlags,
            resolvedAudio,
            plan,
            outputPath,
          }),
          { signal: ctx.signal },
        );
      } else {
        await runCopyConcat({
          inputPaths,
          resolvedSlots,
          durations,
          hasAudioFlags,
          resolvedAudio,
          outputPath,
          signal: ctx.signal,
        });
      }

      const thumbPath = join(finalDir, "original.jpg");
      await runFfmpeg(["-y", "-i", outputPath, "-frames:v", "1", "-q:v", "2", thumbPath], { signal: ctx.signal });

      await ingestWorkspaceOutputs(
        engine,
        finalId,
        [outputFilename, "original.jpg"],
        "render_timeline",
        { orientation, slotCount: n },
      );

      const renderMeta = {
        slotCount: n,
        slots: resolvedSlots.map((s) => s.artifactId),
        output: outputFilename,
        renderedAt: new Date().toISOString(),
      };
      await engine.metadata.artifacts.write(finalId, `${orientation}.render`, renderMeta);

      return { success: true, output: outputFilename };
      },
      { durationMs: LOCK_DURATION_MS },
    );
  });
}
