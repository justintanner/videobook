import { createElevenLabs, type ElevenLabsProvider } from "@apicity/elevenlabs";
import type { Engine } from "videobook-engine";
import { extname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { requireApiKey } from "../api-key.js";
import {
  extractWaveform,
  probeVideo,
  runFfmpeg,
  type ProbeResult,
  type ProbeStream,
} from "../ffmpeg.js";
import { registerJobHandler } from "../queue.js";

const PROVIDER_TIMEOUT_MS = 30 * 60_000;
const SAMPLE_RATE_HZ = 48_000;
const MIN_DURATION_MS = 10_000;
const MAX_DURATION_MS = 30_000;
const MAX_SHORTFALL_SECONDS = 0.25;
const OUTPUT_FILENAME = "original.wav";
const OUTPUT_FORMAT = "mp3_48000_192";
const BASE_DIRECTION = "Create a new instrumental using only drums and a string ensemble. Follow the uploaded reference as strongly as possible for tempo, groove, rhythmic accents, and phrase timing. Start immediately at full musical activity. An optional direction may refine those qualities but must not add vocals or other instruments.";
const POSITIVE_STYLES = [
  "instrumental",
  "drums and string ensemble only",
  "preserve source tempo",
  "preserve source groove",
  "preserve rhythmic accents",
  "preserve phrase timing",
  "immediate start",
  "strongest audio-reference following",
];
const NEGATIVE_STYLES = [
  "vocals",
  "speech",
  "choir",
  "piano",
  "guitar",
  "bass guitar",
  "synth",
  "brass",
  "woodwinds",
  "effects",
  "ambience",
];

export type ReplicateSongPayload = {
  type: "generate_replicated_song";
  audAssetId: string;
  sourceAssetId: string;
  sourceFilename: string;
  targetDurationMs: number;
  direction?: string;
  bookId: string;
};

type ReplicateSongResult = {
  duration: number;
  durationTicks: number;
  generatedDuration: number;
  songId: string;
};

function targetSamples(targetDurationMs: number): number {
  if (
    !Number.isSafeInteger(targetDurationMs)
    || targetDurationMs < MIN_DURATION_MS
    || targetDurationMs > MAX_DURATION_MS
  ) {
    throw new Error(`Replicated song duration must be an integer from ${MIN_DURATION_MS} to ${MAX_DURATION_MS} milliseconds`);
  }
  return targetDurationMs * SAMPLE_RATE_HZ / 1_000;
}

function audioFilter(samples: number): string {
  return [
    `aresample=${SAMPLE_RATE_HZ}:async=1:first_pts=0`,
    "aformat=sample_fmts=s16:channel_layouts=stereo",
    "apad",
    `atrim=end_sample=${samples}`,
    "asetpts=PTS-STARTPTS",
  ].join(",");
}

async function renderExactWav(
  inputPath: string,
  outputPath: string,
  samples: number,
  signal?: AbortSignal,
): Promise<void> {
  await runFfmpeg([
    "-y",
    "-i", inputPath,
    "-map", "0:a:0",
    "-vn",
    "-af", audioFilter(samples),
    "-c:a", "pcm_s16le",
    "-ar", String(SAMPLE_RATE_HZ),
    "-ac", "2",
    outputPath,
  ], { signal });
}

async function decodePcmWav(
  inputPath: string,
  outputPath: string,
  signal?: AbortSignal,
): Promise<void> {
  await runFfmpeg([
    "-y",
    "-i", inputPath,
    "-map", "0:a:0",
    "-vn",
    "-af", `aresample=${SAMPLE_RATE_HZ},aformat=sample_fmts=s16:channel_layouts=stereo`,
    "-c:a", "pcm_s16le",
    "-ar", String(SAMPLE_RATE_HZ),
    "-ac", "2",
    outputPath,
  ], { signal });
}

function requirePcmStream(
  probe: ProbeResult,
  label: string,
): ProbeStream {
  const stream = probe.audioStream;
  if (!probe.hasAudio || !stream?.audio) {
    throw new Error(`${label} has no usable audio stream`);
  }
  if (stream.codec !== "pcm_s16le") {
    throw new Error(`${label} codec is ${stream.codec}, expected pcm_s16le`);
  }
  if (stream.audio.sampleRateHz !== SAMPLE_RATE_HZ) {
    throw new Error(`${label} sample rate is ${stream.audio.sampleRateHz}, expected ${SAMPLE_RATE_HZ}`);
  }
  if (stream.audio.channels !== 2) {
    throw new Error(`${label} has ${stream.audio.channels} channels, expected 2`);
  }
  return stream;
}

function requireExactPcmStream(
  probe: ProbeResult,
  samples: number,
  label: string,
): ProbeStream {
  const stream = requirePcmStream(probe, label);
  if (stream.durationTicks !== samples) {
    throw new Error(`${label} has ${stream.durationTicks} samples, expected ${samples}`);
  }
  return stream;
}

async function registerOutputStream(
  fs: Engine,
  assetId: string,
  stream: ProbeStream,
): Promise<void> {
  const manifest = await fs.files.manifest(assetId);
  if (!manifest.ok) throw new Error(`Failed to read replicated song manifest: ${manifest.error.message}`);
  const file = manifest.value.files.find((candidate) => candidate.name === OUTPUT_FILENAME);
  if (!file) throw new Error(`Replicated song is missing ${OUTPUT_FILENAME}`);
  const registered = await fs.streams.register({
    artifactId: assetId,
    sourcePath: OUTPUT_FILENAME,
    objectHash: file.objectHash,
    streamIndex: stream.index,
    kind: "audio",
    timeBase: stream.timeBase,
    durationTicks: stream.durationTicks,
    codec: stream.codec,
    audio: stream.audio!,
  });
  if (!registered.ok) throw new Error(`Failed to register replicated song stream: ${registered.error.message}`);
}

function generationText(direction: string | undefined): string {
  const trimmed = direction?.trim();
  return trimmed ? `${BASE_DIRECTION} ${trimmed}` : BASE_DIRECTION;
}

export async function replicateSongWithElevenLabs(
  fs: Engine,
  payload: ReplicateSongPayload,
  provider: ElevenLabsProvider,
  signal?: AbortSignal,
): Promise<ReplicateSongResult> {
  const samples = targetSamples(payload.targetDurationMs);
  const targetSeconds = payload.targetDurationMs / 1_000;
  const source = await fs.files.read(payload.sourceAssetId, payload.sourceFilename);
  if (!source.ok) throw new Error(`Failed to read source media: ${source.error.message}`);

  const scratch = await mkdtemp(join(tmpdir(), "videobook-replicate-song-"));
  const sourcePath = join(scratch, `source${extname(payload.sourceFilename) || ".media"}`);
  const referencePath = join(scratch, "reference.wav");
  const generatedPath = join(scratch, "generated.mp3");
  const decodedPath = join(scratch, "generated.wav");
  const outputPath = join(scratch, OUTPUT_FILENAME);

  try {
    signal?.throwIfAborted();
    await writeFile(sourcePath, source.value);
    await renderExactWav(sourcePath, referencePath, samples, signal);
    requireExactPcmStream(await probeVideo(referencePath, { signal }), samples, "Extracted reference audio");

    const reference = await readFile(referencePath);
    const uploaded = await provider.v1.music.upload({
      file: new Blob([new Uint8Array(reference)], { type: "audio/wav" }),
    }, signal);
    if (!uploaded.song_id?.trim()) throw new Error("ElevenLabs music upload returned no song id");

    const generated = await provider.v1.music({
      model_id: "music_v2",
      output_format: OUTPUT_FORMAT,
      composition_plan: {
        chunks: [{
          text: generationText(payload.direction),
          duration_ms: payload.targetDurationMs,
          positive_styles: POSITIVE_STYLES,
          negative_styles: NEGATIVE_STYLES,
          context_adherence: "high",
          conditioning_ref: {
            song_id: uploaded.song_id,
            range: { start_ms: 0, end_ms: payload.targetDurationMs },
          },
          condition_strength: "xhigh",
        }],
      },
    }, signal);
    await writeFile(generatedPath, new Uint8Array(generated));

    await decodePcmWav(generatedPath, decodedPath, signal);
    const generatedStream = requirePcmStream(
      await probeVideo(decodedPath, { signal }),
      "Decoded ElevenLabs replicated song",
    );
    const generatedDuration = generatedStream.durationTicks / SAMPLE_RATE_HZ;
    if (!Number.isFinite(generatedDuration) || generatedDuration <= 0) {
      throw new Error(`ElevenLabs replicated song has invalid duration ${generatedDuration}`);
    }
    const shortfall = targetSeconds - generatedDuration;
    if (shortfall > MAX_SHORTFALL_SECONDS) {
      throw new Error(`ElevenLabs replicated song is ${shortfall.toFixed(3)}s short; maximum allowed shortfall is ${MAX_SHORTFALL_SECONDS.toFixed(3)}s`);
    }

    await renderExactWav(decodedPath, outputPath, samples, signal);
    requireExactPcmStream(await probeVideo(outputPath, { signal }), samples, "Normalized replicated song");

    const persisted = await fs.files.writeFromPath(payload.audAssetId, OUTPUT_FILENAME, outputPath);
    if (!persisted.ok) throw new Error(`Failed to persist replicated song: ${persisted.error.message}`);
    const persistedProbe = await probeVideo(persisted.value, { signal });
    const persistedStream = requireExactPcmStream(persistedProbe, samples, "Persisted replicated song");
    await registerOutputStream(fs, payload.audAssetId, persistedStream);

    const waveform = await extractWaveform(persisted.value);
    const waveformWrite = await fs.metadata.waveforms.write(payload.audAssetId, waveform);
    if (!waveformWrite.ok) throw new Error(`Failed to write replicated song waveform: ${waveformWrite.error.message}`);

    const metadataWrite = await fs.metadata.artifacts.write(payload.audAssetId, "original", {
      origin: "make_cover_song",
      provider: "elevenlabs",
      model: "music_v2",
      output_format: OUTPUT_FORMAT,
      source_asset: payload.sourceAssetId,
      source_filename: payload.sourceFilename,
      conditioning_song_id: uploaded.song_id,
      conditioning_strength: "xhigh",
      context_adherence: "high",
      arrangement: "drums_and_strings",
      direction: payload.direction?.trim() || null,
      target_duration_ms: payload.targetDurationMs,
      generated_duration: generatedDuration,
      duration: targetSeconds,
      target_samples_per_channel: samples,
      instrumental_requested: true,
      sampleRateHz: SAMPLE_RATE_HZ,
      channels: 2,
      generated_at: new Date().toISOString(),
    });
    if (!metadataWrite.ok) throw new Error(`Failed to write replicated song metadata: ${metadataWrite.error.message}`);

    return {
      duration: targetSeconds,
      durationTicks: samples,
      generatedDuration,
      songId: uploaded.song_id,
    };
  } finally {
    await rm(scratch, { recursive: true, force: true, maxRetries: 3 });
  }
}

export function registerReplicateSongJob(fs: Engine): void {
  registerJobHandler("generate_replicated_song", async (rawPayload, ctx) => {
    ctx.getOwnerId();
    const payload = rawPayload as ReplicateSongPayload;
    const provider = createElevenLabs({
      apiKey: requireApiKey("ELEVENLABS_API_KEY"),
      timeout: PROVIDER_TIMEOUT_MS,
    });
    const result = await replicateSongWithElevenLabs(fs, payload, provider, ctx.signal);
    return { success: true, provider: "elevenlabs" as const, ...result };
  });
}
