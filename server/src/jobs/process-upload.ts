import type { ClipfirstFs } from "clipfirst-fs";
import * as path from "node:path";
import { queue } from "../queue.js";

const MEDIA_EXTENSIONS = new Set([
  ".mp4", ".mov", ".webm", ".avi", ".mkv",
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg",
  ".mp3", ".wav", ".aac", ".flac", ".ogg",
]);

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".avi", ".mkv"]);
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".aac", ".flac", ".ogg"]);

export type UnprocessedUpload = {
  assetId: string;
  assetDir: string;
  mediaFilename: string;
  extension: string;
  mediaType: "video" | "image" | "audio";
};

function getMediaType(ext: string): "video" | "image" | "audio" | null {
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (AUDIO_EXTENSIONS.has(ext)) return "audio";
  if (MEDIA_EXTENSIONS.has(ext)) return "image";
  return null;
}

export async function findUnprocessedUploads(
  fs: ClipfirstFs,
  projectSlug: string,
): Promise<UnprocessedUpload[]> {
  const assets = await fs.listAssets(projectSlug);
  const uploads: UnprocessedUpload[] = [];

  for (const asset of assets) {
    const manifest = await fs.getManifest(asset.id, projectSlug);
    if (!manifest.ok) continue;

    const hasOrigin = manifest.value.files.some((f) => f.name === ".original.json");
    if (hasOrigin) continue;

    const mediaFile = manifest.value.files.find((f) => {
      const ext = path.extname(f.name).toLowerCase();
      return MEDIA_EXTENSIONS.has(ext);
    });
    if (!mediaFile) continue;

    const ext = path.extname(mediaFile.name).toLowerCase();
    const mediaType = getMediaType(ext);
    if (!mediaType) continue;

    uploads.push({
      assetId: asset.id,
      assetDir: asset.path,
      mediaFilename: mediaFile.name,
      extension: ext,
      mediaType,
    });
  }

  return uploads;
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

  const provenance = { origin: "external", processed_at: new Date().toISOString() };
  if (upload.mediaType === "video") {
    const videoPath = path.join(upload.assetDir, targetFilename);
    const jobId = `process-video-${upload.assetId}-${Date.now()}`;
    await queue.enqueue(jobId, {
      type: "process_video",
      videoPath,
      assetId: upload.assetId,
      assetDir: upload.assetDir,
      projectSlug,
      provenance,
    } as unknown as Record<string, unknown>);
  } else {
    await fs.writeMetadata(upload.assetId, "original", provenance, projectSlug);
  }
}
