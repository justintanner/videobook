import type { AssetManifestFile } from "clipfirst-fs";
import { extname } from "node:path";

const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "ogg", "flac", "aac", "m4a"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "webm", "avi", "mkv"]);

export function findAudioFile(files: AssetManifestFile[], assetId: string): AssetManifestFile | null {
  if (assetId.startsWith("vid-")) {
    return files.find((f) => f.name === "audio_original.mp3")
      ?? files.find((f) => f.name === "original.mp3")
      ?? null;
  }
  if (assetId.startsWith("aud-")) {
    return files.find((f) => {
      const ext = (f.extension ?? "").replace(/^\./, "").toLowerCase();
      return AUDIO_EXTENSIONS.has(ext);
    }) ?? null;
  }
  return null;
}

export function findVideoFile(files: AssetManifestFile[]): AssetManifestFile | null {
  const videos = files.filter((f) => {
    const ext = (f.extension ?? extname(f.name)).replace(/^\./, "").toLowerCase();
    return VIDEO_EXTENSIONS.has(ext);
  });
  return videos.find((f) => f.name.startsWith("original")) ?? videos[0] ?? null;
}
