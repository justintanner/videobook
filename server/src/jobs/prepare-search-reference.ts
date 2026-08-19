import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  findPrimaryMediaFile,
  findVideoFile,
  LOCAL_CLIP_MANIFEST,
  type Engine,
  type PreparedSearchReference,
} from "videobook-engine";
import { probeVideo, runFfmpeg } from "../ffmpeg.js";
import { registerLocalClipSearchProvider } from "../local-search-models.js";
import {
  searchReferenceStore,
  type SearchReferenceDescriptor,
  type SearchReferenceKind,
} from "../search-reference-store.js";
import { registerJobHandler, type JobHandlerContext } from "../queue.js";

interface PrepareSearchReferencePayload {
  type: "prepare_search_reference";
  bookId: string;
  mediaKind: SearchReferenceKind;
  name: string;
  uploadPath?: string;
  cleanupRoot?: string;
  assetId?: string;
  sourceStartMs?: number;
  sourceDurationMs?: number;
}

async function runPrepareSearchReference(
  engine: Engine,
  payload: PrepareSearchReferencePayload,
  context: JobHandlerContext,
): Promise<SearchReferenceDescriptor> {
  try {
    const source = payload.uploadPath
      ? { path: payload.uploadPath, objectHash: undefined }
      : await existingAssetSource(engine, payload.assetId, payload.mediaKind);
    const prepared = await prepareSearchReferenceFile(
      engine,
      source.path,
      payload.mediaKind,
      {
        name: payload.name,
        ...(source.objectHash
          ? { sourceObjectHash: source.objectHash }
          : {}),
        sourceStartMs: payload.sourceStartMs,
        sourceDurationMs: payload.sourceDurationMs,
        signal: context.signal,
      },
    );
    return searchReferenceStore.put(prepared);
  } finally {
    if (payload.cleanupRoot) {
      await rm(payload.cleanupRoot, { recursive: true, force: true });
    }
  }
}

async function prepareSearchReferenceFile(
  engine: Engine,
  sourcePath: string,
  mediaKind: SearchReferenceKind,
  options: {
    name?: string;
    sourceStartMs?: number;
    sourceDurationMs?: number;
    sourceObjectHash?: string;
    signal?: AbortSignal;
  } = {},
): Promise<{
  kind: SearchReferenceKind;
  name: string;
  durationMs?: number;
  reference: PreparedSearchReference;
}> {
  const provider = registerLocalClipSearchProvider(engine);
  const registered = engine.temporalSearch.manifests.register(LOCAL_CLIP_MANIFEST);
  if (!registered.ok) throw new Error(registered.error.message);
  await provider.prepare();
  options.signal?.throwIfAborted();
  const name = options.name?.trim() || basename(sourcePath);
  if (mediaKind === "image") {
    const vector = await provider.embedImage(sourcePath);
    options.signal?.throwIfAborted();
    return {
      kind: "image",
      name,
      reference: {
        kind: "image",
        embeddingSpace: provider.embeddingSpace,
        vector: [...vector],
        fingerprints: [{
          kind: "sha256",
          value: options.sourceObjectHash ?? await fileHash(sourcePath),
        }],
      },
    };
  }
  const probe = await probeVideo(sourcePath, { signal: options.signal });
  if (!probe.videoStream || probe.videoDuration <= 0) {
    throw new Error("The selected reference has no usable video stream");
  }
  const fullDurationMs = Math.max(1, Math.round(probe.videoDuration * 1_000));
  const sourceStartMs = boundedStart(options.sourceStartMs, fullDurationMs);
  const availableMs = fullDurationMs - sourceStartMs;
  const durationMs = boundedDuration(options.sourceDurationMs, availableMs);
  const offsets = sampleOffsets(durationMs);
  const frameRoot = await mkdtemp(join(tmpdir(), "videobook-search-frames-"));
  try {
    const samples = [];
    for (const [index, offsetMs] of offsets.entries()) {
      options.signal?.throwIfAborted();
      const framePath = join(frameRoot, `${String(index).padStart(2, "0")}.jpg`);
      await runFfmpeg([
        "-ss",
        ((sourceStartMs + offsetMs) / 1_000).toFixed(3),
        "-i",
        sourcePath,
        "-frames:v",
        "1",
        "-q:v",
        "2",
        "-y",
        framePath,
      ], { signal: options.signal });
      const vector = await provider.embedImage(framePath);
      samples.push({ offsetMs, vector: [...vector] });
    }
    return {
      kind: "video",
      name,
      durationMs,
      reference: {
        kind: "video",
        embeddingSpace: provider.embeddingSpace,
        samples,
      },
    };
  } finally {
    await rm(frameRoot, { recursive: true, force: true });
  }
}

export function registerPrepareSearchReferenceJob(engine: Engine): void {
  registerJobHandler("prepare_search_reference", async (payload, context) =>
    runPrepareSearchReference(
      engine,
      payload as unknown as PrepareSearchReferencePayload,
      context,
    ));
}

async function existingAssetSource(
  engine: Engine,
  assetId: string | undefined,
  mediaKind: SearchReferenceKind,
): Promise<{ path: string; objectHash: string }> {
  if (!assetId) throw new Error("Search reference asset ID is required");
  const artifact = engine.artifacts.get(assetId);
  if (!artifact.ok) throw new Error(artifact.error.message);
  if (
    mediaKind === "image"
      ? artifact.value.kind !== "image"
      : artifact.value.kind !== "video" && artifact.value.kind !== "final"
  ) {
    throw new Error(`The selected asset is not a ${mediaKind}`);
  }
  const manifest = await engine.files.manifest(artifact.value.artifactId);
  if (!manifest.ok) throw new Error(manifest.error.message);
  const file = mediaKind === "video"
    ? findVideoFile(manifest.value.files)
      ?? findPrimaryMediaFile(manifest.value.files, artifact.value.kind)
    : findPrimaryMediaFile(manifest.value.files, artifact.value.kind);
  if (!file) throw new Error(`No ${mediaKind} file is available for this asset`);
  return {
    path: join(manifest.value.path, file.name),
    objectHash: file.objectHash,
  };
}

function boundedStart(value: number | undefined, durationMs: number): number {
  if (value === undefined) return 0;
  if (!Number.isFinite(value) || value < 0 || value >= durationMs) {
    throw new Error("Reference start must fall within the video");
  }
  return Math.round(value);
}

function boundedDuration(value: number | undefined, availableMs: number): number {
  if (value === undefined) return availableMs;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("Reference duration must be positive");
  }
  return Math.max(1, Math.min(Math.round(value), availableMs));
}

function sampleOffsets(durationMs: number): number[] {
  if (durationMs <= 100) return [0];
  const count = Math.min(16, Math.max(2, Math.ceil(durationMs / 1_000)));
  const finalOffset = Math.max(1, durationMs - Math.min(50, durationMs / 10));
  return Array.from({ length: count }, (_, index) =>
    Math.round(index * finalOffset / (count - 1)));
}

async function fileHash(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}
