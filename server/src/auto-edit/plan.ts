import { z } from "zod";

const SEGMENT_PLAN_VERSION = 1 as const;
const MAX_SEGMENTS = 24;
const MIN_SEGMENT_OUTPUT_FRAMES = 2;
const MAX_OUTPUT_SECONDS = 180;
const MIN_SEGMENT_SPEED = 0.25;
const MAX_SEGMENT_SPEED = 4;

const SEGMENT_ROLES = [
  "cold_open",
  "body",
  "replay",
  "push_in",
  "crash",
  "custom",
] as const;

const SEGMENT_MOTIONS = ["flow", "blend", "repeat"] as const;
const SEGMENT_AUDIO_POLICIES = ["source", "pitch", "mute"] as const;

export const segmentSourceSchema = z.object({
  artifactId: z.string().min(1),
  sourceHash: z.string().min(1),
  fps: z.number().finite().positive(),
  frames: z.number().int().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  hasAudio: z.boolean(),
}).strict();

export const segmentSchema = z.object({
  id: z.string().min(1),
  role: z.enum(SEGMENT_ROLES),
  startFrame: z.number().int(),
  endFrame: z.number().int(),
  speed: z.number().finite().min(MIN_SEGMENT_SPEED).max(MAX_SEGMENT_SPEED).default(1),
  motion: z.enum(SEGMENT_MOTIONS).default("repeat"),
  audio: z.enum(SEGMENT_AUDIO_POLICIES).default("source"),
}).strict();

export const segmentPlanSchema = z.object({
  version: z.literal(SEGMENT_PLAN_VERSION),
  source: segmentSourceSchema,
  segments: z.array(segmentSchema).min(1).max(MAX_SEGMENTS),
}).strict();

export type SegmentSource = z.infer<typeof segmentSourceSchema>;
export type PlanSegment = z.infer<typeof segmentSchema>;
export type SegmentPlan = z.infer<typeof segmentPlanSchema>;

export interface SegmentPlanIssue {
  segmentId: string;
  message: string;
}

export function secondsToFrame(seconds: number, fps: number): number {
  return Math.round(seconds * fps);
}

export function frameToSeconds(frame: number, fps: number): number {
  return frame / fps;
}

export function segmentOutputFrames(
  segment: Pick<PlanSegment, "startFrame" | "endFrame" | "speed">,
): number {
  return Math.round((segment.endFrame - segment.startFrame) / segment.speed);
}

export function segmentOutputStartFrames(plan: Pick<SegmentPlan, "segments">): number[] {
  const starts: number[] = [];
  let cursor = 0;
  for (const segment of plan.segments) {
    starts.push(cursor);
    cursor += segmentOutputFrames(segment);
  }
  return starts;
}

export function planOutputFrames(plan: Pick<SegmentPlan, "segments">): number {
  return plan.segments.reduce((total, segment) => total + segmentOutputFrames(segment), 0);
}

function checkSegmentRange(segment: PlanSegment, sourceFrames: number): SegmentPlanIssue[] {
  const issues: SegmentPlanIssue[] = [];
  if (!Number.isInteger(segment.startFrame) || !Number.isInteger(segment.endFrame)) {
    issues.push({
      segmentId: segment.id,
      message: `Segment "${segment.id}" frame bounds must be integers.`,
    });
    return issues;
  }
  if (segment.endFrame <= segment.startFrame) {
    issues.push({
      segmentId: segment.id,
      message: `Segment "${segment.id}" has an empty or reversed range (${segment.startFrame} to ${segment.endFrame}).`,
    });
  }
  if (segment.startFrame < 0 || segment.endFrame > sourceFrames) {
    issues.push({
      segmentId: segment.id,
      message: `Segment "${segment.id}" range (${segment.startFrame} to ${segment.endFrame}) falls outside the source's ${sourceFrames} frames.`,
    });
  }
  return issues;
}

export function checkSegmentPlan(plan: SegmentPlan): SegmentPlanIssue[] {
  const issues: SegmentPlanIssue[] = [];
  if (plan.segments.length === 0) {
    issues.push({ segmentId: "", message: "A segment plan needs at least 1 segment." });
    return issues;
  }
  if (plan.segments.length > MAX_SEGMENTS) {
    issues.push({
      segmentId: plan.segments[MAX_SEGMENTS]?.id ?? "",
      message: `A segment plan allows at most ${MAX_SEGMENTS} segments; got ${plan.segments.length}.`,
    });
  }
  const seenIds = new Set<string>();
  let totalOutputFrames = 0;
  for (const segment of plan.segments) {
    if (seenIds.has(segment.id)) {
      issues.push({ segmentId: segment.id, message: `Duplicate segment id "${segment.id}".` });
    } else {
      seenIds.add(segment.id);
    }
    const rangeIssues = checkSegmentRange(segment, plan.source.frames);
    issues.push(...rangeIssues);
    if (!Number.isFinite(segment.speed) || segment.speed < MIN_SEGMENT_SPEED || segment.speed > MAX_SEGMENT_SPEED) {
      issues.push({
        segmentId: segment.id,
        message: `Segment "${segment.id}" speed must be from ${MIN_SEGMENT_SPEED} to ${MAX_SEGMENT_SPEED}; got ${segment.speed}.`,
      });
      continue;
    }
    if (rangeIssues.length === 0) {
      const outputFrames = segmentOutputFrames(segment);
      if (outputFrames < MIN_SEGMENT_OUTPUT_FRAMES) {
        issues.push({
          segmentId: segment.id,
          message: `Segment "${segment.id}" makes ${outputFrames} output frame${outputFrames === 1 ? "" : "s"}; each segment needs at least ${MIN_SEGMENT_OUTPUT_FRAMES}.`,
        });
      }
      totalOutputFrames += outputFrames;
    }
  }
  if (plan.source.fps > 0 && totalOutputFrames / plan.source.fps > MAX_OUTPUT_SECONDS) {
    const seconds = totalOutputFrames / plan.source.fps;
    issues.push({
      segmentId: plan.segments.at(-1)?.id ?? "",
      message: `Output length ${seconds.toFixed(2)} s exceeds the ${MAX_OUTPUT_SECONDS} s limit.`,
    });
  }
  return issues;
}
