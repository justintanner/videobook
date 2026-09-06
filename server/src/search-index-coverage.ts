import { LOCAL_CLIP_MANIFEST, type Engine } from "videobook-engine";

interface VisualIndexAsset {
  artifact_id: string;
  object_hash: string | null;
  type: string;
  status: string;
}

export function missingVisualIndexes<T extends VisualIndexAsset>(engine: Engine, assets: T[]): T[] {
  return assets.filter((asset) => {
    if (asset.status !== "ready" || !["image", "video", "final"].includes(asset.type)) return false;
    if (!asset.object_hash) return true;
    const plan = engine.temporalSearch.plan(
      asset.artifact_id, asset.object_hash, LOCAL_CLIP_MANIFEST.manifestId, LOCAL_CLIP_MANIFEST.manifestId,
    );
    if (!plan.ok) return true;
    return !plan.value.coverage.some((entry) =>
      entry.phase === "visual" && entry.state === "ready" && entry.indexedUnits > 0);
  });
}
