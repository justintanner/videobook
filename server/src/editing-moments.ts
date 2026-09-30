import { createHash } from "node:crypto";
import { z } from "zod";
import type { Engine } from "videobook-engine";
import { readVideoAnalysisSummary } from "./video-analysis-projection.js";

const MOMENTS_SCHEMA_VERSION = 1;
export const MOMENTS_EXTRACTOR_ID = "videobook-scene-scan";
export const MOMENTS_EXTRACTOR_VERSION = "1";
export const MOMENTS_SHOT_THRESHOLD = 0.3;
export const MOMENTS_CHANGE_THRESHOLD = 0.12;
export const MOMENTS_MIN_MOMENT_SECONDS = 0.5;
export const MOMENTS_MAX_SCAN_SECONDS = 1800;
const MOMENTS_MAX_SHOTS = 4000;
export const MOMENTS_MAX_RANKED = 12;

const rangeSchema = z.object({
  startSeconds: z.number().finite().nonnegative(),
  endSeconds: z.number().finite().positive(),
});
const shotSchema = z.object({
  id: z.string().min(1).max(100),
  startSeconds: z.number().finite().nonnegative(),
  endSeconds: z.number().finite().positive(),
  motion: z.number().min(0).max(1),
  change: z.object({
    timeSeconds: z.number().finite().nonnegative(),
    strength: z.number().min(0).max(1),
    quality: z.number().min(0).max(1),
  }).nullable(),
});
export const editingMomentsSchema = z.object({
  schemaVersion: z.literal(MOMENTS_SCHEMA_VERSION),
  momentsId: z.string().min(1),
  artifactId: z.string().uuid(),
  objectHash: z.string().min(1),
  streamId: z.string().uuid(),
  durationSeconds: z.number().finite().positive(),
  extractor: z.object({
    id: z.string().min(1),
    version: z.string().min(1),
    params: z.object({
      shotThreshold: z.number(),
      changeThreshold: z.number(),
      minMomentSeconds: z.number(),
    }),
  }),
  analyzedRanges: z.array(rangeSchema).min(1),
  createdAt: z.number().finite().positive(),
  shots: z.array(shotSchema).max(MOMENTS_MAX_SHOTS),
  usable: z.array(rangeSchema),
  moments: z.array(z.object({
    shotId: z.string().min(1),
    startSeconds: z.number().finite().nonnegative(),
    endSeconds: z.number().finite().positive(),
    score: z.number().min(0).max(1),
    quality: z.number().min(0).max(1),
  })).max(MOMENTS_MAX_SHOTS),
  reused: z.object({
    visionAnalysis: z.object({
      summary: z.string(),
      tags: z.array(z.string()),
      subjects: z.array(z.string()),
      sceneCount: z.number().int().nonnegative(),
      timestampsApproximate: z.literal(true),
    }).nullable(),
    indexCoverage: z.object({
      state: z.string(),
      generation: z.string(),
    }).nullable(),
  }),
});
export type EditingMoments = z.infer<typeof editingMomentsSchema>;
export type EditingMomentsShot = z.infer<typeof shotSchema>;

export function editingMomentsId(input: {
  objectHash: string;
  streamIndex: number;
  startSeconds: number;
  endSeconds: number;
}): string {
  return createHash("sha256").update(JSON.stringify([
    input.objectHash, input.streamIndex, MOMENTS_EXTRACTOR_ID, MOMENTS_EXTRACTOR_VERSION,
    input.startSeconds, input.endSeconds,
  ])).digest("hex");
}

export function editingMomentsCacheKey(momentsId: string): string {
  return `editing.moments.${momentsId}`;
}

export async function readEditingMoments(engine: Engine, artifactId: string, momentsId: string): Promise<EditingMoments | null> {
  const read = await engine.metadata.artifacts.read(artifactId, editingMomentsCacheKey(momentsId));
  if (!read.ok) return null;
  const parsed = editingMomentsSchema.safeParse(read.value);
  if (!parsed.success || parsed.data.artifactId !== artifactId || parsed.data.momentsId !== momentsId) return null;
  return parsed.data;
}

export async function reuseContext(engine: Engine, artifactId: string): Promise<EditingMoments["reused"]> {
  const summary = await readVideoAnalysisSummary(engine, artifactId);
  let coverage: EditingMoments["reused"]["indexCoverage"] = null;
  try {
    const state = engine.temporalSearch.coverage(artifactId);
    coverage = state.ok ? { state: state.value.state, generation: state.value.generation } : null;
  } catch {
    coverage = null;
  }
  return {
    visionAnalysis: summary ? {
      summary: summary.summary,
      tags: summary.tags,
      subjects: summary.subjects,
      sceneCount: summary.scene_count,
      timestampsApproximate: true,
    } : null,
    indexCoverage: coverage,
  };
}

const round = (value: number): number => Math.round(value * 10000) / 10000;

