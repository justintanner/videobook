import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import * as fsp from "node:fs/promises";

const execFileAsync = promisify(execFile);

const require = createRequire(import.meta.url);
export const FFMPEG: string = require("ffmpeg-static");
export const FFPROBE: string = require("ffprobe-static").path;
export const DEFAULT_FFMPEG_TIMEOUT_MS = 30 * 60_000;
export const DEFAULT_FFPROBE_TIMEOUT_MS = 2 * 60_000;

export interface MediaProcessOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export const H264_MEDIUM = ["-c:v", "libx264", "-preset", "medium", "-crf", "23", "-profile:v", "high", "-level:v", "4.0"];
// `-ac 2` downmixes any source to stereo. The native `aac` encoder rejects
// >2-channel layouts (e.g. 5.1 sources fail with "Unsupported channel layout
// '6 channels'"), and stereo is the right delivery format for videocity's
// web/social targets anyway.
export const AUDIO_OPTS = ["-c:a", "aac", "-b:a", "192k", "-ac", "2"];

export interface ProbeResult {
  width: number;
  height: number;
  duration: number;
  videoDuration: number;
  audioDuration: number | null;
  fps: number;
  /** Measured average frame rate (frames/duration). Diverges from `fps`
   * (the container's nominal rate) on variable-frame-rate files; null when
   * ffprobe reports no measurable rate (e.g. "0/0"). */
  avgFps: number | null;
  hasAudio: boolean;
  videoCodec: string | null;
  audioCodec: string | null;
  videoStream: ProbeStream | null;
  audioStream: ProbeStream | null;
}

export interface ProbeStream {
  index: number;
  timeBase: { numerator: number; denominator: number };
  durationTicks: number;
  codec: string;
  video?: {
    width: number;
    height: number;
    rotationDegrees: number;
    pixelAspect: { numerator: number; denominator: number };
    nominalFrameRate?: { numerator: number; denominator: number };
    averageFrameRate?: { numerator: number; denominator: number };
  };
  audio?: {
    sampleRateHz: number;
    channels: number;
    channelLayout: string;
  };
}

function rationalValue(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const [numerator, denominator] = value.split("/").map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null;
  return numerator / denominator;
}

function rationalParts(
  value: unknown,
  separator = "/",
): { numerator: number; denominator: number } | null {
  if (typeof value !== "string") return null;
  const parts = value.split(separator);
  if (parts.length !== 2) return null;
  const numerator = Number(parts[0]);
  const denominator = Number(parts[1]);
  if (
    !Number.isSafeInteger(numerator)
    || !Number.isSafeInteger(denominator)
    || numerator <= 0
    || denominator <= 0
  ) return null;
  return { numerator, denominator };
}

function durationTicks(
  stream: Record<string, unknown>,
  timeBase: { numerator: number; denominator: number },
  fallbackSeconds: number,
): number {
  const direct = Number(stream.duration_ts);
  if (Number.isSafeInteger(direct) && direct > 0) return direct;
  return Math.max(
    1,
    Math.round(fallbackSeconds * timeBase.denominator / timeBase.numerator),
  );
}

function rotationDegrees(stream: Record<string, unknown>): number {
  const sideData = Array.isArray(stream.side_data_list)
    ? stream.side_data_list as Array<Record<string, unknown>>
    : [];
  const sideRotation = sideData
    .map((entry) => Number(entry.rotation))
    .find(Number.isFinite);
  const tags = typeof stream.tags === "object" && stream.tags !== null
    ? stream.tags as Record<string, unknown>
    : {};
  const taggedRotation = Number(tags.rotate);
  return Math.round(sideRotation ?? (Number.isFinite(taggedRotation) ? taggedRotation : 0));
}

function videoProbeStream(
  stream: Record<string, unknown> | undefined,
  fallbackSeconds: number,
): ProbeStream | null {
  if (!stream) return null;
  const timeBase = rationalParts(stream.time_base) ?? { numerator: 1, denominator: 1_000 };
  const nominalFrameRate = rationalParts(stream.r_frame_rate);
  const averageFrameRate = rationalParts(stream.avg_frame_rate);
  return {
    index: Number.isSafeInteger(Number(stream.index)) ? Number(stream.index) : 0,
    timeBase,
    durationTicks: durationTicks(stream, timeBase, fallbackSeconds),
    codec: typeof stream.codec_name === "string" ? stream.codec_name : "unknown",
    video: {
      width: Math.max(1, Number(stream.width) || 1),
      height: Math.max(1, Number(stream.height) || 1),
      rotationDegrees: rotationDegrees(stream),
      pixelAspect: rationalParts(stream.sample_aspect_ratio, ":")
        ?? { numerator: 1, denominator: 1 },
      ...(nominalFrameRate ? { nominalFrameRate } : {}),
      ...(averageFrameRate ? { averageFrameRate } : {}),
    },
  };
}

