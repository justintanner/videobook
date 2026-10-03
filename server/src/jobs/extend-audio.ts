import { createElevenLabs } from "../usage-providers.js";
import { extname, join } from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { type ElevenLabsProvider } from "@apicity/elevenlabs";
import type { Engine } from "videobook-engine";
import {
  audioCrossfadeMs,
  buildSoundContinuationPrompt,
  describeSourceAudio,
  ELEVENLABS_SCRIBE_MODEL,
  ELEVENLABS_SOUND_EFFECT_MODEL,
  ELEVENLABS_SOUND_EFFECT_OUTPUT_FORMAT,
  MAX_SOUND_GENERATION_PROMPT_CHARS,
} from "../elevenlabs-audio-extension.js";
import { extractWaveform, probeVideo, runFfmpeg } from "../ffmpeg.js";
import { requireApiKey } from "../api-key.js";
import { registerJobHandler } from "../queue.js";

const ELEVENLABS_TIMEOUT_MS = 10 * 60_000;
const DURATION_TOLERANCE_SECONDS = 0.25;
const TAIL_ACTIVITY_THRESHOLD = 0.005;

export type ExtendAudioPayload = {
  type: "extend_audio";
  audAssetId: string;
  sourceAssetId: string;
  sourceFilename: string;
  sourceDurationMs: number;
  targetDurationMs: number;
  continuationPrompt?: string;
  bookId: string;
};

function audioMime(filename: string): string {
  switch (extname(filename).toLowerCase()) {
    case ".mp3": return "audio/mpeg";
    case ".wav": return "audio/wav";
    case ".m4a": return "audio/mp4";
    case ".ogg": return "audio/ogg";
    case ".flac": return "audio/flac";
    default: return "application/octet-stream";
  }
}

async function renderContinuation(
  source: Buffer,
  sourceFilename: string,
  generated: ArrayBuffer,
  sourceDurationMs: number,
  targetDurationMs: number,
  crossfadeMs: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  const tempDir = await mkdtemp(join(tmpdir(), "videocity-elevenlabs-extend-"));
  const sourcePath = join(tempDir, `source${extname(sourceFilename) || ".audio"}`);
  const generatedPath = join(tempDir, "continuation.mp3");
  const outputPath = join(tempDir, "extended.mp3");
  const sourceSeconds = sourceDurationMs / 1000;
  const targetSeconds = targetDurationMs / 1000;
  const continuationSeconds = (targetDurationMs - sourceDurationMs) / 1000;
  const crossfadeSeconds = crossfadeMs / 1000;
  const generatedSeconds = continuationSeconds + crossfadeSeconds;
  const filter = [
    `[0:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=duration=${sourceSeconds},asetpts=PTS-STARTPTS[source]`,
    `[1:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=duration=${generatedSeconds},asetpts=PTS-STARTPTS[continuation]`,
    `[source][continuation]acrossfade=d=${crossfadeSeconds}:c1=tri:c2=tri,atrim=duration=${targetSeconds},asetpts=PTS-STARTPTS[out]`,
  ].join(";");

  try {
    await writeFile(sourcePath, source);
    await writeFile(generatedPath, new Uint8Array(generated));
    await runFfmpeg([
      "-y",
      "-i", sourcePath,
      "-i", generatedPath,
      "-filter_complex", filter,
      "-map", "[out]",
      "-c:a", "libmp3lame",
      "-b:a", "192k",
      "-ar", "48000",
      "-ac", "2",
      "-t", String(targetSeconds),
      outputPath,
    ], { signal });
    return await readFile(outputPath);
  } finally {
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  }
}

export async function hasAudibleContinuationTail(audioPath: string): Promise<boolean> {
  const waveform = await extractWaveform(audioPath, 100);
  if (waveform.length === 0) return false;
  const tail = waveform.slice(Math.floor(waveform.length * 0.85));
  const active = tail.filter((level) => level >= TAIL_ACTIVITY_THRESHOLD).length;
  const mean = tail.reduce((sum, level) => sum + level, 0) / tail.length;
  return active / tail.length >= 0.2 && mean >= TAIL_ACTIVITY_THRESHOLD / 2;
}

