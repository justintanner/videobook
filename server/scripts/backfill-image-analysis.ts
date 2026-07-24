/**
 * One-off backfill: scan a project's img-* assets and write
 * `.original.analysis.json` for any that are missing it.
 *
 * Usage:
 *   tsx server/scripts/backfill-image-analysis.ts <project-slug>
 *
 * Reads OPENAI_API_KEY from `.env`. Idempotent — assets that already have
 * `.original.analysis.json` are skipped.
 */
import "dotenv/config";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describeImageBytes, mimeForImageFilename, ANALYSIS_FILENAME } from "../src/jobs/describe-image.js";

const PROJECTS_DIR = join(process.cwd(), "projects");

async function fileExists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

async function findOriginal(assetDir: string): Promise<string | null> {
  const entries = await readdir(assetDir);
  const original = entries.find(
    (e) => /^original\.(jpg|jpeg|png|webp)$/i.test(e),
  );
  return original ? join(assetDir, original) : null;
}

async function backfillAsset(projectDir: string, assetId: string): Promise<"done" | "skipped" | "no-original" | "failed"> {
  const assetDir = join(projectDir, assetId);
  const cachePath = join(assetDir, ANALYSIS_FILENAME);
  if (await fileExists(cachePath)) return "skipped";
  const originalPath = await findOriginal(assetDir);
  if (!originalPath) return "no-original";
  try {
    const bytes = await readFile(originalPath);
    const filename = originalPath.split("/").pop()!;
    const mime = mimeForImageFilename(filename);
    const result = await describeImageBytes(bytes, mime);
    await writeFile(cachePath, JSON.stringify(result, null, 2));
    return "done";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  ⚠ ${assetId}: ${msg}`);
    return "failed";
  }
}

async function main() {
  const bookId = process.argv[2];
  if (!bookId) {
    console.error("usage: tsx server/scripts/backfill-image-analysis.ts <project-slug>");
    process.exit(1);
  }
  if (!process.env.OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY not set");
    process.exit(1);
  }
  const projectDir = join(PROJECTS_DIR, bookId);
  if (!(await fileExists(projectDir))) {
    console.error(`project not found: ${projectDir}`);
    process.exit(1);
  }
  const entries = await readdir(projectDir);
  const imgAssets = entries.filter((e) => e.startsWith("img-"));
  console.log(`scanning ${imgAssets.length} img-* assets in ${bookId}…`);
  let done = 0, skipped = 0, missing = 0, failed = 0;
  for (const assetId of imgAssets) {
    const result = await backfillAsset(projectDir, assetId);
    if (result === "done") {
      done += 1;
      console.log(`  ✓ ${assetId}`);
    } else if (result === "skipped") {
      skipped += 1;
    } else if (result === "no-original") {
      missing += 1;
      console.log(`  · ${assetId} (no original.* file)`);
    } else {
      failed += 1;
    }
  }
  console.log(`\ndone — wrote ${done}, skipped ${skipped}, missing-original ${missing}, failed ${failed}`);
}

void main();
