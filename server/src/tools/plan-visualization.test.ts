import { describe, it, expect } from "vitest";
import { computeChunks, sampleFramesForScenes, dialogForChunk, speechTimelineForChunk, buildSkeletonPlanSidecar, buildSkeletonPlanMarkdown } from "./plan-visualization.js";
import { parseScdetOutput, deriveCandidates } from "../scene-detect.js";

type Candidate = { t: number; score: number; kind: "shot" | "settle" };

const shot = (t: number, score = 25): Candidate => ({ t, score, kind: "shot" });
const settle = (t: number, score = 5): Candidate => ({ t, score, kind: "settle" });

const word = (text: string, start: number, end: number) =>
  ({ text, start, end, type: "word" as const });
const spacing = (start: number, end: number) =>
  ({ text: " ", start, end, type: "spacing" as const });

describe("dialogForChunk", () => {
  it("joins words whose start falls within the chunk's [start, end) window", () => {
    const words = [
      word("hello", 0.0, 0.4),
      word("there", 0.5, 0.9),
      word("friend", 1.2, 1.6),
      word("outside", 2.4, 2.9),
    ];
    expect(dialogForChunk(words, { start: 0, end: 2 })).toBe("hello there friend");
  });

  it("treats the window as half-open — a word starting exactly at chunk.end is excluded", () => {
    const words = [word("inside", 1.0, 1.4), word("boundary", 2.0, 2.4)];
    expect(dialogForChunk(words, { start: 0, end: 2 })).toBe("inside");
  });

  it("ignores spacing tokens", () => {
    const words = [word("tight", 0.1, 0.3), spacing(0.3, 0.35), word("packed", 0.35, 0.6)];
    expect(dialogForChunk(words, { start: 0, end: 1 })).toBe("tight packed");
  });

  it("falls back to a placeholder when no words land in the chunk", () => {
    expect(dialogForChunk([word("later", 9.0, 9.4)], { start: 0, end: 2 })).toBe("(no speech in this chunk)");
    expect(dialogForChunk([], { start: 0, end: 2 })).toBe("(no speech in this chunk)");
  });
});

describe("speechTimelineForChunk", () => {
  const spk = (text: string, start: number, end: number, speaker_id: string) =>
    ({ text, start, end, type: "word" as const, speaker_id });

  it("flags the opening frame SILENT when speech starts >= 0.4s after the chunk opens", () => {
    // First word lands 1.5s in — the frame the swap edits at t=0 is a listening beat.
    const out = speechTimelineForChunk([word("finally", 1.5, 1.9), word("talking", 2.0, 2.4)], { start: 0, end: 8 });
    expect(out).toContain("opening frame @0.00s: SILENT");
    expect(out).toContain("1.50s of lead-in");
  });

  it("flags the opening frame as already speaking when the first word starts < 0.4s in", () => {
    const out = speechTimelineForChunk([word("immediately", 0.1, 0.6)], { start: 0, end: 8 });
    expect(out).toContain("opening frame @0.00s: speech already active");
    expect(out).not.toContain("opening frame @0.00s: SILENT");
  });

  it("flags the closing frame SILENT when the last word ends >= 0.4s before the close", () => {
    const out = speechTimelineForChunk([word("done", 1.0, 1.4)], { start: 0, end: 8 });
    expect(out).toContain("closing frame @8.00s: SILENT");
  });

  it("reports the chunk silent throughout when no words land in the window", () => {
    expect(speechTimelineForChunk([], { start: 0, end: 8 })).toContain("silent throughout");
    expect(speechTimelineForChunk([word("elsewhere", 20, 20.4)], { start: 0, end: 8 })).toContain("silent throughout");
  });

  it("counts distinct diarized speakers — two speakers cue shot/reverse-shot", () => {
    const out = speechTimelineForChunk(
      [spk("you", 0.1, 0.4, "spk_0"), spk("said", 0.5, 0.9, "spk_0"), spk("no", 3.0, 3.4, "spk_1")],
      { start: 0, end: 8 },
    );
    expect(out).toContain("Distinct speakers heard: 2 (spk_0, spk_1)");
    expect(out).toContain("cuts between single shots");
    // Speaker change after a >0.5s gap breaks into separate turns.
    expect(out).toContain("spk=spk_0");
    expect(out).toContain("spk=spk_1");
    expect(out).toContain("[silence");
  });

  it("degrades gracefully when diarization is off (no speaker_id)", () => {
    const out = speechTimelineForChunk([word("hi", 0.1, 0.4)], { start: 0, end: 8 });
    expect(out).toContain("Speaker labels unavailable");
    expect(out).toContain("spk=?");
  });
});

