import {
  ENERGY_ALGORITHM_ID,
  ENERGY_ALGORITHM_VERSION,
  SECTION_DETECTOR_ID,
  SECTION_DETECTOR_VERSION,
  type OnsetEnvelope,
  type RhythmEnergy,
} from "./contract.js";

export interface SectionCandidate {
  id: string;
  timeSeconds: number;
  quality: number;
}

export interface SectionDetection {
  algorithmId: string;
  algorithmVersion: string;
  candidates: SectionCandidate[];
}

export type EnergyTier = "low" | "mid" | "high";

export interface EnergySegment {
  startSeconds: number;
  endSeconds: number;
  meanEnergy: number;
  tier: EnergyTier;
}

const ENERGY_BIN_SECONDS = 0.25;
const SECTION_SMOOTH_SECONDS = 2;
const SECTION_RADIUS_SECONDS = 1.5;
const SECTION_MIN_GAP_SECONDS = 8;
const SECTION_MIN_NOVELTY = 0.12;
const TIER_SPREAD = 0.15;

const round = (value: number): number => Math.round(value * 10000) / 10000;

export function energyCurve(envelope: Pick<OnsetEnvelope, "rms" | "hopSamples" | "sampleRate" | "frameCount">): RhythmEnergy {
  const frameSeconds = envelope.hopSamples / envelope.sampleRate;
  const binFrames = Math.max(1, Math.round(ENERGY_BIN_SECONDS / frameSeconds));
  const raw: number[] = [];
  let peak = 0;
  for (let start = 0; start < envelope.frameCount; start += binFrames) {
    const end = Math.min(envelope.frameCount, start + binFrames);
    let sum = 0;
    for (let index = start; index < end; index += 1) sum += envelope.rms[index] ?? 0;
    const mean = sum / (end - start);
    raw.push(mean);
    if (mean > peak) peak = mean;
  }
  return {
    algorithmId: ENERGY_ALGORITHM_ID,
    algorithmVersion: ENERGY_ALGORITHM_VERSION,
    hopSeconds: round(binFrames * frameSeconds),
    values: raw.map((value) => round(peak > 0 ? value / peak : 0)),
  };
}

export function candidateSections(energy: RhythmEnergy, durationSeconds: number): SectionDetection {
  const binSeconds = energy.hopSeconds;
  const smoothWidth = Math.max(1, 2 * Math.round(SECTION_SMOOTH_SECONDS / binSeconds / 2) + 1);
  const radius = Math.max(1, Math.round(SECTION_RADIUS_SECONDS / binSeconds));
  const smooth = movingAverage(energy.values, smoothWidth);
  const novelty = new Array<number>(energy.values.length).fill(0);
  for (let index = radius; index < energy.values.length - radius; index += 1) {
    novelty[index] = Math.abs(smooth[index + radius]! - smooth[index - radius]!);
  }
  const threshold = Math.max(SECTION_MIN_NOVELTY, 0.6 * quantile(novelty, 0.9));
  const peaks: Array<{ timeSeconds: number; novelty: number }> = [];
  for (let index = 1; index < novelty.length - 1; index += 1) {
    const value = novelty[index]!;
    if (value < threshold) continue;
    if (value < novelty[index - 1]! || value < novelty[index + 1]!) continue;
    const timeSeconds = index * binSeconds;
    if (timeSeconds < SECTION_RADIUS_SECONDS || timeSeconds > durationSeconds - SECTION_RADIUS_SECONDS) continue;
    peaks.push({ timeSeconds, novelty: value });
  }
  peaks.sort((left, right) => right.novelty - left.novelty || left.timeSeconds - right.timeSeconds);
  const kept: Array<{ timeSeconds: number; novelty: number }> = [];
  for (const peak of peaks) {
    if (kept.every((entry) => Math.abs(entry.timeSeconds - peak.timeSeconds) >= SECTION_MIN_GAP_SECONDS)) {
      kept.push(peak);
    }
  }
  kept.sort((left, right) => left.timeSeconds - right.timeSeconds);
  return {
    algorithmId: SECTION_DETECTOR_ID,
    algorithmVersion: SECTION_DETECTOR_VERSION,
    candidates: kept.map((entry, index) => ({
      id: `section-${index + 1}`,
      timeSeconds: round(entry.timeSeconds),
      quality: round(Math.min(1, entry.novelty / (2 * threshold))),
    })),
  };
}

function sampleEnergy(energy: RhythmEnergy, timeSeconds: number): number {
  if (!energy.values.length) return 0;
  const index = Math.min(energy.values.length - 1, Math.max(0, Math.floor(timeSeconds / energy.hopSeconds)));
  return energy.values[index] ?? 0;
}

export function energySegments(energy: RhythmEnergy, sections: SectionDetection | null, durationSeconds: number): EnergySegment[] {
  if (!(durationSeconds > 0)) return [];
  const bounds = [0, ...(sections?.candidates ?? []).map((candidate) => candidate.timeSeconds), durationSeconds]
    .filter((value, index, all) => value >= 0 && value <= durationSeconds && (index === 0 || value > all[index - 1]!));
  if (bounds.length < 2) return [];
  const segments = bounds.slice(0, -1).map((start, index) => {
    const end = bounds[index + 1]!;
    return { startSeconds: start, endSeconds: end, meanEnergy: meanEnergy(energy, start, end), tier: "mid" as EnergyTier };
  });
  const baseline = median(segments.map((segment) => segment.meanEnergy));
  if (baseline > 0) {
    for (const segment of segments) {
      segment.tier = segment.meanEnergy >= baseline * (1 + TIER_SPREAD) ? "high"
        : segment.meanEnergy <= baseline * (1 - TIER_SPREAD) ? "low" : "mid";
    }
  }
  return segments;
}

function meanEnergy(energy: RhythmEnergy, startSeconds: number, endSeconds: number): number {
  const first = Math.max(0, Math.floor(startSeconds / energy.hopSeconds));
  const last = Math.min(energy.values.length, Math.ceil(endSeconds / energy.hopSeconds));
  if (last <= first) return sampleEnergy(energy, (startSeconds + endSeconds) / 2);
  let sum = 0;
  for (let index = first; index < last; index += 1) sum += energy.values[index] ?? 0;
  return round(sum / (last - first));
}

function movingAverage(values: readonly number[], width: number): number[] {
  const half = Math.floor(width / 2);
  const result = new Array<number>(values.length).fill(0);
  for (let index = 0; index < values.length; index += 1) {
    const start = Math.max(0, index - half);
    const end = Math.min(values.length, index + half + 1);
    let sum = 0;
    for (let cursor = start; cursor < end; cursor += 1) sum += values[cursor] ?? 0;
    result[index] = sum / (end - start);
  }
  return result;
}

function quantile(values: readonly number[], share: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const position = Math.min(sorted.length - 1, Math.max(0, Math.floor(share * sorted.length)));
  return sorted[position] ?? 0;
}

function median(values: readonly number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : sorted[middle] ?? 0;
}
