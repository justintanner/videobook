import type { Engine, Artifact, ArtifactKind } from "videobook-engine";
import * as path from "node:path";
import { queue } from "../queue.js";

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".avi", ".mkv"]);
const AUDIO_EXTENSIONS = new Set([
  ".mp3",
  ".wav",
  ".aac",
  ".flac",
  ".ogg",
  ".m4a",
  ".weba",
]);
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg"]);
const SCRIPT_EXTENSIONS = new Set([".md"]);

// process_image writes these alongside an original image. Their presence is
// proof that processing already ran, so the upload sweep must never promote
// one of them to `original.{ext}` — that's how a portrait PNG gets cropped
// into a 1920x1080 landscape JPG when the sweep races a missing
// native processing metadata.
const IMAGE_VARIANT_FILENAMES = new Set(["landscape.jpg", "portrait.jpg", "square.jpg"]);

type UploadMediaType = "video" | "image" | "audio" | "script";

export type UnprocessedUpload = {
  assetId: string;
  assetDir: string;
  mediaFilename: string;
  extension: string;
  mediaType: UploadMediaType;
};

// The asset id prefix is authoritative for type — a vid- asset with a
// promoted OG thumbnail (original.jpg) must not be classified as an image
// upload just because the .jpg sorts before the .mp4. Returns null for asset
// types that aren't candidates for the upload sweep (character/final/plan).
function uploadShapeFor(type: ArtifactKind): { mediaType: UploadMediaType; extensions: Set<string> } | null {
  switch (type) {
    case "video": return { mediaType: "video", extensions: VIDEO_EXTENSIONS };
    case "audio": return { mediaType: "audio", extensions: AUDIO_EXTENSIONS };
    case "image": return { mediaType: "image", extensions: IMAGE_EXTENSIONS };
    case "script": return { mediaType: "script", extensions: SCRIPT_EXTENSIONS };
    default: return null;
  }
}

export async function findUnprocessedUploads(
  fs: Engine,
  bookId: string,
  assets: Artifact[],
): Promise<UnprocessedUpload[]> {
  const results = await Promise.all(
    assets.map(async (asset): Promise<UnprocessedUpload | null> => {
      if (asset.slug === "final") return null;
      const shape = uploadShapeFor(asset.kind);
      if (!shape) return null;

      // Parallelize the independent disk/db reads — each was ~5-20ms serially,
      // multiplied by every asset on every sync.
      const [manifest, originResult, locked, work] = await Promise.all([
        fs.files.manifest(asset.slug),
        fs.metadata.artifacts.read(asset.slug, "original"),
        fs.jobs.locks.isLocked(asset.path),
        fs.jobs.artifactWork.read(bookId),
      ]);
      if (!manifest.ok) return null;
      if (originResult.ok) return null;
      // Skip assets currently held by another job (splice/trim/render mid-write).
      // Otherwise the sweep races the in-flight ffmpeg writing original.mp4 and
      // hands a half-written file to process_video, producing a spurious
      // runtime failure before the real owner finishes.
      if (locked) return null;
      // Skip assets that already have an active job or a terminal failure.
      // 'pending'/'working' WITH meta.kind = the upload's own process_video is
      // already enqueued or in-flight — racing it produces duplicate jobs that
      // re-run the full transcode pipeline (or, with the legacy delete-source
      // flow, fail with "ffprobe missing original.mkv"). 'error' = a prior run
      // failed and nothing has cleared the row; re-enqueuing without recovery
      // just spins (the engine's lease guard rejects new work until the row
      // is cleared via /clear-failed-tasks or equivalent).
      //
      // A 'pending' row with no meta.kind is the placeholder createAsset
      // writes as a 5-minute cleanup marker — that's the exact case the
      // sweep needs to pick up, not skip.
      if (work.ok && work.value) {
        const { status, meta } = work.value;
        if (status === "error") return null;
        if ((status === "pending" || status === "working") && meta.kind != null) return null;
      }

      // Prefer a literal `original.{ext}` first — that's the canonical shape
      // produced by upload-file and processExternalUpload itself. Only fall
      // back to an arbitrary-name file (user dragged "photo.png" straight
      // into the asset folder) when no `original.*` exists AND no
      // process_image variant exists. Without that variant guard, missing
      // processing metadata would cause the sweep to pick the alphabetically
      // first variant (landscape.jpg) and rename it to original.jpg.
      let mediaFile = manifest.value.files.find((f) => {
        const ext = path.extname(f.name).toLowerCase();
        return shape.extensions.has(ext) && f.name === `original${ext}`;
      });
      if (!mediaFile) {
        const hasImageVariant = shape.mediaType === "image"
          && manifest.value.files.some((f) => IMAGE_VARIANT_FILENAMES.has(f.name));
        if (hasImageVariant) return null;
        mediaFile = manifest.value.files.find((f) => {
          const ext = path.extname(f.name).toLowerCase();
          return shape.extensions.has(ext);
        });
      }
      if (!mediaFile) return null;

      const ext = path.extname(mediaFile.name).toLowerCase();

      return {
        assetId: asset.slug,
        assetDir: asset.path,
        mediaFilename: mediaFile.name,
        extension: ext,
        mediaType: shape.mediaType,
      };
    })
  );
  return results.filter((u): u is UnprocessedUpload => u !== null);
}

export async function processExternalUpload(
  fs: Engine,
  upload: UnprocessedUpload,
  bookId: string,
): Promise<void> {
  const targetFilename = `original${upload.extension}`;

  if (upload.mediaFilename !== targetFilename) {
    await fs.files.rename(upload.assetId, upload.mediaFilename, targetFilename);
  }

  await fs.jobs.failures.clear(upload.assetId);

  const provenance = { origin: "external", processed_at: new Date().toISOString() };
  if (upload.mediaType === "video") {
    const videoPath = path.join(upload.assetDir, targetFilename);
    const jobId = `process-video-${upload.assetId}-${Date.now()}`;
    await queue.enqueue(jobId, {
      type: "process_video",
      videoPath,
      assetId: upload.assetId,
      assetDir: upload.assetDir,
      bookId,
      provenance,
    } as unknown as Record<string, unknown>);
  } else if (upload.mediaType === "image") {
    const jobId = `process-image-${upload.assetId}-${Date.now()}`;
    await queue.enqueue(jobId, {
      type: "process_image",
      assetId: upload.assetId,
      bookId,
      extension: upload.extension,
      provenance,
    } as unknown as Record<string, unknown>);
  } else if (upload.mediaType === "audio") {
    const audioPath = path.join(upload.assetDir, targetFilename);
    const jobId = `process-audio-${upload.assetId}-${Date.now()}`;
    await queue.enqueue(jobId, {
      type: "process_audio",
      audioPath,
      sourceFilename: targetFilename,
      assetId: upload.assetId,
      assetDir: upload.assetDir,
      bookId,
      provenance,
    } as unknown as Record<string, unknown>);
  } else {
    await fs.metadata.artifacts.write(upload.assetId, "original", provenance);
  }
}
