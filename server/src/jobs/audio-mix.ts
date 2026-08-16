import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import type { Engine } from "videobook-engine";
import { AUDIO_OPTS, extractWaveform, probeVideo, runFfmpeg } from "../ffmpeg.js";
import { queue, registerJobHandler } from "../queue.js";
import type { AudioMixAssetKind } from "../tools/audio-mix.js";
import { withLockedLocalLease } from "./_lease.js";

const LOCK_DURATION_MS = 30 * 60_000;

const STALE_DERIVATIVES = [
  ".original.analysis.json",
  ".analysis.gpt4otrans.json",
  "elevenlabs.json",
  ".suggest-sfx.json",
];

type AudioMixPayload = {
  type: "audio_mix";
  targetPath: string;
  targetFilename: string;
  targetKind: AudioMixAssetKind;
  layerPath: string;
  layerAssetId: string;
  volume: number;
  assetId: string;
  assetDir: string;
  bookId: string;
};

function decimal(value: number): string {
  return value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

function audioOnlyOutputOptions(outputPath: string): string[] {
  switch (extname(outputPath).toLowerCase()) {
    case ".mp3":
      return ["-c:a", "libmp3lame", "-q:a", "2", "-ac", "2"];
    case ".wav":
      return ["-c:a", "pcm_s16le", "-ac", "2"];
    case ".ogg":
      return ["-c:a", "libvorbis", "-q:a", "5", "-ac", "2"];
    case ".flac":
      return ["-c:a", "flac", "-compression_level", "5", "-ac", "2"];
    case ".aac":
    case ".m4a":
      return AUDIO_OPTS;
    default:
      throw new Error(`Unsupported target audio format: ${extname(outputPath) || "unknown"}`);
  }
}

function videoAudioOutputOptions(outputPath: string): string[] {
  const extension = extname(outputPath).toLowerCase();
  if (extension === ".webm") return ["-c:a", "libopus", "-b:a", "160k", "-ac", "2"];
  if (extension === ".avi") return ["-c:a", "libmp3lame", "-b:a", "192k", "-ac", "2"];
  return AUDIO_OPTS;
}

function outputContainerOptions(outputPath: string): string[] {
  const extension = extname(outputPath).toLowerCase();
  return extension === ".mp4" || extension === ".mov" || extension === ".m4a"
    ? ["-movflags", "+faststart"]
    : [];
}

export function buildAudioMixFilter(
  targetHasAudio: boolean,
  targetDurationSeconds: number,
  layerVolumePercent: number,
): string {
  if (!Number.isFinite(targetDurationSeconds) || targetDurationSeconds <= 0) {
    throw new Error(`Invalid target duration: ${targetDurationSeconds}`);
  }
  if (!Number.isFinite(layerVolumePercent) || layerVolumePercent < 0 || layerVolumePercent > 100) {
    throw new Error(`Layer volume must be between 0 and 100, got: ${layerVolumePercent}`);
  }

  const duration = decimal(targetDurationSeconds);
  const volume = decimal(layerVolumePercent / 100);
  const base = targetHasAudio
    ? `[0:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=duration=${duration},asetpts=PTS-STARTPTS[base]`
    : `anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${duration},asetpts=PTS-STARTPTS[base]`;
  const layer = `[1:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${volume},apad,atrim=duration=${duration},asetpts=PTS-STARTPTS[layer]`;
  const mix = "[base][layer]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95:level=false[outa]";
  return `${base};${layer};${mix}`;
}

export async function mixAudioMedia(
  targetPath: string,
  layerPath: string,
  outputPath: string,
  targetKind: AudioMixAssetKind,
  layerVolumePercent: number,
  signal?: AbortSignal,
): Promise<void> {
  const [targetProbe, layerProbe] = await Promise.all([
    probeVideo(targetPath, { signal }),
    probeVideo(layerPath, { signal }),
  ]);
  if (!layerProbe.hasAudio) throw new Error("Layer asset has no audio stream");
  if (targetKind === "video" && targetProbe.videoCodec === null) {
    throw new Error("Video target has no video stream");
  }
  if (targetKind === "audio" && !targetProbe.hasAudio) {
    throw new Error("Audio target has no audio stream");
  }

  const targetDuration = targetKind === "video"
    ? (targetProbe.videoDuration > 0 ? targetProbe.videoDuration : targetProbe.duration)
    : (targetProbe.audioDuration ?? targetProbe.duration);
  const filter = buildAudioMixFilter(targetProbe.hasAudio, targetDuration, layerVolumePercent);
  const args = [
    "-y",
    "-i", targetPath,
    "-i", layerPath,
    "-filter_complex", filter,
  ];

  if (targetKind === "video") {
    args.push(
      "-map", "0:v:0",
      "-map", "[outa]",
      "-map_metadata", "0",
      "-map_chapters", "0",
      "-c:v", "copy",
      ...videoAudioOutputOptions(outputPath),
      ...outputContainerOptions(outputPath),
      outputPath,
    );
  } else {
    args.push(
      "-map", "[outa]",
      ...audioOnlyOutputOptions(outputPath),
      ...outputContainerOptions(outputPath),
      outputPath,
    );
  }

  await runFfmpeg(args, { signal });

  const outputProbe = await probeVideo(outputPath, { signal });
  if (!outputProbe.hasAudio) throw new Error("Audio mix output has no audio stream");
  if (targetKind === "video") {
    if (outputProbe.videoCodec === null) throw new Error("Audio mix output has no video stream");
    if (outputProbe.videoCodec !== targetProbe.videoCodec) {
      throw new Error(`Audio mix changed the video codec from ${targetProbe.videoCodec} to ${outputProbe.videoCodec}`);
    }
    if (Math.abs(outputProbe.videoDuration - targetDuration) > 0.5) {
      throw new Error(`Audio mix changed video duration from ${targetDuration.toFixed(3)}s to ${outputProbe.videoDuration.toFixed(3)}s`);
    }
    return;
  }

  const outputDuration = outputProbe.audioDuration ?? outputProbe.duration;
  if (Math.abs(outputDuration - targetDuration) > 0.5) {
    throw new Error(`Audio mix changed audio duration from ${targetDuration.toFixed(3)}s to ${outputDuration.toFixed(3)}s`);
  }
}

async function deleteIfPresent(
  fs: Engine,
  assetId: string,
  filename: string,
): Promise<void> {
  const result = await fs.files.delete(assetId, filename);
  if (!result.ok && result.error.code !== "NOT_FOUND") {
    throw new Error(`Failed to delete ${filename}: ${result.error.message}`);
  }
}

async function replaceMixedMedia(
  fs: Engine,
  assetId: string,
  targetFilename: string,
  outputPath: string,
): Promise<void> {
  const output = await readFile(outputPath);
  const writeResult = await fs.files.write(assetId, targetFilename, output);
  if (!writeResult.ok) {
    throw new Error(`Failed to replace ${targetFilename}: ${writeResult.error.message}`);
  }
}

export function registerAudioMixJob(fs: Engine): void {
  registerJobHandler("audio_mix", async (payload, ctx) => {
    const {
      targetPath,
      targetFilename,
      targetKind,
      layerPath,
      layerAssetId,
      volume,
      assetId,
      assetDir,
      bookId,
    } = payload as AudioMixPayload;

    const result = await withLockedLocalLease(
      fs,
      assetId,
      assetDir,
      ctx,
      "replace_audio",
      { durationMs: LOCK_DURATION_MS, data: { state: "mixing-audio" } },
      async () => {
        const tempDir = await mkdtemp(join(tmpdir(), "videocity-audio-mix-"));
        const extension = extname(targetFilename) || (targetKind === "video" ? ".mp4" : ".mp3");
        const outputPath = join(tempDir, `mixed${extension}`);
        try {
          await mixAudioMedia(
            targetPath,
            layerPath,
            outputPath,
            targetKind,
            volume,
            ctx.signal,
          );
          await replaceMixedMedia(fs, assetId, targetFilename, outputPath);
        } finally {
          await rm(tempDir, { recursive: true, force: true });
        }

        for (const filename of STALE_DERIVATIVES) {
          await deleteIfPresent(fs, assetId, filename);
        }

        const mediaPath = join(assetDir, targetFilename);
        if (targetKind === "audio") {
          const peaks = await extractWaveform(mediaPath);
          const waveformResult = await fs.metadata.waveforms.write(assetId, peaks);
          if (!waveformResult.ok) {
            throw new Error(`Failed to update audio waveform: ${waveformResult.error.message}`);
          }
        }

        return { mediaPath };
      },
      { durationMs: LOCK_DURATION_MS, waitForActiveMs: 30_000 },
    );

    if (targetKind === "video") {
      await queue.enqueue(`process-video-${assetId}-${Date.now()}`, {
        type: "process_video",
        videoPath: result.mediaPath,
        assetId,
        assetDir,
        bookId,
        provenance: {
          origin: "audio_mix",
          source_audio_asset: layerAssetId,
          layer_volume: volume,
          mixed_at: new Date().toISOString(),
        },
        force: true,
      } as unknown as Record<string, unknown>);
    }

    return {
      success: true,
      target_asset_id: assetId,
      layer_asset_id: layerAssetId,
      volume,
    };
  });
}
