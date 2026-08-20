import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function defaultDownloadsDir(): string {
  return join(homedir(), "Downloads");
}

export async function resolveDownloadDestination(
  baseName: string,
  ext: string,
  downloadsDir: string = defaultDownloadsDir(),
): Promise<string> {
  const suffix = ext.startsWith(".") ? ext : `.${ext}`;
  let candidate = join(downloadsDir, `${baseName}${suffix}`);
  let n = 2;
  while (await fileExists(candidate)) {
    candidate = join(downloadsDir, `${baseName} (${n})${suffix}`);
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
