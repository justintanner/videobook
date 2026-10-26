import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFfmpeg } from "../ffmpeg.js";

/**
 * Vocal timing for captions: decode a band-limited mono track, then
 * derive a loudness envelope, vocal onsets and per-word energy from it.
 */

export const VOCAL_SAMPLE_RATE = 8_000;
export const HOP_SECONDS = 0.01;
const ONSET_HISTORY_FRAMES = 4;
const ONSET_PEAK_RADIUS = 3;
const ONSET_MIN_SPACING_SECONDS = 0.06;
const ONSET_MIN_NOVELTY = 0.35;
const EPSILON = 1e-4;
const ENERGY_WINDOW_SECONDS = 0.3;
const DEFAULT_SNAP_SECONDS = 0.15;

/** Decode the first audio stream as 8 kHz mono float PCM filtered to the vocal band; callers check the probe for audio first. */
export async function decodeVocalPcm(inputPath: string, signal?: AbortSignal): Promise<Float32Array | null> {
  const dir = await mkdtemp(join(tmpdir(), "videobook-caption-audio-"));
  const output = join(dir, "vocal.f32");
  try {
    await runFfmpeg([
      "-y", "-i", inputPath,
      "-map", "0:a:0", "-vn",
      "-af", "highpass=f=250,lowpass=f=3500",
      "-ac", "1", "-ar", String(VOCAL_SAMPLE_RATE),
      "-f", "f32le", output,
    ], { signal });
    const bytes = await readFile(output).catch(() => null);
    if (!bytes || bytes.length < 4) return null;
    const aligned = new Uint8Array(bytes.length - (bytes.length % 4));
    aligned.set(bytes.subarray(0, aligned.length));
    return new Float32Array(aligned.buffer);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** RMS per hop over a two-hop window. */
export function rmsFrames(samples: Float32Array, sampleRate: number, hopSeconds = HOP_SECONDS): Float32Array {
  const hop = Math.max(1, Math.round(sampleRate * hopSeconds));
  const window = hop * 2;
  const count = Math.ceil(samples.length / hop);
  const frames = new Float32Array(count);
  for (let frame = 0; frame < count; frame++) {
    const begin = frame * hop;
    const end = Math.min(samples.length, begin + window);
    let sum = 0;
    for (let index = begin; index < end; index++) sum += samples[index] * samples[index];
    frames[frame] = Math.sqrt(sum / Math.max(1, end - begin));
  }
  return frames;
}

function percentile(values: ArrayLike<number>, fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = Array.from(values).sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(fraction * (sorted.length - 1))));
  return sorted[index];
}

function historyMean(rms: Float32Array, frame: number): number {
  const from = Math.max(0, frame - ONSET_HISTORY_FRAMES);
  if (frame === from) return 0;
  let sum = 0;
  for (let index = from; index < frame; index++) sum += rms[index];
  return sum / (frame - from);
}

/** Log-energy rise of each frame over its recent history, gated by a noise floor. */
function onsetNovelty(rms: Float32Array): Float32Array {
  const floor = percentile(rms, 0.2) * 2 + EPSILON;
  const novelty = new Float32Array(rms.length);
  for (let frame = 0; frame < rms.length; frame++) {
    if (rms[frame] < floor) continue;
    novelty[frame] = Math.max(0, Math.log(rms[frame] + EPSILON) - Math.log(historyMean(rms, frame) + EPSILON));
  }
  return novelty;
}

function noveltyThreshold(novelty: Float32Array): number {
  const active = Array.from(novelty).filter((value) => value > 0);
  if (active.length === 0) return Infinity;
  const mean = active.reduce((sum, value) => sum + value, 0) / active.length;
  const variance = active.reduce((sum, value) => sum + (value - mean) ** 2, 0) / active.length;
  return Math.max(ONSET_MIN_NOVELTY, mean + Math.sqrt(variance));
}