export async function fillLoopableContinuation(
  audio: ArrayBuffer,
  durationSeconds: number,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const tempDir = await mkdtemp(join(tmpdir(), "videocity-elevenlabs-loop-fill-"));
  const inputPath = join(tempDir, "input.mp3");
  const trimmedPath = join(tempDir, "trimmed.wav");
  const outputPath = join(tempDir, "filled.mp3");
  try {
    await writeFile(inputPath, new Uint8Array(audio));
    await runFfmpeg([
      "-y",
      "-i", inputPath,
      "-af", "areverse,silenceremove=start_periods=1:start_duration=0.15:start_threshold=-45dB,areverse",
      "-c:a", "pcm_s16le",
      "-ar", "48000",
      "-ac", "2",
      trimmedPath,
    ], { signal });
    const trimmedProbe = await probeVideo(trimmedPath, { signal });
    const trimmedDuration = trimmedProbe.audioDuration ?? trimmedProbe.duration;
    if (!Number.isFinite(trimmedDuration) || trimmedDuration < 0.5) {
      throw new Error("ElevenLabs loopable continuation has too little audible content");
    }

    const crossfadeSeconds = Math.min(0.15, trimmedDuration / 4);
    const repeatCount = Math.max(
      1,
      Math.ceil((durationSeconds - crossfadeSeconds) / (trimmedDuration - crossfadeSeconds)),
    );
    const args = ["-y"];
    for (let index = 0; index < repeatCount; index++) {
      args.push("-i", trimmedPath);
    }
    const filters: string[] = [];
    if (repeatCount === 1) {
      filters.push(`[0:a:0]atrim=duration=${durationSeconds},asetpts=PTS-STARTPTS[out]`);
    } else {
      let previous = "[0:a:0]";
      for (let index = 1; index < repeatCount; index++) {
        const output = index === repeatCount - 1 ? "[joined]" : `[join${index}]`;
        filters.push(`${previous}[${index}:a:0]acrossfade=d=${crossfadeSeconds}:c1=tri:c2=tri${output}`);
        previous = output;
      }
      filters.push(`[joined]atrim=duration=${durationSeconds},asetpts=PTS-STARTPTS[out]`);
    }
    args.push(
      "-filter_complex", filters.join(";"),
      "-map", "[out]",
      "-c:a", "libmp3lame",
      "-b:a", "192k",
      "-ar", "48000",
      "-ac", "2",
      "-t", String(durationSeconds),
      outputPath,
    );
    await runFfmpeg(args, { signal });
    if (!(await hasAudibleContinuationTail(outputPath))) {
      throw new Error("ElevenLabs loop-filled continuation still has a silent tail");
    }
    return Uint8Array.from(await readFile(outputPath)).buffer;
  } finally {
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  }
}

