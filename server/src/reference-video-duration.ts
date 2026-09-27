import type { Engine } from "videobook-engine";

export async function referenceVideoDuration(engine: Engine, refs: readonly string[]): Promise<number | undefined> {
  if (refs.length === 0) return undefined;
  let total = 0;
  for (const ref of refs) {
    const assetId = ref.replace(/^@/, "");
    const artifact = engine.artifacts.get(assetId);
    if (!artifact.ok || artifact.value.kind !== "video") return undefined;
    const metadata = await engine.metadata.artifacts.read<{ duration?: number }>(assetId, "original");
    const duration = metadata.ok ? metadata.value?.duration : undefined;
    if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) return undefined;
    total += duration;
  }
  return total;
}
