/**
 * Persisted watermark handle preferences.
 *
 * The chat watermark review remembers the X handles you've used so it can default to
 * your last-used (or explicitly saved) handle instead of asking every time. The
 * authenticated user's handle is read live via @apicity/x's /2/users/me endpoint
 * (see x/authenticated-handle.ts); `authenticatedHandle` below is a read-through
 * cache so the review still pre-fills when the API is unreachable.
 *
 * Stored as unversioned application state in the main Dolt database.
 */

import type { Engine } from "videobook-engine";
import { getActiveEngine } from "./queue.js";
import type { WatermarkPlatform } from "./watermark-platform.js";

const RECENT_LIMIT = 8;

interface WatermarkConfig {
  savedHandle: string | null;
  recent: string[];
  authenticatedHandle: string | null;
}

const EMPTY_CONFIG: WatermarkConfig = { savedHandle: null, recent: [], authenticatedHandle: null };
const SETTINGS_KEY = "application.watermark.v1";

/** Trim surrounding whitespace then strip one leading @; empty string ⇒ null. */
export function normalizeHandle(handle: string): string | null {
  const cleaned = handle.trim().replace(/^@/, "").trim();
  return cleaned.length > 0 ? cleaned : null;
}

let writeChain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeChain.then(fn, fn);
  writeChain = next.catch(() => {});
  return next;
}

function settingsKey(platform: WatermarkPlatform): string {
  return platform === "x" ? SETTINGS_KEY : "application.watermark.tiktok.v1";
}

function readConfig(engine: Engine, platform: WatermarkPlatform = "x"): WatermarkConfig {
  const parsed = engine.settings.get<Partial<WatermarkConfig>>(settingsKey(platform));
  if (!parsed) return { ...EMPTY_CONFIG };
  const recent = Array.isArray(parsed.recent)
    ? parsed.recent.filter((handle): handle is string => typeof handle === "string")
    : [];
  const savedHandle = typeof parsed.savedHandle === "string" ? parsed.savedHandle : null;
  const authenticatedHandle = typeof parsed.authenticatedHandle === "string" ? parsed.authenticatedHandle : null;
  return { savedHandle, recent, authenticatedHandle };
}

export async function readWatermarkConfig(
  engine: Engine = getActiveEngine(),
  platform: WatermarkPlatform = "x",
): Promise<WatermarkConfig> {
  return readConfig(engine, platform);
}

function writeWatermarkConfig(
  engine: Engine,
  config: WatermarkConfig,
  platform: WatermarkPlatform = "x",
): void {
  const written = engine.settings.set(settingsKey(platform), config);
  if (!written.ok) throw new Error(written.error.message);
}

/** Record a freshly-used handle: unshift into `recent` (case-insensitive dedup,
 *  capped), and pin it as `savedHandle` when `saveDefault` is set. No-op for
 *  blank handles. Returns the updated config. */
export async function recordHandle(
  handle: string,
  opts: { saveDefault?: boolean; platform?: WatermarkPlatform } = {},
  engine: Engine = getActiveEngine(),
): Promise<WatermarkConfig> {
  const normalized = normalizeHandle(handle);
  const platform = opts.platform ?? "x";
  if (!normalized) return readConfig(engine, platform);

  return serialize(async () => {
    const current = readConfig(engine, platform);
    const deduped = current.recent.filter((h) => h.toLowerCase() !== normalized.toLowerCase());
    const next: WatermarkConfig = {
      savedHandle: opts.saveDefault ? normalized : current.savedHandle,
      recent: [normalized, ...deduped].slice(0, RECENT_LIMIT),
      authenticatedHandle: current.authenticatedHandle,
    };
    writeWatermarkConfig(engine, next, platform);
    return next;
  });
}

/** Cache the authenticated X handle (read-through fallback when the API is
 *  unreachable). Pass null to clear. No-op when the value is unchanged. */
export async function setAuthenticatedHandle(
  handle: string | null,
  engine: Engine = getActiveEngine(),
): Promise<WatermarkConfig> {
  const normalized = handle === null ? null : normalizeHandle(handle);
  return serialize(async () => {
    const current = readConfig(engine);
    if (current.authenticatedHandle === normalized) return current;
    const next: WatermarkConfig = {
      savedHandle: current.savedHandle,
      recent: current.recent,
      authenticatedHandle: normalized,
    };
    writeWatermarkConfig(engine, next);
    return next;
  });
}