function isLocalPeak(novelty: Float32Array, frame: number): boolean {
  const from = Math.max(0, frame - ONSET_PEAK_RADIUS);
  const to = Math.min(novelty.length - 1, frame + ONSET_PEAK_RADIUS);
  for (let index = from; index <= to; index++) {
    if (novelty[index] > novelty[frame]) return false;
  }
  return true;
}

/** Onset times in seconds, ascending. */
export function detectOnsets(rms: Float32Array, hopSeconds = HOP_SECONDS): number[] {
  const novelty = onsetNovelty(rms);
  const threshold = noveltyThreshold(novelty);
  const onsets: number[] = [];
  for (let frame = 0; frame < novelty.length; frame++) {
    if (novelty[frame] < threshold || !isLocalPeak(novelty, frame)) continue;
    const time = frame * hopSeconds;
    if (onsets.length > 0 && time - onsets[onsets.length - 1] < ONSET_MIN_SPACING_SECONDS) continue;
    onsets.push(Math.round(time * 1000) / 1000);
  }
  return onsets;
}

function firstAtOrAfter(sorted: number[], value: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (sorted[mid] < value) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** Nearest onset to `start` within ±maxShift that is not before `notBefore`; else `start`. */
export function snapToOnset(start: number, onsets: number[], notBefore: number, maxShift = DEFAULT_SNAP_SECONDS): number {
  const from = firstAtOrAfter(onsets, Math.max(start - maxShift, notBefore));
  let best = start;
  let bestDistance = Infinity;
  for (let index = from; index < onsets.length && onsets[index] <= start + maxShift; index++) {
    const distance = Math.abs(onsets[index] - start);
    if (distance < bestDistance) {
      best = onsets[index];
      bestDistance = distance;
    }
  }
  return best;
}

export interface TimedSpan {
  start: number;
  end: number;
}

/** Snap each word start to a vocal onset, keeping word order strictly increasing. */
export function snapWordStarts(words: TimedSpan[], onsets: number[], maxShift = DEFAULT_SNAP_SECONDS): number[] {
  const snapped: number[] = [];
  for (const word of words) {
    const previous = snapped.length > 0 ? snapped[snapped.length - 1] + 0.04 : 0;
    snapped.push(snapToOnset(word.start, onsets, previous, maxShift));
  }
  return snapped;
}

function meanRms(rms: Float32Array, start: number, end: number, hopSeconds: number): number {
  const from = Math.max(0, Math.floor(start / hopSeconds));
  const to = Math.min(rms.length, Math.max(from + 1, Math.ceil(end / hopSeconds)));
  let sum = 0;
  for (let index = from; index < to; index++) sum += rms[index];
  return to > from ? sum / (to - from) : 0;
}

/** Per-word vocal energy normalized so the loudest ~5% of words reach 1. */
export function wordEnergies(words: TimedSpan[], rms: Float32Array, hopSeconds = HOP_SECONDS): number[] {
  const raw = words.map((word) => meanRms(rms, word.start, Math.min(word.end, word.start + ENERGY_WINDOW_SECONDS), hopSeconds));
  const reference = percentile(raw, 0.95);
  if (reference <= 0) return words.map(() => 0.5);
  return raw.map((value) => Math.round(Math.min(1, value / reference) * 100) / 100);
}

/** Downsample RMS frames to `hz` peak buckets normalized to 0..1. */
export function envelopeSeries(rms: Float32Array, hz: number, hopSeconds = HOP_SECONDS): number[] {
  const perBucket = Math.max(1, Math.round(1 / (hz * hopSeconds)));
  const peaks: number[] = [];
  for (let begin = 0; begin < rms.length; begin += perBucket) {
    let peak = 0;
    for (let index = begin; index < Math.min(rms.length, begin + perBucket); index++) peak = Math.max(peak, rms[index]);
    peaks.push(peak);
  }
  const reference = percentile(peaks, 0.99) || 1;
  return peaks.map((peak) => Math.round(Math.min(1, peak / reference) * 1000) / 1000);
}
