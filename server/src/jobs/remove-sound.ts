import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import {
  createElevenLabs,
  type ElevenLabsProvider,
  type ElevenLabsSpeechToTextResponse,
  type ElevenLabsTranscriptWord,
} from "@apicity/elevenlabs";
import type { Engine } from "videobook-engine";
import { requireApiKey } from "../api-key.js";
import { ELEVENLABS_SCRIBE_MODEL } from "../elevenlabs-audio-extension.js";
import { AUDIO_OPTS, extractWaveform, probeVideo, runFfmpeg } from "../ffmpeg.js";
import { queue, registerJobHandler } from "../queue.js";
import { withLockedLocalLease } from "./_lease.js";

const LOCK_DURATION_MS = 30 * 60_000;
const ELEVENLABS_TIMEOUT_MS = 10 * 60_000;
const MAX_REMOVAL_COVERAGE = 0.95;
export const SOUND_SEGMENT_PADDING_SECONDS = 0.15;
export const SOUND_SEGMENT_FADE_SECONDS = 0.05;

const QUERY_STOPWORDS = new Set([
  "a", "an", "the", "of", "some", "any", "all", "that", "this",
  "sound", "sounds", "noise", "noises", "audio", "sfx", "effect", "effects",
]);

const STALE_DERIVATIVES = [
  ".original.analysis.json",
  ".analysis.gpt4otrans.json",
  "elevenlabs.json",
  ".suggest-sfx.json",
];

export type RemoveSoundAssetKind = "video" | "audio";

export type SoundEvent = {
  text: string;
  start: number;
  end: number;
};

export type SoundSegment = {
  start: number;
  end: number;
};

export type RemoveSoundPayload = {
  type: "remove_sound";
  assetId: string;
  assetKind: RemoveSoundAssetKind;
  assetDir: string;
  filename: string;
  sound: string;
  bookId: string;
};

export type RemoveSoundResult = {
  success: true;
  asset_id: string;
  sound: string;
  matched_events: SoundEvent[];
  removed_segments: SoundSegment[];
  removed_seconds: number;
  detected_events: string[];
  duration: number;
};

