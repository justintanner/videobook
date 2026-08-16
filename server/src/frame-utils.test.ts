import { describe, expect, it } from "vitest";
import { generateTimestamps, sampleEvenly } from "./frame-utils.js";

describe("sampleEvenly", () => {
  const items = [0, 1, 2, 3, 4];

  it("returns no samples when the maximum is zero", () => {
    expect(sampleEvenly(items, 0)).toEqual([]);
  });

  it("returns the first item when the maximum is one", () => {
    expect(sampleEvenly(items, 1)).toEqual([0]);
  });

  it("preserves both endpoints when the maximum is two", () => {
    expect(sampleEvenly(items, 2)).toEqual([0, 4]);
  });

  it("keeps endpoints while distributing samples across the input", () => {
    expect(sampleEvenly(items, 3)).toEqual([0, 2, 4]);
  });
});

describe("generateTimestamps", () => {
  it("returns no timestamps for non-positive or non-finite durations", () => {
    expect(generateTimestamps(0)).toEqual([]);
    expect(generateTimestamps(-1)).toEqual([]);
    expect(generateTimestamps(Number.NaN)).toEqual([]);
    expect(generateTimestamps(Number.POSITIVE_INFINITY)).toEqual([]);
  });

  it("generates distinct increasing timestamps for clips shorter than the end margin", () => {
    const timestamps = generateTimestamps(0.05);

    expect(timestamps).toHaveLength(3);
    expect(new Set(timestamps).size).toBe(timestamps.length);
    expect(timestamps.every((timestamp, index) => (
      index === 0 || timestamp > timestamps[index - 1]!
    ))).toBe(true);
    expect(timestamps.at(-1)).toBeLessThan(0.05);
  });

  it("keeps the ten-second sampling boundary and stays inside the clip", () => {
    const timestamps = generateTimestamps(10);

    expect(timestamps).toHaveLength(5);
    expect(timestamps[0]).toBe(0);
    expect(timestamps.at(-1)).toBeCloseTo(9.9);
    expect(timestamps.at(-1)).toBeLessThan(10);
  });

  it("produces unique monotonic timestamps for long clips", () => {
    const timestamps = generateTimestamps(150);

    expect(timestamps).toHaveLength(30);
    expect(new Set(timestamps).size).toBe(timestamps.length);
    expect(timestamps.every((timestamp, index) => (
      index === 0 || timestamp > timestamps[index - 1]!
    ))).toBe(true);
    expect(timestamps.at(-1)).toBeLessThan(150);
  });
});
