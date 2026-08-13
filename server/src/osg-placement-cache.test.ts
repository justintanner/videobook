import { describe, expect, it } from "vitest";
import type { ArtifactManifestFile } from "videobook-engine";
import {
  OSG_PLACEMENT_VERSION,
  osgPlacementFingerprint,
  parseOsgPlacementAnalysis,
} from "./osg-placement-cache.js";
import type { OsgPlacementAnalysis } from "./osg-placement-cache.js";

const VIDEO_FILE: ArtifactManifestFile = {
  name: "original.mp4",
  sizeBytes: 100,
  extension: "mp4",
  objectHash: "hash-a",
};

const BOX = { aspect: 480 / 580, minDimFraction: 0.16, userScale: 1 };
const FRAMES = ["0.00.jpg", "2.00.jpg", "4.00.jpg"];

function analysisFixture(): OsgPlacementAnalysis {
  return {
    version: OSG_PLACEMENT_VERSION,
    fingerprint: "fixture",
    sourceWidth: 1920,
    sourceHeight: 1080,
    frameTimes: [0, 2, 4],
    regions: [{ kind: "face", confidence: 0.9, x: 0.1, y: 0.1, width: 0.2, height: 0.3 }],
    positions: { landscape: "bottom-right", portrait: "top-left", square: "bottom-left" },
    analyzedAt: "2026-08-13T00:00:00.000Z",
  };
}

describe("osg placement cache", () => {
  it("fingerprints video content, sampled frames, and the badge box", () => {
    const original = osgPlacementFingerprint(VIDEO_FILE, FRAMES, BOX);
    const changedVideo = osgPlacementFingerprint({ ...VIDEO_FILE, objectHash: "hash-b" }, FRAMES, BOX);
    const changedFrames = osgPlacementFingerprint(VIDEO_FILE, FRAMES.slice(0, 2), BOX);
    const changedScale = osgPlacementFingerprint(VIDEO_FILE, FRAMES, { ...BOX, userScale: 1.5 });

    expect(original).not.toBe(changedVideo);
    expect(original).not.toBe(changedFrames);
    expect(original).not.toBe(changedScale);
    // Sub-rounding scale jitter does not invalidate the cache.
    expect(osgPlacementFingerprint(VIDEO_FILE, FRAMES, { ...BOX, userScale: 1.001 })).toBe(original);
  });

  it("round-trips a valid analysis", () => {
    const analysis = analysisFixture();
    expect(parseOsgPlacementAnalysis(analysis)).toEqual(analysis);
  });

  it("rejects regions outside normalized bounds", () => {
    const analysis = analysisFixture();
    analysis.regions = [{ kind: "text", confidence: 1, x: 0.9, y: 0.1, width: 0.3, height: 0.2 }];
    expect(() => parseOsgPlacementAnalysis(analysis)).toThrow();
  });

  it("rejects missing orientations and unknown positions", () => {
    const missing = analysisFixture() as unknown as Record<string, unknown>;
    missing.positions = { landscape: "bottom-right", portrait: "top-left" };
    expect(() => parseOsgPlacementAnalysis(missing)).toThrow();

    const invalid = analysisFixture() as unknown as { positions: Record<string, string> };
    invalid.positions = { landscape: "bottom-right", portrait: "top-left", square: "somewhere" };
    expect(() => parseOsgPlacementAnalysis(invalid)).toThrow();
  });

  it("rejects a version mismatch", () => {
    const analysis = analysisFixture() as unknown as { version: number };
    analysis.version = OSG_PLACEMENT_VERSION + 1;
    expect(() => parseOsgPlacementAnalysis(analysis)).toThrow();
  });
});
