import type { ClipfirstFs } from "clipfirst-fs";
import { rename, writeFile as fsWriteFile } from "node:fs/promises";
import { join } from "node:path";
import * as path from "node:path";
import { probeVideo } from "../ffmpeg.js";

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

    const hasOrigin = manifest.value.files.some((f) => f.name === ".origin.json");
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
  const srcPath = join(upload.assetDir, upload.mediaFilename);
  const dstPath = join(upload.assetDir, targetFilename);

  if (upload.mediaFilename !== targetFilename) {
    await rename(srcPath, dstPath);
  }

  let width: number | undefined;
  let height: number | undefined;
  let duration: number | undefined;

  try {
    const probe = await probeVideo(dstPath);
    if (probe.width > 0) width = probe.width;
    if (probe.height > 0) height = probe.height;
    if (probe.duration > 0) duration = probe.duration;
  } catch {
    // probing is non-fatal
  }

  const origin: Record<string, unknown> = {
    origin: "external",
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    ...(duration !== undefined ? { duration } : {}),
    processed_at: new Date().toISOString(),
  };

  await fsWriteFile(join(upload.assetDir, ".origin.json"), JSON.stringify(origin, null, 2));
  await fs.commitOperation("external", upload.assetId, {}, projectSlug);
}