describe("buildSkeletonPlanSidecar", () => {
  const characters = [
    { asset_id: "char-a", name: "Alice", description: "desc a" },
    { asset_id: "char-b", name: "Bob", description: "desc b" },
  ];

  it("builds a char_swap sidecar with no scenes but source, cast, and analysis prompt populated", () => {
    const sidecar = buildSkeletonPlanSidecar("vid-source", characters);
    expect(sidecar.formula).toBe("char_swap");
    expect(sidecar.scenes).toEqual([]);
    expect(sidecar.source_asset_id).toBe("vid-source");
    expect(sidecar.characters).toEqual(characters);
    expect(sidecar.analysis_prompt.length).toBeGreaterThan(0);
  });

  it("round-trips through JSON so read_plan returns the same shape the client expects", () => {
    const parsed = JSON.parse(JSON.stringify(buildSkeletonPlanSidecar("vid-source", characters)));
    expect(parsed.formula).toBe("char_swap");
    expect(parsed.scenes).toEqual([]);
    expect(parsed.characters).toHaveLength(2);
    expect(typeof parsed.analysis_prompt).toBe("string");
  });
});

describe("buildSkeletonPlanMarkdown", () => {
  const characters = [
    { asset_id: "char-a", name: "Alice", description: "desc a" },
    { asset_id: "char-b", name: "Bob", description: "desc b" },
  ];

  // The plan asset reads as orphan-"error" (red @plan card) until index.md
  // exists, so the tool must write a non-empty placeholder up front.
  it("produces non-empty markdown naming the source and every character", () => {
    const md = buildSkeletonPlanMarkdown("vid-source", characters);
    expect(md.length).toBeGreaterThan(0);
    expect(md).toContain("vid-source");
    expect(md).toContain("@char-a (Alice)");
    expect(md).toContain("@char-b (Bob)");
  });
});

describe("computeChunks", () => {
  it("returns no chunks for non-positive duration", () => {
    expect(computeChunks(0, [])).toEqual([]);
    expect(computeChunks(-1, [])).toEqual([]);
  });

  it("packs the entire clip into one chunk when duration ≤ MAX (14s)", () => {
    expect(computeChunks(5, [])).toEqual([{ start: 0, end: 5 }]);
    expect(computeChunks(14, [])).toEqual([{ start: 0, end: 14 }]);
  });

  it("hard-cuts at the constrained windowEnd when no candidate is in the legal window", () => {
    // 28s, no candidates → first cut hits the end-constrained window [14,14].
    expect(computeChunks(28, [])).toEqual([
      { start: 0, end: 14 },
      { start: 14, end: 28 },
    ]);
  });

  it("cuts at a single shot candidate inside the window, snapped to integer", () => {
    // 22s clip with one shot at 10.7s → snaps to 11.
    expect(computeChunks(22, [shot(10.7)])).toEqual([
      { start: 0, end: 11 },
      { start: 11, end: 22 },
    ]);
  });

  it("prefers shot candidates over settle candidates regardless of score", () => {
    // Window [7, 14]. settle@10 has higher numeric score than shot@12, but
    // shot still wins.
    const candidates: Candidate[] = [
      { t: 10, score: 100, kind: "settle" },
      { t: 12, score: 15, kind: "shot" },
    ];
    expect(computeChunks(22, candidates)).toEqual([
      { start: 0, end: 12 },
      { start: 12, end: 22 },
    ]);
  });

  it("with multiple shot candidates, picks the highest score; ties go to later position", () => {
    // 22s clip, window [7, 14]:
    //   shot@8.0  score=12
    //   shot@13.2 score=20  ← winner, snaps to 13
    expect(computeChunks(22, [shot(8.0, 12), shot(13.2, 20)])).toEqual([
      { start: 0, end: 13 },
      { start: 13, end: 22 },
    ]);
    // Tie: same score → later wins.
    expect(computeChunks(22, [shot(8.2, 15), shot(13.4, 15)])).toEqual([
      { start: 0, end: 13 },
      { start: 13, end: 22 },
    ]);
  });

  it("ignores candidates outside the legal window", () => {
    // Shot at 5s is before windowStart=7; shot at 16s is after windowEnd=14.
    // Falls back to hard-cut at windowEnd, then trailing chunk.
    const candidates = [shot(5, 50), shot(16, 50)];
    expect(computeChunks(22, candidates)).toEqual([
      { start: 0, end: 14 },
      { start: 14, end: 22 },
    ]);
  });

  it("settle wins when no shot is present in the window", () => {
    // 22s, window [7, 14]. Only a settle candidate at 9.8 → snaps to 10.
    expect(computeChunks(22, [settle(9.8)])).toEqual([
      { start: 0, end: 10 },
      { start: 10, end: 22 },
    ]);
  });

  it("guarantees the trailing chunk is in [MIN, MAX] via end-constrained final cut", () => {
    // 20s, no candidates: first cut window = [max(7,6), min(14,13)] = [7,13].
    // Hard-cut at 13. Tail = 7s.
    expect(computeChunks(20, [])).toEqual([
      { start: 0, end: 13 },
      { start: 13, end: 20 },
    ]);
  });

  it("emits 3 chunks for ~30s sources with end-constrained final cut", () => {
    // 30s, no candidates: cut1=14, cut2 window=[max(21,16), min(28,23)]=[21,23].
    // Hard-cut at 23. Tail = 7s.
    expect(computeChunks(30, [])).toEqual([
      { start: 0, end: 14 },
      { start: 14, end: 23 },
      { start: 23, end: 30 },
    ]);
  });
});

