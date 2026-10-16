import type { Engine, ArtifactManifestFile } from "videobook-engine";
import { findAudioFile, findVideoFile } from "videobook-engine";
import { extname } from "node:path";

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "bmp", "tif", "tiff", "gif"]);

function findImageFile(files: ArtifactManifestFile[]): ArtifactManifestFile | null {
  const images = files.filter((f) => {
    const ext = (f.extension ?? extname(f.name)).replace(/^\./, "").toLowerCase();
    return IMAGE_EXTENSIONS.has(ext);
  });
  return images.find((f) => f.name.startsWith("original")) ?? images[0] ?? null;
}

export type RefInput = { assetId: string; filename: string };

type ResolveOk = { ok: true; value: RefInput };
type ResolveErr = { ok: false; error: string };

export async function resolveImageRef(engine: Engine, raw: string): Promise<ResolveOk | ResolveErr> {
  const assetId = raw.replace(/^@/, "");
  const artifact = engine.artifacts.get(assetId);
  if (!artifact.ok) return { ok: false, error: artifact.error.message };
  if (artifact.value.kind !== "image") {
    return { ok: false, error: `image ref must be an image artifact, got ${artifact.value.kind}: ${assetId}` };
  }
  const manifest = await engine.files.manifest(assetId);
  if (!manifest.ok) return { ok: false, error: manifest.error.message };
  const file = findImageFile(manifest.value.files);
  if (!file) return { ok: false, error: `No image file found in asset ${assetId}` };
  return { ok: true, value: { assetId, filename: file.name } };
}

// `@<assetId>/<filename>` addresses a specific sibling file inside an
// asset. Used by plan-driven render (e.g. `@plan/s1.mp4`); bypasses the
// artifact-kind gate since the destination asset may hold multiple media
// files of mixed kinds.
async function resolveSlashedRef(
  engine: Engine,
  raw: string,
): Promise<ResolveOk | ResolveErr | null> {
  const stripped = raw.replace(/^@/, "");
  const slashIdx = stripped.indexOf("/");
  if (slashIdx < 0) return null;
  const assetId = stripped.slice(0, slashIdx);
  const filename = stripped.slice(slashIdx + 1);
  if (!assetId || !filename) return { ok: false, error: `Invalid slashed ref: ${raw}` };
  const manifest = await engine.files.manifest(assetId);
  if (!manifest.ok) return { ok: false, error: manifest.error.message };
  const file = manifest.value.files.find((f) => f.name === filename);
  if (!file) return { ok: false, error: `File ${filename} not found in asset ${assetId}` };
  return { ok: true, value: { assetId, filename } };
}

export async function resolveVideoRef(engine: Engine, raw: string): Promise<ResolveOk | ResolveErr> {
  const slashed = await resolveSlashedRef(engine, raw);
  if (slashed !== null) return slashed;
  const assetId = raw.replace(/^@/, "");
  const artifact = engine.artifacts.get(assetId);
  if (!artifact.ok) return { ok: false, error: artifact.error.message };
  if (artifact.value.kind !== "video") {
    return { ok: false, error: `video ref must be a video artifact, got ${artifact.value.kind}: ${assetId}` };
  }
  const manifest = await engine.files.manifest(assetId);
  if (!manifest.ok) return { ok: false, error: manifest.error.message };
  const file = findVideoFile(manifest.value.files);
  if (!file) return { ok: false, error: `No video file found in asset ${assetId}` };
  return { ok: true, value: { assetId, filename: file.name } };
}

// Audio replacement always targets a first-class audio artifact. Notebook
// cells reference artifact identities; they do not expose nested file paths.
export async function resolveAudioRef(engine: Engine, raw: string): Promise<ResolveOk | ResolveErr> {
  const assetId = raw.replace(/^@/, "");
  const artifact = engine.artifacts.get(assetId);
  if (!artifact.ok) return { ok: false, error: artifact.error.message };
  if (artifact.value.kind !== "audio") {
    return { ok: false, error: `audio ref must be an audio artifact, got ${artifact.value.kind}: ${assetId}` };
  }
  const manifest = await engine.files.manifest(assetId);
  if (!manifest.ok) return { ok: false, error: manifest.error.message };
  const file = findAudioFile(manifest.value.files, "audio");
  if (!file) return { ok: false, error: `No audio file found in asset ${assetId}` };
  return { ok: true, value: { assetId, filename: file.name } };
}
