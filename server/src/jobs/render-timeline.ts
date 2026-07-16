import type { VideocityFs } from "videocity-engine";
import { join } from "node:path";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { registerJobHandler } from "../queue.js";
import { runFfmpeg, probeVideo, AUDIO_OPTS } from "../ffmpeg.js";
import { withLockedLocalLease } from "./_lease.js";

const LOCK_DURATION_MS = 1_800_000;

const LANDSCAPE_RENDER = "landscape.mp4";
const PORTRAIT_RENDER = "portrait.mp4";
const SQUARE_RENDER = "square.mp4";
const LANDSCAPE_OUTPUT = "timeline_landscape.mp4";
const PORTRAIT_OUTPUT = "timeline_portrait.mp4";
const SQUARE_OUTPUT = "timeline_square.mp4";

type ResolvedSlot = {
  slug: string;
  volume: number;
  fadeIn: number;
  fadeOut: number;
  assetDir: string;
};

type ResolvedAudioOverlay = {
  id: string;
  slug: string;
  audioPath: string;
  startMs: number;
  durationMs: number;
  volume: number;
  fadeInMs: number;
  fadeOutMs: number;
};

type RenderTimelinePayload = {
  type: "render_timeline";
  projectSlug: string;
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

export function registerRenderTimelineJob(fs: VideocityFs): void {
  registerJobHandler("render_timeline", async (payload, ctx) => {
    ctx.signal.throwIfAborted();
    const {
      projectSlug,
      orientation,
      resolvedSlots,
      resolvedAudio = [],
    } = payload as RenderTimelinePayload;

    const projectResult = await fs.getProject(projectSlug);
    if (!projectResult.ok) throw new Error(projectResult.error.message);
    const projectDir = projectResult.value.path;

    const finalDir = join(projectDir, "final");
    await mkdir(finalDir, { recursive: true });

    return withLockedLocalLease(
      fs,
      projectSlug,
      "final",
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

      for (const slot of resolvedSlots) {
        ctx.signal.throwIfAborted();
        const inputPath = join(slot.assetDir, renderFilename);
        inputPaths.push(inputPath);
        const probe = await probeVideo(inputPath, { signal: ctx.signal });
        durations.push(probe.duration);
        hasAudioFlags.push(probe.hasAudio);
      }

      const n = resolvedSlots.length;

      // All per-slot renders come from the same Remotion pipeline, so codec,
      // resolution, fps, and pixel format already match. Use the concat
      // demuxer to stream-copy video (no re-encode). Audio still needs
      // filtering when any slot deviates from defaults OR when overlay
      // audio clips are present (must be mixed via amix).
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

        await runFfmpeg(ffmpegArgs, { signal: ctx.signal });
      } finally {
        await rm(concatListDir, { recursive: true, force: true });
      }

      const thumbPath = join(finalDir, "original.jpg");
      await runFfmpeg(["-y", "-i", outputPath, "-frames:v", "1", "-q:v", "2", thumbPath], { signal: ctx.signal });

      const renderMeta = {
        slotCount: n,
        slots: resolvedSlots.map((s) => s.slug),
        output: outputFilename,
        renderedAt: new Date().toISOString(),
      };
      await fs.writeMetadata("final", `${orientation}.render`, renderMeta, projectSlug);

      await fs.commitOperation("render-timeline", "final", { orientation, slotCount: n }, projectSlug);

      return { success: true, output: outputFilename };
      },
      { durationMs: LOCK_DURATION_MS },
    );
  });
}
