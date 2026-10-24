import { readFile, readdir, stat, unlink, writeFile, rename } from "node:fs/promises";
import { join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { harDirectory, readHarSettings, type HarSettings } from "./har-settings.js";
import { maintainHarCaptures } from "./har-capture.js";
import { logger } from "./logger.js";

let nextSweep = 0;

async function captureFiles(dir: string, root = dir): Promise<Array<{ file: string; bytes: number; time: number }>> {
  const result: Array<{ file: string; bytes: number; time: number }> = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await captureFiles(path, root));
    else if (entry.isFile() && entry.name.endsWith(".har")) {
      const info = await stat(path);
      result.push({ file: relative(root, path), bytes: info.size, time: info.mtimeMs });
    }
  }
  return result;
}

export async function pruneHarCaptures(dir: string, settings: HarSettings, now = Date.now()): Promise<void> {
  if (settings.mode === "off") return;
  let files: Awaited<ReturnType<typeof captureFiles>>;
  try { files = await captureFiles(dir); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  files.sort((a, b) => a.time - b.time || a.file.localeCompare(b.file));
  let index = "";
  try { index = await readFile(join(dir, "index.jsonl"), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const rows = index.split("\n").filter(Boolean).map((line) => ({ line, value: JSON.parse(line) as { file: string } }));
  let bytes = files.reduce((sum, file) => sum + file.bytes, 0) + Buffer.byteLength(index);
  const keep = new Set(files.map((file) => file.file));
  for (const file of files) {
    if (file.time >= now - settings.maxAgeDays * 86_400_000 && bytes <= settings.maxTotalMB * 1024 * 1024) continue;
    await unlink(join(dir, file.file));
    keep.delete(file.file);
    bytes -= file.bytes + rows.filter((row) => row.value.file === file.file).reduce((sum, row) => sum + Buffer.byteLength(row.line) + 1, 0);
  }
  const retained = rows.filter((row) => keep.has(row.value.file)).map((row) => row.line + "\n").join("");
  const temporary = join(dir, `.index-${randomUUID()}.tmp`);
  await writeFile(temporary, retained, { mode: 0o600 });
  await rename(temporary, join(dir, "index.jsonl"));
}

export async function sweepHarCaptures(force = false): Promise<void> {
  if (!force && Date.now() < nextSweep) return;
  nextSweep = Date.now() + 86_400_000;
  try {
    const settings = await readHarSettings();
    if (settings.mode === "off") { nextSweep = 0; return; }
    if (!await maintainHarCaptures(() => pruneHarCaptures(harDirectory(), settings))) nextSweep = Date.now() + 60_000;
  } catch (error) {
    logger.warn("har-capture-failed", { error });
  }
}
