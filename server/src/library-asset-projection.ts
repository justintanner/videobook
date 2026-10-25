import type {
  Artifact,
  ArtifactKind,
  ArtifactManifestFile,
  ArtifactStream,
  ArtifactView,
  Engine,
  GenerationError,
  PendingTask,
  Rational,
} from "videobook-engine";
import { computeArtifactStatus } from "videobook-engine";
import {
  EMPTY_TAG_SUMMARY,
  matchesTagFilter,
  readAssetTagSummaries,
  type AssetTagFilter,
  type AssetTagSummary,
} from "./asset-tags.js";
import {
  assetDuration,
  assetMediaUrls,
  assetStreamProfile,
  findAssetMediaFile,
  groupByArtifactId,
  indexByArtifactId,
  PARTIAL_DOWNLOAD_RE,
  scheduleMissingVideoPoster,
  servedVideoProxyFile,
} from "./asset-media-projection.js";
import type { VideoProxyAssessment } from "./video-proxy.js";

export type LibraryCandidate = {
  id: string;
  artifact_id: string;
  label?: string;
  type: string;
  created_at: string;
  status: string;
  prompt: string | null;
  object_hash: string | null;
  tags: AssetTagSummary;
  source: LibraryCandidateSource;
};

type LibraryCandidateSource = {
  artifact: Artifact;
  files: ArtifactManifestFile[];
  meta: Record<string, unknown> | null;
  mediaFile: ArtifactManifestFile | null;
  work: ArtifactView | null;
  streams: ArtifactStream[];
};

type LibraryAssetWork = {
  status: ArtifactView["status"];
  meta: ArtifactView["meta"];
  ownerKind: ArtifactView["ownerKind"];
  deadlineAt: number | null;
};

export type LibraryAssetRow = {
  id: string;
  artifact_id: string;
  label?: string;
  type: string;
  created_at: string;
  media_url: string | null;
  thumbnail_url: string | null;
  object_hash: string | null;
  status: string;
  assetWork: LibraryAssetWork | null;
  width: number | null;
  height: number | null;
  origin: string | null;
  prompt: string | null;
  duration: number | null;
  fps: number | null;
  tags: AssetTagSummary;
};

type BookJobIndexes = {
  pending: Map<string, PendingTask>;
  failures: Map<string, GenerationError>;
  work: Map<string, ArtifactView>;
  streams: Map<string, ArtifactStream[]>;
};

function metadataNumber(meta: Record<string, unknown> | null, key: string): number | null {
  const value = meta?.[key];
  return typeof value === "number" ? value : null;
}

function metadataString(meta: Record<string, unknown> | null, key: string): string | null {
  const value = meta?.[key];
  return typeof value === "string" ? value : null;
}

function readJobIndexes(engine: Engine): BookJobIndexes {
  const pending = engine.jobs.pending.findAll();
  const failures = engine.jobs.failures.findAll();
  const work = engine.jobs.artifactWork.list();
  const streams = engine.streams.list();
  return {
    pending: indexByArtifactId(pending.ok ? pending.value : []),
    failures: indexByArtifactId(failures.ok ? failures.value : []),
    work: indexByArtifactId(work.ok ? work.value : []),
    streams: groupByArtifactId(streams.ok ? streams.value : []),
  };
}

async function readCandidate(
  engine: Engine,
  artifact: Artifact,
  jobs: BookJobIndexes,
  tags: AssetTagSummary,
): Promise<LibraryCandidate> {
  const [manifest, metadata] = await Promise.all([
    engine.files.manifest(artifact.artifactId, { includeDotfiles: true }),
    engine.metadata.artifacts.read<Record<string, unknown>>(artifact.artifactId, "original"),
  ]);
  const files = manifest.ok ? manifest.value.files : [];
  const meta = metadata.ok ? metadata.value : null;
  const mediaFile = findAssetMediaFile(files, artifact);
  const work = jobs.work.get(artifact.artifactId) ?? null;
  const status = computeArtifactStatus({
    kind: artifact.kind,
    fileNames: new Set(files.map((file) => file.name)),
    primaryMediaName: mediaFile?.name ?? null,
    hasOriginalMetadata: metadata.ok,
    hasPartFile: files.some((file) => PARTIAL_DOWNLOAD_RE.test(file.name)),
    lockData: engine.jobs.locks.get(artifact.path),
    pendingTask: jobs.pending.get(artifact.artifactId) ?? null,
    generationError: jobs.failures.get(artifact.artifactId) ?? null,
    artifactRow: work
      ? { status: work.status, meta: work.meta, deadlineAt: work.deadlineAt }
      : null,
  });
  return {
    id: artifact.artifactId,
    artifact_id: artifact.artifactId,
    ...(artifact.label ? { label: artifact.label } : {}),
    type: artifact.kind,
    created_at: new Date(artifact.createdAt).toISOString(),
    status,
    prompt: metadataString(meta, "prompt"),
    object_hash: mediaFile?.objectHash ?? null,
    tags,
    source: {
      artifact,
      files,
      meta,
      mediaFile,
      work,
      streams: jobs.streams.get(artifact.artifactId) ?? [],
    },
  };
}

