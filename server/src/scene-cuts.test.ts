import { describe, expect, it } from "vitest";
import type { SceneData } from "./scene-cuts.js";
import { asSceneData, parseSceneDocument, selectSceneCuts } from "./scene-cuts.js";
import { contrastCuts } from "./scene-detect.js";

const SCENES: SceneData = {
  assetId: "vid",
  durationSeconds: 10,
  fps: 24,
  cuts: [
    { t: 0.1, score: 40 },
    { t: 2, score: 30 },
    { t: 2.2, score: 12 },
    { t: 5, score: 8 },
    { t: 9.8, score: 35 },
  ],
  settles: [{ t: 7, score: 3 }, { t: 5.1, score: 6 }],
  filmstrip: null,
};

describe("selectSceneCuts", () => {
  it("keeps cuts above the default score away from the edges and from each other", () => {
    expect(selectSceneCuts(SCENES)).toEqual([2, 5]);
  });

  it("raises the threshold to keep only the strongest cuts", () => {
    expect(selectSceneCuts(SCENES, { minScore: 10 })).toEqual([2]);
  });

  it("adds settles after cuts without crowding them", () => {
    expect(selectSceneCuts(SCENES, { minScore: 6, includeSettles: true })).toEqual([2, 5, 7]);
  });

  it("honours a custom minimum scene length", () => {
    expect(selectSceneCuts(SCENES, { minScore: 6, minSceneSeconds: 0.1 })).toEqual([0.1, 2, 2.2, 5, 9.8]);
  });
});

describe("scene documents", () => {
  it("parses the persisted sidecar and round-trips the tool payload", () => {
    const parsed = parseSceneDocument({
      asset_id: "vid",
      duration: 10,
      fps: 25,
      cuts: [{ t: 2, score: 30 }, { t: "bad", score: 1 }],
      settle_points: [{ t: 7, score: 3 }],
      filmstrip: { file: ".detect-scenes-filmstrip.jpg", frames: 12, frameWidth: 128, frameHeight: 72, interval: 0.8 },
    }, (file) => `/files/book/vid/${file}`);
    expect(parsed).toEqual({
      assetId: "vid",
      durationSeconds: 10,
      fps: 25,
      cuts: [{ t: 2, score: 30 }],
      settles: [{ t: 7, score: 3 }],
      filmstrip: { url: "/files/book/vid/.detect-scenes-filmstrip.jpg", frames: 12, frameWidth: 128, frameHeight: 72, interval: 0.8 },
    });
    expect(asSceneData(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
    expect(parseSceneDocument({ candidates: [] }, (file) => file)).toBeNull();
  });
});

describe("contrastCuts", () => {
  const frames = (scores: number[]) => scores.map((score, index) => ({ t: index / 30, score }));

  it("finds a dim hard cut that stands out from quiet neighbours", () => {
    const scores = Array.from({ length: 90 }, (_, index) => 0.2 + (index % 3) * 0.1);
    scores[45] = 3.4;
    scores[46] = 2.1;
    expect(contrastCuts(frames(scores))).toEqual([{ t: 1.5, score: 6.8 }]);
  });

  it("ignores spikes inside sustained camera motion", () => {
    const scores = Array.from({ length: 90 }, (_, index) => 3 + (index % 4));
    scores[45] = 7.5;
    expect(contrastCuts(frames(scores))).toEqual([]);
  });
});
