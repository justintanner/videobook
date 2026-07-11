import { describe, it, expect } from "vitest";
import { planIntervalSplit } from "./even-split.js";

describe("planIntervalSplit (pure)", () => {
  it("D=34, I=10 → 3 targets [10,10,10], clips [10,10,10,4]", () => {
    const r = planIntervalSplit(34, 10);
    expect(r.disabled).toBe(false);
    expect(r.targets).toEqual([10, 10, 10]);
    expect(r.clipDurations).toEqual([10, 10, 10, 4]);
    expect(r.clipCount).toBe(4);
    expect(r.boundaries).toEqual([10, 20, 30]);
  });

  it("D=30, I=10 → 3 targets [10,10,10], clips [10,10,10], no leftover", () => {
    const r = planIntervalSplit(30, 10);
    expect(r.disabled).toBe(false);
    expect(r.targets).toEqual([10, 10, 10]);
    expect(r.clipDurations).toEqual([10, 10, 10]);
    expect(r.clipCount).toBe(3);
    expect(r.boundaries).toEqual([10, 20]);
  });

  it("D=20, I=10 → 2 targets, exact fit, 2 clips", () => {
    const r = planIntervalSplit(20, 10);
    expect(r.disabled).toBe(false);
    expect(r.targets).toEqual([10, 10]);
    expect(r.clipDurations).toEqual([10, 10]);
    expect(r.clipCount).toBe(2);
    expect(r.boundaries).toEqual([10]);
  });

  it("D=15, I=5 → 3 targets, exact fit, 3 clips", () => {
    const r = planIntervalSplit(15, 5);
    expect(r.disabled).toBe(false);
    expect(r.targets).toEqual([5, 5, 5]);
    expect(r.clipDurations).toEqual([5, 5, 5]);
    expect(r.clipCount).toBe(3);
  });

  it("D=30.3, I=10 → omit one (remainder < 0.5), 2 targets, 3 clips [10,10,10.3]", () => {
    const r = planIntervalSplit(30.3, 10);
    expect(r.disabled).toBe(false);
    expect(r.targets).toEqual([10, 10]);
    expect(r.clipDurations[0]).toBe(10);
    expect(r.clipDurations[1]).toBe(10);
    expect(r.clipDurations[2]).toBeCloseTo(10.3, 5);
    expect(r.clipCount).toBe(3);
  });

  it("D=20.4, I=10 → omit one, 1 target, 2 clips [10,10.4]", () => {
    const r = planIntervalSplit(20.4, 10);
    expect(r.disabled).toBe(false);
    expect(r.targets).toEqual([10]);
    expect(r.clipDurations[0]).toBe(10);
    expect(r.clipDurations[1]).toBeCloseTo(10.4, 5);
    expect(r.clipCount).toBe(2);
  });

  it("D=20.5, I=10 → no omit (remainder = 0.5), 2 targets, 3 clips [10,10,0.5]", () => {
    const r = planIntervalSplit(20.5, 10);
    expect(r.disabled).toBe(false);
    expect(r.targets).toEqual([10, 10]);
    expect(r.clipDurations).toEqual([10, 10, 0.5]);
    expect(r.clipCount).toBe(3);
  });

  it("D=10.4, I=10 → omit one → 0 targets → disabled", () => {
    const r = planIntervalSplit(10.4, 10);
    expect(r.disabled).toBe(true);
    expect(r.clipCount).toBe(0);
  });

  it("D=10, I=10 → 1 target, 1 clip → disabled (< 2 clips)", () => {
    const r = planIntervalSplit(10, 10);
    expect(r.disabled).toBe(true);
    expect(r.clipCount).toBe(1);
  });

  it("D=5, I=10 → 0 targets → disabled", () => {
    const r = planIntervalSplit(5, 10);
    expect(r.disabled).toBe(true);
  });

  it("D=34, I=5 → 6 targets, clips [5,5,5,5,5,5,4]", () => {
    const r = planIntervalSplit(34, 5);
    expect(r.disabled).toBe(false);
    expect(r.targets).toEqual([5, 5, 5, 5, 5, 5]);
    expect(r.clipDurations).toEqual([5, 5, 5, 5, 5, 5, 4]);
    expect(r.clipCount).toBe(7);
  });

  it("D=34, I=15 → 2 targets, clips [15,15,4]", () => {
    const r = planIntervalSplit(34, 15);
    expect(r.disabled).toBe(false);
    expect(r.targets).toEqual([15, 15]);
    expect(r.clipDurations).toEqual([15, 15, 4]);
    expect(r.clipCount).toBe(3);
  });

  it("rejects invalid input", () => {
    expect(planIntervalSplit(0, 10).disabled).toBe(true);
    expect(planIntervalSplit(-1, 10).disabled).toBe(true);
    expect(planIntervalSplit(NaN, 10).disabled).toBe(true);
    expect(planIntervalSplit(30, 0).disabled).toBe(true);
    expect(planIntervalSplit(30, -1).disabled).toBe(true);
  });

  it("boundaries are cumulative clip duration sums", () => {
    const r = planIntervalSplit(34, 10);
    expect(r.boundaries).toEqual([10, 20, 30]);
    const last = r.boundaries[r.boundaries.length - 1];
    expect(last + r.clipDurations[r.clipDurations.length - 1]).toBeCloseTo(34, 5);
  });
});
