import type { VideocityFs } from "videobook-engine";
import { createElevenLabs } from "@apicity/elevenlabs";
import { extname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { requireApiKey } from "../api-key.js";
import { AUDIO_OPTS, probeVideo, runFfmpeg } from "../ffmpeg.js";
import { queue, registerJobHandler } from "../queue.js";
import { withLockedLocalLease } from "./_lease.js";

const LOCK_DURATION_MS = 2 * 60 * 60_000;
const PROVIDER_TIMEOUT_MS = 65 * 60_000;
const MAX_ISOLATION_BYTES = 500 * 1024 * 1024;
const MAX_ISOLATION_DURATION_SECONDS = 60 * 60;
const MIN_MUSIC_DURATION_MS = 3_000;
const MAX_MUSIC_DURATION_MS = 600_000;
const DEFAULT_MUSIC_PROMPT = "A light, unobtrusive, warm instrumental underscore with a sparse arrangement, gentle dynamics, no vocals, and plenty of space for dialogue and natural sound effects.";

const STALE_DERIVATIVES = [
  ".original.analysis.json",
  ".analysis.gpt4otrans.json",
  "elevenlabs.json",
  ".kie-task.json",
  ".suggest-sfx.json",
];

export type CleanAudioMixOptions = {
  durationSeconds: number;
  sourceMix: number;
  edgeFadeMs: number;
  musicVolume: number;
  hasMusic: boolean;
};

type CleanVideoAudioPayload = {
  type: "clean_video_audio";
  assetId: string;
  assetDir: string;
  videoFilename: string;
  projectSlug: string;
  sourceMix: number;
  edgeFadeMs: number;
  addMusic: boolean;
  musicPrompt: string | null;
  musicVolume: number;
};

function decimal(value: number): string {
  return value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

function inferVideoMime(filename: string): string {
  switch (extname(filename).toLowerCase()) {
    case ".mp4":
    case ".m4v":
      return "video/mp4";
    case ".mov":
      return "video/quicktime";
    case ".webm":
      return "video/webm";
    case ".mkv":
      return "video/x-matroska";
    default:
      return "application/octet-stream";
  }
}

function outputAudioOptions(outputPath: string): string[] {
  return extname(outputPath).toLowerCase() === ".webm"
    ? ["-c:a", "libopus", "-b:a", "160k", "-ac", "2"]
    : AUDIO_OPTS;
}

function outputContainerOptions(outputPath: string): string[] {
  const extension = extname(outputPath).toLowerCase();
  return extension === ".mp4" || extension === ".mov" || extension === ".m4v"
    ? ["-movflags", "+faststart"]
    : [];
}

export function buildCleanAudioFilter(options: CleanAudioMixOptions): string {
  const duration = decimal(options.durationSeconds);
  const edgeFade = Math.min(options.edgeFadeMs / 1000, options.durationSeconds / 2);
  const edgeFadeText = decimal(edgeFade);
  const edgeFadeOutStart = decimal(Math.max(0, options.durationSeconds - edgeFade));
  const musicFade = Math.min(1.5, options.durationSeconds / 4);
  const musicFadeText = decimal(musicFade);
  const musicFadeOutStart = decimal(Math.max(0, options.durationSeconds - musicFade));
  const voiceSplit = options.hasMusic
    ? "asplit=3[voice_source][voice_mix][voice_music]"
    : "asplit=2[voice_source][voice_mix]";
  const parts = [
    `[0:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,highpass=f=60,lowpass=f=16000,afftdn=nr=10:nf=-35:tn=1,volume=${decimal(options.sourceMix)}[source]`,
    `[1:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=1,${voiceSplit}`,
    "[source][voice_source]sidechaincompress=threshold=0.03:ratio=6:attack=20:release=300[source_ducked]",
  ];

  if (options.hasMusic) {
    const musicFilters = [
      "aresample=48000",
      "aformat=sample_fmts=fltp:channel_layouts=stereo",
      `atrim=duration=${duration}`,
      "asetpts=PTS-STARTPTS",
      `volume=${decimal(options.musicVolume)}`,
    ];
    if (musicFade > 0.01) {
      musicFilters.push(
        `afade=t=in:st=0:d=${musicFadeText}`,
        `afade=t=out:st=${musicFadeOutStart}:d=${musicFadeText}`,
      );
    }
    parts.push(
      `[2:a:0]${musicFilters.join(",")}[music]`,
      "[music][voice_music]sidechaincompress=threshold=0.025:ratio=8:attack=20:release=500[music_ducked]",
      "[source_ducked][voice_mix][music_ducked]amix=inputs=3:duration=longest:dropout_transition=0:normalize=0[mix]",
    );
  } else {
    parts.push(
      "[source_ducked][voice_mix]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[mix]",
    );
  }

  const finalFilters = [
    "apad",
    `atrim=duration=${duration}`,
    "loudnorm=I=-16:TP=-1.5:LRA=11",
  ];
  if (edgeFade > 0.001) {
    finalFilters.push(
      `afade=t=in:st=0:d=${edgeFadeText}`,
      `afade=t=out:st=${edgeFadeOutStart}:d=${edgeFadeText}`,
    );
  }
  finalFilters.push("alimiter=limit=0.95");
  parts.push(`[mix]${finalFilters.join(",")}[outa]`);
  return parts.join(";");
}

export async function renderCleanVideoAudio(
  inputPath: string,
  isolatedVoicePath: string,
  musicPath: string | null,
  outputPath: string,
  options: CleanAudioMixOptions,
  signal?: AbortSignal,
): Promise<void> {
  const inputProbe = await probeVideo(inputPath, { signal });
  const args = ["-y", "-i", inputPath, "-i", isolatedVoicePath];
  if (musicPath) args.push("-stream_loop", "-1", "-i", musicPath);
  args.push(
    "-filter_complex", buildCleanAudioFilter(options),
    "-map", "0:v:0",
    "-map", "[outa]",
    "-map_metadata", "0",
    "-map_chapters", "0",
    "-c:v", "copy",
    ...outputAudioOptions(outputPath),
    ...outputContainerOptions(outputPath),
    outputPath,
  );
  await runFfmpeg(args, { signal });

  const outputProbe = await probeVideo(outputPath, { signal });
  if (!outputProbe.hasAudio || outputProbe.videoCodec === null) {
    throw new Error("Audio cleanup output is missing a usable video or audio stream");
  }
  if (outputProbe.videoCodec !== inputProbe.videoCodec) {
    throw new Error(`Audio cleanup changed the video codec from ${inputProbe.videoCodec} to ${outputProbe.videoCodec}`);
  }
  if (Math.abs(outputProbe.videoDuration - inputProbe.videoDuration) > 0.5) {
    throw new Error(`Audio cleanup changed video duration from ${inputProbe.videoDuration.toFixed(3)}s to ${outputProbe.videoDuration.toFixed(3)}s`);
  }
}

async function deleteIfPresent(
  fs: VideocityFs,
  assetId: string,
  filename: string,
  projectSlug: string,
): Promise<void> {
  const result = await fs.deleteFile(assetId, filename, projectSlug);
  if (!result.ok && result.error.code !== "NOT_FOUND") {
    throw new Error(`Failed to delete stale ${filename}: ${result.error.message}`);
  }
}

export async function replaceVideoAssetInPlace(
  fs: VideocityFs,
  assetId: string,
  videoFilename: string,
  renderedPath: string,
  projectSlug: string,
): Promise<void> {
  const outputBytes = await readFile(renderedPath);
  const written = await fs.writeFile(assetId, videoFilename, outputBytes, projectSlug);
  if (!written.ok) throw new Error(`Failed to replace ${videoFilename}: ${written.error.message}`);
}

export function registerCleanVideoAudioJob(fs: VideocityFs): void {
  registerJobHandler("clean_video_audio", async (payload, ctx) => {
    const {
      assetId,
      assetDir,
      videoFilename,
      projectSlug,
      sourceMix,
      edgeFadeMs,
      addMusic,
      musicPrompt,
      musicVolume,
    } = payload as CleanVideoAudioPayload;
    const apiKey = requireApiKey("ELEVENLABS_API_KEY");

    const result = await withLockedLocalLease(
      fs,
      projectSlug,
      assetId,
      assetDir,
      ctx,
      "replace_audio",
      { durationMs: LOCK_DURATION_MS, data: { state: "cleaning-audio" } },
      async () => {
        const inputPath = join(assetDir, videoFilename);
        const probe = await probeVideo(inputPath, { signal: ctx.signal });
        if (!probe.hasAudio) throw new Error(`Video asset ${assetId} has no audio track to clean`);
        if (probe.duration <= 0 || probe.duration > MAX_ISOLATION_DURATION_SECONDS) {
          throw new Error(`ElevenLabs Voice Isolator requires a video between 0 and ${MAX_ISOLATION_DURATION_SECONDS} seconds; got ${probe.duration}`);
        }

        const sourceResult = await fs.readFile(assetId, videoFilename, projectSlug);
        if (!sourceResult.ok) throw new Error(sourceResult.error.message);
        if (sourceResult.value.byteLength > MAX_ISOLATION_BYTES) {
          throw new Error(`ElevenLabs Voice Isolator supports files up to ${MAX_ISOLATION_BYTES} bytes`);
        }

        const sourceBytes = new Uint8Array(sourceResult.value);
        const sourceBlob = new Blob([sourceBytes], { type: inferVideoMime(videoFilename) });
        const provider = createElevenLabs({ apiKey, timeout: PROVIDER_TIMEOUT_MS });
        const isolatedAudio = await provider.v1.audioIsolation({
          audio: sourceBlob,
          file_format: "other",
        }, ctx.signal);

        let musicAudio: ArrayBuffer | null = null;
        const resolvedMusicPrompt = musicPrompt ?? DEFAULT_MUSIC_PROMPT;
        if (addMusic) {
          const musicLengthMs = Math.min(
            MAX_MUSIC_DURATION_MS,
            Math.max(MIN_MUSIC_DURATION_MS, Math.round(probe.duration * 1000)),
          );
          musicAudio = await provider.v1.music({
            prompt: resolvedMusicPrompt,
            generation_mode: "ambience",
            music_length_ms: musicLengthMs,
            model_id: "music_v2",
            force_instrumental: true,
          }, ctx.signal);
        }

        const tempDir = await mkdtemp(join(tmpdir(), "videocity-clean-audio-"));
        try {
          const voicePath = join(tempDir, "isolated.mp3");
          const musicPath = musicAudio ? join(tempDir, "music.mp3") : null;
          const extension = extname(videoFilename) || ".mp4";
          const outputPath = join(tempDir, `cleaned${extension}`);
          await writeFile(voicePath, Buffer.from(isolatedAudio));
          if (musicPath && musicAudio) await writeFile(musicPath, Buffer.from(musicAudio));

          await renderCleanVideoAudio(
            inputPath,
            voicePath,
            musicPath,
            outputPath,
            {
              durationSeconds: probe.duration,
              sourceMix,
              edgeFadeMs,
              musicVolume,
              hasMusic: musicPath !== null,
            },
            ctx.signal,
          );

          await replaceVideoAssetInPlace(fs, assetId, videoFilename, outputPath, projectSlug);
        } finally {
          await rm(tempDir, { recursive: true, force: true });
        }

        for (const filename of STALE_DERIVATIVES) {
          await deleteIfPresent(fs, assetId, filename, projectSlug);
        }

        return { videoPath: inputPath };
      },
      { durationMs: LOCK_DURATION_MS, waitForActiveMs: 30_000 },
    );

    await queue.enqueue(`process-video-${assetId}-${Date.now()}`, {
      type: "process_video",
      videoPath: result.videoPath,
      assetId,
      assetDir,
      projectSlug,
      provenance: {
        origin: "clean_video_audio",
        provider: "elevenlabs",
        source_mix: sourceMix,
        edge_fade_ms: edgeFadeMs,
        light_music: addMusic,
        ...(addMusic ? { music_prompt: musicPrompt ?? DEFAULT_MUSIC_PROMPT, music_volume: musicVolume } : {}),
        cleaned_at: new Date().toISOString(),
      },
      force: true,
    });

    return { success: true, asset_id: assetId, light_music: addMusic };
  });
}
