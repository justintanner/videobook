import type { Engine } from "videobook-engine";
import { randomInt } from "node:crypto";
import { extname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { synthCover } from "../acestep/client.js";
import { aceStepConfig } from "../acestep/config.js";
import { ensureAceServer, withSynthLock } from "../acestep/process.js";
import {
  extractWaveform,
  probeVideo,
  runFfmpeg,
  type ProbeResult,
  type ProbeStream,
} from "../ffmpeg.js";
import { registerJobHandler } from "../queue.js";

const SYNTH_TIMEOUT_MS = 30 * 60_000;
const SAMPLE_RATE_HZ = 48_000;
const MIN_DURATION_MS = 10_000;
const MAX_DURATION_MS = 240_000;
const MAX_SHORTFALL_SECONDS = 0.25;
const OUTPUT_FILENAME = "original.wav";
const OUTPUT_FORMAT = "wav16";
// Tag-style caption: ACE-Step captions are genre/style conditioning through the
// Qwen3 text encoder, not free-form instructions. Vocal suppression comes from
// the pinned "[Instrumental]" lyrics, which acestep.cpp passes verbatim to the DiT.
const BASE_CAPTION = "instrumental cover, drums and string ensemble only, cinematic strings, punchy drums, follows the source rhythm and phrasing, immediate start, no vocals";
const INSTRUMENTAL_LYRICS = "[Instrumental]";
const TASK_TYPE = "cover";
const AUDIO_COVER_STRENGTH = 1.0;
const INFERENCE_STEPS = 0;

export type AcestepCoverPayload = {
  type: "generate_acestep_cover";
  audAssetId: string;
  sourceAssetId: string;
  sourceFilename: string;
  targetDurationMs: number;
  direction?: string;
  bookId: string;
};

type AcestepCoverResult = {
  duration: number;
  durationTicks: number;
  generatedDuration: number;
  seed: number;
};

function targetSamples(targetDurationMs: number): number {
  if (
    !Number.isSafeInteger(targetDurationMs)
    || targetDurationMs < MIN_DURATION_MS
    || targetDurationMs > MAX_DURATION_MS
  ) {
    throw new Error(`Cover song duration must be an integer from ${MIN_DURATION_MS} to ${MAX_DURATION_MS} milliseconds`);
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
  if (!manifest.ok) throw new Error(`Failed to read cover song manifest: ${manifest.error.message}`);
  const file = manifest.value.files.find((candidate) => candidate.name === OUTPUT_FILENAME);
  if (!file) throw new Error(`Cover song is missing ${OUTPUT_FILENAME}`);
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
  if (!registered.ok) throw new Error(`Failed to register cover song stream: ${registered.error.message}`);
}

function coverCaption(direction: string | undefined): string {
  const trimmed = direction?.trim();
  return trimmed ? `${BASE_CAPTION}, ${trimmed}` : BASE_CAPTION;
}

export async function coverSongWithAcestep(
  fs: Engine,
  payload: AcestepCoverPayload,
  signal?: AbortSignal,
): Promise<AcestepCoverResult> {
  const samples = targetSamples(payload.targetDurationMs);
  const targetSeconds = payload.targetDurationMs / 1_000;
  const config = aceStepConfig();
  const source = await fs.files.read(payload.sourceAssetId, payload.sourceFilename);
  if (!source.ok) throw new Error(`Failed to read source media: ${source.error.message}`);

  const scratch = await mkdtemp(join(tmpdir(), "videobook-acestep-cover-"));
  const sourcePath = join(scratch, `source${extname(payload.sourceFilename) || ".media"}`);
  const referencePath = join(scratch, "reference.wav");
  const generatedPath = join(scratch, "generated.wav");
  const decodedPath = join(scratch, "decoded.wav");
  const outputPath = join(scratch, OUTPUT_FILENAME);

  try {
    signal?.throwIfAborted();
    await writeFile(sourcePath, source.value);
    await renderExactWav(sourcePath, referencePath, samples, signal);
    requireExactPcmStream(await probeVideo(referencePath, { signal }), samples, "Extracted reference audio");

    const server = await ensureAceServer({ signal });
    const seed = randomInt(0, 2 ** 31 - 1);
    const caption = coverCaption(payload.direction);
    const synth = await withSynthLock(() => synthCover(
      server.baseUrl,
      referencePath,
      {
        caption,
        lyrics: INSTRUMENTAL_LYRICS,
        taskType: TASK_TYPE,
        outputFormat: OUTPUT_FORMAT,
        seed,
        inferenceSteps: INFERENCE_STEPS,
        audioCoverStrength: AUDIO_COVER_STRENGTH,
        synthBatchSize: 1,
        synthModel: config.model,
        duration: 0,
      },
      { signal, timeoutMs: SYNTH_TIMEOUT_MS },
    ));
    await writeFile(generatedPath, synth.audio);

    await decodePcmWav(generatedPath, decodedPath, signal);
    const generatedStream = requirePcmStream(
      await probeVideo(decodedPath, { signal }),
      "Decoded ACE-Step cover song",
    );
    const generatedDuration = generatedStream.durationTicks / SAMPLE_RATE_HZ;
    if (!Number.isFinite(generatedDuration) || generatedDuration <= 0) {
      throw new Error(`ACE-Step cover song has invalid duration ${generatedDuration}`);
    }
    const shortfall = targetSeconds - generatedDuration;
    if (shortfall > MAX_SHORTFALL_SECONDS) {
      throw new Error(`ACE-Step cover song is ${shortfall.toFixed(3)}s short; maximum allowed shortfall is ${MAX_SHORTFALL_SECONDS.toFixed(3)}s`);
    }

    await renderExactWav(decodedPath, outputPath, samples, signal);
    requireExactPcmStream(await probeVideo(outputPath, { signal }), samples, "Normalized cover song");

    const persisted = await fs.files.writeFromPath(payload.audAssetId, OUTPUT_FILENAME, outputPath);
    if (!persisted.ok) throw new Error(`Failed to persist cover song: ${persisted.error.message}`);
    const persistedProbe = await probeVideo(persisted.value, { signal });
    const persistedStream = requireExactPcmStream(persistedProbe, samples, "Persisted cover song");
    await registerOutputStream(fs, payload.audAssetId, persistedStream);

    const waveform = await extractWaveform(persisted.value);
    const waveformWrite = await fs.metadata.waveforms.write(payload.audAssetId, waveform);
    if (!waveformWrite.ok) throw new Error(`Failed to write cover song waveform: ${waveformWrite.error.message}`);

    const metadataWrite = await fs.metadata.artifacts.write(payload.audAssetId, "original", {
      origin: "make_cover_song",
      provider: "acestep.cpp",
      model: config.model,
      task_type: TASK_TYPE,
      output_format: OUTPUT_FORMAT,
      audio_cover_strength: AUDIO_COVER_STRENGTH,
      inference_steps: INFERENCE_STEPS,
      seed,
      caption,
      lyrics: INSTRUMENTAL_LYRICS,
      arrangement: "drums_and_strings",
      source_asset: payload.sourceAssetId,
      source_filename: payload.sourceFilename,
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
    if (!metadataWrite.ok) throw new Error(`Failed to write cover song metadata: ${metadataWrite.error.message}`);

    return {
      duration: targetSeconds,
      durationTicks: samples,
      generatedDuration,
      seed,
    };
  } finally {
    await rm(scratch, { recursive: true, force: true, maxRetries: 3 });
  }
}

export function registerAcestepCoverJob(fs: Engine): void {
  registerJobHandler("generate_acestep_cover", async (rawPayload, ctx) => {
    ctx.getOwnerId();
    const payload = rawPayload as AcestepCoverPayload;
    // ctx.signal aborts the ffmpeg passes and the /synth fetch; ace-server has
    // no cancellation API, so an aborted generation finishes server-side and is
    // discarded. Acceptable for a single-user local runtime.
    const result = await coverSongWithAcestep(fs, payload, ctx.signal);
    return { success: true, provider: "acestep.cpp" as const, ...result };
  });
}
