import { copyFile, lstat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function defaultDownloadsDir(): string {
  return process.env.VIDEOBOOK_DOWNLOADS_DIR || join(homedir(), "Downloads");
}

/** Flatten a display label into a single Downloads filename stem.
 *  Generation labels include model slugs like `kling-3.0/video — …`; those
 *  slashes (and `..` / backslashes) must not become path segments. */
function sanitizeDownloadBaseName(baseName: string): string {
  const parts = baseName.split(/[/\\]+/u).flatMap((part) => {
    const trimmed = part.replaceAll("\0", "").trim();
    if (!trimmed || trimmed === "." || trimmed === "..") return [];
    return [trimmed];
  });
  const joined = parts.join(" - ").replace(/\s+/gu, " ").trim();
  return joined || "download";
}

export async function resolveDownloadDestination(
  baseName: string,
  ext: string,
  downloadsDir: string = defaultDownloadsDir(),
): Promise<string> {
  const stem = sanitizeDownloadBaseName(baseName);
  const suffix = ext.startsWith(".") ? ext : `.${ext}`;
  let candidate = join(downloadsDir, `${stem}${suffix}`);
  let n = 2;
  while (await fileExists(candidate)) {
    candidate = join(downloadsDir, `${stem} (${n})${suffix}`);
    n += 1;
  }
  return candidate;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

export async function copyToDownloads(
  sourcePath: string,
  baseName: string,
  ext: string,
  downloadsDir?: string,
): Promise<string> {
  while (true) {
    const destination = await resolveDownloadDestination(baseName, ext, downloadsDir);
    try {
      await copyFile(sourcePath, destination, fsConstants.COPYFILE_EXCL);
      return destination;
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") continue;
      throw error;
    }
  }
}
