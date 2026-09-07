/**
 * Per-book configuration for automatic tagging.
 *
 * Automatic tagging is on by default for new assets, because an asset nobody
 * can find is the problem the feature exists to solve. Turning it off stops
 * the coordinator from being queued at all — it does not disable tags: manual
 * tagging, filtering and search keep working exactly as before, which is also
 * what a book with no provider key gets.
 */

import type { Engine } from "videobook-engine";

const SETTINGS_KEY = "asset-tagging";

export type TaggingSettings = {
  /** Queue tagging when a new asset becomes ready. */
  automaticEnabled: boolean;
  /**
   * Let tagging request analysis that is not cached. Off by default: the
   * existing library is backfilled by an explicit user action with counts in
   * front of it, never by unbounded provider work at boot.
   */
  analysisOnNewAssets: boolean;
};

export const DEFAULT_TAGGING_SETTINGS: TaggingSettings = {
  automaticEnabled: true,
  analysisOnNewAssets: true,
};

export function readTaggingSettings(engine: Engine): TaggingSettings {
  const stored = engine.settings.get<Record<string, unknown>>(SETTINGS_KEY);
  if (!stored) return { ...DEFAULT_TAGGING_SETTINGS };
  return {
    automaticEnabled: stored.automaticEnabled !== false,
    analysisOnNewAssets: stored.analysisOnNewAssets !== false,
  };
}

export function writeTaggingSettings(
  engine: Engine,
  update: Partial<TaggingSettings>,
): TaggingSettings {
  const next: TaggingSettings = { ...readTaggingSettings(engine), ...update };
  const written = engine.settings.set(SETTINGS_KEY, next);
  if (!written.ok) throw new Error(written.error.message);
  return next;
}
