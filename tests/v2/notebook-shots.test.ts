import { describe, expect, it } from "vitest";
import {
  normalizeShots,
  overlapSeconds,
  parseAnalysisShots,
  reconcileOwnedBranches,
} from "../../server/src/notebook-shots.js";

describe("notebook shot normalization and reconcile", () => {
  it("covers the source exactly with generation-safe 4-15s ranges", () => {
    const shots = normalizeShots(
      [
        { startSeconds: 0, endSeconds: 3, label: "cold open" },
        { startSeconds: 3, endSeconds: 40, label: "long monologue" },
        { startSeconds: 40, endSeconds: 42, label: "tail" },
      ],
      45,
    );
    expect(shots[0]?.startSeconds).toBe(0);
    expect(shots.at(-1)?.endSeconds).toBe(45);
    for (let index = 1; index < shots.length; index += 1) {
      expect(shots[index]?.startSeconds).toBe(shots[index - 1]?.endSeconds);
    }
    for (const shot of shots) {
      expect(shot.durationSeconds).toBeGreaterThanOrEqual(4);
      expect(shot.durationSeconds).toBeLessThanOrEqual(15);
    }
    const covered = shots.reduce((sum, shot) => sum + shot.durationSeconds, 0);
    expect(Math.round(covered * 1000) / 1000).toBe(45);
  });

  it("is idempotent for identical analysis output", () => {
    const raw = {
      scenes: [
        { title: "A", timestamp: [0, 10] },
        { title: "B", timestamp: [10, 20] },
      ],
    };
    const first = normalizeShots(parseAnalysisShots(raw), 20);
    const second = normalizeShots(parseAnalysisShots(raw), 20);
    expect(second).toEqual(first);
  });

  it("preserves matching owned branches by greatest overlap", () => {
    const existing = [
      {
        cellId: "keep-me",
        range: { startSeconds: 0, endSeconds: 10 },
        config: { model: "seedance", prompt: "keep" },
      },
      {
        cellId: "drop-me",
        range: { startSeconds: 40, endSeconds: 50 },
        config: { model: "old" },
      },
    ];
    const shots = [
      {
        ordinal: 1,
        startSeconds: 0,
        endSeconds: 12,
        durationSeconds: 12,
        label: "grown",
      },
      {
        ordinal: 2,
        startSeconds: 12,
        endSeconds: 24,
        durationSeconds: 12,
        label: "new",
      },
    ];
    const result = reconcileOwnedBranches(existing, shots);
    expect(result.keep.map((entry) => entry.existing.cellId)).toEqual(["keep-me"]);
    expect(result.remove.map((entry) => entry.cellId)).toEqual(["drop-me"]);
    expect(result.create.map((shot) => shot.label)).toEqual(["new"]);
    expect(overlapSeconds(existing[0]!.range, shots[0]!)).toBeGreaterThan(0);
  });
});
