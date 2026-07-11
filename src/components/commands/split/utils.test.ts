import { describe, expect, it } from 'vitest';
import type { TimedCue } from './types';
import {
  clampSplitSec,
  findActiveCueIndex,
  frameIndex,
  MIN_CHUNK_SEC,
  parseTimestamp,
  quantizeToFrame,
} from './utils';

const cues: TimedCue[] = [
  { text: 'Hello', start: 1.0, end: 1.5 },
  { text: 'world', start: 1.6, end: 2.0 },
  { text: 'again', start: 2.5, end: 3.0 },
];

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

  it('findActiveCueIndex covers mid-word and gaps', () => {
    expect(findActiveCueIndex(cues, 1.2)).toBe(0);
    expect(findActiveCueIndex(cues, 1.55)).toBe(0);
    expect(findActiveCueIndex(cues, 1.8)).toBe(1);
    expect(findActiveCueIndex(cues, 2.2)).toBe(1);
    expect(findActiveCueIndex(cues, 2.7)).toBe(2);
  });

  it('findActiveCueIndex handles before first, after last, empty', () => {
    expect(findActiveCueIndex(cues, 0)).toBe(-1);
    expect(findActiveCueIndex(cues, 10)).toBe(2);
    expect(findActiveCueIndex([], 1)).toBe(-1);
  });
});

