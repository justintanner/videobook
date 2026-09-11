import type { Engine } from "videobook-engine";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { registerJobHandler, queue } from "../queue.js";
import { extractWaveform, probeVideo, runFfmpeg } from "../ffmpeg.js";
import { audioOnlyOutputOptions, videoAudioOutputOptions } from "../audio-encoding.js";
import { registerMediaStreams } from "./process-video.js";
import { withLockedLocalLease } from "./_lease.js";
import { replaceArtifactFileFromPath } from "./_persist-output.js";

const LOCK_DURATION_MS = 300_000;

function buildBoostOutputOptions(boost: number, isVideo: boolean, inputPath: string): string[] {
  const audioFilter = `volume=${boost}`;
  if (isVideo) {
    return ["-c:v", "copy", "-af", audioFilter, ...videoAudioOutputOptions(inputPath)];
  }
  return ["-af", audioFilter, ...audioOnlyOutputOptions(inputPath)];
}

type AudioBoostPayload = {
  type: "audio_boost";
  inputPath: string;
  outputPath: string;
  boost: number;
  isVideo: boolean;
  assetId: string;
  assetDir: string;
  bookId: string;
};

export function registerAudioBoostJob(engine: Engine): void {
  registerJobHandler("audio_boost", async (payload, ctx) => {
    const {
      inputPath, boost, isVideo,
      assetId, assetDir, bookId,
    } = payload as AudioBoostPayload;

    const result = await withLockedLocalLease(
      engine,
      assetId,
      assetDir,
      ctx,
      "apply_sfx",
      { durationMs: LOCK_DURATION_MS, data: { state: "boosting-audio" } },
      async () => {
        const inputFilename = basename(inputPath);
        const mediaPath = join(assetDir, inputFilename);
        const workspace = await mkdtemp(join(tmpdir(), "videobook-audio-boost-"));
        const outputPath = join(workspace, `output${extname(inputFilename)}`);
        try {
          const source = await probeVideo(inputPath, { signal: ctx.signal });
          if (!source.hasAudio) throw new Error("Source has no playable audio stream");
          await runFfmpeg(["-y", "-i", inputPath, ...buildBoostOutputOptions(boost, isVideo, inputPath), outputPath], { signal: ctx.signal });
          const output = await probeVideo(outputPath, { signal: ctx.signal });
          if (!output.hasAudio || Math.abs(output.duration - source.duration) > 0.15) {
            throw new Error("Audio boost produced an invalid duration");
          }
          await replaceArtifactFileFromPath(engine, assetId, inputFilename, outputPath);
          if (!isVideo) {
            await registerMediaStreams(engine, assetId, inputFilename, output);
            const previous = await engine.metadata.artifacts.read<Record<string, unknown>>(assetId, "original");
            const metadata = await engine.metadata.artifacts.write(assetId, "original", {
              ...(previous.ok ? previous.value : {}),
              origin: "audio_boost",
              boost,
              duration: output.audioDuration ?? output.duration,
            });
            if (!metadata.ok) throw new Error(metadata.error.message);
            const waveform = await engine.metadata.waveforms.write(assetId, await extractWaveform(mediaPath));
            if (!waveform.ok) throw new Error(waveform.error.message);
          }
        } finally {
          await rm(workspace, { recursive: true, force: true });
        }
        return { mediaPath };
      },
      { durationMs: LOCK_DURATION_MS, waitForActiveMs: 30_000 },
    );

    if (isVideo) {
      await queue.enqueue(`process-video-${assetId}-${Date.now()}`, {
        type: "process_video",
        videoPath: result.mediaPath,
        assetId,
        assetDir,
        bookId,
        provenance: { origin: "audio_boost", boost, boosted_at: new Date().toISOString() },
        force: true,
        skipDownstreamJobs: true,
      } as unknown as Record<string, unknown>);
    }

    return { success: true };
  });
}
