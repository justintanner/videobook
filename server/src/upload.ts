import { free } from "@apicity/free";
import { createHash } from "node:crypto";
import type { ClipfirstFs } from "clipfirst-fs";

export function contentHash(data: Buffer | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

const MIME_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  avi: "video/x-msvideo",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  flac: "audio/flac",
  aac: "audio/aac",
  m4a: "audio/mp4",
};

function inferMimeType(filename: string): string | undefined {
  const ext = filename.split(".").pop()?.toLowerCase();
  return ext ? MIME_TYPES[ext] : undefined;
}

// Upload bytes to a free file host and return a publicly accessible download
// URL. Tries catbox → litterbox → uguu and returns the first success. We
// bypass Kie's own CDN because tempfile.redpandaai.co is periodically
// unreachable from Kie's own workers.
type UploadAttempt = { host: string; upload: () => Promise<string> };

export async function uploadBytes(data: Uint8Array | Buffer, filename: string): Promise<string> {
  const mimeType = inferMimeType(filename) ?? "application/octet-stream";
  const blob = new Blob([new Uint8Array(data)], { type: mimeType });
  const file = new File([blob], filename, { type: mimeType });

  const f = free();
  const attempts: UploadAttempt[] = [
    { host: "catbox", upload: () => f.catbox.upload({ file, filename }) },
    { host: "litterbox", upload: () => f.litterbox.upload({ file, filename, time: "1h" }) },
    {
      host: "uguu",
      upload: async () => {
        const res = await f.uguu.upload({ file, filename });
        const url = res.files[0]?.url;
        if (!url) throw new Error("uguu upload returned no URL");
        return url;
      },
    },
  ];

  const failures: string[] = [];
  for (const { host, upload } of attempts) {
    try {
      return await upload();
    } catch (err) {
      failures.push(`${host}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(`All upload hosts failed — ${failures.join(" | ")}`);
}

// Upload an asset file. The remote filename is derived from the file's
// SHA-256 hash so every distinct file lands at a unique path — this prevents
// cross-asset collisions where two assets with the same local filename
// (`original.mp4`) would otherwise overwrite each other.
export async function uploadAssetFile(
  fs: ClipfirstFs,
  assetId: string,
  filename: string,
  projectSlug: string,
): Promise<string> {
  const readResult = await fs.readFile(assetId, filename, projectSlug);
  if (!readResult.ok) throw new Error(readResult.error.message);
  const fileData = new Uint8Array(readResult.value);

  const ext = filename.split(".").pop() ?? "bin";
  const hashedFilename = `${contentHash(fileData)}.${ext}`;

  return uploadBytes(fileData, hashedFilename);
}
