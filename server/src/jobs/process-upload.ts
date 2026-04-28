import type { ClipfirstFs, AssetEntry } from "clipfirst-fs";
import * as path from "node:path";
import { queue } from "../queue.js";
import { WHITELISTED_AT_FILE } from "../tools/whitelist-asset.js";

const MEDIA_EXTENSIONS = new Set([
  ".mp4", ".mov", ".webm", ".avi", ".mkv",
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg",
  ".mp3", ".wav", ".aac", ".flac", ".ogg",
]);

const SUPPORTED_EXTENSIONS = new Set([
  ...MEDIA_EXTENSIONS,
  ".md",
]);

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".avi", ".mkv"]);
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".aac", ".flac", ".ogg"]);

export type UnprocessedUpload = {
  assetId: string;
  assetDir: string;
  mediaFilename: string;
  extension: string;
  mediaType: "video" | "image" | "audio" | "script";
};

function getMediaType(ext: string): "video" | "image" | "audio" | "script" | null {
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (AUDIO_EXTENSIONS.has(ext)) return "audio";
  if (ext === ".md") return "script";
  if (SUPPORTED_EXTENSIONS.has(ext)) return "image";
  return null;
}

export async function findUnprocessedUploads(
  fs: ClipfirstFs,
  projectSlug: string,
  assets: AssetEntry[],
): Promise<UnprocessedUpload[]> {
  const results = await Promise.all(
    assets.map(async (asset): Promise<UnprocessedUpload | null> => {
      if (asset.id === "final") return null;
      const manifest = await fs.getManifest(asset.id, projectSlug);
      if (!manifest.ok) return null;

      const originResult = await fs.readMetadata(asset.id, "original", projectSlug);
      if (originResult.ok) return null;

      // Skip assets currently held by another job (splice/trim/render mid-write).
      // Otherwise the sweep races the in-flight ffmpeg writing original.mp4 and
      // hands a half-written file to process_video, producing a spurious
      // .generation-error.json before the real owner finishes.
      if (await fs.isLocked(asset.path)) return null;

      const mediaFile = manifest.value.files.find((f) => {
        const ext = path.extname(f.name).toLowerCase();
        return SUPPORTED_EXTENSIONS.has(ext);
      });
      if (!mediaFile) return null;

      const ext = path.extname(mediaFile.name).toLowerCase();
      const mediaType = getMediaType(ext);
      if (!mediaType) return null;

      return {
        assetId: asset.id,
        assetDir: asset.path,
        mediaFilename: mediaFile.name,
        extension: ext,
        mediaType,
      };
    })
  );
  return results.filter((u): u is UnprocessedUpload => u !== null);
}

export async function processExternalUpload(
  fs: ClipfirstFs,
  upload: UnprocessedUpload,
  projectSlug: string,
): Promise<void> {
  const targetFilename = `original${upload.extension}`;

  if (upload.mediaFilename !== targetFilename) {
    await fs.renameFile(upload.assetId, upload.mediaFilename, targetFilename, projectSlug);
  }

  // Drop any prior failure sidecar so a successful retry dismisses the
  // /inbox FAILED tile (mirrors writePendingTask in pending-task.ts).
  await fs.deleteFile(upload.assetId, ".generation-error.json", projectSlug).catch(() => {});

  const provenance = { origin: "external", processed_at: new Date().toISOString() };
  if (upload.mediaType === "video") {
    const videoPath = path.join(upload.assetDir, targetFilename);
    await fs.writeFile(upload.assetId, WHITELISTED_AT_FILE, String(Date.now() / 1000), projectSlug);
    const jobId = `process-video-${upload.assetId}-${Date.now()}`;
    await queue.enqueue(jobId, {
      type: "process_video",
      videoPath,
      assetId: upload.assetId,
      assetDir: upload.assetDir,
      projectSlug,
      provenance,
    } as unknown as Record<string, unknown>);
  } else if (upload.mediaType === "image") {
    const jobId = `process-image-${upload.assetId}-${Date.now()}`;
    await queue.enqueue(jobId, {
      type: "process_image",
      assetId: upload.assetId,
      projectSlug,
      extension: upload.extension,
      provenance,
    } as unknown as Record<string, unknown>);
  } else {
    await fs.writeMetadata(upload.assetId, "original", provenance, projectSlug);
  }
}
