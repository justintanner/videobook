import { describe, expect, it } from "vitest";
import type { ArtifactManifestFile } from "videobook-engine";
import {
  keywordPlacementFingerprint,
  parseKeywordPlacementAnalysis,
} from "./keyword-placement-cache.js";
import {
  KEYWORD_FRAME_CACHE_FILENAME,
  KEYWORD_PLACEMENT_VERSION,
} from "./remotion/keyword-placement.js";
import type { KeywordGraphic } from "./remotion/subtitles/types.js";

const VIDEO_FILE: ArtifactManifestFile = {
  name: "original.mp4",
  size_bytes: 100,
  extension: "mp4",
  mtimeMs: 1234,
};

const GRAPHICS: KeywordGraphic[] = [{
  text: "Success",
  start: 1,
  end: 3,
  frameTime: 1.5,
  side: "right",
}];

describe("keyword placement cache", () => {
  it("fingerprints source media, transcript, and cue timing", () => {
    const original = keywordPlacementFingerprint(VIDEO_FILE, Buffer.from("hello"), GRAPHICS);
    const changedTranscript = keywordPlacementFingerprint(VIDEO_FILE, Buffer.from("goodbye"), GRAPHICS);
    const changedCue = keywordPlacementFingerprint(VIDEO_FILE, Buffer.from("hello"), [{
      ...GRAPHICS[0],
      frameTime: 1.6,
    }]);

    expect(original).not.toBe(changedTranscript);
    expect(original).not.toBe(changedCue);
  });

  it("rejects occupied regions outside normalized frame bounds", () => {
    expect(() => parseKeywordPlacementAnalysis({
      version: KEYWORD_PLACEMENT_VERSION,
      fingerprint: "fixture",
      sourceWidth: 1920,
      sourceHeight: 1080,
      frameCacheFilename: KEYWORD_FRAME_CACHE_FILENAME,
      analyzedAt: "2026-07-18T00:00:00.000Z",
      cues: [{
        cueId: "success@1.500",
        text: "Success",
        frameTime: 1.5,
        regions: [{
          kind: "face",
          confidence: 1,
          x: 0.8,
          y: 0.1,
          width: 0.3,
          height: 0.3,
        }],
      }],
    })).toThrow("occupied region extends beyond the source frame");
  });
});
