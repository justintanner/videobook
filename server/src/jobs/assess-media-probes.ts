import type { ArtifactManifestFile, Engine } from "videobook-engine";
import { join } from "node:path";
import { probeVideo } from "../ffmpeg.js";
import { logger } from "../logger.js";
import { queue, registerJobHandler } from "../queue.js";
import {
  invalidVideoProxyMetadata,
  probeStoredVideoFile,
  videoProxyAssessmentMatches,
  videoProxyMetadata,
  videoProxyValidationError,
  type VideoProxyAssessment,
  type VideoProxySourceProfile,
} from "../video-proxy.js";

type AssessVideoProxyPayload = {
  type: "assess_video_proxy";
  bookId: string;
  proxyAssetId: string;
  sourceFilename: string;
  sourceHash: string;
  proxyHash: string;
  sourceProfile: VideoProxySourceProfile;
};

type BackfillMediaDurationPayload = {
  type: "backfill_media_duration";
  bookId: string;
  durationAssetId: string;
  mediaFilename: string;
  mediaHash: string;
};

const PROXY_FILENAME = "proxy.mp4";

export function scheduleVideoProxyAssessment(input: {
  bookId: string;
  artifactId: string;
  sourceFile: ArtifactManifestFile;
  proxyFile: ArtifactManifestFile;
  sourceProfile: VideoProxySourceProfile;
}): void {
  const jobId = `assess-video-proxy-${input.bookId}-${input.artifactId}-${input.proxyFile.objectHash}`;
  void queue.enqueue(jobId, {
    type: "assess_video_proxy",
    bookId: input.bookId,
    proxyAssetId: input.artifactId,
    sourceFilename: input.sourceFile.name,
    sourceHash: input.sourceFile.objectHash,
    proxyHash: input.proxyFile.objectHash,
    sourceProfile: input.sourceProfile,
  }).catch((error: unknown) => {
    logger.error("proxy-assessment-enqueue-failed", { assetId: input.artifactId, error });
  });
}

export function scheduleMediaDurationBackfill(input: {
  bookId: string;
  artifactId: string;
  mediaFile: ArtifactManifestFile;
}): void {
  const jobId = `backfill-media-duration-${input.bookId}-${input.artifactId}-${input.mediaFile.objectHash}`;
  void queue.enqueue(jobId, {
    type: "backfill_media_duration",
    bookId: input.bookId,
    durationAssetId: input.artifactId,
    mediaFilename: input.mediaFile.name,
    mediaHash: input.mediaFile.objectHash,
  }).catch((error: unknown) => {
    logger.error("duration-backfill-enqueue-failed", { assetId: input.artifactId, error });
  });
}

async function currentFile(
  engine: Engine,
  artifactId: string,
  name: string,
  objectHash: string,
): Promise<ArtifactManifestFile | null> {
  const manifest = await engine.files.manifest(artifactId);
  if (!manifest.ok) return null;
  return manifest.value.files.find((file) =>
    file.name === name && file.objectHash === objectHash) ?? null;
}

export async function assessStoredVideoProxy(
  engine: Engine,
  assetId: string,
  sourceFile: ArtifactManifestFile,
  proxyFile: ArtifactManifestFile,
  sourceProfile: VideoProxySourceProfile,
): Promise<boolean> {
  let assessment: VideoProxyAssessment;
  try {
    const proxy = await probeStoredVideoFile(engine, assetId, proxyFile.name);
    const error = videoProxyValidationError(sourceProfile, proxy);
    assessment = error
      ? invalidVideoProxyMetadata(sourceFile, proxyFile, error)
      : videoProxyMetadata(sourceFile, proxyFile, proxy);
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause);
    assessment = invalidVideoProxyMetadata(sourceFile, proxyFile, error);
  }
  await engine.metadata.artifacts.write(assetId, "proxy", assessment);
  return assessment.valid;
}

async function runVideoProxyAssessment(
  engine: Engine,
  payload: AssessVideoProxyPayload,
): Promise<{ skipped: true } | { valid: boolean }> {
  const { proxyAssetId } = payload;
  const sourceFile = await currentFile(engine, proxyAssetId, payload.sourceFilename, payload.sourceHash);
  const proxyFile = await currentFile(engine, proxyAssetId, PROXY_FILENAME, payload.proxyHash);
  if (!sourceFile || !proxyFile) return { skipped: true };
  const existing = await engine.metadata.artifacts.read<VideoProxyAssessment>(proxyAssetId, "proxy");
  if (existing.ok && videoProxyAssessmentMatches(existing.value, sourceFile, proxyFile)) {
    return { skipped: true };
  }
  return {
    valid: await assessStoredVideoProxy(engine, proxyAssetId, sourceFile, proxyFile, payload.sourceProfile),
  };
}

async function runMediaDurationBackfill(
  engine: Engine,
  payload: BackfillMediaDurationPayload,
  signal: AbortSignal | undefined,
): Promise<{ skipped: true } | { duration: number }> {
  const { durationAssetId } = payload;
  const metadata = await engine.metadata.artifacts.read<Record<string, unknown>>(durationAssetId, "original");
  if (!metadata.ok || typeof metadata.value.duration === "number") return { skipped: true };
  if (!await currentFile(engine, durationAssetId, payload.mediaFilename, payload.mediaHash)) {
    return { skipped: true };
  }
  const dir = await engine.workspaces.resolveArtifact(durationAssetId);
  if (!dir.ok) throw new Error(`backfill_media_duration: ${dir.error.message}`);
  const probe = await probeVideo(join(dir.value, payload.mediaFilename), { signal });
  if (!Number.isFinite(probe.duration) || probe.duration <= 0) return { skipped: true };
  const written = await engine.metadata.artifacts.write(durationAssetId, "original", {
    ...metadata.value,
    duration: probe.duration,
  });
  if (!written.ok) throw new Error(written.error.message);
  return { duration: probe.duration };
}

export function registerAssessMediaProbeJobs(engine: Engine): void {
  registerJobHandler("assess_video_proxy", async (payload) =>
    runVideoProxyAssessment(engine, payload as AssessVideoProxyPayload));
  registerJobHandler("backfill_media_duration", async (payload, { signal }) =>
    runMediaDurationBackfill(engine, payload as BackfillMediaDurationPayload, signal));
}
