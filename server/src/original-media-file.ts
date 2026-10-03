import { findAudioFile, findPrimaryMediaFile, findVideoFile } from "videobook-engine";
import type { ArtifactKind, ArtifactManifestFile } from "videobook-engine";

export function findOriginalMediaFile(
  files: ArtifactManifestFile[],
  kind: ArtifactKind,
): ArtifactManifestFile | null {
  const originals = files.filter((file) => /^original\./i.test(file.name));
  if (kind === "video") return findVideoFile(originals);
  if (kind === "audio") {
    return findAudioFile(originals, kind)
      ?? originals.find((file) => /^original\.webm$/i.test(file.name))
      ?? null;
  }
  return findPrimaryMediaFile(files, kind);
}
