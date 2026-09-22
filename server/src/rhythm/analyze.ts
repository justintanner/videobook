import { spawn } from "node:child_process";
import { createOnsetAccumulator } from "./onset.js";
import { trackBeats } from "./track.js";
import {
  RHYTHM_SAMPLE_RATE,
  type RhythmAnalysis,
  type RhythmResources,
} from "./contract.js";

const YIELD_EVERY_HOPS = 96;

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

function startEventLoopProbe(intervalMs = 20): { stop(): number } {
  let maxLag = 0;
  let previous = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    maxLag = Math.max(maxLag, now - previous - intervalMs);
    previous = now;
  }, intervalMs);
  return {
    stop(): number {
      clearInterval(timer);
      return Math.max(0, maxLag, Date.now() - previous - intervalMs);
    },
  };
}

async function analyzePcmStream(
  chunks: AsyncIterable<Float32Array>,
  options: { signal?: AbortSignal; sampleRate?: number } = {},
): Promise<RhythmAnalysis> {
  const sampleRate = options.sampleRate ?? RHYTHM_SAMPLE_RATE;
  const accumulator = createOnsetAccumulator(sampleRate);
  const probe = startEventLoopProbe();
  let peakRss = process.memoryUsage().rss;
  let yieldedAt = 0;
  let samples = 0;
  try {
    for await (const chunk of chunks) {
      options.signal?.throwIfAborted();
      accumulator.push(chunk);
      samples += chunk.length;
      if (samples > sampleRate * 60 * 60) throw new Error("Music analysis supports up to 60 minutes");
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
      const hops = accumulator.hopCount();
      if (hops - yieldedAt >= YIELD_EVERY_HOPS) {
        yieldedAt = hops;
        await yieldToEventLoop();
        peakRss = Math.max(peakRss, process.memoryUsage().rss);
      }
    }
    options.signal?.throwIfAborted();
    const analysis = trackBeats(accumulator.finish());
    analysis.resources = resources(
      Math.max(peakRss, process.memoryUsage().rss),
      probe.stop(),
      accumulator.retainedSamples(),
      samples / sampleRate,
    );
    return analysis;
  } catch (error) {
    probe.stop();
    throw error;
  }
}

export async function analyzePcm(
  samples: Float32Array,
  sampleRate = RHYTHM_SAMPLE_RATE,
  signal?: AbortSignal,
): Promise<RhythmAnalysis> {
  async function* once(): AsyncGenerator<Float32Array> {
    const slice = Math.max(sampleRate, 1);
    for (let offset = 0; offset < samples.length; offset += slice) {
      yield samples.subarray(offset, Math.min(samples.length, offset + slice));
    }
  }
  return analyzePcmStream(once(), { sampleRate, signal });
}

async function* decodeAudioToPcm(
  ffmpegPath: string,
  inputPath: string,
  signal?: AbortSignal,
  streamIndex?: number,
): AsyncGenerator<Float32Array> {
  signal?.throwIfAborted();
  const child = spawn(ffmpegPath, [
    "-v", "error",
    "-i", inputPath,
    "-map", streamIndex === undefined ? "0:a:0" : `0:${streamIndex}`, "-vn", "-ac", "1",
    "-ar", String(RHYTHM_SAMPLE_RATE),
    "-f", "f32le",
    "pipe:1",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const stderr: Buffer[] = [];
  let errorBytes = 0;
  child.stderr?.on("data", (chunk: Buffer) => {
    if (errorBytes < 8192) stderr.push(chunk.subarray(0, 8192 - errorBytes));
    errorBytes += chunk.length;
  });
  const closed = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
  void closed.catch(() => undefined);
  let pending = Buffer.alloc(0);
  const abort = (): void => {
    child.kill("SIGTERM");
  };
  signal?.addEventListener("abort", abort, { once: true });
  let drained = false;
  try {
    for await (const chunk of child.stdout ?? []) {
      if (signal?.aborted) break;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const combined = pending.length === 0 ? bytes : Buffer.concat([pending, bytes]);
      const sampleCount = Math.floor(combined.length / 4);
      const pcm = new Float32Array(sampleCount);
      for (let index = 0; index < sampleCount; index += 1) {
        pcm[index] = combined.readFloatLE(index * 4);
      }
      pending = Buffer.from(combined.subarray(sampleCount * 4));
      if (pcm.length > 0) yield pcm;
    }
    drained = true;
  } finally {
    signal?.removeEventListener("abort", abort);
    if (!drained && child.exitCode === null) child.kill("SIGTERM");
  }
  const exitCode = await closed;
  signal?.throwIfAborted();
  if (exitCode !== 0) {
    throw new Error(`ffmpeg decode failed (${exitCode}): ${Buffer.concat(stderr).toString("utf8")}`);
  }
}

export async function analyzeAudioFile(
  ffmpegPath: string,
  inputPath: string,
  signal?: AbortSignal,
  streamIndex?: number,
): Promise<RhythmAnalysis> {
  return analyzePcmStream(decodeAudioToPcm(ffmpegPath, inputPath, signal, streamIndex), { signal });
}

function resources(
  peakRssBytes: number,
  maxEventLoopLagMs: number,
  pcmRetainedSamples: number,
  durationSeconds: number,
): RhythmResources {
  return { peakRssBytes, maxEventLoopLagMs, pcmRetainedSamples, durationSeconds };
}
