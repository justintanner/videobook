import type { ArtifactManifestFile, Engine } from "videobook-engine";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { probeVideo, type ProbeResult } from "./ffmpeg.js";

export type VideoProxySourceProfile = Pick<
  ProbeResult,
  "videoDuration" | "avgFps" | "hasAudio"
>;

type VideoProxyMetadata = {
  valid: true;
  sourceObjectHash: string;
  proxyObjectHash: string;
  duration: number;
  videoDuration: number;
  width: number;
  height: number;
  hasAudio: boolean;
};

type InvalidVideoProxyMetadata = {
  valid: false;
  sourceObjectHash: string;
  proxyObjectHash: string;
  error: string;
};

export type VideoProxyAssessment = VideoProxyMetadata | InvalidVideoProxyMetadata;

export function videoProxyValidationError(
  source: VideoProxySourceProfile,
  proxy: ProbeResult,
): string | null {
  if (proxy.videoCodec === null || proxy.width <= 0 || proxy.height <= 0) {
    return "proxy has no video stream";
  }
  if (proxy.videoDuration <= 0 || proxy.duration <= 0) {
    return "proxy has no measurable duration";
  }
  const durationTolerance = Math.max(0.25, source.videoDuration * 0.05);
  if (Math.abs(proxy.videoDuration - source.videoDuration) > durationTolerance) {
    return `proxy video duration ${proxy.videoDuration}s does not match source ${source.videoDuration}s`;
  }
  const sourceFrames = source.avgFps === null
    ? null
    : source.avgFps * source.videoDuration;
  const proxyFrames = proxy.avgFps === null
    ? null
    : proxy.avgFps * proxy.videoDuration;
  if (
    sourceFrames !== null
    && proxyFrames !== null
    && sourceFrames >= 4
    && proxyFrames < sourceFrames * 0.8
  ) {
    return `proxy frame count ${Math.round(proxyFrames)} does not match source ${Math.round(sourceFrames)}`;
  }
  if (source.hasAudio && !proxy.hasAudio) {
    return "proxy is missing source audio";
  }
  return null;
}

export function videoProxyMetadata(
  sourceFile: ArtifactManifestFile,
  proxyFile: ArtifactManifestFile,
  proxy: ProbeResult,
): VideoProxyMetadata {
  return {
    valid: true,
    sourceObjectHash: sourceFile.objectHash,
    proxyObjectHash: proxyFile.objectHash,
    duration: proxy.duration,
    videoDuration: proxy.videoDuration,
    width: proxy.width,
    height: proxy.height,
    hasAudio: proxy.hasAudio,
  };
}

export function invalidVideoProxyMetadata(
  sourceFile: ArtifactManifestFile,
  proxyFile: ArtifactManifestFile,
  error: string,
): InvalidVideoProxyMetadata {
  return {
    valid: false,
    sourceObjectHash: sourceFile.objectHash,
    proxyObjectHash: proxyFile.objectHash,
    error,
  };
}

export function videoProxyAssessmentMatches(
  value: unknown,
  sourceFile: ArtifactManifestFile,
  proxyFile: ArtifactManifestFile,
): value is VideoProxyAssessment {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const metadata = value as Record<string, unknown>;
  if (
    metadata.sourceObjectHash !== sourceFile.objectHash
    || metadata.proxyObjectHash !== proxyFile.objectHash
  ) return false;
  if (metadata.valid === false) return typeof metadata.error === "string";
  if (metadata.valid !== true) return false;
  return typeof metadata.duration === "number"
    && Number.isFinite(metadata.duration)
    && metadata.duration > 0
    && typeof metadata.videoDuration === "number"
    && Number.isFinite(metadata.videoDuration)
    && metadata.videoDuration > 0
    && typeof metadata.width === "number"
    && Number.isFinite(metadata.width)
    && metadata.width > 0
    && typeof metadata.height === "number"
    && Number.isFinite(metadata.height)
    && metadata.height > 0
    && typeof metadata.hasAudio === "boolean";
}

export function videoProxyMetadataMatches(
  value: unknown,
  sourceFile: ArtifactManifestFile,
  proxyFile: ArtifactManifestFile,
): value is VideoProxyMetadata {
  return videoProxyAssessmentMatches(value, sourceFile, proxyFile) && value.valid;
}

export async function probeStoredVideoFile(
  engine: Engine,
  assetId: string,
  filename: string,
): Promise<ProbeResult> {
  const manifest = await engine.files.manifest(assetId);
  if (!manifest.ok) {
    throw new Error(`Failed to read media manifest for ${assetId}: ${manifest.error.message}`);
  }
  const snapshot = await engine.files.readAtRevision(
    manifest.value.artifactId,
    filename,
    engine.head,
  );
  if (!snapshot.ok) {
    throw new Error(`Failed to read immutable ${filename} for ${assetId}: ${snapshot.error.message}`);
  }
  const workspace = await mkdtemp(join(tmpdir(), "videobook-probe-"));
  const path = join(workspace, "media.mp4");
  try {
    await writeFile(path, snapshot.value);
    return await probeVideo(path);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
