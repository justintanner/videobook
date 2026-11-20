import { z } from "zod";
import { SEGMENT_LOOK_IDS, type SegmentLook } from "./looks.js";

const SEGMENT_PLAN_VERSION = 1 as const;
const MAX_SEGMENTS = 24;
const MIN_SEGMENT_OUTPUT_FRAMES = 2;
const MAX_OUTPUT_SECONDS = 180;
const MIN_SEGMENT_SPEED = 0.25;
const MAX_SEGMENT_SPEED = 4;
const MIN_ZOOM_SCALE = 1;
const MAX_ZOOM_SCALE = 3;

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
const SEGMENT_ZOOM_EASES = ["hold", "linear", "smooth"] as const;

const segmentZoomPointSchema = z.object({
  scale: z.number().finite().min(MIN_ZOOM_SCALE).max(MAX_ZOOM_SCALE),
  x: z.number().finite().min(0).max(1),
  y: z.number().finite().min(0).max(1),
}).strict();

const segmentZoomSchema = z.object({
  from: segmentZoomPointSchema,
  to: segmentZoomPointSchema,
  ease: z.enum(SEGMENT_ZOOM_EASES),
  rampFraction: z.number().finite().gt(0).max(1).default(1),
}).strict();

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
  zoom: segmentZoomSchema.optional(),
  look: z.enum(SEGMENT_LOOK_IDS).default("none"),
}).strict();

export const segmentPlanSchema = z.object({
  version: z.literal(SEGMENT_PLAN_VERSION),
  source: segmentSourceSchema,
  segments: z.array(segmentSchema).min(1).max(MAX_SEGMENTS),
}).strict();

export type SegmentZoomPoint = z.infer<typeof segmentZoomPointSchema>;
export type SegmentZoom = Omit<z.infer<typeof segmentZoomSchema>, "rampFraction"> & {
  rampFraction?: number;
};
export type SegmentSource = z.infer<typeof segmentSourceSchema>;
export type PlanSegment = Omit<z.infer<typeof segmentSchema>, "zoom" | "look"> & {
  zoom?: SegmentZoom;
  look?: SegmentLook;
};
export type SegmentPlan = Omit<z.infer<typeof segmentPlanSchema>, "segments"> & {
  segments: PlanSegment[];
};

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

export function segmentZoomAt(
  segment: Pick<PlanSegment, "startFrame" | "endFrame" | "speed" | "zoom">,
  outputFrame: number,
): SegmentZoomPoint {
  const zoom = segment.zoom;
  if (!zoom) return { scale: 1, x: 0.5, y: 0.5 };
  if (zoom.ease === "hold") {
    return { scale: zoom.to.scale, x: zoom.to.x, y: zoom.to.y };
  }
  const frames = segmentOutputFrames(segment);
  const rampFraction = zoom.rampFraction ?? 1;
  const span = (frames - 1) * rampFraction;
  const u = span <= 0 ? 1 : Math.min(1, Math.max(0, outputFrame / span));
  const eased = zoom.ease === "smooth" ? u * u * (3 - 2 * u) : u;
  return {
    scale: zoom.from.scale + (zoom.to.scale - zoom.from.scale) * eased,
    x: zoom.from.x + (zoom.to.x - zoom.from.x) * eased,
    y: zoom.from.y + (zoom.to.y - zoom.from.y) * eased,
  };
}

function checkZoomPoint(
  segmentId: string,
  label: "from" | "to",
  point: SegmentZoomPoint,
): SegmentPlanIssue[] {
  const issues: SegmentPlanIssue[] = [];
  if (!Number.isFinite(point.scale) || point.scale < MIN_ZOOM_SCALE || point.scale > MAX_ZOOM_SCALE) {
    issues.push({
      segmentId,
      message: `Segment "${segmentId}" zoom.${label}.scale must be from ${MIN_ZOOM_SCALE} to ${MAX_ZOOM_SCALE}; got ${point.scale}.`,
    });
  }
  if (!Number.isFinite(point.x) || point.x < 0 || point.x > 1) {
    issues.push({
      segmentId,
      message: `Segment "${segmentId}" zoom.${label}.x must be from 0 to 1; got ${point.x}.`,
    });
  }
  if (!Number.isFinite(point.y) || point.y < 0 || point.y > 1) {
    issues.push({
      segmentId,
      message: `Segment "${segmentId}" zoom.${label}.y must be from 0 to 1; got ${point.y}.`,
    });
  }
  return issues;
}

function checkSegmentZoom(segment: PlanSegment): SegmentPlanIssue[] {
  const zoom = segment.zoom;
  if (!zoom) return [];
  const issues: SegmentPlanIssue[] = [
    ...checkZoomPoint(segment.id, "from", zoom.from),
    ...checkZoomPoint(segment.id, "to", zoom.to),
  ];
  const rampFraction = zoom.rampFraction ?? 1;
  if (!Number.isFinite(rampFraction) || rampFraction <= 0 || rampFraction > 1) {
    issues.push({
      segmentId: segment.id,
      message: `Segment "${segment.id}" zoom.rampFraction must be above 0 and at most 1; got ${rampFraction}.`,
    });
  }
  if (!SEGMENT_ZOOM_EASES.includes(zoom.ease)) {
    issues.push({
      segmentId: segment.id,
      message: `Segment "${segment.id}" zoom.ease "${String(zoom.ease)}" is not supported.`,
    });
  }
  return issues;
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
    issues.push(...checkSegmentZoom(segment));
    if (segment.look !== undefined && !SEGMENT_LOOK_IDS.includes(segment.look)) {
      issues.push({
        segmentId: segment.id,
        message: `Segment "${segment.id}" look "${String(segment.look)}" is not supported.`,
      });
    }
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
