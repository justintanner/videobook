import { describe, expect, it } from "vitest";
import { builtinSound } from "../sound-effects/catalog.js";
import {
  checkSegmentPlan,
  frameToSeconds,
  planOutputFrames,
  segmentOutputFrames,
  segmentOutputStartFrames,
  type SegmentSource,
} from "./plan.js";
import {
  autoEditAnchorsSchema,
  autoEditCuesSchema,
  autoEditCueSchema,
  autoEditSectionsSchema,
  buildAutoEditPlan,
  CRASH_REPLAY,
  DEFAULT_AUTO_EDIT_SECTIONS,
  defaultAnchors,
  normalizeAnchors,
  type AutoEditAnchors,
  type AutoEditSections,
} from "./style.js";

function sourceOf(fps: number, frames: number): SegmentSource {
  return {
    artifactId: "01a1f7ff-f474-728a-86cf-d78a3d147b8a",
    sourceHash: "a".repeat(64),
    fps,
    frames,
    width: 1080,
    height: 1920,
    hasAudio: true,
  };
}

const REFERENCE_SOURCE = sourceOf(59.94, 1780);
const REFERENCE_ANCHORS: AutoEditAnchors = {
  hook: { start: 1.718, end: 4.288 },
  moment: { start: 7.017, peak: 7.484, end: 8.252 },
  focus: {
    start: { x: 0.5, y: 0.5 },
    peak: { x: 0.63, y: 0.62 },
    end: { x: 0.36, y: 0.53 },
  },
  keep: { start: 1.018, end: 21.188 },
  cuts: [{ start: 13.096, end: 16.333 }],
};