function decimal(value: number): string {
  return value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

function mediaMime(filename: string): string {
  switch (extname(filename).toLowerCase()) {
    case ".mp3": return "audio/mpeg";
    case ".wav": return "audio/wav";
    case ".m4a": return "audio/mp4";
    case ".ogg": return "audio/ogg";
    case ".flac": return "audio/flac";
    case ".mp4":
    case ".m4v": return "video/mp4";
    case ".mov": return "video/quicktime";
    case ".webm": return "video/webm";
    case ".mkv": return "video/x-matroska";
    default: return "application/octet-stream";
  }
}

function soundTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function commonPrefixLength(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let length = 0;
  while (length < limit && a[length] === b[length]) length++;
  return length;
}

function stemCandidates(token: string): Set<string> {
  const candidates = new Set([token]);
  for (const suffix of ["ing", "ed", "es", "s"]) {
    if (token.endsWith(suffix) && token.length - suffix.length >= 3) {
      candidates.add(token.slice(0, token.length - suffix.length));
    }
  }
  return candidates;
}

function tokensMatch(a: string, b: string): boolean {
  for (const stemA of stemCandidates(a)) {
    for (const stemB of stemCandidates(b)) {
      if (stemA === stemB || commonPrefixLength(stemA, stemB) >= 5) return true;
    }
  }
  return false;
}

export function extractAudioEvents(response: ElevenLabsSpeechToTextResponse): SoundEvent[] {
  const words: ElevenLabsTranscriptWord[] = "words" in response && Array.isArray(response.words)
    ? response.words
    : "transcripts" in response && Array.isArray(response.transcripts)
      ? response.transcripts.flatMap((transcript) => transcript.words)
      : [];
  return words
    .filter((word) => word.type === "audio_event" && word.end > word.start)
    .map((word) => ({
      text: word.text.replace(/^\[|\]$/g, "").trim(),
      start: word.start,
      end: word.end,
    }));
}

export function matchSoundEvents(events: SoundEvent[], sound: string): SoundEvent[] {
  const queryTokens = soundTokens(sound).filter((token) => !QUERY_STOPWORDS.has(token));
  if (queryTokens.length === 0) {
    throw new Error(`Describe the sound to remove more specifically than "${sound}"`);
  }
  return events.filter((event) => {
    const eventTokens = soundTokens(event.text);
    return queryTokens.every((queryToken) =>
      eventTokens.some((eventToken) => tokensMatch(queryToken, eventToken)));
  });
}

export function mergeSoundSegments(
  events: SoundEvent[],
  durationSeconds: number,
  paddingSeconds: number = SOUND_SEGMENT_PADDING_SECONDS,
): SoundSegment[] {
  const toMilliseconds = (value: number): number => Math.round(value * 1000) / 1000;
  const padded = events
    .map((event) => ({
      start: toMilliseconds(Math.max(0, event.start - paddingSeconds)),
      end: toMilliseconds(Math.min(durationSeconds, event.end + paddingSeconds)),
    }))
    .filter((segment) => segment.end > segment.start)
    .sort((a, b) => a.start - b.start);

  const merged: SoundSegment[] = [];
  for (const segment of padded) {
    const previous = merged[merged.length - 1];
    if (previous && segment.start <= previous.end + SOUND_SEGMENT_FADE_SECONDS * 2) {
      previous.end = Math.max(previous.end, segment.end);
    } else {
      merged.push({ ...segment });
    }
  }
  return merged;
}

export function buildSoundRemovalFilter(
  segments: SoundSegment[],
  fadeSeconds: number = SOUND_SEGMENT_FADE_SECONDS,
): string {
  if (segments.length === 0) throw new Error("No segments to remove");
  const fade = decimal(fadeSeconds);
  // Each gate ramps 0→1 over [start-fade, start], holds 1 across the segment,
  // and ramps back over [end, end+fade]; volume is the product of (1 - gate).
  const gates = segments.map((segment) => {
    const rampInStart = decimal(segment.start - fadeSeconds);
    const rampOutEnd = decimal(segment.end + fadeSeconds);
    return `(1-clip((t-${rampInStart})/${fade},0,1)*clip((${rampOutEnd}-t)/${fade},0,1))`;
  });
  return [
    "[0:a:0]aresample=48000",
    "aformat=sample_fmts=fltp:channel_layouts=stereo",
    `volume=volume='${gates.join("*")}':eval=frame[outa]`,
  ].join(",");
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
      throw new Error(`Unsupported audio format: ${extname(outputPath) || "unknown"}`);
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

export async function renderSoundRemoval(
  inputPath: string,
  outputPath: string,
  assetKind: RemoveSoundAssetKind,
  segments: SoundSegment[],
  signal?: AbortSignal,
): Promise<void> {
  const inputProbe = await probeVideo(inputPath, { signal });
  if (!inputProbe.hasAudio) throw new Error("Asset has no audio stream");
  const inputDuration = assetKind === "video"
    ? (inputProbe.videoDuration > 0 ? inputProbe.videoDuration : inputProbe.duration)
    : (inputProbe.audioDuration ?? inputProbe.duration);

  const args = ["-y", "-i", inputPath, "-filter_complex", buildSoundRemovalFilter(segments)];
  if (assetKind === "video") {
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
  if (!outputProbe.hasAudio) throw new Error("Sound removal output has no audio stream");
  if (assetKind === "video") {
    if (outputProbe.videoCodec === null) throw new Error("Sound removal output has no video stream");
    if (outputProbe.videoCodec !== inputProbe.videoCodec) {
      throw new Error(`Sound removal changed the video codec from ${inputProbe.videoCodec} to ${outputProbe.videoCodec}`);
    }
    if (Math.abs(outputProbe.videoDuration - inputDuration) > 0.5) {
      throw new Error(`Sound removal changed video duration from ${inputDuration.toFixed(3)}s to ${outputProbe.videoDuration.toFixed(3)}s`);
    }
    return;
  }
  const outputDuration = outputProbe.audioDuration ?? outputProbe.duration;
  if (Math.abs(outputDuration - inputDuration) > 0.5) {
    throw new Error(`Sound removal changed audio duration from ${inputDuration.toFixed(3)}s to ${outputDuration.toFixed(3)}s`);
  }
}

function describeDetectedEvents(events: SoundEvent[]): string[] {
  return events.map((event) => `[${event.text}] ${event.start.toFixed(2)}-${event.end.toFixed(2)}s`);
}

export async function removeSoundWithElevenLabs(
  fs: Engine,
  payload: RemoveSoundPayload,
  provider: ElevenLabsProvider,
  signal?: AbortSignal,
): Promise<Omit<RemoveSoundResult, "success">> {
  const inputPath = join(payload.assetDir, payload.filename);
  const inputProbe = await probeVideo(inputPath, { signal });
  const duration = payload.assetKind === "video"
    ? (inputProbe.videoDuration > 0 ? inputProbe.videoDuration : inputProbe.duration)
    : (inputProbe.audioDuration ?? inputProbe.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`Could not determine a valid duration for ${payload.assetId}`);
  }

  const source = await fs.files.read(payload.assetId, payload.filename);
  if (!source.ok) throw new Error(`Failed to read ${payload.assetId}: ${source.error.message}`);
  const sourceBytes = new Uint8Array(source.value);
  const transcript = await provider.v1.speechToText({
    model_id: ELEVENLABS_SCRIBE_MODEL,
    file: new Blob([sourceBytes], { type: mediaMime(payload.filename) }),
    tag_audio_events: true,
    diarize: false,
  }, signal);

  const events = extractAudioEvents(transcript);
  const matched = matchSoundEvents(events, payload.sound);
  if (matched.length === 0) {
    const detected = describeDetectedEvents(events);
    throw new Error(detected.length === 0
      ? `Scribe found no tagged audio events in ${payload.assetId}, so there is no "${payload.sound}" to remove`
      : `No audio event matching "${payload.sound}" in ${payload.assetId}. Detected events: ${detected.join(", ")}`);
  }

  const segments = mergeSoundSegments(matched, duration);
  const removedSeconds = segments.reduce((sum, segment) => sum + (segment.end - segment.start), 0);
  if (removedSeconds / duration > MAX_REMOVAL_COVERAGE) {
    throw new Error(`"${payload.sound}" spans ${removedSeconds.toFixed(2)}s of the ${duration.toFixed(2)}s asset — removing it would leave near-silence`);
  }

  const tempDir = await mkdtemp(join(tmpdir(), "videocity-remove-sound-"));
  try {
    const extension = extname(payload.filename) || (payload.assetKind === "video" ? ".mp4" : ".mp3");
    const outputPath = join(tempDir, `removed${extension}`);
    await renderSoundRemoval(inputPath, outputPath, payload.assetKind, segments, signal);
    const output = await readFile(outputPath);
    const written = await fs.files.write(payload.assetId, payload.filename, output);
    if (!written.ok) throw new Error(`Failed to replace ${payload.filename}: ${written.error.message}`);
  } finally {
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  }

  for (const filename of STALE_DERIVATIVES) {
    const result = await fs.files.delete(payload.assetId, filename);
    if (!result.ok && result.error.code !== "NOT_FOUND") {
      throw new Error(`Failed to delete stale ${filename}: ${result.error.message}`);
    }
  }

  if (payload.assetKind === "audio") {
    const peaks = await extractWaveform(inputPath);
    const waveform = await fs.metadata.waveforms.write(payload.assetId, peaks);
    if (!waveform.ok) throw new Error(`Failed to update audio waveform: ${waveform.error.message}`);
  }

  return {
    asset_id: payload.assetId,
    sound: payload.sound,
    matched_events: matched,
    removed_segments: segments,
    removed_seconds: removedSeconds,
    detected_events: describeDetectedEvents(events),
    duration,
  };
}

export function registerRemoveSoundJob(fs: Engine): void {
  registerJobHandler("remove_sound", async (rawPayload, ctx) => {
    const payload = rawPayload as RemoveSoundPayload;
    const provider = createElevenLabs({
      apiKey: requireApiKey("ELEVENLABS_API_KEY"),
      timeout: ELEVENLABS_TIMEOUT_MS,
    });

    const result = await withLockedLocalLease(
      fs,
      payload.bookId,
      payload.assetId,
      payload.assetDir,
      ctx,
      "replace_audio",
      { durationMs: LOCK_DURATION_MS, data: { state: "removing-sound" } },
      () => removeSoundWithElevenLabs(fs, payload, provider, ctx.signal),
      { durationMs: LOCK_DURATION_MS, waitForActiveMs: 30_000 },
    );

    if (payload.assetKind === "video") {
      await queue.enqueue(`process-video-${payload.assetId}-${Date.now()}`, {
        type: "process_video",
        videoPath: join(payload.assetDir, payload.filename),
        assetId: payload.assetId,
        assetDir: payload.assetDir,
        bookId: payload.bookId,
        provenance: {
          origin: "remove_sound",
          provider: "elevenlabs",
          removed_sound: payload.sound,
          removed_segments: result.removed_segments,
          removed_at: new Date().toISOString(),
        },
        force: true,
      } as unknown as Record<string, unknown>);
    }

    return { success: true, ...result } satisfies RemoveSoundResult;
  });
}
