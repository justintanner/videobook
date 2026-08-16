import { join, extname } from "node:path";
import type { ArtifactManifestFile, Engine } from "videobook-engine";
import type { OsgPosition, OsgSize } from "./remotion/subtitles/types.js";

const OSG_POSITIONS: readonly OsgPosition[] = [
  "top-left", "top-center", "top-right",
  "middle-left", "middle-center", "middle-right",
  "bottom-left", "bottom-center", "bottom-right",
];

export function isOsgPosition(value: unknown): value is OsgPosition {
  return OSG_POSITIONS.includes(value as OsgPosition);
}

export function isOsgSize(value: unknown): value is OsgSize {
  return value === "small" || value === "medium" || value === "large";
}

// Wider than _image-inputs' set: OSG accepts svg since Remotion renders it in
// a browser, while provider uploads (the _image-inputs consumers) cannot.
const OSG_IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif", "svg"]);

function findOsgImageFile(files: ArtifactManifestFile[]): ArtifactManifestFile | null {
  const images = files.filter((file) => {
    const ext = (file.extension ?? extname(file.name)).replace(/^\./, "").toLowerCase();
    return OSG_IMAGE_EXTENSIONS.has(ext);
  });
  // Manifests are alphabetically sorted, so a bare images[0] would pick a
  // cover-crop preview variant (landscape.jpg) over the transparent source.
  return images.find((file) => file.name.startsWith("original")) ?? images[0] ?? null;
}

export type OsgImagePathResult =
  | { ok: true; path: string }
  | { ok: false; error: string };

/** Resolve an OSG image asset id to the on-disk path of its source image. */
export async function resolveOsgImagePath(
  fs: Engine,
  osgAssetId: string,
): Promise<OsgImagePathResult> {
  const manifest = await fs.files.manifest(osgAssetId);
  if (!manifest.ok) {
    return { ok: false, error: `OSG asset error: ${manifest.error.message}` };
  }
  const imgFile = findOsgImageFile(manifest.value.files);
  if (!imgFile) {
    return { ok: false, error: `No image file found in OSG asset ${osgAssetId}` };
  }
  return { ok: true, path: join(manifest.value.path, imgFile.name) };
}
