import type { ClipfirstFs } from "clipfirst-fs";
import { join } from "node:path";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { registerJobHandler } from "../queue.js";
import { runFfmpeg, probeVideo, AUDIO_OPTS } from "../ffmpeg.js";

const LOCK_DURATION_MS = 900_000; // 15 min

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

type RenderTimelinePayload = {
  type: "render_timeline";
  projectSlug: string;
  orientation: "landscape" | "portrait" | "square";
  resolvedSlots: ResolvedSlot[];
};

function buildAudioFilter(index: number, slot: ResolvedSlot, duration: number): string {
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
  return `[${index}:a:0]${filters.join(",")}[a${index}]`;
}

export function registerRenderTimelineJob(fs: ClipfirstFs): void {
  registerJobHandler("render_timeline", async (payload) => {
    const {
      projectSlug,
      orientation,
      resolvedSlots,
    } = payload as RenderTimelinePayload;

    const projectResult = await fs.getProject(projectSlug);
    if (!projectResult.ok) throw new Error(projectResult.error.message);
    const projectDir = projectResult.value.path;

    const finalDir = join(projectDir, "final");
    await mkdir(finalDir, { recursive: true });

    const lockResult = await fs.acquireLock(finalDir, { durationMs: LOCK_DURATION_MS });
    if (!lockResult.ok) throw new Error(`Final asset is locked: ${lockResult.error.message}`);

    try {
      const renderFilename = orientation === "portrait" ? PORTRAIT_RENDER : orientation === "square" ? SQUARE_RENDER : LANDSCAPE_RENDER;
      const outputFilename = orientation === "portrait" ? PORTRAIT_OUTPUT : orientation === "square" ? SQUARE_OUTPUT : LANDSCAPE_OUTPUT;
      const outputPath = join(finalDir, outputFilename);

      const inputPaths: string[] = [];
      const durations: number[] = [];

      for (const slot of resolvedSlots) {
        const inputPath = join(slot.assetDir, renderFilename);
        inputPaths.push(inputPath);
        const probe = await probeVideo(inputPath);
        durations.push(probe.duration);
      }

      const n = resolvedSlots.length;

      // All per-slot renders come from the same Remotion pipeline, so codec,
      // resolution, fps, and pixel format already match. Use the concat
      // demuxer to stream-copy video (no re-encode). Audio still needs
      // per-slot volume/fade filtering when any slot deviates from defaults.
      const needsAudioFilter = resolvedSlots.some(
        (s) => s.volume !== 100 || s.fadeIn > 0 || s.fadeOut > 0,
      );

      const concatListDir = await mkdtemp(join(tmpdir(), "clipfirst-concat-"));
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

          const filterParts: string[] = [];
          for (let i = 0; i < n; i++) {
            // Input indices for the per-slot reopens start at 1.
            filterParts.push(buildAudioFilter(i + 1, resolvedSlots[i], durations[i]));
          }
          const concatInputs = Array.from({ length: n }, (_, i) => `[a${i + 1}]`).join("");
          filterParts.push(`${concatInputs}concat=n=${n}:v=0:a=1[outa]`);

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

        await runFfmpeg(ffmpegArgs);
      } finally {
        await rm(concatListDir, { recursive: true, force: true });
      }

      const thumbPath = join(finalDir, "original.jpg");
      await runFfmpeg(["-y", "-i", outputPath, "-frames:v", "1", "-q:v", "2", thumbPath]);

      const renderMeta = {
        slotCount: n,
        slots: resolvedSlots.map((s) => s.slug),
        output: outputFilename,
        renderedAt: new Date().toISOString(),
      };
      await fs.writeMetadata("final", `${orientation}.render`, renderMeta, projectSlug);

      await fs.commitOperation("render-timeline", "final", { orientation, slotCount: n }, projectSlug);

      return { success: true, output: outputFilename };
    } finally {
      await fs.releaseLock(finalDir);
    }
  });
}