function audioProbeStream(
  stream: Record<string, unknown> | undefined,
  fallbackSeconds: number,
): ProbeStream | null {
  if (!stream) return null;
  const sampleRateHz = Math.max(1, Number(stream.sample_rate) || 48_000);
  const timeBase = rationalParts(stream.time_base)
    ?? { numerator: 1, denominator: sampleRateHz };
  const channels = Math.max(1, Number(stream.channels) || 1);
  const channelLayout = typeof stream.channel_layout === "string"
    ? stream.channel_layout
    : channels === 1 ? "mono" : channels === 2 ? "stereo" : `${channels} channels`;
  return {
    index: Number.isSafeInteger(Number(stream.index)) ? Number(stream.index) : 0,
    timeBase,
    durationTicks: durationTicks(stream, timeBase, fallbackSeconds),
    codec: typeof stream.codec_name === "string" ? stream.codec_name : "unknown",
    audio: { sampleRateHz, channels, channelLayout },
  };
}

function taggedDuration(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(value);
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function streamDuration(stream: Record<string, unknown> | undefined, fallback: number): number {
  if (!stream) return 0;
  const direct = Number(stream.duration);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const durationTs = Number(stream.duration_ts);
  const timeBase = rationalValue(stream.time_base);
  if (Number.isFinite(durationTs) && timeBase !== null && durationTs * timeBase > 0) {
    return durationTs * timeBase;
  }
  const tags = typeof stream.tags === "object" && stream.tags !== null
    ? stream.tags as Record<string, unknown>
    : undefined;
  const tagged = taggedDuration(tags?.DURATION ?? tags?.duration);
  return tagged !== null && tagged > 0 ? tagged : fallback;
}

function interruptionMessage(
  processName: string,
  error: unknown,
  options: MediaProcessOptions,
  timeoutMs: number,
): string | null {
  if (options.signal?.aborted) {
    const reason = options.signal.reason;
    const detail = reason instanceof Error ? reason.message : String(reason ?? "aborted");
    return `${processName} cancelled: ${detail}`;
  }
  const processError = error as { killed?: boolean; signal?: string | null };
  if (processError.killed && processError.signal) {
    return `${processName} timed out after ${timeoutMs}ms`;
  }
  return null;
}

export async function probeVideo(
  filePath: string,
  options: MediaProcessOptions = {},
): Promise<ProbeResult> {
  let stdout: string;
  const timeoutMs = options.timeoutMs ?? DEFAULT_FFPROBE_TIMEOUT_MS;
  try {
    const result = await execFileAsync(FFPROBE, [
      "-v", "error",
      "-print_format", "json",
      "-show_streams",
      "-show_format",
      filePath,
    ], {
      encoding: "utf8",
      killSignal: "SIGKILL",
      signal: options.signal,
      timeout: timeoutMs,
    });
    stdout = result.stdout;
  } catch (error) {
    const interruption = interruptionMessage("ffprobe", error, options, timeoutMs);
    if (interruption) throw new Error(`${interruption} for ${filePath}`);
    const e = error as Error & { code?: number | string; stderr?: string | Buffer };
    const stderr = typeof e.stderr === "string" ? e.stderr : e.stderr?.toString() ?? "";
    const exit = e.code !== undefined ? String(e.code) : "?";
    let size = "missing";
    try {
      const { size: bytes } = await fsp.stat(filePath);
      size = `${bytes} bytes`;
    } catch { /* file gone */ }
    throw new Error(
      `ffprobe failed for ${filePath} (exit ${exit}, ${size}): ${stderr.trim() || e.message}`,
    );
  }
  const data = JSON.parse(stdout);
  const videoStream = (data.streams as Array<Record<string, unknown>>)?.find(
    (s) => s.codec_type === "video",
  );
  const width = Number(videoStream?.width ?? 0);
  const height = Number(videoStream?.height ?? 0);
  const duration = Number(data.format?.duration ?? 0);
  const videoDuration = streamDuration(videoStream, duration);

  let fps = 30;
  const rFrameRate = videoStream?.r_frame_rate;
  if (typeof rFrameRate === "string" && rFrameRate.includes("/")) {
    const [num, den] = rFrameRate.split("/").map(Number);
    if (den > 0) fps = num / den;
  }
  const avgFps = rationalValue(videoStream?.avg_frame_rate);

  const audioStream = (data.streams as Array<Record<string, unknown>>)?.find(
    (s) => s.codec_type === "audio",
  );
  const hasAudio = audioStream !== undefined;
  const audioDuration = audioStream ? streamDuration(audioStream, duration) : null;

  const videoCodec = typeof videoStream?.codec_name === "string" ? videoStream.codec_name : null;
  const audioCodec = typeof audioStream?.codec_name === "string" ? audioStream.codec_name : null;

  return {
    width,
    height,
    duration,
    videoDuration,
    audioDuration,
    fps,
    avgFps,
    hasAudio,
    videoCodec,
    audioCodec,
    videoStream: videoProbeStream(videoStream, videoDuration),
    audioStream: audioProbeStream(audioStream, audioDuration ?? duration),
  };
}

export function summarizeFfmpegStderr(stderr: string, maxChars = 600): string {
  const lines = stderr.split("\n").map((l) => l.trimEnd()).filter(Boolean);
  const meaningful = lines.filter((l) => {
    if (/^ffmpeg version /.test(l)) return false;
    if (/^\s*built with /.test(l)) return false;
    if (/^\s*configuration:/.test(l)) return false;
    if (/^\s*lib\w+\s+\d/.test(l)) return false;
    if (/^(frame|size)=/.test(l)) return false;
    return true;
  });
  const tail = meaningful.slice(-8).join("\n");
  return tail.length > maxChars ? tail.slice(-maxChars) : tail;
}

export async function runFfmpeg(
  args: string[],
  options: MediaProcessOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_FFMPEG_TIMEOUT_MS;
  try {
    await execFileAsync(FFMPEG, args, {
      encoding: "utf8",
      killSignal: "SIGKILL",
      signal: options.signal,
      timeout: timeoutMs,
    });
  } catch (error) {
    const interruption = interruptionMessage("ffmpeg", error, options, timeoutMs);
    if (interruption) throw new Error(interruption);
    const stderrRaw = error instanceof Error ? (error as Error & { stderr?: string }).stderr : undefined;
    const fallback = error instanceof Error ? error.message : String(error);
    const summary = stderrRaw ? summarizeFfmpegStderr(stderrRaw) : "";
    throw new Error(`ffmpeg failed: ${summary || fallback}`);
  }
}

interface FFmpeggyProbeStream {
  codec_type: string;
}
interface FFmpeggyProbeFormat {
  duration: string;
}
interface FFmpeggyProbeResult {
  streams: FFmpeggyProbeStream[];
  format: FFmpeggyProbeFormat;
}
interface FFmpeggyConstructorOpts {
  input: string;
  output: string;
  outputOptions: string[];
  overwriteExisting: boolean;
}
interface FFmpeggyInstance {
  run(): Promise<unknown>;
  done(): Promise<unknown>;
}
export interface FFmpeggyClass {
  new (opts: FFmpeggyConstructorOpts): FFmpeggyInstance;
  DefaultConfig: { ffmpegBin: string; ffprobeBin: string };
  probe(filePath: string): Promise<FFmpeggyProbeResult>;
}

let _FFmpeggy: FFmpeggyClass | null = null;

const SAMPLE_RATE = 8000;
// Fine-grained RMS accumulators (~768 KB). We fold these in halves as audio
// streams in, so memory stays constant regardless of clip length — see
// extractWaveform.
const WAVEFORM_FINE_BUCKETS = 1 << 16;

/**
 * Streams an asset's decoded audio and folds it into a bounded set of RMS
 * accumulators, returning `barCount` normalised peaks (0..1).
 *
 * The earlier implementation buffered the entire PCM stream via execFile with a
 * 50 MB `maxBuffer`. A video whose audio decoded to more than ~52 minutes of
 * 8 kHz mono s16le overflowed that cap; ffmpeg was killed mid-stream, the error
 * was swallowed, and an empty waveform came back — which never cached and so
 * re-ran the multi-second decode on every poll. Streaming removes the cap (and
 * the failure mode) entirely: memory is O(WAVEFORM_FINE_BUCKETS), not
 * O(duration).
 */
export async function extractWaveform(videoPath: string, barCount?: number): Promise<number[]> {
  const sumSq = new Float64Array(WAVEFORM_FINE_BUCKETS);
  const count = new Int32Array(WAVEFORM_FINE_BUCKETS);
  let samplesPerBucket = 1;
  let writeIdx = 0;
  let inBucket = 0;
  let totalSamples = 0;

  // Halve resolution in place when the buckets fill: merge each adjacent pair,
  // double the samples-per-bucket, and resume writing at the midpoint. This
  // caps the accumulators at WAVEFORM_FINE_BUCKETS for any clip length.
  const foldPairs = (): void => {
    const half = WAVEFORM_FINE_BUCKETS >> 1;
    for (let i = 0; i < half; i++) {
      sumSq[i] = sumSq[2 * i] + sumSq[2 * i + 1];
      count[i] = count[2 * i] + count[2 * i + 1];
    }
    sumSq.fill(0, half);
    count.fill(0, half);
    samplesPerBucket *= 2;
    writeIdx = half;
  };

  const addSample = (sample: number): void => {
    sumSq[writeIdx] += sample * sample;
    inBucket++;
    totalSamples++;
    if (inBucket === samplesPerBucket) {
      count[writeIdx] = inBucket;
      writeIdx++;
      inBucket = 0;
      if (writeIdx === WAVEFORM_FINE_BUCKETS) foldPairs();
    }
  };

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        FFMPEG,
        ["-i", videoPath, "-vn", "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "s16le", "pipe:1"],
        { stdio: ["ignore", "pipe", "pipe"] },
      );

      let carry = -1; // a single low byte left over when a chunk splits a sample
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        let offset = 0;
        if (carry !== -1 && chunk.length > 0) {
          addSample((((carry | (chunk[0] << 8)) << 16) >> 16)); // sign-extend 16-bit LE
          offset = 1;
          carry = -1;
        }
        const usableBytes = chunk.length - offset;
        const end = offset + usableBytes - (usableBytes & 1);
        for (let i = offset; i < end; i += 2) addSample(chunk.readInt16LE(i));
        carry = usableBytes & 1 ? chunk[chunk.length - 1] : -1;
      });
      child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
      child.on("error", reject);
      child.on("close", (code) => {
        // No samples means no decodable audio (no audio stream, or a decode
        // error). Surface it once, but return empty rather than rejecting so a
        // genuinely silent clip caches as "no waveform" instead of churning.
        if (totalSamples === 0 && code !== 0) {
          console.warn(
            `[ffmpeg] no waveform for ${videoPath} (ffmpeg exit ${code}): ${
              summarizeFfmpegStderr(stderr) || "no audio stream"
            }`,
          );
        }
        resolve();
      });
    });

    if (totalSamples === 0) return [];
    if (inBucket > 0) count[writeIdx++] = inBucket; // finalise the partial bucket
    const usedBuckets = writeIdx;

    // Default: 100 bars per second of audio (0.01s resolution), clamped 20..1000.
    if (barCount === undefined) {
      const durationSec = totalSamples / SAMPLE_RATE;
      barCount = Math.max(20, Math.min(1000, Math.round(durationSec * 100)));
    }
    barCount = Math.min(barCount, usedBuckets);

    // True RMS per bar: sum the squared energy and sample counts across the
    // fine buckets the bar spans, then take the root-mean-square.
    const peaks: number[] = new Array(barCount);
    for (let b = 0; b < barCount; b++) {
      const start = Math.floor((b * usedBuckets) / barCount);
      const stop = Math.max(start + 1, Math.floor(((b + 1) * usedBuckets) / barCount));
      let energy = 0;
      let samples = 0;
      for (let i = start; i < stop && i < usedBuckets; i++) {
        energy += sumSq[i];
        samples += count[i];
      }
      peaks[b] = samples > 0 ? Math.sqrt(energy / samples) : 0;
    }
    const max = Math.max(...peaks, 1);
    return peaks.map((p) => p / max);
  } catch (err) {
    // Only reached if ffmpeg fails to spawn (e.g. binary missing). The stream
    // never buffers, so the old maxBuffer failure mode can't recur here.
    console.error(
      `[ffmpeg] waveform extraction failed for ${videoPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return [];
  }
}

export async function isThumbnailBlank(imagePath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(FFMPEG, [
      "-i", imagePath,
      "-vf", "format=gray",
      "-f", "rawvideo",
      "-pix_fmt", "gray",
      "pipe:1",
    ], { encoding: "buffer", maxBuffer: 10 * 1024 * 1024 });
    const buf = stdout as unknown as Buffer;
    if (buf.length === 0) return true;

    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i];
    const mean = sum / buf.length;

    let variance = 0;
    for (let i = 0; i < buf.length; i++) {
      const diff = buf[i] - mean;
      variance += diff * diff;
    }
    const stddev = Math.sqrt(variance / buf.length);

    // Near-black or uniform solid color
    return mean < 10 || stddev < 5;
  } catch {
    return false;
  }
}

export async function getFFmpeggy(): Promise<FFmpeggyClass> {
  if (!_FFmpeggy) {
    const mod = await import("ffmpeggy") as { FFmpeggy: FFmpeggyClass };
    _FFmpeggy = mod.FFmpeggy;
    _FFmpeggy.DefaultConfig.ffmpegBin = FFMPEG;
    _FFmpeggy.DefaultConfig.ffprobeBin = FFPROBE;
  }
  return _FFmpeggy;
}
