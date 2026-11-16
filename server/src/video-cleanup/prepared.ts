import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { findPrimaryMediaFile, type Engine } from "videobook-engine";
import { FFMPEG, runFfmpeg } from "../ffmpeg.js";
import { indexedRenderRequests, renderRequestFingerprint, writeRenderSetting } from "../render-requests.js";
import { cleanupMethodSchema, cleanupRegionsSchema, type CleanupMethod, type CleanupRegion } from "./model.js";
import { cleanupSource } from "./source.js";

export const CLEANUP_RENDER_VERSION = 2;
const exec = promisify(execFile);
const provenanceSchema = z.object({
  version: z.number().int().optional(), sourceArtifactId: z.string(), sourceHash: z.string(),
  method: cleanupMethodSchema, regions: cleanupRegionsSchema, outputHash: z.string().optional(),
});

function maskValues({ x, y, width, height, start, end }: CleanupRegion): number[] {
  return [x, y, width, height, start, end];
}

export function canonicalCleanupRegions(regions: readonly CleanupRegion[]): CleanupRegion[] {
  return [...regions].sort((left, right) => JSON.stringify(maskValues(left)).localeCompare(JSON.stringify(maskValues(right))));
}

export function cleanupContentKey(sourceHash: string, method: CleanupMethod, regions: readonly CleanupRegion[]): string {
  const masks = canonicalCleanupRegions(regions).map(maskValues);
  return renderRequestFingerprint([CLEANUP_RENDER_VERSION, sourceHash, method,
    method === "lama" ? "1faef5301d78db7dda502fe59966957ec4b79dd64e16f03ed96913c7a4eb68d6" : "ffmpeg-delogo", masks]);
}

export async function cleanupCandidate(engine: Engine, artifactId: string, sourceHash: string) {
  const file = await engine.files.read(artifactId, "video-cleanup.json");
  if (!file.ok) return null;
  let json: unknown;
  try { json = JSON.parse(file.value.toString()); } catch { return null; }
  const parsed = provenanceSchema.safeParse(json);
  if (!parsed.success || parsed.data.sourceHash !== sourceHash) return null;
  const provenance = parsed.data;
  const manifest = await engine.files.manifest(artifactId);
  const media = manifest.ok ? findPrimaryMediaFile(manifest.value.files, "video") : null;
  if (!media || provenance.outputHash && media.objectHash !== provenance.outputHash) return null;
  const identity = cleanupContentKey(sourceHash, provenance.method, provenance.regions);
  const reviewed = typeof engine.settings.get<unknown>(`video-cleanup.review.${identity}.${media.objectHash}`) === "string";
  return { artifactId, mediaHash: media.objectHash, method: provenance.method, regions: provenance.regions, identity, reviewed,
    reusable: provenance.version === CLEANUP_RENDER_VERSION && provenance.outputHash === media.objectHash };
}

export async function cleanupCandidates(engine: Engine, sourceArtifactId: string, sourceHash: string) {
  const ids = indexedRenderRequests(engine, `video-cleanup.requests.${sourceArtifactId}`).slice(-100);
  const artifacts = new Set<string>();
  for (const id of ids) {
    const request = engine.settings.get<{ outputArtifactId?: string }>(`video-cleanup.request.${id}`);
    if (request?.outputArtifactId) artifacts.add(request.outputArtifactId);
  }
  const candidates = await Promise.all([...artifacts].map(id => cleanupCandidate(engine, id, sourceHash)));
  return candidates.filter(candidate => candidate !== null).slice(-30);
}

export async function validateCleanupCopy(engine: Engine, sourceArtifactId: string, artifactId: string, sourceHash: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const source = await cleanupSource(engine, sourceArtifactId);
  const prepared = await cleanupSource(engine, artifactId);
  if (source.mediaHash !== sourceHash) throw new Error("The source changed after review. Refresh the analysis before preparing it.");
  if (source.width !== prepared.width || source.height !== prepared.height || Math.abs(source.fps - prepared.fps) > 0.01
    || Math.abs(source.durationSeconds - prepared.durationSeconds) > 1 / source.fps + 0.002 || source.hasAudio !== prepared.hasAudio) {
    throw new Error("The cleaned copy does not preserve the source duration, dimensions, frame rate and audio.");
  }
  await runFfmpeg(["-v", "error", "-xerror", "-i", prepared.path, "-map", "0:v:0", "-map", "0:a:0?", "-f", "null", "-"], { signal });
  if (source.hasAudio) {
    const audioHash = async (path: string) => (await exec(FFMPEG, ["-v", "error", "-i", path, "-map", "0:a:0", "-c", "copy", "-f", "hash", "-hash", "sha256", "pipe:1"], { signal, maxBuffer: 16384 })).stdout.trim();
    const [original, copy] = await Promise.all([audioHash(source.path), audioHash(prepared.path)]);
    if (original !== copy) throw new Error("The cleaned copy's audio differs from the original. Use a cleanup that preserves the source audio.");
  }
  return prepared;
}

export function reviewCleanupCopy(engine: Engine, identity: string, mediaHash: string): void {
  writeRenderSetting(engine, `video-cleanup.review.${identity}.${mediaHash}`, new Date().toISOString());
}
