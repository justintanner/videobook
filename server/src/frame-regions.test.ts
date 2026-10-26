import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Engine } from "videobook-engine";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEngineForTest } from "./engine.js";
import type { FrameRegion } from "./frame-regions.js";
import { frameRegionsAt, missingFrameTimes, storeFrameRegions } from "./frame-regions.js";

const FACE: FrameRegion = { kind: "face", confidence: 0.9, x: 0.6, y: 0.1, width: 0.3, height: 0.3 };
const TITLE: FrameRegion = { kind: "text", confidence: 0.8, x: 0.1, y: 0.8, width: 0.8, height: 0.1 };

describe("shared frame regions", () => {
  let engine: Engine;
  let tempDir: string;
  let artifactId: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videobook-frame-regions-"));
    engine = createEngineForTest(tempDir);
    const created = await engine.artifacts.create("video", "regions");
    if (!created.ok) throw new Error(created.error.message);
    artifactId = created.value.artifactId;
  });

  afterAll(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("reports one time per uncovered quarter-second bucket", () => {
    storeFrameRegions(engine, artifactId, "media-a", [{ time: 0, regions: [FACE] }, { time: 0.5, regions: [] }]);
    expect(missingFrameTimes(engine, "media-a", [0.05, 0.12, 0.5, 0.52, 0.74, 0.76, 1])).toEqual([0.74, 1]);
    expect(missingFrameTimes(engine, "media-b", [0.05])).toEqual([0.05]);
  });

  it("answers covered frames from earlier passes without a key or frame extraction", async () => {
    storeFrameRegions(engine, artifactId, "media-c", [{ time: 1, regions: [FACE] }]);
    storeFrameRegions(engine, artifactId, "media-c", [{ time: 2, regions: [TITLE] }]);
    let extracted = 0;
    const regions = await frameRegionsAt({
      engine,
      artifactId,
      mediaHash: "media-c",
      times: [1.04, 2, 2.1],
      frames: async (times) => {
        extracted += times.length;
        return [];
      },
      apiKey: null,
      signal: new AbortController().signal,
    });
    expect(extracted).toBe(0);
    expect(regions).toEqual([
      { time: 1.04, regions: [FACE] },
      { time: 2, regions: [TITLE] },
      { time: 2.1, regions: [TITLE] },
    ]);
  });

  it("asks for a key before extracting frames it would have to analyse", async () => {
    let extracted = 0;
    await expect(frameRegionsAt({
      engine,
      artifactId,
      mediaHash: "media-c",
      times: [1, 3],
      frames: async (times) => {
        extracted += times.length;
        return [];
      },
      apiKey: null,
      signal: new AbortController().signal,
    })).rejects.toThrow("OPENAI_API_KEY");
    expect(extracted).toBe(0);
  });
});
