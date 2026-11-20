import { describe, expect, it } from "vitest";
import {
  checkSegmentPlan,
  frameToSeconds,
  planOutputFrames,
  secondsToFrame,
  segmentOutputFrames,
  segmentOutputStartFrames,
  segmentPlanSchema,
  segmentZoomAt,
  type SegmentPlan,
} from "./plan.js";

function basePlan(overrides: Partial<SegmentPlan> = {}): SegmentPlan {
  return {
    version: 1,
    source: {
      artifactId: "01a1f7ff-f474-728a-86cf-d78a3d147b8a",
      sourceHash: "a".repeat(64),
      fps: 30,
      frames: 300,
      width: 320,
      height: 180,
      hasAudio: true,
    },
    segments: [
      { id: "cold-open", role: "cold_open", startFrame: 60, endFrame: 90, speed: 1, motion: "repeat", audio: "source" },
      { id: "body-1", role: "body", startFrame: 0, endFrame: 120, speed: 1, motion: "repeat", audio: "source" },
    ],
    ...overrides,
  };
}

describe("segment plan schema and frame arithmetic", () => {
  it("parses a plan with defaults and rejects unknown fields like objectHash", () => {
    const parsed = segmentPlanSchema.parse({
      version: 1,
      source: basePlan().source,
      segments: [{ id: "seg-1", role: "body", startFrame: 0, endFrame: 60 }],
    });
    expect(parsed.segments[0]).toEqual({
      id: "seg-1",
      role: "body",
      startFrame: 0,
      endFrame: 60,
      speed: 1,
      motion: "repeat",
      audio: "source",
      look: "none",
    });
    expect(() => segmentPlanSchema.parse({
      ...basePlan(),
      source: { ...basePlan().source, objectHash: "b".repeat(64) },
    })).toThrow();
    expect(() => segmentPlanSchema.parse({ ...basePlan(), segments: [] })).toThrow();
    expect(() => segmentPlanSchema.parse({
      ...basePlan(),
      segments: Array.from({ length: 25 }, (_, i) => ({
        id: `s-${i}`, role: "body", startFrame: 0, endFrame: 10,
      })),
    })).toThrow();
  });

  it("computes output frames, segment start frames, and second/frame conversions", () => {
    expect(secondsToFrame(2.5, 30)).toBe(75);
    expect(frameToSeconds(75, 30)).toBe(2.5);
    expect(segmentOutputFrames({ startFrame: 30, endFrame: 60, speed: 0.5 })).toBe(60);
    expect(segmentOutputFrames({ startFrame: 0, endFrame: 60, speed: 2 })).toBe(30);
    const plan = basePlan({
      segments: [
        { id: "a", role: "cold_open", startFrame: 60, endFrame: 90, speed: 1, motion: "repeat", audio: "source" },
        { id: "b", role: "crash", startFrame: 30, endFrame: 60, speed: 0.5, motion: "flow", audio: "pitch" },
        { id: "c", role: "body", startFrame: 0, endFrame: 60, speed: 2, motion: "repeat", audio: "mute" },
      ],
    });
    expect(segmentOutputStartFrames(plan)).toEqual([0, 30, 90]);
    expect(planOutputFrames(plan)).toBe(120);
    expect(checkSegmentPlan(plan)).toEqual([]);
  });

  it("reports ranges outside the source, empty, and reversed ranges", () => {
    const plan = basePlan({
      segments: [
        { id: "neg", role: "body", startFrame: -5, endFrame: 30, speed: 1, motion: "repeat", audio: "source" },
        { id: "past", role: "body", startFrame: 280, endFrame: 305, speed: 1, motion: "repeat", audio: "source" },
        { id: "empty", role: "body", startFrame: 50, endFrame: 50, speed: 1, motion: "repeat", audio: "source" },
        { id: "rev", role: "body", startFrame: 90, endFrame: 60, speed: 1, motion: "repeat", audio: "source" },
      ],
    });
    const issues = checkSegmentPlan(plan);
    expect(issues.map((issue) => issue.segmentId)).toEqual(["neg", "past", "empty", "rev"]);
    expect(issues[0]!.message).toContain("outside");
    expect(issues[1]!.message).toContain("outside");
    expect(issues[2]!.message).toContain("empty or reversed");
    expect(issues[3]!.message).toContain("empty or reversed");
  });

  it("reports segments with fewer than 2 output frames, duplicate ids, and output over 180 s", () => {
    const shortIssues = checkSegmentPlan(basePlan({
      segments: [
        { id: "one", role: "custom", startFrame: 10, endFrame: 11, speed: 1, motion: "repeat", audio: "source" },
        { id: "fast", role: "custom", startFrame: 10, endFrame: 13, speed: 4, motion: "repeat", audio: "source" },
      ],
    }));
    expect(shortIssues.map((issue) => issue.segmentId)).toEqual(["one", "fast"]);
    expect(shortIssues.every((issue) => issue.message.includes("at least 2"))).toBe(true);

    const dupIssues = checkSegmentPlan(basePlan({
      segments: [
        { id: "dup", role: "replay", startFrame: 0, endFrame: 30, speed: 1, motion: "repeat", audio: "source" },
        { id: "dup", role: "replay", startFrame: 0, endFrame: 30, speed: 1, motion: "repeat", audio: "source" },
      ],
    }));
    expect(dupIssues).toEqual([{ segmentId: "dup", message: 'Duplicate segment id "dup".' }]);

    const longIssues = checkSegmentPlan(basePlan({
      source: { ...basePlan().source, frames: 3000 },
      segments: [
        { id: "s1", role: "body", startFrame: 0, endFrame: 3000, speed: 0.5, motion: "blend", audio: "source" },
      ],
    }));
    expect(longIssues).toHaveLength(1);
    expect(longIssues[0]!.segmentId).toBe("s1");
    expect(longIssues[0]!.message).toContain("180 s");
  });

  it("evaluates segmentZoomAt for hold, linear, smooth and rampFraction", () => {
    const baseSeg = { startFrame: 0, endFrame: 31, speed: 1 };
    expect(segmentZoomAt(baseSeg, 10)).toEqual({ scale: 1, x: 0.5, y: 0.5 });

    const holdSeg = {
      ...baseSeg,
      zoom: { from: { scale: 1, x: 0.2, y: 0.2 }, to: { scale: 2, x: 0.5, y: 0.25 }, ease: "hold" as const },
    };
    expect(segmentZoomAt(holdSeg, 0)).toEqual({ scale: 2, x: 0.5, y: 0.25 });
    expect(segmentZoomAt(holdSeg, 30)).toEqual({ scale: 2, x: 0.5, y: 0.25 });

    const linearSeg = {
      ...baseSeg,
      zoom: { from: { scale: 1, x: 0.3, y: 0.5 }, to: { scale: 2, x: 0.7, y: 0.5 }, ease: "linear" as const },
    };
    expect(segmentZoomAt(linearSeg, 0)).toEqual({ scale: 1, x: 0.3, y: 0.5 });
    expect(segmentZoomAt(linearSeg, 15).scale).toBeCloseTo(1.5, 6);
    expect(segmentZoomAt(linearSeg, 15).x).toBeCloseTo(0.5, 6);
    expect(segmentZoomAt(linearSeg, 30)).toEqual({ scale: 2, x: 0.7, y: 0.5 });

    const smoothSeg = {
      ...baseSeg,
      zoom: {
        from: { scale: 1, x: 0.5, y: 0.5 },
        to: { scale: 2.7, x: 0.6, y: 0.4 },
        ease: "smooth" as const,
        rampFraction: 0.5,
      },
    };
    expect(segmentZoomAt(smoothSeg, 0)).toEqual({ scale: 1, x: 0.5, y: 0.5 });
    expect(segmentZoomAt(smoothSeg, 15)).toEqual({ scale: 2.7, x: 0.6, y: 0.4 });
    expect(segmentZoomAt(smoothSeg, 30)).toEqual({ scale: 2.7, x: 0.6, y: 0.4 });
  });

  it("reports zoom fields out of range in checkSegmentPlan", () => {
    const badZoomPlan = basePlan({
      segments: [
        {
          id: "bad-z",
          role: "push_in",
          startFrame: 0,
          endFrame: 30,
          speed: 1,
          motion: "repeat",
          audio: "source",
          zoom: {
            from: { scale: 0.5, x: -0.1, y: 0.5 },
            to: { scale: 3.5, x: 0.5, y: 1.2 },
            ease: "linear",
            rampFraction: 0,
          },
        },
      ],
    });
    const issues = checkSegmentPlan(badZoomPlan);
    expect(issues.every((issue) => issue.segmentId === "bad-z")).toBe(true);
    expect(issues.map((issue) => issue.message)).toEqual(expect.arrayContaining([
      expect.stringContaining("zoom.from.scale"),
      expect.stringContaining("zoom.from.x"),
      expect.stringContaining("zoom.to.scale"),
      expect.stringContaining("zoom.to.y"),
      expect.stringContaining("zoom.rampFraction"),
    ]));
  });
});
