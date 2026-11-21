import { z } from "zod";
import { BUILTIN_SOUND_IDS, builtinSound, type BuiltinSoundId } from "../sound-effects/catalog.js";
import type { SegmentLook } from "./looks.js";
import {
  frameToSeconds,
  secondsToFrame,
  segmentOutputStartFrames,
  type PlanSegment,
  type SegmentPlan,
  type SegmentSource,
} from "./plan.js";

const MIN_KEEP_SECONDS = 1;
const MIN_START_TO_PEAK_SECONDS = 0.2;
const MAX_START_TO_PEAK_SECONDS = 0.8;
const MIN_PEAK_TO_END_SECONDS = 0.3;
const MAX_PEAK_TO_END_SECONDS = 2;
const MIN_HOOK_SECONDS = 1.5;
const MAX_HOOK_SECONDS = 5;

export const AUTO_EDIT_ANCHOR_LIMITS = {
  minStartToPeakSeconds: MIN_START_TO_PEAK_SECONDS,
  maxStartToPeakSeconds: MAX_START_TO_PEAK_SECONDS,
  minPeakToEndSeconds: MIN_PEAK_TO_END_SECONDS,
  maxPeakToEndSeconds: MAX_PEAK_TO_END_SECONDS,
  minHookSeconds: MIN_HOOK_SECONDS,
  maxHookSeconds: MAX_HOOK_SECONDS,
} as const;

const MIN_CUT_SECONDS = 0.3;
const MAX_CUTS = 3;
const DEFAULT_HOOK_SECONDS = 2.5;
const DEFAULT_HOOK_MIN_CLIP_SECONDS = 5;
const DEFAULT_MOMENT_SECONDS = 1;
const DEFAULT_PEAK_OFFSET_SECONDS = 0.4;
const DEFAULT_FOCUS = { x: 0.5, y: 0.45 } as const;
const MIN_BODY_FRAMES = 2;
const MAX_CUES = 16;

const autoEditPointSchema = z.object({
  x: z.number().finite().min(0).max(1),
  y: z.number().finite().min(0).max(1),
}).strict();

const autoEditRangeSchema = z.object({
  start: z.number().finite(),
  end: z.number().finite(),
}).strict();

export const autoEditAnchorsSchema = z.object({
  hook: autoEditRangeSchema.nullable(),
  moment: z.object({
    start: z.number().finite(),
    peak: z.number().finite(),
    end: z.number().finite(),
  }).strict(),
  focus: z.object({
    start: autoEditPointSchema,
    peak: autoEditPointSchema,
    end: autoEditPointSchema,
  }).strict(),
  keep: autoEditRangeSchema,
  cuts: z.array(autoEditRangeSchema).max(MAX_CUTS).default([]),
}).strict();

export const autoEditSectionsSchema = z.object({
  coldOpen: z.boolean().default(true),
  replays: z.boolean().default(true),
  pushIn: z.boolean().default(true),
  crash: z.boolean().default(true),
  sounds: z.boolean().default(true),
}).strict();

export const autoEditCueSchema = z.object({
  sound: z.enum(BUILTIN_SOUND_IDS),
  startSeconds: z.number().finite().nonnegative(),
  volume: z.number().finite().min(0).max(100).default(70),
}).strict();

export const autoEditCuesSchema = z.array(autoEditCueSchema).max(MAX_CUES);

export type AutoEditAnchors = z.infer<typeof autoEditAnchorsSchema>;
export type AutoEditSections = z.infer<typeof autoEditSectionsSchema>;
export type AutoEditCue = z.infer<typeof autoEditCueSchema>;

export const DEFAULT_AUTO_EDIT_SECTIONS: AutoEditSections = {
  coldOpen: true,
  replays: true,
  pushIn: true,
  crash: true,
  sounds: true,
};

interface AutoEditStyleCueSpec {
  sound: BuiltinSoundId;
  targetSegmentId: "replay-1" | "replay-2" | "crash";
  align: "start" | "accent";
}

