import { describe, expect, it } from "vitest";
import type { ArtifactManifestFile } from "videobook-engine";
import type { ProbeResult } from "./ffmpeg.js";
import {
  invalidVideoProxyMetadata,
  videoProxyAssessmentMatches,
  videoProxyMetadata,
  videoProxyMetadataMatches,
  videoProxyValidationError,
  type VideoProxySourceProfile,
} from "./video-proxy.js";

const SOURCE_FILE: ArtifactManifestFile = {
  name: "original.mp4",
  sizeBytes: 1_000,
  extension: "mp4",
  objectHash: "source-hash",
};

const PROXY_FILE: ArtifactManifestFile = {
  name: ".proxy.mp4",
  sizeBytes: 500,
  extension: "mp4",
  objectHash: "proxy-hash",
};

const SOURCE: VideoProxySourceProfile = {
  videoDuration: 10,
  avgFps: 30,
  hasAudio: true,
};

function probe(overrides: Partial<ProbeResult> = {}): ProbeResult {
  return {
    width: 1280,
    height: 720,
    duration: 10,
    videoDuration: 10,
    audioDuration: 10,
    fps: 30,
    avgFps: 30,
    hasAudio: true,
    videoCodec: "h264",
    audioCodec: "aac",
    videoStream: null,
    audioStream: null,
    ...overrides,
  };
}

describe("videoProxyValidationError", () => {
  it("rejects missing video and measurable duration", () => {
    expect(videoProxyValidationError(SOURCE, probe({ videoCodec: null }))).toBe("proxy has no video stream");
    expect(videoProxyValidationError(SOURCE, probe({ width: 0 }))).toBe("proxy has no video stream");
    expect(videoProxyValidationError(SOURCE, probe({ duration: 0 }))).toBe("proxy has no measurable duration");
  });

  it("accepts the duration tolerance boundary and rejects values beyond it", () => {
    expect(videoProxyValidationError(SOURCE, probe({ videoDuration: 10.5 }))).toBeNull();
    expect(videoProxyValidationError(SOURCE, probe({ videoDuration: 10.500_001 }))).toContain("does not match source");
  });

  it("accepts exactly eighty percent of source frames and rejects greater loss", () => {
    expect(videoProxyValidationError(SOURCE, probe({ avgFps: 24 }))).toBeNull();
    expect(videoProxyValidationError(SOURCE, probe({ avgFps: 23.9 }))).toContain("proxy frame count");
  });

  it("requires source audio to remain present", () => {
    expect(videoProxyValidationError(SOURCE, probe({ hasAudio: false }))).toBe("proxy is missing source audio");
  });
});

describe("video proxy metadata", () => {
  it("matches valid metadata only for the current source and proxy hashes", () => {
    const metadata = videoProxyMetadata(SOURCE_FILE, PROXY_FILE, probe());
    expect(videoProxyMetadataMatches(metadata, SOURCE_FILE, PROXY_FILE)).toBe(true);
    expect(videoProxyMetadataMatches(metadata, { ...SOURCE_FILE, objectHash: "changed" }, PROXY_FILE)).toBe(false);
    expect(videoProxyMetadataMatches(metadata, SOURCE_FILE, { ...PROXY_FILE, objectHash: "changed" })).toBe(false);
  });

  it("rejects malformed and non-finite valid metadata", () => {
    const metadata = videoProxyMetadata(SOURCE_FILE, PROXY_FILE, probe());
    expect(videoProxyAssessmentMatches({ ...metadata, width: Number.POSITIVE_INFINITY }, SOURCE_FILE, PROXY_FILE)).toBe(false);
    expect(videoProxyMetadataMatches({ ...metadata, height: Number.NaN }, SOURCE_FILE, PROXY_FILE)).toBe(false);
  });

  it("requires an error message for invalid assessments", () => {
    const metadata = invalidVideoProxyMetadata(SOURCE_FILE, PROXY_FILE, "probe failed");
    expect(videoProxyAssessmentMatches(metadata, SOURCE_FILE, PROXY_FILE)).toBe(true);
    expect(videoProxyMetadataMatches(metadata, SOURCE_FILE, PROXY_FILE)).toBe(false);
    expect(videoProxyAssessmentMatches({
      valid: false,
      sourceObjectHash: SOURCE_FILE.objectHash,
      proxyObjectHash: PROXY_FILE.objectHash,
    }, SOURCE_FILE, PROXY_FILE)).toBe(false);
  });
});
