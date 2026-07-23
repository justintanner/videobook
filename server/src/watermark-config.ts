/**
 * Persisted watermark handle preferences.
 *
 * The /watermark dialog remembers the X handles you've used so it can default to
 * your last-used (or explicitly saved) handle instead of asking every time. The
 * authenticated user's handle is read live via @apicity/x's /2/users/me endpoint
 * (see x/authenticated-handle.ts); `authenticatedHandle` below is a read-through
 * cache so the dialog still pre-fills when the API is unreachable.
 *
 * Stored at ~/.videobook/watermark-config.json (override WATERMARK_CONFIG_PATH),
 * mirroring the atomic-write pattern in x/x-tokens.ts.
 */

import { homedir } from "node:os";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const RECENT_LIMIT = 8;

export interface WatermarkConfig {
  savedHandle: string | null;
  recent: string[];
  authenticatedHandle: string | null;
}

const EMPTY_CONFIG: WatermarkConfig = { savedHandle: null, recent: [], authenticatedHandle: null };

function configFilePath(): string {
  return (
    process.env.WATERMARK_CONFIG_PATH
    ?? join(homedir(), ".videobook", "watermark-config.json")
  );
}

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

export async function readWatermarkConfig(): Promise<WatermarkConfig> {
  let raw: string;
  try {
    raw = await readFile(configFilePath(), "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ...EMPTY_CONFIG };
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<WatermarkConfig>;
    const recent = Array.isArray(parsed.recent)
      ? parsed.recent.filter((h): h is string => typeof h === "string")
      : [];
    const savedHandle = typeof parsed.savedHandle === "string" ? parsed.savedHandle : null;
    const authenticatedHandle = typeof parsed.authenticatedHandle === "string" ? parsed.authenticatedHandle : null;
    return { savedHandle, recent, authenticatedHandle };
  } catch {
    return { ...EMPTY_CONFIG };
  }
}

async function writeWatermarkConfig(config: WatermarkConfig): Promise<void> {
  await serialize(async () => {
    const path = configFilePath();
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp.${process.pid}`;
    await writeFile(tmp, JSON.stringify(config, null, 2), "utf8");
    await rename(tmp, path);
  });
}

/** Record a freshly-used handle: unshift into `recent` (case-insensitive dedup,
 *  capped), and pin it as `savedHandle` when `saveDefault` is set. No-op for
 *  blank handles. Returns the updated config. */
export async function recordHandle(
  handle: string,
  opts: { saveDefault?: boolean } = {},
): Promise<WatermarkConfig> {
  const normalized = normalizeHandle(handle);
  if (!normalized) return readWatermarkConfig();

  const current = await readWatermarkConfig();
  const deduped = current.recent.filter((h) => h.toLowerCase() !== normalized.toLowerCase());
  const next: WatermarkConfig = {
    savedHandle: opts.saveDefault ? normalized : current.savedHandle,
    recent: [normalized, ...deduped].slice(0, RECENT_LIMIT),
    authenticatedHandle: current.authenticatedHandle,
  };
  await writeWatermarkConfig(next);
  return next;
}

/** Cache the authenticated X handle (read-through fallback when the API is
 *  unreachable). Pass null to clear. No-op when the value is unchanged. */
export async function setAuthenticatedHandle(handle: string | null): Promise<WatermarkConfig> {
  const normalized = handle === null ? null : normalizeHandle(handle);
  const current = await readWatermarkConfig();
  if (current.authenticatedHandle === normalized) return current;
  const next: WatermarkConfig = {
    savedHandle: current.savedHandle,
    recent: current.recent,
    authenticatedHandle: normalized,
  };
  await writeWatermarkConfig(next);
  return next;
}