export async function readLibraryCandidates(
  engine: Engine,
  input: { kinds: ReadonlySet<ArtifactKind>; tags?: AssetTagFilter },
): Promise<LibraryCandidate[]> {
  const artifacts = engine.artifacts.list({ sort: "newest" })
    .filter((artifact) => input.kinds.has(artifact.kind));
  const tagsByArtifact = readAssetTagSummaries(
    engine,
    artifacts.map((artifact) => artifact.artifactId),
  );
  const tagged = artifacts.filter((artifact) =>
    matchesTagFilter(tagsByArtifact.get(artifact.artifactId), input.tags));
  if (tagged.length === 0) return [];
  const jobs = readJobIndexes(engine);
  return Promise.all(tagged.map((artifact) => readCandidate(
    engine,
    artifact,
    jobs,
    tagsByArtifact.get(artifact.artifactId) ?? EMPTY_TAG_SUMMARY,
  )));
}

function libraryAssetWork(work: ArtifactView | null): LibraryAssetWork | null {
  return work
    ? {
        status: work.status,
        meta: work.meta,
        ownerKind: work.ownerKind,
        deadlineAt: work.deadlineAt,
      }
    : null;
}

function framesPerSecond(
  meta: Record<string, unknown> | null,
  frameRate: Rational | undefined,
): number | null {
  const metadataFps = Number(meta?.fps);
  if (Number.isFinite(metadataFps) && metadataFps > 0) return metadataFps;
  if (!frameRate || frameRate.denominator <= 0) return null;
  const streamFps = frameRate.numerator / frameRate.denominator;
  return Number.isFinite(streamFps) && streamFps > 0 ? streamFps : null;
}

export async function projectLibraryAsset(
  engine: Engine,
  bookId: string,
  candidate: LibraryCandidate,
): Promise<LibraryAssetRow> {
  const { artifact, files, meta, mediaFile, work, streams } = candidate.source;
  const profile = assetStreamProfile(streams, meta);
  const proxyMetadata = artifact.kind === "video" && files.some((file) => file.name === "proxy.mp4")
    ? await engine.metadata.artifacts.read<VideoProxyAssessment>(artifact.artifactId, "proxy")
    : { ok: false as const, error: { code: "NOT_FOUND" as const, message: "no proxy" } };
  const proxyFile = servedVideoProxyFile({
    bookId,
    artifact,
    files,
    mediaFile,
    proxyMetadata,
    work,
    sourceProfile: profile.sourceProfile,
  });
  await scheduleMissingVideoPoster(engine, {
    bookId,
    artifact,
    files,
    mediaFile,
    status: candidate.status,
  });
  return {
    id: candidate.id,
    artifact_id: candidate.artifact_id,
    ...(candidate.label ? { label: candidate.label } : {}),
    type: candidate.type,
    created_at: candidate.created_at,
    ...assetMediaUrls({ bookId, artifact, files, mediaFile, proxyFile }),
    object_hash: candidate.object_hash,
    status: candidate.status,
    assetWork: libraryAssetWork(work),
    width: metadataNumber(meta, "width"),
    height: metadataNumber(meta, "height"),
    origin: metadataString(meta, "origin"),
    prompt: candidate.prompt,
    duration: assetDuration({
      bookId,
      artifactId: artifact.artifactId,
      meta,
      mediaFile,
      profile,
    }),
    fps: framesPerSecond(meta, profile.frameRate),
    tags: candidate.tags,
  };
}
