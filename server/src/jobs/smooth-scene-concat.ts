import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Engine } from "videobook-engine";
import {
  AUDIO_OPTS,
  FFMPEG,
  H264_MEDIUM,
  probeVideo,
  runFfmpeg,
  type ProbeResult,
} from "../ffmpeg.js";
import { registerJobHandler, queue } from "../queue.js";
import { withLockedLocalLease } from "./_lease.js";
import { ingestWorkspaceOutputs } from "./_persist-output.js";

const execFileAsync = promisify(execFile);

const LOCK_DURATION_MS = 1_800_000;
const PCM_SAMPLE_RATE = 8_000;
const MIN_AUDIO_OVERLAP_SECONDS = 0.08;
const MAX_AUDIO_OVERLAP_SECONDS = 3;
const AUDIO_MATCH_THRESHOLD = 0.8;
const DEFAULT_TRANSITION_SECONDS = 0.35;
const MIN_TRANSITION_SECONDS = 0.05;

type SmoothSceneConcatPayload = {
  type: "smooth_scene_concat";
  firstPath: string;
  secondPath: string;
  outputPath: string;
  firstAssetId: string;
  secondAssetId: string;
  assetId: string;
  assetDir: string;
  bookId: string;
  transitionSeconds?: number;
};

export type AudioOverlapMatch = {
  overlapSeconds: number;
  score: number;
};

export type SmoothSceneConcatResult = {
  mode: "audio_match" | "fixed";
  transitionSeconds: number;
  secondStartSeconds: number;
  audioOverlapSeconds: number;
  matchScore: number | null;
  outputDuration: number;
};

export type SmoothSceneConcatOptions = {
  firstPath: string;
  secondPath: string;
  outputPath: string;
  transitionSeconds?: number;
  signal?: AbortSignal;
};

type TransitionTiming = Omit<SmoothSceneConcatResult, "outputDuration">;

