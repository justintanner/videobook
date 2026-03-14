/**
 * Reusable @tag parsing & resolution for asset references in prompts.
 */
import type { ClipfirstFs } from "clipfirst-fs";

type ResolvedAsset = {
  tag: string;         // "@img-sunset"
  asset_id: string;    // "img-sunset"
  asset_type: string;  // "image" | "video" | "audio" | "script"
  file_path: string | null;
  asset_dir: string;
};

const TAG_PATTERN = /@([a-zA-Z0-9]+-[a-zA-Z0-9_-]+)/g;

function parseAssetTags(text: string): string[] {
  const matches = text.matchAll(TAG_PATTERN);
  return Array.from(matches, (m) => m[1]);
}

function stripAssetTags(text: string): string {
  return text.replace(TAG_PATTERN, "").trim();
}

async function resolveAllAssets(
  text: string,
  fs: ClipfirstFs,
  projectSlug: string,
): Promise<{ resolved: ResolvedAsset[]; unresolved: string[] }> {
  const tags = parseAssetTags(text);
  if (tags.length === 0) return { resolved: [], unresolved: [] };

  const slug = projectSlug;
  const allAssets = await fs.listAssets(slug);

  const assetIds = new Set(allAssets.map((a) => a.id));

  const resolved: ResolvedAsset[] = [];
  const unresolved: string[] = [];

  for (const tag of tags) {
    // Try exact match first, then prefixed variants
    const candidates = [tag, `img-${tag}`, `vid-${tag}`, `aud-${tag}`, `script-${tag}`];
    const matchedId = candidates.find((c) => assetIds.has(c));

    if (!matchedId) {
      unresolved.push(tag);
      continue;
    }

    const entry = allAssets.find((a) => a.id === matchedId)!;
    let filePath: string | null = null;

    const manifest = await fs.getManifest(matchedId, slug);
    if (manifest.ok && manifest.value.files.length > 0) {
      const original = manifest.value.files.find((f) => f.name.startsWith("original"));
      const firstFile = original ?? manifest.value.files[0];
      filePath = `${manifest.value.path}/${firstFile.name}`;
    }

    resolved.push({
      tag: `@${tag}`,
      asset_id: matchedId,
      asset_type: entry.type,
      file_path: filePath,
      asset_dir: entry.path,
    });
  }

  return { resolved, unresolved };
}

export { parseAssetTags, stripAssetTags, resolveAllAssets };
export type { ResolvedAsset };
