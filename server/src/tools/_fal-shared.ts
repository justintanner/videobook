import type { ClipfirstFs, AssetManifestFile } from "clipfirst-fs";
import { extname } from "node:path";

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif"]);

export function findImageFile(files: AssetManifestFile[]): AssetManifestFile | null {
  const images = files.filter((f) => {
    const ext = (f.extension ?? extname(f.name)).replace(/^\./, "").toLowerCase();
    return IMAGE_EXTENSIONS.has(ext);
  });
  return images.find((f) => f.name.startsWith("original")) ?? images[0] ?? null;
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30)
    .replace(/-$/, "");
}

export type ImageInput = { assetId: string; filename: string };

export type SlugResolution =
  | { ok: true; inputs: ImageInput[]; sourceImageIds: string[] }
  | { ok: false; error: string };

export async function resolveImageSlugs(
  fs: ClipfirstFs,
  rawSlugs: readonly string[],
  projectSlug: string,
): Promise<SlugResolution> {
  const inputs: ImageInput[] = [];
  const sourceImageIds: string[] = [];
  for (const raw of rawSlugs) {
    const assetId = raw.replace(/^@/, "");
    if (!assetId.startsWith("img-")) {
      return { ok: false, error: `image_slugs entries must be img-* assets, got: ${assetId}` };
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