interface AutoEditStyle {
  id: string;
  name: string;
  replayZoomScale: number;
  pushInZoomScale: number;
  crashZoomScale: number;
  crashSpeed: number;
  crashRampFraction: number;
  crashLook: SegmentLook;
  crashFlowMaxSourceSeconds: number;
  cueVolume: number;
  cues: readonly AutoEditStyleCueSpec[];
}

export const CRASH_REPLAY: AutoEditStyle = {
  id: "crash_replay",
  name: "Crash replay",
  replayZoomScale: 1.9,
  pushInZoomScale: 2.0,
  crashZoomScale: 2.7,
  crashSpeed: 0.5,
  crashRampFraction: 0.55,
  crashLook: "crash",
  crashFlowMaxSourceSeconds: 2,
  cueVolume: 70,
  cues: [
    { sound: "riser", targetSegmentId: "replay-1", align: "accent" },
    { sound: "impact", targetSegmentId: "replay-1", align: "start" },
    { sound: "impact", targetSegmentId: "replay-2", align: "start" },
    { sound: "glitch", targetSegmentId: "crash", align: "start" },
    { sound: "shutdown", targetSegmentId: "crash", align: "start" },
  ],
};

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(1, Math.max(0, value));
}

function clampFrame(seconds: number, fps: number, totalFrames: number): { frame: number; clamped: boolean } {
  const duration = frameToSeconds(totalFrames, fps);
  const tolerance = 0.5 / fps;
  const clamped = seconds < -tolerance || seconds > duration + tolerance;
  const rawFrame = secondsToFrame(seconds, fps);
  const frame = Math.min(totalFrames, Math.max(0, rawFrame));
  return { frame, clamped };
}

function pushUnique(list: string[], message: string): void {
  if (!list.includes(message)) list.push(message);
}

export function defaultAnchors(source: Pick<SegmentSource, "fps" | "frames">): AutoEditAnchors {
  const duration = frameToSeconds(source.frames, source.fps);
  const half = duration / 2;
  const momentStart = Math.max(0, half - DEFAULT_MOMENT_SECONDS / 2);
  const momentEnd = Math.min(duration, momentStart + DEFAULT_MOMENT_SECONDS);
  const momentPeak = Math.min(momentEnd, momentStart + DEFAULT_PEAK_OFFSET_SECONDS);
  const snap = (sec: number): number => frameToSeconds(
    Math.min(source.frames, Math.max(0, secondsToFrame(sec, source.fps))),
    source.fps,
  );
  return {
    hook: duration < DEFAULT_HOOK_MIN_CLIP_SECONDS
      ? null
      : { start: 0, end: snap(Math.min(DEFAULT_HOOK_SECONDS, duration)) },
    moment: {
      start: snap(momentStart),
      peak: snap(momentPeak),
      end: snap(momentEnd),
    },
    focus: {
      start: { ...DEFAULT_FOCUS },
      peak: { ...DEFAULT_FOCUS },
      end: { ...DEFAULT_FOCUS },
    },
    keep: { start: 0, end: duration },
    cuts: [],
  };
}

interface NormalizedFrameAnchors {
  hook: { start: number; end: number } | null;
  moment: { start: number; peak: number; end: number };
  focus: AutoEditAnchors["focus"];
  keep: { start: number; end: number };
  cuts: Array<{ start: number; end: number }>;
  changes: string[];
}

