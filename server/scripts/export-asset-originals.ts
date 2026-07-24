/**
 * One-off: copy every vid-/img-/char- asset's `original.{ext}` from every
 * project to a single shared `<projects-root>/exports/<sha256>.<ext>` pile.
 *
 * Usage:
 *   tsx server/scripts/export-asset-originals.ts            # all projects
 *   tsx server/scripts/export-asset-originals.ts <slug>     # one project
 *
 * Idempotent: if the destination filename already exists, the asset is skipped
 * (sha256 filenames are content-addressed, so existence implies identity —
 * identical content across projects naturally collapses to one file).
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";

import { fs, PROJECTS_DIR } from "../src/fs.js";

const ORIGINAL_RE = /^original\.(mp4|mov|mp3|wav|m4a|jpg|jpeg|png|webp)$/i;

interface ProjectStats {
  exported: number;
  skipped: number;
  noOriginal: number;
  failed: number;
}

function emptyStats(): ProjectStats {
  return { exported: 0, skipped: 0, noOriginal: 0, failed: 0 };
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function findOriginals(assetDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(assetDir);
  } catch {
    return [];
  }
  const matches = entries.filter((e) => ORIGINAL_RE.test(e));
  // Drop any whose `.part` sibling still exists — upload/processing in flight.
  return matches
    .filter((e) => !entries.includes(`${e}.part`))
    .map((e) => join(assetDir, e));
}

async function sha256OfFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(filePath), hash);
  return hash.digest("hex");
}

async function exportAsset(
  exportsDir: string,
  assetId: string,
  bookId: string,
): Promise<ProjectStats> {
  const stats = emptyStats();
  const dirResult = await fs.workspaces.resolveArtifact(assetId, bookId);
  if (!dirResult.ok) {
    stats.failed += 1;
    return stats;
  }
  const assetDir = dirResult.value;

  const originals = await findOriginals(assetDir);
  if (originals.length === 0) {
    stats.noOriginal += 1;
    return stats;
  }

  for (const originalPath of originals) {
    const ext = originalPath.split(".").pop()!.toLowerCase();
    const sha = await sha256OfFile(originalPath);
    const destPath = join(exportsDir, `${sha}.${ext}`);
    if (await fileExists(destPath)) {
      stats.skipped += 1;
    } else {
      await copyFile(originalPath, destPath);
      stats.exported += 1;
    }
  }
  return stats;
}

async function exportProject(slug: string, exportsDir: string): Promise<ProjectStats> {
  const stats = emptyStats();
  const projectDir = await fs.resolveProjectDir(slug);
  if (!projectDir) {
    console.error(`  ! project not found: ${slug}`);
    stats.failed += 1;
    return stats;
  }

  const assets = await fs.artifacts.list(slug);
  const media = assets.filter(
    (a) => a.type === "video" || a.type === "image" || a.type === "character",
  );
  if (media.length === 0) {
    console.log(`${slug}: no vid-/img-/char- assets`);
    return stats;
  }

  for (const asset of media) {
    try {
      const s = await exportAsset(exportsDir, asset.id, slug);
      stats.exported += s.exported;
      stats.skipped += s.skipped;
      stats.noOriginal += s.noOriginal;
      stats.failed += s.failed;
    } catch (err) {
      stats.failed += 1;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  ⚠ ${slug}/${asset.id}: ${msg}`);
    }
  }

  console.log(
    `${slug}: exported ${stats.exported}, skipped ${stats.skipped}, ` +
      `no-original ${stats.noOriginal}, failed ${stats.failed}`,
  );
  return stats;
}

async function main(): Promise<void> {
  const argSlug = process.argv[2];

  let slugs: string[];
  if (argSlug) {
    slugs = [argSlug];
  } else {
    const projects = await fs.projects.list();
    slugs = projects.map((p) => p.slug);
  }

  const exportsDir = join(PROJECTS_DIR, "exports");
  await mkdir(exportsDir, { recursive: true });

  console.log(`projects root: ${PROJECTS_DIR}`);
  console.log(`exports dir:   ${exportsDir}`);
  console.log(`processing ${slugs.length} project(s)…\n`);

  const total = emptyStats();
  for (const slug of slugs) {
    const s = await exportProject(slug, exportsDir);
    total.exported += s.exported;
    total.skipped += s.skipped;
    total.noOriginal += s.noOriginal;
    total.failed += s.failed;
  }

  console.log(
    `\ntotal — exported ${total.exported}, skipped ${total.skipped}, ` +
      `no-original ${total.noOriginal}, failed ${total.failed}`,
  );
}

void main();
