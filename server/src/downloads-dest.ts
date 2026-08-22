import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function defaultDownloadsDir(): string {
  return join(homedir(), "Downloads");
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
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}