function normalizeFrameAnchors(
  source: Pick<SegmentSource, "fps" | "frames">,
  anchors: AutoEditAnchors,
): NormalizedFrameAnchors {
  const fps = source.fps;
  const total = source.frames;
  const changes: string[] = [];

  const snap = (seconds: number): number => {
    const result = clampFrame(seconds, fps, total);
    if (result.clamped) pushUnique(changes, "Clamped anchors to the clip length.");
    return result.frame;
  };

  const clampPoint = (point: { x: number; y: number }): { x: number; y: number } => {
    const x = clampUnit(point.x);
    const y = clampUnit(point.y);
    if (x !== point.x || y !== point.y) pushUnique(changes, "Clamped subject focus inside the frame.");
    return { x, y };
  };

  const focus: AutoEditAnchors["focus"] = {
    start: clampPoint(anchors.focus.start),
    peak: clampPoint(anchors.focus.peak),
    end: clampPoint(anchors.focus.end),
  };

  let keepStart = snap(anchors.keep.start);
  let keepEnd = snap(anchors.keep.end);
  if (keepStart > keepEnd) {
    [keepStart, keepEnd] = [keepEnd, keepStart];
    pushUnique(changes, "Swapped kept range start and end into order.");
  }
  const minKeepFrames = Math.min(total, Math.max(MIN_BODY_FRAMES, secondsToFrame(MIN_KEEP_SECONDS, fps)));
  if (keepEnd - keepStart < minKeepFrames) {
    keepEnd = Math.min(total, keepStart + minKeepFrames);
    if (keepEnd - keepStart < minKeepFrames) {
      keepStart = Math.max(0, keepEnd - minKeepFrames);
    }
    pushUnique(changes, "Extended the kept range to at least 1 s.");
  }

  let momentStart = snap(anchors.moment.start);
  let momentPeak = snap(anchors.moment.peak);
  let momentEnd = snap(anchors.moment.end);

  const clampedStart = Math.min(keepEnd, Math.max(keepStart, momentStart));
  const clampedPeak = Math.min(keepEnd, Math.max(keepStart, momentPeak));
  const clampedEnd = Math.min(keepEnd, Math.max(keepStart, momentEnd));
  if (clampedStart !== momentStart || clampedPeak !== momentPeak || clampedEnd !== momentEnd) {
    momentStart = clampedStart;
    momentPeak = clampedPeak;
    momentEnd = clampedEnd;
    pushUnique(changes, "Moved the moment inside the kept range.");
  }

  if (momentStart > momentPeak || momentPeak > momentEnd) {
    const sorted = [momentStart, momentPeak, momentEnd].sort((a, b) => a - b);
    momentStart = sorted[0]!;
    momentPeak = sorted[1]!;
    momentEnd = sorted[2]!;
    pushUnique(changes, "Ordered moment start, peak and end.");
  }

  const minSpFrames = Math.max(MIN_BODY_FRAMES, secondsToFrame(MIN_START_TO_PEAK_SECONDS, fps));
  const maxSpFrames = Math.max(minSpFrames, secondsToFrame(MAX_START_TO_PEAK_SECONDS, fps));
  const minPeFrames = Math.max(MIN_BODY_FRAMES, secondsToFrame(MIN_PEAK_TO_END_SECONDS, fps));
  const maxPeFrames = Math.max(minPeFrames, secondsToFrame(MAX_PEAK_TO_END_SECONDS, fps));

  const minAllowedPeak = Math.min(keepEnd - minPeFrames, keepStart + minSpFrames);
  const maxAllowedPeak = Math.max(minAllowedPeak, keepEnd - minPeFrames);
  if (momentPeak < minAllowedPeak) {
    momentPeak = minAllowedPeak;
    pushUnique(changes, "Shifted the moment peak inside the kept range so lead-in and tail fit.");
  } else if (momentPeak > maxAllowedPeak) {
    momentPeak = maxAllowedPeak;
    pushUnique(changes, "Shifted the moment peak inside the kept range so lead-in and tail fit.");
  }

  if (momentPeak - momentStart > maxSpFrames) {
    momentStart = momentPeak - maxSpFrames;
    pushUnique(changes, "Moved moment start closer to the peak (at most 0.8 s before).");
  } else if (momentPeak - momentStart < minSpFrames) {
    momentStart = Math.max(keepStart, momentPeak - minSpFrames);
    pushUnique(changes, "Widened moment start to at least 0.2 s before the peak.");
  }

  if (momentEnd - momentPeak > maxPeFrames) {
    momentEnd = momentPeak + maxPeFrames;
    pushUnique(changes, "Moved moment end closer to the peak (at most 2 s after).");
  } else if (momentEnd - momentPeak < minPeFrames) {
    momentEnd = Math.min(keepEnd, momentPeak + minPeFrames);
    pushUnique(changes, "Widened moment end to at least 0.3 s after the peak.");
  }

  const minHookFrames = Math.max(MIN_BODY_FRAMES, secondsToFrame(MIN_HOOK_SECONDS, fps));
  const maxHookFrames = Math.max(minHookFrames, secondsToFrame(MAX_HOOK_SECONDS, fps));
  let hook: { start: number; end: number } | null = null;
  if (anchors.hook !== null) {
    let hookStart = snap(anchors.hook.start);
    let hookEnd = snap(anchors.hook.end);
    if (hookStart > hookEnd) {
      [hookStart, hookEnd] = [hookEnd, hookStart];
      pushUnique(changes, "Swapped cold-open hook start and end into order.");
    }
    const clampedHookStart = Math.min(keepEnd, Math.max(keepStart, hookStart));
    const clampedHookEnd = Math.min(keepEnd, Math.max(keepStart, hookEnd));
    if (clampedHookStart !== hookStart || clampedHookEnd !== hookEnd) {
      hookStart = clampedHookStart;
      hookEnd = clampedHookEnd;
      pushUnique(changes, "Moved the cold-open hook inside the kept range.");
    }

    let hookClearedPeak = false;
    if (hookStart <= momentPeak && momentPeak < hookEnd) {
      const targetLen = Math.min(maxHookFrames, Math.max(minHookFrames, hookEnd - hookStart));
      hookEnd = momentPeak;
      if (hookEnd - hookStart < minHookFrames) {
        hookStart = Math.max(keepStart, hookEnd - targetLen);
      }
      if (hookEnd - hookStart < minHookFrames) {
        hook = null;
        pushUnique(changes, "Removed the cold-open hook because it covered the moment peak.");
        hookClearedPeak = true;
      } else {
        pushUnique(changes, "Trimmed the cold-open hook to end before the moment peak.");
      }
    }

    if (!hookClearedPeak) {
      const upperBound = hookEnd <= momentPeak ? momentPeak : keepEnd;
      if (hookEnd - hookStart > maxHookFrames) {
        hookEnd = hookStart + maxHookFrames;
        pushUnique(changes, "Shortened the cold-open hook to 5 s.");
      }
      if (hookEnd - hookStart < minHookFrames) {
        hookEnd = Math.min(upperBound, hookStart + minHookFrames);
        if (hookEnd - hookStart < minHookFrames) {
          hookStart = Math.max(keepStart, hookEnd - minHookFrames);
        }
        if (hookEnd - hookStart < minHookFrames) {
          hook = null;
          pushUnique(changes, "Removed the cold-open hook because it could not fit 1.5 s inside the kept range.");
        } else {
          hook = { start: hookStart, end: hookEnd };
          pushUnique(changes, "Extended the cold-open hook to 1.5 s.");
        }
      } else {
        hook = { start: hookStart, end: hookEnd };
      }
    }
  }

  const rawCuts = anchors.cuts.map((cut) => {
    let start = snap(cut.start);
    let end = snap(cut.end);
    if (start > end) {
      [start, end] = [end, start];
      pushUnique(changes, "Swapped a cut start and end into order.");
    }
    return { start, end };
  });
  rawCuts.sort((a, b) => a.start - b.start || a.end - b.end);

  const mergedCuts: Array<{ start: number; end: number }> = [];
  for (const cut of rawCuts) {
    const previous = mergedCuts.at(-1);
    if (previous && cut.start <= previous.end) {
      previous.end = Math.max(previous.end, cut.end);
      pushUnique(changes, "Merged overlapping cuts.");
    } else {
      mergedCuts.push({ ...cut });
    }
  }

  const minCutFrames = Math.max(1, secondsToFrame(MIN_CUT_SECONDS, fps));
  const cuts: Array<{ start: number; end: number }> = [];
  for (const cut of mergedCuts) {
    if (cut.start < keepStart || cut.end > keepEnd) {
      pushUnique(changes, "Dropped a cut outside the kept range.");
      continue;
    }
    if (cut.start <= momentEnd && cut.end >= momentStart) {
      pushUnique(changes, "Dropped a cut touching the moment.");
      continue;
    }
    if (cut.end - cut.start < minCutFrames) {
      pushUnique(changes, "Dropped a cut shorter than 0.3 s.");
      continue;
    }
    cuts.push(cut);
  }
  if (cuts.length > MAX_CUTS) {
    cuts.length = MAX_CUTS;
    pushUnique(changes, `Kept only the first ${MAX_CUTS} cuts.`);
  }

  return {
    hook,
    moment: { start: momentStart, peak: momentPeak, end: momentEnd },
    focus,
    keep: { start: keepStart, end: keepEnd },
    cuts,
    changes,
  };
}

