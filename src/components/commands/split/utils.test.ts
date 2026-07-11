import { describe, expect, it } from 'vitest';
import {
  clampSplitSec,
  frameIndex,
  MIN_CHUNK_SEC,
  parseTimestamp,
  planIntervalSplit,
  quantizeToFrame,
} from './utils';

describe('split utils', () => {
  it('parseTimestamp handles seconds and m:ss', () => {
    expect(parseTimestamp('12')).toBe(12);
    expect(parseTimestamp('0:12')).toBe(12);
    expect(parseTimestamp('1:05')).toBe(65);
    expect(parseTimestamp('1:02:03')).toBe(3723);
    expect(parseTimestamp('')).toBeUndefined();
  });

  it('quantizeToFrame snaps to frame grid', () => {
    expect(quantizeToFrame(1.0, 30)).toBeCloseTo(1.0, 5);
    expect(quantizeToFrame(1.01, 30)).toBeCloseTo(1.0, 5);
    expect(quantizeToFrame(1.02, 30)).toBeCloseTo(1 + 1 / 30, 5);
  });

  it('frameIndex is stable for neighbors', () => {
    expect(frameIndex(1.0, 30)).toBe(30);
    expect(frameIndex(1 + 1 / 30, 30)).toBe(31);
  });

  it('clampSplitSec keeps both chunks >= MIN_CHUNK_SEC', () => {
    expect(clampSplitSec(0, 10)).toBe(MIN_CHUNK_SEC);
    expect(clampSplitSec(10, 10)).toBe(10 - MIN_CHUNK_SEC);
    expect(clampSplitSec(5, 10)).toBe(5);
  });
});

describe('planIntervalSplit', () => {
  it('34s @ 10s → 10/10/10/4 with three boundaries', () => {
    const r = planIntervalSplit(34, 10);
    expect(r.disabled).toBe(false);
    expect(r.targets).toEqual([10, 10, 10]);
    expect(r.clipDurations).toEqual([10, 10, 10, 4]);
    expect(r.clipCount).toBe(4);
    expect(r.boundaries).toEqual([10, 20, 30]);
  });

  it('exact multiple has no remainder clip', () => {
    const r = planIntervalSplit(30, 10);
    expect(r.targets).toEqual([10, 10, 10]);
    expect(r.clipDurations).toEqual([10, 10, 10]);
    expect(r.boundaries).toEqual([10, 20]);
  });

  it('sub-MIN remainder drops one target so stub merges', () => {
    const r = planIntervalSplit(30.3, 10);
    expect(r.targets).toEqual([10, 10]);
    expect(r.clipDurations[0]).toBe(10);
    expect(r.clipDurations[1]).toBe(10);
    expect(r.clipDurations[2]).toBeCloseTo(10.3, 5);
    expect(r.clipCount).toBe(3);
  });

  it('disables when fewer than two clips', () => {
    expect(planIntervalSplit(10, 10).disabled).toBe(true);
    expect(planIntervalSplit(5, 10).disabled).toBe(true);
    expect(planIntervalSplit(10.4, 10).disabled).toBe(true);
  });

  it('rejects invalid inputs', () => {
    expect(planIntervalSplit(0, 10).disabled).toBe(true);
    expect(planIntervalSplit(30, 0).disabled).toBe(true);
    expect(planIntervalSplit(NaN, 10).disabled).toBe(true);
  });
});
