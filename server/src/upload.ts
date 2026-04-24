import { free } from "@apicity/free";
import { createHash } from "node:crypto";
import type { ClipfirstFs } from "clipfirst-fs";
import { maybeReencodeImage, maybeUpscaleSmallImage } from "./image-compress.js";

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

export function inferMimeType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  return (ext && MIME_TYPES[ext]) ?? "application/octet-stream";
}

type UploadAttempt = { host: string; upload: () => Promise<string> };

function shuffle<T>(arr: T[]): T[] {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// Upload bytes to a free file host and return a publicly accessible download
// URL. Rotation picks a random order across litterbox/uguu/tflink on each call
// and returns the first success.
//
// Host selection matters: Alibaba/Kie workers run in China and synchronously
// fetch the URL server-side during data inspection. Several otherwise-fine
// hosts (catbox.moe, filebin.net, temp.sh, tmpfiles.org) are unreachable or
// mis-typed from that side and cause InvalidParameter.DataInspection 400s
// even when the upload itself succeeded. The three hosts below were verified
// end-to-end (upload OK + Alibaba submit accepted).
export async function uploadBytesToFreeHost(
  data: Uint8Array | Buffer,
  filename: string,
): Promise<string> {
  const mimeType = inferMimeType(filename);
  const blob = new Blob([new Uint8Array(data)], { type: mimeType });
  const file = new File([blob], filename, { type: mimeType });

  const f = free();
  const attempts: UploadAttempt[] = [
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
    {
      host: "tflink",
      upload: async () => {
        const res = await f.tflink.upload({ file, filename });
        return res.downloadLink;
      },
    },
  ];

  const failures: string[] = [];
  for (const { host, upload } of shuffle(attempts)) {
    try {
      return await upload();
    } catch (err) {
      failures.push(`${host}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(`All upload hosts failed — ${failures.join(" | ")}`);
}

// Back-compat alias for callers that still reach into the free-host path
// directly (e.g. provider-agnostic helpers). New code should prefer the
// provider-specific `uploadAssetTo{Fal,Kie,Alibaba}` wrappers which try the
// provider's native endpoint first.
export const uploadBytes = uploadBytesToFreeHost;

// Read an asset, optionally re-encode it, and hash its final bytes for use as
// a collision-free remote filename. Shared preamble for every provider-native
// upload wrapper.
export async function prepareAssetForUpload(
  fs: ClipfirstFs,
  assetId: string,
  filename: string,
  projectSlug: string,
): Promise<{ data: Uint8Array; hashedFilename: string; contentType: string }> {
  const readResult = await fs.readFile(assetId, filename, projectSlug);
  if (!readResult.ok) throw new Error(readResult.error.message);
  const raw = new Uint8Array(readResult.value);
  const reencoded = await maybeReencodeImage(raw, filename);
  const { data, filename: outName } = await maybeUpscaleSmallImage(reencoded.data, reencoded.filename);

  const ext = outName.split(".").pop() ?? "bin";
  const hashedFilename = `${contentHash(data)}.${ext}`;
  const contentType = inferMimeType(outName);

  return { data, hashedFilename, contentType };
}

// Upload an asset file via the free-host rotation. Kept for
// provider-agnostic callers (e.g. `transcribe.ts`) that don't target a
// specific AI provider. Provider-specific jobs should call the matching
// `uploadAssetTo{Fal,Kie,Alibaba}` wrapper instead.
export async function uploadAssetFile(
  fs: ClipfirstFs,
  assetId: string,
  filename: string,
  projectSlug: string,
): Promise<string> {
  const { data, hashedFilename } = await prepareAssetForUpload(fs, assetId, filename, projectSlug);
  return uploadBytesToFreeHost(data, hashedFilename);
}
