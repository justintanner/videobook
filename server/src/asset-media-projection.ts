import { createHash } from "node:crypto";
import type {
  Artifact,
  ArtifactManifestFile,
  ArtifactStream,
  ArtifactView,
  Engine,
  Rational,
  Result,
  EngineError,
} from "videobook-engine";
import { findAudioFile, findPrimaryMediaFile, findVideoFile } from "videobook-engine";
import { logger } from "./logger.js";
import { queue } from "./queue.js";
import {
  scheduleMediaDurationBackfill,
  scheduleVideoProxyAssessment,
} from "./jobs/assess-media-probes.js";
import {
  videoProxyAssessmentMatches,
  videoProxyMetadataMatches,
  type VideoProxyAssessment,
  type VideoProxySourceProfile,
} from "./video-proxy.js";

export const PARTIAL_DOWNLOAD_RE = /\.(mp4|mov)\.part$/i;
const DURATION_PROBE_EXT_RE = /\.(mp4|mov|webm|mkv|mp3|wav|m4a|aac|ogg|flac)$/i;
const IMAGE_FILE_RE = /\.(jpg|jpeg|png|webp|gif)$/i;

export type AssetStreamProfile = {
  videoStream: ArtifactStream | undefined;
  audioStream: ArtifactStream | undefined;
  frameRate: Rational | undefined;
  sourceProfile: VideoProxySourceProfile | null;
};

export type AssetMediaUrls = {
  media_url: string | null;
  thumbnail_url: string | null;
};

export function findAssetMediaFile(
  files: ArtifactManifestFile[],
  asset: Pick<Artifact, "kind">,
): ArtifactManifestFile | null {
  return asset.kind === "audio"
    ? findAudioFile(files, asset.kind)
    : asset.kind === "video"
      ? findVideoFile(files.filter((file) => file.name !== "proxy.mp4"))
    : findPrimaryMediaFile(files, asset.kind);
}

// Content fingerprint for cache-busting media URLs. Pure function of the
// manifest tuples; partial downloads are excluded because their size grows on
// every poll while no served URL points at them.
function computeAssetFingerprint(files: ArtifactManifestFile[]): string {
  const settled = files.filter((f) => !PARTIAL_DOWNLOAD_RE.test(f.name));
  if (settled.length === 0) return "";
  const sorted = [...settled].sort((a, b) => a.name.localeCompare(b.name));
  const hash = createHash("sha1");
  for (const f of sorted) {
    hash.update(f.name);
    hash.update("\0");
    hash.update(String(f.sizeBytes ?? 0));
    hash.update("\0");
    hash.update(f.objectHash);
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 12);
}

export function indexByArtifactId<T extends { artifactId: string }>(
  rows: readonly T[],
): Map<string, T> {
  const map = new Map<string, T>();
  for (const row of rows) map.set(row.artifactId, row);
  return map;
}

export function groupByArtifactId<T extends { artifactId: string }>(
  rows: readonly T[],
): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const list = map.get(row.artifactId);
    if (list) list.push(row);
    else map.set(row.artifactId, [row]);
  }
  return map;
}

function streamSeconds(stream: ArtifactStream): number {
  return stream.durationTicks * stream.timeBase.numerator / stream.timeBase.denominator;
}

export function assetStreamProfile(
  streams: readonly ArtifactStream[],
  meta: Record<string, unknown> | null,
): AssetStreamProfile {
  const videoStream = streams.find((stream) => stream.kind === "video" && stream.video);
  const audioStream = streams.find((stream) => stream.kind === "audio" && stream.audio);
  const frameRate = videoStream?.video?.averageFrameRate
    ?? videoStream?.video?.nominalFrameRate;
  const streamDuration = videoStream ? streamSeconds(videoStream) : 0;
  const metadataDuration = Number(meta?.duration);
  const sourceDuration = streamDuration > 0
    ? streamDuration
    : Number.isFinite(metadataDuration) ? metadataDuration : 0;
  const sourceProfile: VideoProxySourceProfile | null = sourceDuration > 0
    ? {
        videoDuration: sourceDuration,
        avgFps: frameRate ? frameRate.numerator / frameRate.denominator : null,
        hasAudio: audioStream !== undefined || meta?.hasAudio === true,
      }
    : null;
  return { videoStream, audioStream, frameRate, sourceProfile };
}

function isActiveWork(work: ArtifactView | null): boolean {
  return work !== null && (work.status === "pending" || work.status === "working");
}