function frameAnchorsToSeconds(
  frames: NormalizedFrameAnchors,
  fps: number,
): AutoEditAnchors {
  return {
    hook: frames.hook
      ? { start: frameToSeconds(frames.hook.start, fps), end: frameToSeconds(frames.hook.end, fps) }
      : null,
    moment: {
      start: frameToSeconds(frames.moment.start, fps),
      peak: frameToSeconds(frames.moment.peak, fps),
      end: frameToSeconds(frames.moment.end, fps),
    },
    focus: {
      start: { ...frames.focus.start },
      peak: { ...frames.focus.peak },
      end: { ...frames.focus.end },
    },
    keep: {
      start: frameToSeconds(frames.keep.start, fps),
      end: frameToSeconds(frames.keep.end, fps),
    },
    cuts: frames.cuts.map((cut) => ({
      start: frameToSeconds(cut.start, fps),
      end: frameToSeconds(cut.end, fps),
    })),
  };
}

export function normalizeAnchors(
  source: Pick<SegmentSource, "fps" | "frames">,
  anchors: AutoEditAnchors,
): { anchors: AutoEditAnchors; changes: string[] } {
  const normalized = normalizeFrameAnchors(source, anchors);
  return {
    anchors: frameAnchorsToSeconds(normalized, source.fps),
    changes: normalized.changes,
  };
}