async function generateAudibleContinuation(
  provider: ElevenLabsProvider,
  generationPrompt: string,
  generationDurationSeconds: number,
  signal?: AbortSignal,
): Promise<{ audio: ArrayBuffer; attempts: number; loopFilled: boolean }> {
  const retrySuffix = " Audible every moment; seamless loop; no quiet tail.";
  const attempts = [
    { text: generationPrompt, loop: false },
    {
      text: `${generationPrompt.slice(0, MAX_SOUND_GENERATION_PROMPT_CHARS - retrySuffix.length)}${retrySuffix}`,
      loop: true,
    },
  ];

  for (let index = 0; index < attempts.length; index++) {
    const attempt = attempts[index];
    const audio = await provider.v1.soundGeneration({
      text: attempt.text,
      model_id: ELEVENLABS_SOUND_EFFECT_MODEL,
      duration_seconds: generationDurationSeconds,
      prompt_influence: 0.9,
      loop: attempt.loop,
      output_format: ELEVENLABS_SOUND_EFFECT_OUTPUT_FORMAT,
    }, signal);
    const tempDir = await mkdtemp(join(tmpdir(), "videocity-elevenlabs-tail-check-"));
    const audioPath = join(tempDir, "continuation.mp3");
    try {
      await writeFile(audioPath, new Uint8Array(audio));
      if (await hasAudibleContinuationTail(audioPath)) {
        return { audio, attempts: index + 1, loopFilled: false };
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
    }
    if (attempt.loop) {
      const filled = await fillLoopableContinuation(audio, generationDurationSeconds, signal);
      return {
        audio: filled,
        attempts: index + 1,
        loopFilled: true,
      };
    }
  }
  throw new Error("ElevenLabs generated an unusable continuation twice");
}

export async function extendAudioWithElevenLabs(
  engine: Engine,
  payload: ExtendAudioPayload,
  provider: ElevenLabsProvider,
  signal?: AbortSignal,
): Promise<{
  duration: number;
  sourceDescription: string;
  generationAttempts: number;
  loopFilled: boolean;
}> {
  const source = await engine.files.read(payload.sourceAssetId, payload.sourceFilename);
  if (!source.ok) throw new Error(`Failed to read source audio: ${source.error.message}`);

  const sourceBytes = new Uint8Array(source.value);
  const transcript = await provider.v1.speechToText({
    model_id: ELEVENLABS_SCRIBE_MODEL,
    file: new Blob([sourceBytes], { type: audioMime(payload.sourceFilename) }),
    tag_audio_events: true,
    diarize: false,
  }, signal);
  const sourceDescription = describeSourceAudio(transcript);
  const continuationDurationMs = payload.targetDurationMs - payload.sourceDurationMs;
  const crossfadeMs = audioCrossfadeMs(payload.sourceDurationMs, continuationDurationMs);
  const generationDurationSeconds = (continuationDurationMs + crossfadeMs) / 1000;
  const generationPrompt = buildSoundContinuationPrompt(
    sourceDescription,
    generationDurationSeconds,
    payload.continuationPrompt,
  );
  const generated = await generateAudibleContinuation(
    provider,
    generationPrompt,
    generationDurationSeconds,
    signal,
  );

  const output = await renderContinuation(
    source.value,
    payload.sourceFilename,
    generated.audio,
    payload.sourceDurationMs,
    payload.targetDurationMs,
    crossfadeMs,
    signal,
  );
  const write = await engine.files.write(payload.audAssetId, "original.mp3", output);
  if (!write.ok) throw new Error(`Failed to write extended audio: ${write.error.message}`);

  const assetDir = await engine.workspaces.resolveArtifact(payload.audAssetId);
  if (!assetDir.ok) throw new Error(`Failed to resolve extended audio: ${assetDir.error.message}`);
  const probe = await probeVideo(join(assetDir.value, "original.mp3"));
  const duration = probe.audioDuration ?? probe.duration;
  const targetSeconds = payload.targetDurationMs / 1000;
  if (!Number.isFinite(duration) || Math.abs(duration - targetSeconds) > DURATION_TOLERANCE_SECONDS) {
    throw new Error(`Extended audio is ${duration.toFixed(3)}s, expected ${targetSeconds.toFixed(3)}s`);
  }

  const metadata = await engine.metadata.artifacts.write(payload.audAssetId, "original", {
    origin: "elevenlabs_sound_generation_extend",
    provider: "elevenlabs",
    transcription_model: ELEVENLABS_SCRIBE_MODEL,
    generation_model: ELEVENLABS_SOUND_EFFECT_MODEL,
    output_format: ELEVENLABS_SOUND_EFFECT_OUTPUT_FORMAT,
    source_asset: payload.sourceAssetId,
    source_description: sourceDescription,
    source_duration: payload.sourceDurationMs / 1000,
    target_duration: targetSeconds,
    continuation_duration: continuationDurationMs / 1000,
    generation_duration: generationDurationSeconds,
    generation_attempts: generated.attempts,
    generation_loop_filled: generated.loopFilled,
    crossfade_duration: crossfadeMs / 1000,
    continuation_prompt: payload.continuationPrompt ?? null,
    duration,
    generated_at: new Date().toISOString(),
  });
  if (!metadata.ok) throw new Error(`Failed to write extended audio metadata: ${metadata.error.message}`);

  return {
    duration,
    sourceDescription,
    generationAttempts: generated.attempts,
    loopFilled: generated.loopFilled,
  };
}

export function registerExtendAudioJob(engine: Engine): void {
  registerJobHandler("extend_audio", async (rawPayload, ctx) => {
    const payload = rawPayload as ExtendAudioPayload;
    ctx.getOwnerId();
    const provider = createElevenLabs({
      apiKey: requireApiKey("ELEVENLABS_API_KEY"),
      timeout: ELEVENLABS_TIMEOUT_MS,
    });
    const result = await extendAudioWithElevenLabs(engine, payload, provider, ctx.signal);
    return { success: true, provider: "elevenlabs" as const, ...result };
  });
}