function mediaNumber(value: number): string {
  return value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

async function decodeMonoPcm(
  path: string,
  startSeconds: number,
  durationSeconds: number,
  signal?: AbortSignal,
): Promise<Int16Array> {
  const { stdout } = await execFileAsync(FFMPEG, [
    "-hide_banner",
    "-loglevel", "error",
    "-i", path,
    "-ss", mediaNumber(startSeconds),
    "-t", mediaNumber(durationSeconds),
    "-map", "0:a:0",
    "-vn",
    "-ac", "1",
    "-ar", String(PCM_SAMPLE_RATE),
    "-f", "s16le",
    "pipe:1",
  ], {
    encoding: "buffer",
    maxBuffer: 2 * 1024 * 1024,
    signal,
  });
  const buffer = stdout as unknown as Buffer;
  return new Int16Array(
    buffer.buffer,
    buffer.byteOffset,
    Math.floor(buffer.byteLength / Int16Array.BYTES_PER_ELEMENT),
  );
}

function correlationForOverlap(
  first: Int16Array,
  second: Int16Array,
  overlapSamples: number,
): number | null {
  const firstStart = first.length - overlapSamples;
  let firstSum = 0;
  let secondSum = 0;
  let firstSquares = 0;
  let secondSquares = 0;
  let products = 0;

  for (let index = 0; index < overlapSamples; index++) {
    const firstSample = first[firstStart + index];
    const secondSample = second[index];
    firstSum += firstSample;
    secondSum += secondSample;
    firstSquares += firstSample * firstSample;
    secondSquares += secondSample * secondSample;
    products += firstSample * secondSample;
  }

  const firstVariance = firstSquares - (firstSum * firstSum) / overlapSamples;
  const secondVariance = secondSquares - (secondSum * secondSum) / overlapSamples;
  const minimumVariance = overlapSamples * 64 * 64;
  if (firstVariance < minimumVariance || secondVariance < minimumVariance) return null;

  const covariance = products - (firstSum * secondSum) / overlapSamples;
  return covariance / Math.sqrt(firstVariance * secondVariance);
}

function bestAudioOverlap(
  first: Int16Array,
  second: Int16Array,
): AudioOverlapMatch | null {
  const minimumSamples = Math.ceil(MIN_AUDIO_OVERLAP_SECONDS * PCM_SAMPLE_RATE);
  const maximumSamples = Math.min(first.length, second.length);
  if (maximumSamples < minimumSamples) return null;

  const coarseStep = Math.max(1, Math.round(PCM_SAMPLE_RATE / 1_000));
  let bestSamples = minimumSamples;
  let bestScore = Number.NEGATIVE_INFINITY;

  const evaluate = (samples: number): void => {
    const score = correlationForOverlap(first, second, samples);
    if (score === null) return;
    if (score > bestScore || (score === bestScore && samples > bestSamples)) {
      bestSamples = samples;
      bestScore = score;
    }
  };

  for (let samples = minimumSamples; samples <= maximumSamples; samples += coarseStep) {
    evaluate(samples);
  }
  evaluate(maximumSamples);

  const refineStart = Math.max(minimumSamples, bestSamples - coarseStep + 1);
  const refineEnd = Math.min(maximumSamples, bestSamples + coarseStep - 1);
  for (let samples = refineStart; samples <= refineEnd; samples++) evaluate(samples);

  if (!Number.isFinite(bestScore) || bestScore < AUDIO_MATCH_THRESHOLD) return null;
  return {
    overlapSeconds: bestSamples / PCM_SAMPLE_RATE,
    score: bestScore,
  };
}

export async function detectSharedAudioOverlap(
  firstPath: string,
  secondPath: string,
  firstAudioDuration: number,
  secondAudioDuration: number,
  signal?: AbortSignal,
): Promise<AudioOverlapMatch | null> {
  const windowSeconds = Math.min(
    MAX_AUDIO_OVERLAP_SECONDS,
    firstAudioDuration - MIN_TRANSITION_SECONDS,
    secondAudioDuration - MIN_TRANSITION_SECONDS,
  );
  if (windowSeconds < MIN_AUDIO_OVERLAP_SECONDS) return null;

  const [first, second] = await Promise.all([
    decodeMonoPcm(
      firstPath,
      Math.max(0, firstAudioDuration - windowSeconds),
      windowSeconds,
      signal,
    ),
    decodeMonoPcm(secondPath, 0, windowSeconds, signal),
  ]);
  return bestAudioOverlap(first, second);
}

function fixedTransitionSeconds(
  first: ProbeResult,
  second: ProbeResult,
  requested: number | undefined,
): number {
  const available = Math.min(first.videoDuration, second.videoDuration);
  const transition = requested ?? Math.min(DEFAULT_TRANSITION_SECONDS, available / 2);
  if (!Number.isFinite(transition) || transition < MIN_TRANSITION_SECONDS) {
    throw new Error(`Transition must be at least ${MIN_TRANSITION_SECONDS} seconds`);
  }
  if (transition >= available) {
    throw new Error("Transition must be shorter than both video clips");
  }
  return transition;
}

async function resolveTransitionTiming(
  firstPath: string,
  secondPath: string,
  first: ProbeResult,
  second: ProbeResult,
  requested: number | undefined,
  signal?: AbortSignal,
): Promise<TransitionTiming> {
  if (
    requested === undefined &&
    first.hasAudio &&
    second.hasAudio &&
    first.audioDuration !== null &&
    second.audioDuration !== null
  ) {
    const match = await detectSharedAudioOverlap(
      firstPath,
      secondPath,
      first.audioDuration,
      second.audioDuration,
      signal,
    );
    if (match) {
      const secondStartSeconds = first.audioDuration - match.overlapSeconds;
      const transitionSeconds = first.videoDuration - secondStartSeconds;
      if (
        secondStartSeconds >= 0 &&
        transitionSeconds >= MIN_TRANSITION_SECONDS &&
        transitionSeconds < first.videoDuration &&
        transitionSeconds < second.videoDuration
      ) {
        return {
          mode: "audio_match",
          transitionSeconds,
          secondStartSeconds,
          audioOverlapSeconds: match.overlapSeconds,
          matchScore: match.score,
        };
      }
    }
  }

  const transitionSeconds = fixedTransitionSeconds(first, second, requested);
  return {
    mode: "fixed",
    transitionSeconds,
    secondStartSeconds: first.videoDuration - transitionSeconds,
    audioOverlapSeconds: transitionSeconds,
    matchScore: null,
  };
}

function normalizedVideoFilter(
  input: number,
  label: string,
  width: number,
  height: number,
  fps: number,
): string {
  return `[${input}:v]fps=${mediaNumber(fps)},scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p,settb=AVTB,setpts=PTS-STARTPTS[${label}]`;
}

function fixedAudioFilter(
  input: number,
  label: string,
  duration: number,
  hasAudio: boolean,
): string {
  if (!hasAudio) {
    return `anullsrc=r=48000:cl=stereo:d=${mediaNumber(duration)}[${label}]`;
  }
  return `[${input}:a]aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,apad,atrim=duration=${mediaNumber(duration)},asetpts=PTS-STARTPTS[${label}]`;
}

function matchedAudioFilter(
  input: number,
  label: string,
  duration: number,
): string {
  return `[${input}:a]aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,atrim=duration=${mediaNumber(duration)},asetpts=PTS-STARTPTS[${label}]`;
}

async function renderSmoothConcat(
  options: SmoothSceneConcatOptions,
  first: ProbeResult,
  second: ProbeResult,
  timing: TransitionTiming,
): Promise<number> {
  const width = first.width;
  const height = first.height;
  const fps = first.fps;
  const outputDuration = timing.secondStartSeconds + second.videoDuration;
  const filters = [
    normalizedVideoFilter(0, "v0", width, height, fps),
    normalizedVideoFilter(1, "v1", width, height, fps),
    `[v0][v1]xfade=transition=fade:duration=${mediaNumber(timing.transitionSeconds)}:offset=${mediaNumber(timing.secondStartSeconds)},format=yuv420p[v]`,
  ];

  const withAudio = first.hasAudio || second.hasAudio;
  if (withAudio) {
    if (
      timing.mode === "audio_match" &&
      first.audioDuration !== null &&
      second.audioDuration !== null
    ) {
      filters.push(matchedAudioFilter(0, "a0", first.audioDuration));
      filters.push(matchedAudioFilter(1, "a1", second.audioDuration));
    } else {
      filters.push(fixedAudioFilter(0, "a0", first.videoDuration, first.hasAudio));
      filters.push(fixedAudioFilter(1, "a1", second.videoDuration, second.hasAudio));
    }
    filters.push(
      `[a0][a1]acrossfade=d=${mediaNumber(timing.audioOverlapSeconds)}:c1=tri:c2=tri,apad,atrim=duration=${mediaNumber(outputDuration)}[a]`,
    );
  }

  await runFfmpeg([
    "-y",
    "-i", options.firstPath,
    "-i", options.secondPath,
    "-filter_complex", filters.join(";"),
    "-map", "[v]",
    ...(withAudio ? ["-map", "[a]"] : []),
    ...H264_MEDIUM,
    ...(withAudio ? AUDIO_OPTS : []),
    "-movflags", "+faststart",
    options.outputPath,
  ], { signal: options.signal });

  return outputDuration;
}

function validateProbe(label: string, probe: ProbeResult): void {
  if (probe.width <= 0 || probe.height <= 0 || probe.videoDuration <= 0 || probe.fps <= 0) {
    throw new Error(`${label} input is not a valid video`);
  }
}

export async function smoothSceneConcatFiles(
  options: SmoothSceneConcatOptions,
): Promise<SmoothSceneConcatResult> {
  const [first, second] = await Promise.all([
    probeVideo(options.firstPath, { signal: options.signal }),
    probeVideo(options.secondPath, { signal: options.signal }),
  ]);
  validateProbe("First", first);
  validateProbe("Second", second);
  const timing = await resolveTransitionTiming(
    options.firstPath,
    options.secondPath,
    first,
    second,
    options.transitionSeconds,
    options.signal,
  );
  const outputDuration = await renderSmoothConcat(options, first, second, timing);
  return { ...timing, outputDuration };
}

export function registerSmoothSceneConcatJob(fs: Engine): void {
  registerJobHandler("smooth_scene_concat", async (payload, ctx) => {
    const {
      firstPath,
      secondPath,
      outputPath,
      firstAssetId,
      secondAssetId,
      assetId,
      assetDir,
      bookId,
      transitionSeconds,
    } = payload as SmoothSceneConcatPayload;

    const result = await withLockedLocalLease(
      fs,
      bookId,
      assetId,
      assetDir,
      ctx,
      "splice",
      { durationMs: LOCK_DURATION_MS, data: { state: "splicing" } },
      async () => {
        const concat = await smoothSceneConcatFiles({
          firstPath,
          secondPath,
          outputPath,
          transitionSeconds,
          signal: ctx.signal,
        });
        const provenance = {
          origin: "smooth_scene_concat",
          first_asset: firstAssetId,
          second_asset: secondAssetId,
          alignment_mode: concat.mode,
          transition_seconds: concat.transitionSeconds,
          second_start_seconds: concat.secondStartSeconds,
          audio_overlap_seconds: concat.audioOverlapSeconds,
          match_score: concat.matchScore,
          output_duration: concat.outputDuration,
          concatenated_at: new Date().toISOString(),
        };
        await ingestWorkspaceOutputs(
          fs,
          bookId,
          assetId,
          [outputPath.split("/").pop()!],
          "smooth_scene_concat",
          provenance,
        );
        await fs.metadata.artifacts.write(assetId, "original", provenance);
        return { concat, provenance };
      },
      { durationMs: LOCK_DURATION_MS, waitForActiveMs: 30_000 },
    );

    const processJobId = `process-video-${assetId}-${Date.now()}`;
    await queue.enqueue(processJobId, {
      type: "process_video",
      videoPath: outputPath,
      assetId,
      assetDir,
      bookId,
      provenance: result.provenance,
    });

    return {
      success: true,
      alignment_mode: result.concat.mode,
      transition_seconds: result.concat.transitionSeconds,
      match_score: result.concat.matchScore,
    };
  });
}
