import { describe, expect, it } from 'vitest';
import {
  clampSplitSec,
  frameIndex,
  MIN_CHUNK_SEC,
  parseTimestamp,
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
