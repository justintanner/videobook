import type { Engine } from "videobook-engine";

// Fetch `url`, write the response bytes to the given asset file, and return
// the buffer for callers that need it (e.g. for content-hash provenance).
// `options.kind` only changes the error-message wording.
export async function downloadUrlIntoAsset(
  fs: Engine,
  url: string,
  assetId: string,
  filename: string,
  projectSlug: string,
  options: { kind?: string; fetchInit?: RequestInit } = {},
): Promise<Buffer> {
  const response = await fetch(url, options.fetchInit);
  if (!response.ok) {
    throw new Error(
      `Failed to download ${options.kind ?? "file"}: ${response.status} ${response.statusText}`,
    );
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const written = await fs.files.write(
    assetId,
    filename,
    buffer,
    projectSlug,
  );
  if (!written.ok) {
    throw new Error(
      `Failed to persist ${options.kind ?? "file"}: ${written.error.message}`,
    );
  }
  return buffer;
}
