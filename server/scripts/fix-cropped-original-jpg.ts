/**
 * One-off repair: when a sync race renames `landscape.jpg` to `original.jpg`,
 * the asset ends up with a cropped 1920x1080 `original.jpg` while the real
 * portrait/landscape source still lives in `original.png`. The variants and
 * `.original.json` reflect the cropped JPG instead of the actual PNG.
 *
 * For each asset:
 *   1. Read `original.png` and re-probe its true dimensions.
 *   2. Delete the bogus `original.jpg`.
 *   3. Rewrite `landscape.jpg`, `portrait.jpg`, `square.jpg` from `original.png`.
 *   4. Rewrite `.original.json` with the correct width/height (preserving
 *      origin/processed_at so provenance survives).
 *
 * Skips assets that don't actually have the inconsistency. Idempotent.
 *
 * Usage:
 *   tsx server/scripts/fix-cropped-original-jpg.ts <project-slug> [assetId...]
 *
 * If no asset IDs are given, scans every img-* asset in the project.
 */
import "dotenv/config";
import { fs, PROJECTS_DIR } from "../src/fs.js";
import { probeImage, cropToFill } from "../src/image.js";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

type RepairOutcome =
  | { kind: "fixed"; assetId: string; pngWidth: number; pngHeight: number }
  | { kind: "skipped"; assetId: string; reason: string }
  | { kind: "failed"; assetId: string; reason: string };

async function fileExists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

async function repairAsset(projectSlug: string, assetId: string): Promise<RepairOutcome> {
  const manifestResult = await fs.files.manifest(assetId, projectSlug, { includeDotfiles: true });
  if (!manifestResult.ok) return { kind: "failed", assetId, reason: manifestResult.error.message };

  const fileNames = new Set(manifestResult.value.files.map((f) => f.name));
  if (!fileNames.has("original.png")) return { kind: "skipped", assetId, reason: "no original.png" };
  if (!fileNames.has("original.jpg")) return { kind: "skipped", assetId, reason: "no original.jpg (already clean)" };

  const pngResult = await fs.files.read(assetId, "original.png", projectSlug);
  if (!pngResult.ok) return { kind: "failed", assetId, reason: `read original.png: ${pngResult.error.message}` };
  const pngBuffer = Buffer.isBuffer(pngResult.value) ? pngResult.value : Buffer.from(pngResult.value);

  const jpgResult = await fs.files.read(assetId, "original.jpg", projectSlug);
  if (!jpgResult.ok) return { kind: "failed", assetId, reason: `read original.jpg: ${jpgResult.error.message}` };
  const jpgBuffer = Buffer.isBuffer(jpgResult.value) ? jpgResult.value : Buffer.from(jpgResult.value);

  const pngDims = await probeImage(pngBuffer);
  const jpgDims = await probeImage(jpgBuffer);

  // If the JPG already matches the PNG aspect, the asset isn't broken in the
  // way we're repairing — leave it alone.
  if (pngDims.width === jpgDims.width && pngDims.height === jpgDims.height) {
    return { kind: "skipped", assetId, reason: `original.jpg already matches original.png (${pngDims.width}x${pngDims.height})` };
  }

  // Preserve provenance fields if they exist; only overwrite width/height.
  const meta = await fs.metadata.artifacts.read<Record<string, unknown>>(assetId, "original", projectSlug);
  const provenance: Record<string, unknown> = meta.ok ? { ...meta.value } : {};
  delete provenance.width;
  delete provenance.height;

  const [landscape, portrait, square] = await Promise.all([
    cropToFill(pngBuffer, 1920, 1080),
    cropToFill(pngBuffer, 1080, 1920),
    cropToFill(pngBuffer, 1080, 1080),
  ]);

  await fs.files.delete(assetId, "original.jpg", projectSlug);
  await fs.files.write(assetId, "landscape.jpg", landscape, projectSlug);
  await fs.files.write(assetId, "portrait.jpg", portrait, projectSlug);
  await fs.files.write(assetId, "square.jpg", square, projectSlug);
  await fs.metadata.artifacts.write(
    assetId,
    "original",
    { ...provenance, width: pngDims.width, height: pngDims.height },
    projectSlug,
  );

  return { kind: "fixed", assetId, pngWidth: pngDims.width, pngHeight: pngDims.height };
}

async function listImgAssets(projectSlug: string): Promise<string[]> {
  const projectDir = join(PROJECTS_DIR, projectSlug);
  const entries = await readdir(projectDir);
  return entries.filter((e) => e.startsWith("img-")).sort();
}

async function main(): Promise<void> {
  const projectSlug = process.argv[2];
  const assetIdArgs = process.argv.slice(3);

  if (!projectSlug) {
    console.error("usage: tsx server/scripts/fix-cropped-original-jpg.ts <project-slug> [assetId...]");
    process.exit(1);
  }

  const projectDir = join(PROJECTS_DIR, projectSlug);
  if (!(await fileExists(projectDir))) {
    console.error(`project not found: ${projectDir}`);
    process.exit(1);
  }

  const assetIds = assetIdArgs.length > 0 ? assetIdArgs : await listImgAssets(projectSlug);
  console.log(`scanning ${assetIds.length} asset(s) in ${projectSlug}…`);

  let fixed = 0, skipped = 0, failed = 0;
  for (const assetId of assetIds) {
    const outcome = await repairAsset(projectSlug, assetId);
    if (outcome.kind === "fixed") {
      fixed += 1;
      console.log(`  ✓ ${assetId}: rebuilt variants from original.png (${outcome.pngWidth}x${outcome.pngHeight})`);
    } else if (outcome.kind === "skipped") {
      skipped += 1;
      console.log(`  · ${assetId}: ${outcome.reason}`);
    } else {
      failed += 1;
      console.log(`  ✗ ${assetId}: ${outcome.reason}`);
    }
  }

  console.log(`\ndone — fixed ${fixed}, skipped ${skipped}, failed ${failed}`);
}

void main();
