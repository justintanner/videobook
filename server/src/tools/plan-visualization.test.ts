import { describe, it, expect } from "vitest";
import { computeChunks } from "./plan-visualization.js";

describe("computeChunks", () => {
  it("returns no chunks for non-positive duration", () => {
    expect(computeChunks(0)).toEqual([]);
    expect(computeChunks(-1)).toEqual([]);
  });

  it("packs the entire clip into one chunk when shorter than CHUNK_S", () => {
    expect(computeChunks(5)).toEqual([{ start: 0, end: 5 }]);
    expect(computeChunks(7)).toEqual([{ start: 0, end: 7 }]);
  });

  it("yields exact 7s chunks when duration is a clean multiple", () => {
    expect(computeChunks(14)).toEqual([
      { start: 0, end: 7 },
      { start: 7, end: 14 },
    ]);
    expect(computeChunks(21)).toEqual([
      { start: 0, end: 7 },
      { start: 7, end: 14 },
      { start: 14, end: 21 },
    ]);
  });

  it("keeps a healthy trailing remainder as its own chunk", () => {
    expect(computeChunks(10)).toEqual([
      { start: 0, end: 7 },
      { start: 7, end: 10 },
    ]);
    expect(computeChunks(17)).toEqual([
      { start: 0, end: 7 },
      { start: 7, end: 14 },
      { start: 14, end: 17 },
    ]);
  });

  it("merges sub-0.5s trailing remainder into the previous chunk", () => {
    // 35.48 = 5×7 + 0.48 — 0.48s trailing would break ffmpeg slicing, so
    // it folds into chunk 5, giving 5 chunks total with a 7.48s last.
    expect(computeChunks(35.48)).toEqual([
      { start: 0, end: 7 },
      { start: 7, end: 14 },
      { start: 14, end: 21 },
      { start: 21, end: 28 },
      { start: 28, end: 35.48 },
    ]);
    // 14.4 = 2×7 + 0.4 — 0.4 is sub-MIN, so the last chunk extends to 14.4.
    expect(computeChunks(14.4)).toEqual([
      { start: 0, end: 7 },
      { start: 7, end: 14.4 },
    ]);
  });

  it("keeps trailing remainder when exactly at MIN_TRAILING_SEC", () => {
    // 14.5 = 2×7 + 0.5 — 0.5s is the inclusive minimum, kept as its own chunk.
    expect(computeChunks(14.5)).toEqual([
      { start: 0, end: 7 },
      { start: 7, end: 14 },
      { start: 14, end: 14.5 },
    ]);
  });

  it("never merges if there's only one chunk and the source is short", () => {
    // 0.3s is sub-MIN but there's no prior chunk to merge into; it stays as
    // a single short chunk so callers can decide what to do.
    expect(computeChunks(0.3)).toEqual([{ start: 0, end: 0.3 }]);
  });
});
