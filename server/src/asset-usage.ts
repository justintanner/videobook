import type { Engine } from "videobook-engine";

const SETTINGS_KEY = "asset-last-used";
const MAX_ENTRIES = 500;

export type AssetUsage = ReadonlyMap<string, number>;

function usageEntries(stored: unknown): Array<[string, number]> {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return [];
  return Object.entries(stored).filter((entry): entry is [string, number] =>
    typeof entry[1] === "number" && Number.isFinite(entry[1]));
}

export function readAssetUsage(engine: Engine): AssetUsage {
  return new Map(usageEntries(engine.settings.get<unknown>(SETTINGS_KEY)));
}

export function recordAssetUse(
  engine: Engine,
  artifactId: string,
  usedAt = Date.now(),
): boolean {
  const entries = usageEntries(engine.settings.get<unknown>(SETTINGS_KEY))
    .filter(([id]) => id !== artifactId);
  const next = [[artifactId, usedAt] as [string, number], ...entries]
    .sort((left, right) => right[1] - left[1])
    .slice(0, MAX_ENTRIES);
  return engine.settings.set(SETTINGS_KEY, Object.fromEntries(next)).ok;
}

export function assetRecency(
  createdAt: string,
  lastUsedAt: number | undefined,
): number {
  const created = Date.parse(createdAt);
  const createdMs = Number.isFinite(created) ? created : 0;
  return Math.max(createdMs, lastUsedAt ?? 0);
}
