import { extname } from "node:path";
import { normalizeFilePath, type Engine } from "videobook-engine";

export async function withMediaOutputLock<T>(
  engine: Engine,
  assetDir: string,
  signal: AbortSignal,
  fn: () => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
  const lock = await engine.jobs.locks.acquire(assetDir, { durationMs: 120_000 });
  if (!lock.ok) throw new Error(`Asset is locked: ${lock.error.message}`);
  try {
    signal.throwIfAborted();
    return await fn();
  } finally {
    engine.jobs.locks.release(assetDir, lock.value.ownerId);
  }
}

export async function validateMediaOutputPaths(
  engine: Engine,
  assetId: string,
  filenames: string[],
  extension: string,
): Promise<string[]> {
  const paths = filenames.map(normalizeFilePath);
  const manifest = await engine.files.manifest(assetId, { includeDotfiles: true });
  if (!manifest.ok) throw new Error(`Destination asset ${assetId} not found: ${manifest.error.message}`);
  const occupied = new Set(manifest.value.files.map((file) => file.name.normalize("NFC").toLowerCase()));
  for (const filename of paths) {
    const key = filename.normalize("NFC").toLowerCase();
    if ([...occupied].some((existing) => existing === key || existing.startsWith(`${key}/`) || key.startsWith(`${existing}/`))) {
      throw new Error(`Destination already contains ${filename} or a conflicting path. Refusing silent overwrite.`);
    }
    if (extname(filename).toLowerCase() !== extension) {
      throw new Error(`Destination filename must end in ${extension}: ${filename}`);
    }
    occupied.add(key);
  }
  return paths;
}