describe("crash replay auto-edit style", () => {
  it("reproduces the measured reference timeline, zooms, look, sound policies, and cues", () => {
    expect(CRASH_REPLAY.replayZoomScale).toBe(1.9);
    expect(CRASH_REPLAY.pushInZoomScale).toBe(2.0);
    expect(CRASH_REPLAY.crashZoomScale).toBe(2.7);
    expect(CRASH_REPLAY.crashSpeed).toBe(0.5);
    expect(CRASH_REPLAY.crashRampFraction).toBe(0.55);

    const parsedAnchors = autoEditAnchorsSchema.parse(REFERENCE_ANCHORS);
    const parsedSections = autoEditSectionsSchema.parse({});
    expect(parsedSections).toEqual(DEFAULT_AUTO_EDIT_SECTIONS);

    const { plan, cues, changes } = buildAutoEditPlan(REFERENCE_SOURCE, parsedAnchors, parsedSections);
    expect(changes).toEqual([]);
    expect(checkSegmentPlan(plan)).toEqual([]);
    expect(autoEditCuesSchema.parse(cues)).toEqual(cues);

    expect(plan.segments.map((segment) => segment.role)).toEqual([
      "cold_open",
      "body",
      "replay",
      "replay",
      "push_in",
      "crash",
      "body",
      "body",
    ]);

    const expectedLengths = [2.6, 7.267, 0.467, 0.467, 1.333, 1.433, 4.833, 4.9];
    const actualLengths = plan.segments.map((segment) => frameToSeconds(segmentOutputFrames(segment), REFERENCE_SOURCE.fps));
    actualLengths.forEach((length, idx) => {
      expect(Math.abs(length - expectedLengths[idx]!), `segment ${idx} length`).toBeLessThanOrEqual(0.15);
    });
    const totalSeconds = frameToSeconds(planOutputFrames(plan), REFERENCE_SOURCE.fps);
    expect(Math.abs(totalSeconds - 23.3)).toBeLessThanOrEqual(0.2);

    const replay2 = plan.segments[3]!;
    expect(replay2.zoom).toEqual({
      from: { scale: 1.9, x: 0.5, y: 0.5 },
      to: { scale: 1.9, x: 0.5, y: 0.5 },
      ease: "hold",
      rampFraction: 1,
    });

    const pushIn = plan.segments[4]!;
    expect(pushIn.zoom).toEqual({
      from: { scale: 1, x: 0.5, y: 0.5 },
      to: { scale: 2, x: 0.36, y: 0.53 },
      ease: "linear",
      rampFraction: 1,
    });

    const crash = plan.segments[5]!;
    expect(crash.speed).toBe(0.5);
    expect(crash.motion).toBe("flow");
    expect(crash.look).toBe("crash");
    expect(crash.audio).toBe("pitch");
    expect(crash.zoom).toEqual({
      from: { scale: 1, x: 0.63, y: 0.62 },
      to: { scale: 2.7, x: 0.63, y: 0.62 },
      ease: "smooth",
      rampFraction: 0.55,
    });

    const starts = segmentOutputStartFrames(plan);
    const replay1Start = frameToSeconds(starts[2]!, REFERENCE_SOURCE.fps);
    const replay2Start = frameToSeconds(starts[3]!, REFERENCE_SOURCE.fps);
    const crashStart = frameToSeconds(starts[5]!, REFERENCE_SOURCE.fps);

    expect(cues.map((cue) => cue.sound)).toEqual(["riser", "impact", "impact", "glitch", "power_down"]);
    expect(cues.every((cue) => cue.volume === 70)).toBe(true);
    expect(cues[0]!.startSeconds).toBeCloseTo(replay1Start - builtinSound("riser").accentSeconds, 6);
    expect(cues[1]!.startSeconds).toBeCloseTo(replay1Start, 6);
    expect(cues[2]!.startSeconds).toBeCloseTo(replay2Start, 6);
    expect(cues[3]!.startSeconds).toBeCloseTo(crashStart, 6);
    expect(cues[4]!.startSeconds).toBeCloseTo(crashStart, 6);
    expect(autoEditCueSchema.parse(cues[0])).toEqual(cues[0]);
  });

  it("removes exactly each section's segments and cues while keeping full coverage of keep minus cuts", () => {
    const cases: Array<{
      name: string;
      override: Partial<AutoEditSections>;
      roles: string[];
      cues: string[];
    }> = [
      {
        name: "coldOpen off",
        override: { coldOpen: false },
        roles: ["body", "replay", "replay", "push_in", "crash", "body", "body"],
        cues: ["riser", "impact", "impact", "glitch", "power_down"],
      },
      {
        name: "replays off",
        override: { replays: false },
        roles: ["cold_open", "body", "push_in", "crash", "body", "body"],
        cues: ["glitch", "power_down"],
      },
      {
        name: "pushIn off",
        override: { pushIn: false },
        roles: ["cold_open", "body", "replay", "replay", "crash", "body", "body"],
        cues: ["riser", "impact", "impact", "glitch", "power_down"],
      },
      {
        name: "crash off",
        override: { crash: false },
        roles: ["cold_open", "body", "replay", "replay", "push_in", "body", "body"],
        cues: ["riser", "impact", "impact"],
      },
      {
        name: "sounds off",
        override: { sounds: false },
        roles: ["cold_open", "body", "replay", "replay", "push_in", "crash", "body", "body"],
        cues: [],
      },
      {
        name: "all moment effects off",
        override: { replays: false, pushIn: false, crash: false },
        roles: ["cold_open", "body", "body"],
        cues: [],
      },
    ];

    for (const testCase of cases) {
      const sections: AutoEditSections = { ...DEFAULT_AUTO_EDIT_SECTIONS, ...testCase.override };
      const { plan, cues } = buildAutoEditPlan(REFERENCE_SOURCE, REFERENCE_ANCHORS, sections);
      expect(checkSegmentPlan(plan), testCase.name).toEqual([]);
      expect(plan.segments.map((segment) => segment.role), testCase.name).toEqual(testCase.roles);
      expect(cues.map((cue) => cue.sound), testCase.name).toEqual(testCase.cues);

      const bodySegments = plan.segments.filter((segment) => segment.role === "body");
      const keepStart = Math.round(REFERENCE_ANCHORS.keep.start * REFERENCE_SOURCE.fps);
      const keepEnd = Math.round(REFERENCE_ANCHORS.keep.end * REFERENCE_SOURCE.fps);
      const cutStart = Math.round(REFERENCE_ANCHORS.cuts[0]!.start * REFERENCE_SOURCE.fps);
      const cutEnd = Math.round(REFERENCE_ANCHORS.cuts[0]!.end * REFERENCE_SOURCE.fps);
      const coveredFrames = bodySegments.reduce((total, segment) => total + (segment.endFrame - segment.startFrame), 0);
      expect(coveredFrames, testCase.name).toBe((keepEnd - keepStart) - (cutEnd - cutStart));
    }
  });

  it("repairs every rule violation in normalizeAnchors and handles moments at clip edges", () => {
    const src = sourceOf(30, 300);
    const broken: AutoEditAnchors = {
      hook: { start: -1, end: 8 },
      moment: { start: 6.5, peak: 5.0, end: 9.5 },
      focus: {
        start: { x: 0.5, y: 0.5 },
        peak: { x: 0.5, y: 0.5 },
        end: { x: 0.5, y: 0.5 },
      },
      keep: { start: -0.5, end: 11 },
      cuts: [
        { start: 0.5, end: 0.6 },
        { start: 2.0, end: 2.5 },
        { start: 2.3, end: 2.9 },
        { start: 5.5, end: 6.2 },
      ],
    };
    const { anchors: fixed, changes } = normalizeAnchors(src, broken);
    expect(changes.length).toBeGreaterThanOrEqual(5);
    expect(fixed.keep.start).toBe(0);
    expect(fixed.keep.end).toBe(10);
    expect(fixed.moment.start).toBeLessThan(fixed.moment.peak);
    expect(fixed.moment.peak).toBeLessThan(fixed.moment.end);
    expect(fixed.moment.peak - fixed.moment.start).toBeGreaterThanOrEqual(0.2 - 1e-6);
    expect(fixed.moment.peak - fixed.moment.start).toBeLessThanOrEqual(0.8 + 1e-6);
    expect(fixed.moment.end - fixed.moment.peak).toBeGreaterThanOrEqual(0.3 - 1e-6);
    expect(fixed.moment.end - fixed.moment.peak).toBeLessThanOrEqual(2 + 1e-6);
    expect(fixed.hook).not.toBeNull();
    expect(fixed.hook!.end - fixed.hook!.start).toBeLessThanOrEqual(5 + 1e-6);
    expect(fixed.hook!.end).toBeLessThanOrEqual(fixed.moment.peak + 1e-6);
    expect(fixed.cuts).toEqual([{ start: 2, end: 2.9 }]);
    expect(checkSegmentPlan(buildAutoEditPlan(src, broken).plan)).toEqual([]);

    const shortKeep = normalizeAnchors(src, {
      ...broken,
      hook: { start: 3, end: 3.5 },
      keep: { start: 4, end: 4.2 },
      moment: { start: 4, peak: 4.1, end: 4.2 },
      cuts: [{ start: 1, end: 2 }],
    });
    expect(shortKeep.anchors.keep.end - shortKeep.anchors.keep.start).toBeCloseTo(1, 3);
    expect(shortKeep.anchors.hook).toBeNull();
    expect(shortKeep.anchors.cuts).toEqual([]);
    expect(checkSegmentPlan(buildAutoEditPlan(src, shortKeep.anchors).plan)).toEqual([]);

    const atStart = buildAutoEditPlan(src, {
      hook: null,
      moment: { start: 0, peak: 0, end: 0.4 },
      focus: defaultAnchors(src).focus,
      keep: { start: 0, end: 10 },
      cuts: [],
    });
    expect(checkSegmentPlan(atStart.plan)).toEqual([]);
    expect(atStart.cues.some((cue) => cue.sound === "riser")).toBe(false);

    const atEnd = buildAutoEditPlan(src, {
      hook: { start: 0, end: 2.5 },
      moment: { start: 9.8, peak: 10, end: 10 },
      focus: defaultAnchors(src).focus,
      keep: { start: 0, end: 10 },
      cuts: [],
    });
    expect(checkSegmentPlan(atEnd.plan)).toEqual([]);
    expect(atEnd.plan.segments.filter((segment) => segment.role === "body")).toHaveLength(1);
  });

  it("builds deterministic valid plans from defaultAnchors for 1 s, 4 s, 9 s and 60 s clips", () => {
    for (const seconds of [1, 4, 9, 60]) {
      const src = sourceOf(30, seconds * 30);
      const anchors = defaultAnchors(src);
      if (seconds < 5) expect(anchors.hook).toBeNull();
      else expect(anchors.hook).toEqual({ start: 0, end: 2.5 });
      const first = buildAutoEditPlan(src, anchors);
      const second = buildAutoEditPlan(src, anchors);
      expect(first).toEqual(second);
      expect(checkSegmentPlan(first.plan)).toEqual([]);
    }
  });
});
