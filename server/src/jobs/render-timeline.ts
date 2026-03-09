import type { ClipfirstFs } from "clipfirst-fs";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { registerJobHandler } from "../queue.js";
import { runFfmpeg, probeVideo, H264_MEDIUM, AUDIO_OPTS } from "../ffmpeg.js";

const LOCK_DURATION_MS = 900_000; // 15 min

const LANDSCAPE_RENDER = "1920x1080_landscape.mp4";
const PORTRAIT_RENDER = "1080x1920_portrait.mp4";
const LANDSCAPE_OUTPUT = "timeline_1920x1080.mp4";
const PORTRAIT_OUTPUT = "timeline_1080x1920.mp4";

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
  orientation: "landscape" | "portrait";
  resolvedSlots: ResolvedSlot[];
};

function buildAudioFilter(index: number, slot: ResolvedSlot, duration: number): string {
  const filters: string[] = [];
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
  if (filters.length === 0) {
    return `[${index}:a:0]acopy[a${index}]`;
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
      const renderFilename = orientation === "portrait" ? PORTRAIT_RENDER : LANDSCAPE_RENDER;
      const outputFilename = orientation === "portrait" ? PORTRAIT_OUTPUT : LANDSCAPE_OUTPUT;
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

      // Build filter_complex
      const filterParts: string[] = [];

      // Video: setsar for each input, then concat
      for (let i = 0; i < n; i++) {
        filterParts.push(`[${i}:v:0]setsar=1[v${i}]`);
      }

      // Audio: per-slot volume/fade filters
      for (let i = 0; i < n; i++) {
        filterParts.push(buildAudioFilter(i, resolvedSlots[i], durations[i]));
      }

      // Concat
      const videoInputs = Array.from({ length: n }, (_, i) => `[v${i}]`).join("");
      const audioInputs = Array.from({ length: n }, (_, i) => `[a${i}]`).join("");
      filterParts.push(`${videoInputs}${audioInputs}concat=n=${n}:v=1:a=1[outv][outa]`);

      const filterComplex = filterParts.join(";");

      const ffmpegArgs: string[] = [];
      for (const p of inputPaths) {
        ffmpegArgs.push("-i", p);
      }
      ffmpegArgs.push(
        "-filter_complex", filterComplex,
        "-map", "[outv]",
        "-map", "[outa]",
        ...H264_MEDIUM,
        "-level:v", "4.2",
        ...AUDIO_OPTS,
        "-movflags", "+faststart",
        "-y",
        outputPath,
      );

      await runFfmpeg(ffmpegArgs);

      const renderMeta = {
        orientation,
        slotCount: n,
        slots: resolvedSlots.map((s) => s.slug),
        output: outputFilename,
        renderedAt: new Date().toISOString(),
      };
      await fs.writeMetadata("final", "render", renderMeta, projectSlug);

      await fs.commitOperation("render-timeline", "final", { orientation, slotCount: n }, projectSlug);

      return { success: true, output: outputFilename };
    } finally {
      await fs.releaseLock(finalDir);
    }
  });
}
