import type { Engine } from "videobook-engine";
import type { Orientation } from "./remotion/subtitles/types.js";

const ORIENTATIONS: readonly Orientation[] = ["landscape", "portrait", "square"];

export type OsgSettingsResult = { ok: true } | { ok: false; error: string };

/**
 * Merge OSG fields into every orientation's `.render` metadata without
 * triggering a render. `patch` receives the orientation and its existing
 * metadata so callers can vary fields per orientation (the frame-aware
 * watermark stores a different corner for each) or derive defaults from the
 * stored values.
 */
export async function writeOsgSettings(
  fs: Engine,
  assetId: string,
  patch: (orientation: Orientation, base: Record<string, unknown>) => Record<string, unknown>,
): Promise<OsgSettingsResult> {
  for (const orientation of ORIENTATIONS) {
    const existing = await fs.metadata.artifacts.read<Record<string, unknown>>(assetId, `${orientation}.render`);
    const base = existing.ok ? existing.value : {};
    const merged: Record<string, unknown> = { ...base, ...patch(orientation, base) };
    const written = await fs.metadata.artifacts.write(assetId, `${orientation}.render`, merged);
    if (!written.ok) return { ok: false, error: written.error.message };
  }
  return { ok: true };
}
