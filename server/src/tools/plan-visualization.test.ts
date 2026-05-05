import { describe, it, expect } from "vitest";
import { computeChunks } from "./plan-visualization.js";
import type { ElevenLabsWord } from "./_suggest-shared.js";

function w(text: string, start: number, end: number): ElevenLabsWord {
  return { text, start, end, type: "word" };
}

describe("computeChunks", () => {
  it("returns no chunks for non-positive duration", () => {
    expect(computeChunks(0, [])).toEqual([]);
    expect(computeChunks(-1, [])).toEqual([]);
  });

  it("packs the entire clip into one chunk when duration ≤ MAX (14s)", () => {
    expect(computeChunks(5, [])).toEqual([{ start: 0, end: 5 }]);
    expect(computeChunks(10, [])).toEqual([{ start: 0, end: 10 }]);
    expect(computeChunks(14, [])).toEqual([{ start: 0, end: 14 }]);
  });

  it("hard-cuts at the constrained windowEnd when no qualifying silence is in the legal window", () => {
    // 28s of solid speech (0.01s word boundaries) — no real pause anywhere.
    // First cut: remaining=28, end-constraint kicks in → window=[14,14], cut at 14.
    // Tail = 14s, in range. Two chunks of exactly 14s.
    const words = Array.from({ length: 28 }, (_, i) => w("x", i, i + 0.99));
    expect(computeChunks(28, words)).toEqual([
      { start: 0, end: 14 },
      { start: 14, end: 28 },
    ]);
  });

  it("cuts at the midpoint of a silence gap inside the legal window", () => {
    // 22s clip with a clean ~1.6s pause: word[9] ends at 9.9, next word starts at 11.5.
    // Window for first cut: max(7, 22-14)=8, min(14, 22-7)=14 → [8,14].
    // Gap midpoint = (9.9 + 11.5) / 2 = 10.7, inside [8,14] → cut there.
    const words: ElevenLabsWord[] = [];
    for (let i = 0; i < 10; i++) words.push(w("x", i, i + 0.9));
    for (let i = 0; i < 11; i++) words.push(w("y", 11.5 + i, 11.5 + i + 0.5));
    const chunks = computeChunks(22, words);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].start).toBe(0);
    expect(chunks[0].end).toBeCloseTo(10.7, 2);
    expect(chunks[1].start).toBeCloseTo(10.7, 2);
    expect(chunks[1].end).toBe(22);
  });

  it("ignores silences shorter than MIN_SILENCE_GAP_S (0.25s)", () => {
    // 22s of word-boundary spacing only (~50ms gaps). No real pause → falls
    // back to hard cut at the constrained windowEnd (=14).
    const words: ElevenLabsWord[] = [];
    for (let i = 0; i < 110; i++) {
      const start = i * 0.2;
      words.push(w("x", start, start + 0.15)); // 50ms gap
    }
    expect(computeChunks(22, words)).toEqual([
      { start: 0, end: 14 },
      { start: 14, end: 22 },
    ]);
  });

  it("picks the longest gap when multiple qualify", () => {
    // 22s clip with two silences both inside window [8, 14]:
    //   0.4s gap at [9.0, 9.4]   midpoint 9.2
    //   1.5s gap at [12.0, 13.5] midpoint 12.75
    // Longest wins.
    const words: ElevenLabsWord[] = [];
    for (let i = 0; i < 9; i++) words.push(w("a", i, i + 0.9));
    // 0.4s silence at [9.0, 9.4]
    for (let i = 0; i < 3; i++) words.push(w("b", 9.4 + i, 9.4 + i + 0.7));
    // 0.4 + 0.7*3 = 9.4 + 2.1 = 11.5, then need to fill until 12.0 with no gap
    // Last "b" ends at 12.1. Adjust: instead start filler at 9.4 ending at 12.0.
    // Simpler: just place words manually.
    words.length = 0;
    words.push(w("a", 0, 1), w("b", 1, 2), w("c", 2, 3), w("d", 3, 4),
               w("e", 4, 5), w("f", 5, 6), w("g", 6, 7), w("h", 7, 8),
               w("i", 8, 9));
    // 0.4s gap [9, 9.4]
    words.push(w("j", 9.4, 10), w("k", 10, 11), w("l", 11, 12));
    // 1.5s gap [12, 13.5]
    words.push(w("m", 13.5, 14.5), w("n", 14.5, 15.5), w("o", 15.5, 16.5),
               w("p", 16.5, 17.5), w("q", 17.5, 18.5), w("r", 18.5, 19.5),
               w("s", 19.5, 20.5), w("t", 20.5, 21.5), w("u", 21.5, 22));
    const chunks = computeChunks(22, words);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].end).toBeCloseTo(12.75, 2); // midpoint of [12, 13.5]
  });

  it("breaks ties on equal-length gaps by preferring the later position", () => {
    // 22s clip with two 0.5s pauses both inside [8, 14]:
    //   [9.0, 9.5]   midpoint 9.25
    //   [12.5, 13.0] midpoint 12.75
    // Tie on length → later wins (longer first chunk = fewer scenes).
    const words: ElevenLabsWord[] = [
      w("a", 0, 1), w("b", 1, 2), w("c", 2, 3), w("d", 3, 4),
      w("e", 4, 5), w("f", 5, 6), w("g", 6, 7), w("h", 7, 8),
      w("i", 8, 9),
      // 0.5s gap [9, 9.5]
      w("j", 9.5, 10.5), w("k", 10.5, 11.5), w("l", 11.5, 12.5),
      // 0.5s gap [12.5, 13]
      w("m", 13, 14), w("n", 14, 15), w("o", 15, 16),
      w("p", 16, 17), w("q", 17, 18), w("r", 18, 19),
      w("s", 19, 20), w("t", 20, 21), w("u", 21, 22),
    ];
    const chunks = computeChunks(22, words);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].end).toBeCloseTo(12.75, 2);
  });

  it("guarantees the trailing chunk is in [MIN, MAX] via end-constrained final cut", () => {
    // 20s of solid speech. First cut: remaining=20, constrain.
    //   windowStart = max(7, 20-14) = 7
    //   windowEnd   = min(14, 20-7) = 13
    // No silence → hard-cut at 13. Tail = 7s ≥ MIN. ✓
    const words = Array.from({ length: 20 }, (_, i) => w("x", i, i + 0.99));
    expect(computeChunks(20, words)).toEqual([
      { start: 0, end: 13 },
      { start: 13, end: 20 },
    ]);
  });

  it("emits 3 chunks for ~30s sources with constrained final cut", () => {
    // 30s of solid speech: cut 1 at 14 (remaining 30 > 28, unconstrained).
    // Cut 2: cursor=14, remaining=16, constrain → window=[max(21,16), min(28,23)]=[21,23].
    // No silence → hard-cut at 23. Tail = 7s.
    const words = Array.from({ length: 30 }, (_, i) => w("x", i, i + 0.99));
    expect(computeChunks(30, words)).toEqual([
      { start: 0, end: 14 },
      { start: 14, end: 23 },
      { start: 23, end: 30 },
    ]);
  });

  it("treats words extending past duration as bounded", () => {
    // Transcription rounding: last word ends at 22.05 even though duration is 22.
    // 0.6s pause at [10, 10.6] — midpoint 10.3 inside window [8, 14].
    const words: ElevenLabsWord[] = [
      w("a", 0, 5), w("b", 5, 10),
      w("c", 10.6, 22.05),
    ];
    const chunks = computeChunks(22, words);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].end).toBeCloseTo(10.3, 2);
  });
});