export interface SceneFrame {
  timeSeconds: number;
  score: number;
}

export function shotsFromScan(frames: readonly SceneFrame[], durationSeconds: number): Array<EditingMomentsShot & { id: string }> {
  const boundaries = shotBoundaries(frames);
  const edges = [0, ...boundaries, durationSeconds];
  let cursor = 0;
  return edges.slice(0, -1).map((start, index) => {
    const end = edges[index + 1]!;
    while (cursor < frames.length && frames[cursor]!.timeSeconds < start) cursor += 1;
    const samples: SceneFrame[] = [];
    for (let probe = cursor; probe < frames.length && frames[probe]!.timeSeconds < end; probe += 1) {
      samples.push(frames[probe]!);
    }
    return buildShot(`shot-${index + 1}`, start, end, samples);
  }).filter((shot) => shot.endSeconds - shot.startSeconds > 0);
}

function shotBoundaries(frames: readonly SceneFrame[]): number[] {
  const peaks: Array<{ timeSeconds: number; score: number }> = [];
  for (let index = 1; index < frames.length - 1; index += 1) {
    const frame = frames[index]!;
    if (frame.score < MOMENTS_SHOT_THRESHOLD) continue;
    if (frame.score < frames[index - 1]!.score || frame.score < frames[index + 1]!.score) continue;
    peaks.push({ timeSeconds: frame.timeSeconds, score: frame.score });
  }
  const kept: number[] = [];
  for (const peak of [...peaks].sort((left, right) => right.score - left.score)) {
    if (kept.every((time) => Math.abs(time - peak.timeSeconds) >= MOMENTS_MIN_MOMENT_SECONDS)) {
      kept.push(peak.timeSeconds);
    }
  }
  return kept.sort((left, right) => left - right).map(round);
}

function buildShot(
  id: string,
  startSeconds: number,
  endSeconds: number,
  samples: ReadonlyArray<{ timeSeconds: number; score: number }>,
): EditingMomentsShot & { id: string } {
  const motion = samples.length ? samples.reduce((sum, frame) => sum + frame.score, 0) / samples.length : 0;
  return {
    id,
    startSeconds: round(startSeconds),
    endSeconds: round(endSeconds),
    motion: round(Math.min(1, motion)),
    change: strongestChange(samples, startSeconds, endSeconds),
  };
}

function strongestChange(
  samples: ReadonlyArray<{ timeSeconds: number; score: number }>,
  startSeconds: number,
  endSeconds: number,
): EditingMomentsShot["change"] {
  let best: { timeSeconds: number; strength: number } | null = null;
  for (const frame of samples) {
    if (frame.score < MOMENTS_CHANGE_THRESHOLD) continue;
    if (frame.timeSeconds - startSeconds < MOMENTS_MIN_MOMENT_SECONDS) continue;
    if (endSeconds - frame.timeSeconds < MOMENTS_MIN_MOMENT_SECONDS) continue;
    if (!best || frame.score > best.strength) best = { timeSeconds: frame.timeSeconds, strength: frame.score };
  }
  return best ? {
    timeSeconds: round(best.timeSeconds),
    strength: round(best.strength),
    quality: round(Math.min(1, best.strength / (2 * MOMENTS_SHOT_THRESHOLD))),
  } : null;
}

export function usableRanges(ranges: EditingMoments["analyzedRanges"], shots: ReadonlyArray<EditingMomentsShot>): EditingMoments["usable"] {
  return ranges.map((range) => {
    const inside = shots.filter((shot) => shot.startSeconds >= range.startSeconds && shot.endSeconds <= range.endSeconds + 0.001);
    const start = inside.length && inside[0]!.startSeconds - range.startSeconds < MOMENTS_MIN_MOMENT_SECONDS
      ? inside[0]!.endSeconds
      : range.startSeconds;
    const last = inside.at(-1);
    const end = last && range.endSeconds - last.endSeconds < MOMENTS_MIN_MOMENT_SECONDS
      ? last.startSeconds
      : range.endSeconds;
    return { startSeconds: round(start), endSeconds: round(end) };
  }).filter((range) => range.endSeconds - range.startSeconds >= MOMENTS_MIN_MOMENT_SECONDS);
}

export function rankedMoments(shots: ReadonlyArray<EditingMomentsShot>): EditingMoments["moments"] {
  return shots
    .filter((shot) => shot.endSeconds - shot.startSeconds >= MOMENTS_MIN_MOMENT_SECONDS)
    .sort((left, right) => right.motion - left.motion || left.startSeconds - right.startSeconds)
    .map((shot) => ({
      shotId: shot.id,
      startSeconds: shot.startSeconds,
      endSeconds: shot.endSeconds,
      score: shot.motion,
      quality: round(Math.min(1, (shot.endSeconds - shot.startSeconds) / 2)),
    }));
}