function splitByCuts(
  startFrame: number,
  endFrame: number,
  cuts: ReadonlyArray<{ start: number; end: number }>,
): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let cursor = startFrame;
  for (const cut of cuts) {
    if (cut.end <= startFrame || cut.start >= endFrame) continue;
    const cutStart = Math.max(startFrame, cut.start);
    const cutEnd = Math.min(endFrame, cut.end);
    if (cutStart - cursor >= MIN_BODY_FRAMES) {
      ranges.push({ start: cursor, end: cutStart });
    }
    cursor = Math.max(cursor, cutEnd);
  }
  if (endFrame - cursor >= MIN_BODY_FRAMES) {
    ranges.push({ start: cursor, end: endFrame });
  }
  return ranges;
}

export interface AutoEditBuildResult {
  plan: SegmentPlan;
  cues: AutoEditCue[];
  anchors: AutoEditAnchors;
  changes: string[];
}

export function buildAutoEditPlan(
  source: SegmentSource,
  anchors: AutoEditAnchors,
  sections: AutoEditSections = DEFAULT_AUTO_EDIT_SECTIONS,
  style: AutoEditStyle = CRASH_REPLAY,
): AutoEditBuildResult {
  const normalized = normalizeFrameAnchors(source, anchors);
  const segments: PlanSegment[] = [];
  let bodyIndex = 0;

  const pushBodyRanges = (startFrame: number, endFrame: number): void => {
    for (const range of splitByCuts(startFrame, endFrame, normalized.cuts)) {
      bodyIndex += 1;
      segments.push({
        id: `body-${bodyIndex}`,
        role: "body",
        startFrame: range.start,
        endFrame: range.end,
        speed: 1,
        motion: "repeat",
        audio: "source",
        look: "none",
      });
    }
  };

  if (sections.coldOpen && normalized.hook !== null && normalized.hook.end - normalized.hook.start >= MIN_BODY_FRAMES) {
    segments.push({
      id: "cold-open",
      role: "cold_open",
      startFrame: normalized.hook.start,
      endFrame: normalized.hook.end,
      speed: 1,
      motion: "repeat",
      audio: "source",
      look: "none",
    });
  }

  const hasMomentEffects = sections.replays || sections.pushIn || sections.crash;
  if (!hasMomentEffects) {
    pushBodyRanges(normalized.keep.start, normalized.keep.end);
  } else {
    pushBodyRanges(normalized.keep.start, normalized.moment.end);

    if (sections.replays) {
      segments.push({
        id: "replay-1",
        role: "replay",
        startFrame: normalized.moment.start,
        endFrame: normalized.moment.peak,
        speed: 1,
        motion: "repeat",
        audio: "source",
        look: "none",
      });
      segments.push({
        id: "replay-2",
        role: "replay",
        startFrame: normalized.moment.start,
        endFrame: normalized.moment.peak,
        speed: 1,
        motion: "repeat",
        audio: "source",
        zoom: {
          from: { scale: style.replayZoomScale, x: normalized.focus.start.x, y: normalized.focus.start.y },
          to: { scale: style.replayZoomScale, x: normalized.focus.start.x, y: normalized.focus.start.y },
          ease: "hold",
          rampFraction: 1,
        },
        look: "none",
      });
    }

    if (sections.pushIn) {
      segments.push({
        id: "push-in",
        role: "push_in",
        startFrame: normalized.moment.start,
        endFrame: normalized.moment.end,
        speed: 1,
        motion: "repeat",
        audio: "source",
        zoom: {
          from: { scale: 1, x: normalized.focus.start.x, y: normalized.focus.start.y },
          to: { scale: style.pushInZoomScale, x: normalized.focus.end.x, y: normalized.focus.end.y },
          ease: "linear",
          rampFraction: 1,
        },
        look: "none",
      });
    }

    if (sections.crash) {
      const crashSourceSeconds = (normalized.moment.end - normalized.moment.peak) / source.fps;
      segments.push({
        id: "crash",
        role: "crash",
        startFrame: normalized.moment.peak,
        endFrame: normalized.moment.end,
        speed: style.crashSpeed,
        motion: crashSourceSeconds <= style.crashFlowMaxSourceSeconds ? "flow" : "blend",
        audio: "pitch",
        zoom: {
          from: { scale: 1, x: normalized.focus.peak.x, y: normalized.focus.peak.y },
          to: { scale: style.crashZoomScale, x: normalized.focus.peak.x, y: normalized.focus.peak.y },
          ease: "smooth",
          rampFraction: style.crashRampFraction,
        },
        look: style.crashLook,
      });
    }

    pushBodyRanges(normalized.moment.end, normalized.keep.end);
  }

  const plan: SegmentPlan = {
    version: 1,
    source,
    segments,
  };

  const cues: AutoEditCue[] = [];
  if (sections.sounds) {
    const startFrames = segmentOutputStartFrames(plan);
    const segmentStarts = new Map<string, number>();
    plan.segments.forEach((segment, index) => {
      segmentStarts.set(segment.id, frameToSeconds(startFrames[index]!, source.fps));
    });
    for (const cueSpec of style.cues) {
      const targetSeconds = segmentStarts.get(cueSpec.targetSegmentId);
      if (targetSeconds === undefined) continue;
      if (cueSpec.align === "accent") {
        const startSeconds = targetSeconds - builtinSound(cueSpec.sound).accentSeconds;
        if (startSeconds < 0) continue;
        cues.push({ sound: cueSpec.sound, startSeconds, volume: style.cueVolume });
      } else {
        cues.push({ sound: cueSpec.sound, startSeconds: targetSeconds, volume: style.cueVolume });
      }
    }
  }

  return {
    plan,
    cues,
    anchors: frameAnchorsToSeconds(normalized, source.fps),
    changes: normalized.changes,
  };
}