export function servedVideoProxyFile(input: {
  bookId: string;
  artifact: Pick<Artifact, "artifactId" | "kind">;
  files: ArtifactManifestFile[];
  mediaFile: ArtifactManifestFile | null;
  proxyMetadata: Result<VideoProxyAssessment, EngineError>;
  work: ArtifactView | null;
  sourceProfile: VideoProxySourceProfile | null;
}): ArtifactManifestFile | null {
  if (input.artifact.kind !== "video" || !input.mediaFile) return null;
  const proxyFile = input.files.find((file) => file.name === "proxy.mp4");
  if (!proxyFile) return null;
  const metadata = input.proxyMetadata;
  if (metadata.ok && videoProxyMetadataMatches(metadata.value, input.mediaFile, proxyFile)) {
    return proxyFile;
  }
  const assessed = metadata.ok
    && videoProxyAssessmentMatches(metadata.value, input.mediaFile, proxyFile);
  if (!assessed && !isActiveWork(input.work) && input.sourceProfile) {
    scheduleVideoProxyAssessment({
      bookId: input.bookId,
      artifactId: input.artifact.artifactId,
      sourceFile: input.mediaFile,
      proxyFile,
      sourceProfile: input.sourceProfile,
    });
  }
  return null;
}

export function assetDuration(input: {
  bookId: string;
  artifactId: string;
  meta: Record<string, unknown> | null;
  mediaFile: ArtifactManifestFile | null;
  profile: AssetStreamProfile;
}): number | null {
  const stored = input.meta?.duration;
  if (typeof stored === "number") return stored;
  const stream = input.profile.videoStream ?? input.profile.audioStream;
  const measured = stream ? streamSeconds(stream) : 0;
  if (measured > 0) return measured;
  if (input.meta && input.mediaFile && DURATION_PROBE_EXT_RE.test(input.mediaFile.name)) {
    scheduleMediaDurationBackfill({
      bookId: input.bookId,
      artifactId: input.artifactId,
      mediaFile: input.mediaFile,
    });
  }
  return null;
}

function mediaCacheBust(
  kind: string,
  files: ArtifactManifestFile[],
  mediaFile: ArtifactManifestFile | null,
): string {
  if (kind === "video" || kind === "image") {
    const fingerprint = computeAssetFingerprint(files);
    return fingerprint ? `?v=${fingerprint}` : "";
  }
  const mediaHash = mediaFile?.objectHash;
  return mediaHash ? `?v=${mediaHash.slice(0, 12)}` : "";
}

export function assetMediaUrls(input: {
  bookId: string;
  artifact: Pick<Artifact, "artifactId" | "kind">;
  files: ArtifactManifestFile[];
  mediaFile: ArtifactManifestFile | null;
  proxyFile: ArtifactManifestFile | null;
}): AssetMediaUrls {
  const { artifact, files } = input;
  const base = `/files/${input.bookId}/${artifact.artifactId}`;
  const cacheBust = mediaCacheBust(artifact.kind, files, input.mediaFile);
  const characterImage = artifact.kind === "character"
    ? files.find((file) => IMAGE_FILE_RE.test(file.name)) ?? null
    : null;
  const served = characterImage ?? input.proxyFile ?? input.mediaFile;
  const media_url = served ? `${base}/${served.name}${cacheBust}` : null;
  if (characterImage) return { media_url, thumbnail_url: media_url };
  const hasThumbnail = files.some((file) => file.name === "original.jpg");
  const thumbnail_url = hasThumbnail
    ? `${base}/original.jpg${cacheBust}`
    : artifact.kind === "image" ? media_url : null;
  return { media_url, thumbnail_url };
}

export async function scheduleMissingVideoPoster(
  engine: Engine,
  input: {
    bookId: string;
    artifact: Pick<Artifact, "artifactId" | "kind">;
    files: ArtifactManifestFile[];
    mediaFile: ArtifactManifestFile | null;
    status: string;
  },
): Promise<void> {
  const { artifact, mediaFile } = input;
  if (artifact.kind !== "video" || input.status !== "ready" || !mediaFile) return;
  if (input.files.some((file) => file.name === "original.jpg")) return;
  const recovery = await engine.metadata.artifacts.read<{ sourceHash: string; failed: boolean }>(
    artifact.artifactId, "poster-recovery",
  );
  if (recovery.ok && recovery.value.failed && recovery.value.sourceHash === mediaFile.objectHash) return;
  void queue.enqueue(`extract-video-poster-${input.bookId}-${artifact.artifactId}-${mediaFile.objectHash}`, {
    type: "extract_video_poster",
    bookId: input.bookId,
    posterArtifactId: artifact.artifactId,
    sourceFilename: mediaFile.name,
    sourceHash: mediaFile.objectHash,
  }).catch((error: unknown) => {
    logger.error("poster-enqueue-failed", { assetId: artifact.artifactId, error });
  });
}
