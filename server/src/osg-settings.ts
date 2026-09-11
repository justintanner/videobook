import type { Engine } from "videobook-engine";
import type { Orientation } from "./remotion/subtitles/types.js";

const ORIENTATIONS: readonly Orientation[] = ["landscape", "portrait", "square"];

type OsgSettingsResult =
  | { ok: true; settings: Record<string, Record<string, unknown>> }
  | { ok: false; error: string };

/**
 * Merge OSG fields into every orientation's `.render` metadata without
 * triggering a render. `patch` receives the orientation and its existing
 * metadata so callers can vary fields per orientation (the frame-aware
 * watermark stores a different corner for each) or derive defaults from the
 * stored values.
 */
export async function writeOsgSettings(
  engine: Engine,
  assetId: string,
  patch: (orientation: Orientation, base: Record<string, unknown>) => Record<string, unknown>,
): Promise<OsgSettingsResult> {
  const settings: Record<string, Record<string, unknown>> = {};
  try {
    for (const orientation of ORIENTATIONS) {
      const existing = await engine.metadata.artifacts.read<Record<string, unknown>>(assetId, `${orientation}.render`);
      const base = existing.ok ? existing.value : {};
      settings[orientation] = { ...base, ...patch(orientation, base) };
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  for (const orientation of ORIENTATIONS) {
    const written = await engine.metadata.artifacts.write(assetId, `${orientation}.render`, settings[orientation]);
    if (!written.ok) return { ok: false, error: written.error.message };
  }
  return { ok: true, settings };
}
