import { describe, expect, it } from "vitest";
import { buildTimewarpVideoFilter, createTimewarpPlan } from "./timewarp.js";

describe("createTimewarpPlan", () => {
  it("computes the canonical fixed-duration warp", () => {
    const plan = createTimewarpPlan({
      sourceDuration: 10,
      sourceFps: 30,
      startSeconds: 0,
      endSeconds: 4.2,
      stretchFactor: 1.5,
    });

    expect(plan.selectedOutputDuration).toBeCloseTo(6.3, 10);
    expect(plan.outsideOutputDuration).toBeCloseTo(3.7, 10);
    expect(plan.outsideStretchFactor).toBeCloseTo(3.7 / 5.8, 10);
    expect(plan.segments.map((item) => item.kind)).toEqual(["selection", "suffix"]);
    expect(plan.segments.reduce((sum, item) => sum + item.outputDuration, 0)).toBeCloseTo(10, 10);
  });

  it("uses one outside factor for prefix and suffix", () => {
    const plan = createTimewarpPlan({
      sourceDuration: 12,
      sourceFps: 24,
      startSeconds: 3,
      endSeconds: 7,
      stretchFactor: 0.5,
    });

    expect(plan.segments.map((item) => item.kind)).toEqual(["prefix", "selection", "suffix"]);
    expect(plan.segments[0].stretchFactor).toBe(plan.outsideStretchFactor);
    expect(plan.segments[2].stretchFactor).toBe(plan.outsideStretchFactor);
    expect(plan.segments.reduce((sum, item) => sum + item.outputDuration, 0)).toBeCloseTo(12, 10);
  });

  it("builds a video-only trim, setpts, and concat graph", () => {
    const plan = createTimewarpPlan({
      sourceDuration: 5,
      sourceFps: 25,
      startSeconds: 1,
      endSeconds: 3,
      stretchFactor: 1.5,
    });

    const filter = buildTimewarpVideoFilter(plan);
    expect(filter).toContain("[0:v:0]trim=start=1:end=3,setpts=(PTS-STARTPTS)*1.5[v1]");
    expect(filter).toContain("[v0][v1][v2]concat=n=3:v=1:a=0[vout]");
    expect(filter).not.toContain("atempo");
    expect(filter).not.toContain("atrim");
  });

  it.each([
    { startSeconds: -1, endSeconds: 2, stretchFactor: 1.5, message: "range" },
    { startSeconds: 2, endSeconds: 2, stretchFactor: 1.5, message: "range" },
    { startSeconds: 0, endSeconds: 10, stretchFactor: 1.5, message: "full clip" },
    { startSeconds: 0, endSeconds: 8, stretchFactor: 2, message: "no time" },
    { startSeconds: 0, endSeconds: 2, stretchFactor: 1, message: "no-op" },
    { startSeconds: 0, endSeconds: 2, stretchFactor: 0.1, message: "between" },
    { startSeconds: 0, endSeconds: 2, stretchFactor: 5, message: "between" },
  ])("rejects invalid plan %#", ({ startSeconds, endSeconds, stretchFactor, message }) => {
    expect(() => createTimewarpPlan({
      sourceDuration: 10,
      sourceFps: 30,
      startSeconds,
      endSeconds,
      stretchFactor,
    })).toThrow(message);
  });

  it("rejects an output segment shorter than one frame", () => {
    expect(() => createTimewarpPlan({
      sourceDuration: 10,
      sourceFps: 30,
      startSeconds: 0,
      endSeconds: 0.1,
      stretchFactor: 0.25,
    })).toThrow("shorter than one source frame");
  });
});
