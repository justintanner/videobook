/**
 * Persisted watermark handle preferences.
 *
 * The /watermark dialog remembers the X handles you've used so it can default to
 * your last-used (or explicitly saved) handle instead of asking every time. We
 * can't read the connected X username (the @apicity/x provider exposes no
 * users/me endpoint), so this small local store is the source of truth.
 *
 * Stored at ~/.videocity/watermark-config.json (override WATERMARK_CONFIG_PATH),
 * mirroring the atomic-write pattern in x/x-tokens.ts.
 */

import { homedir } from "node:os";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const RECENT_LIMIT = 8;

export interface WatermarkConfig {
  savedHandle: string | null;
  recent: string[];
}

const EMPTY_CONFIG: WatermarkConfig = { savedHandle: null, recent: [] };

function configFilePath(): string {
  return (
    process.env.WATERMARK_CONFIG_PATH
    ?? join(homedir(), ".videocity", "watermark-config.json")
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
    return { savedHandle, recent };
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
  };
  await writeWatermarkConfig(next);
  return next;
}
