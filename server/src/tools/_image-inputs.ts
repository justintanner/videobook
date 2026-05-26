import type { ClipfirstFs, AssetManifestFile } from "vc-engine";
import { extname } from "node:path";

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif"]);

export function findImageFile(files: AssetManifestFile[]): AssetManifestFile | null {
  const images = files.filter((f) => {
    const ext = (f.extension ?? extname(f.name)).replace(/^\./, "").toLowerCase();
    return IMAGE_EXTENSIONS.has(ext);
  });
  return images.find((f) => f.name.startsWith("original")) ?? images[0] ?? null;
}

// Reference to an image for provider upload. Either a real project asset
// (read from vc-engine at upload time) or a pre-uploaded URL that the
// provider can fetch directly — used for ephemeral inputs like pose
// skeletons that never get persisted as assets.
export type ImageInput =
  | { assetId: string; filename: string }
  | { url: string };

export type SlugResolution =
  | { ok: true; inputs: ImageInput[]; sourceImageIds: string[] }
  | { ok: false; error: string };

function isHttpUrl(s: string): boolean {
  return s.startsWith("http://") || s.startsWith("https://");
}

export async function resolveImageSlugs(
  fs: ClipfirstFs,
  rawSlugs: readonly string[],
  projectSlug: string,
): Promise<SlugResolution> {
  const inputs: ImageInput[] = [];
  const sourceImageIds: string[] = [];
  for (const raw of rawSlugs) {
    if (isHttpUrl(raw)) {
      inputs.push({ url: raw });
      continue;
    }
    const assetId = raw.replace(/^@/, "");
    if (!assetId.startsWith("img-") && !assetId.startsWith("char-")) {
      return { ok: false, error: `image_slugs entries must be img-* or char-* assets or http(s) URLs, got: ${assetId}` };
    }
    const manifestResult = await fs.getManifest(assetId, projectSlug);
    if (!manifestResult.ok) return { ok: false, error: manifestResult.error.message };
    const imageFile = findImageFile(manifestResult.value.files);
    if (!imageFile) return { ok: false, error: `No image file found in asset ${assetId}` };
    inputs.push({ assetId, filename: imageFile.name });
    sourceImageIds.push(assetId);
  }
  return { ok: true, inputs, sourceImageIds };
}