describe("parseScdetOutput", () => {
  it("parses ffmpeg scdet stderr lines into (t, score) pairs", () => {
    const stderr = [
      "[scdet @ 0x600000bb4680] lavfi.scd.score: 0.000, lavfi.scd.time: 0",
      "[scdet @ 0x600000bb4680] lavfi.scd.score: 4.798, lavfi.scd.time: 0.25",
      "frame=    1 fps=0.0 q=-0.0 size=       0kB",
      "[scdet @ 0x600000bb4680] lavfi.scd.score: 16.054, lavfi.scd.time: 5.25",
    ].join("\n");
    expect(parseScdetOutput(stderr)).toEqual([
      { t: 0, score: 0 },
      { t: 0.25, score: 4.798 },
      { t: 5.25, score: 16.054 },
    ]);
  });

  it("returns [] when no scdet lines present", () => {
    expect(parseScdetOutput("ffmpeg version 6.0\nbuilt with...\n")).toEqual([]);
  });
});

describe("deriveCandidates", () => {
  it("emits a shot candidate per frame whose score crosses the threshold", () => {
    const samples = [
      { t: 0, score: 0 },
      { t: 0.25, score: 1 },
      { t: 0.5, score: 12 },   // shot
      { t: 0.75, score: 0.5 },
      { t: 1, score: 25 },     // shot
    ];
    const candidates = deriveCandidates(samples).filter((c) => c.kind === "shot");
    expect(candidates.map((c) => c.t)).toEqual([0.5, 1]);
    expect(candidates.map((c) => c.score)).toEqual([12, 25]);
  });

  it("emits a settle candidate when motion drops sustained-low after sustained-high", () => {
    // 4s of high motion, then 2s of low motion (no shot cuts). Settle should
    // land at the start of the low-motion run.
    const samples: Array<{ t: number; score: number }> = [];
    for (let i = 0; i < 16; i++) samples.push({ t: i * 0.25, score: 5 });   // 0..3.75 high
    for (let i = 0; i < 8; i++) samples.push({ t: 4 + i * 0.25, score: 0.2 }); // 4..5.75 low
    const settles = deriveCandidates(samples).filter((c) => c.kind === "settle");
    expect(settles.length).toBeGreaterThan(0);
    expect(settles[0].t).toBeCloseTo(4, 1);
  });

  it("emits no settle candidates when the segment never sustains low motion", () => {
    const samples = Array.from({ length: 20 }, (_, i) => ({ t: i * 0.25, score: 5 + (i % 2) }));
    expect(deriveCandidates(samples).filter((c) => c.kind === "settle")).toEqual([]);
  });
});

describe("sampleFramesForScenes", () => {
  it("samples ceil(duration/2) frames per scene, clamped to [3, 8]", () => {
    const frameNames = Array.from({ length: 50 }, (_, i) => `${(i * 0.5).toFixed(2)}.jpg`);
    const scenes = [
      { start: 0, end: 7 },   // duration 7 → ceil(7/2)=4
      { start: 7, end: 21 },  // duration 14 → ceil(14/2)=7
    ];
    const sampled = sampleFramesForScenes(frameNames, scenes);
    const perScene = [0, 1].map((idx) => sampled.filter((s) => s.sceneIdx === idx));
    expect(perScene[0].length).toBe(4);
    expect(perScene[1].length).toBe(7);
    expect(perScene[0].every((s) => s.t >= 0 && s.t < 7)).toBe(true);
    expect(perScene[1].every((s) => s.t >= 7 && s.t < 21)).toBe(true);
  });

  it("returns all in-range frames when fewer than the target are available", () => {
    const frameNames = ["0.00.jpg", "5.00.jpg"];
    const scenes = [{ start: 0, end: 14 }];
    const sampled = sampleFramesForScenes(frameNames, scenes);
    expect(sampled.map((s) => s.name)).toEqual(["0.00.jpg", "5.00.jpg"]);
  });
});
