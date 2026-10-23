import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Engine } from "videobook-engine";
import { queue } from "../queue.js";
import { contentHash } from "../upload.js";
import { probeVideo, runFfmpeg } from "../ffmpeg.js";
import type { ProviderOutput } from "./adapters/types.js";
import type { Media } from "./types.js";
import { record } from "./adapters/pending.js";

export interface MediaCompletion {
  engine: Engine;
  assetId: string;
  assetDir: string;
  bookId: string;
  meta: Record<string, unknown>;
  outputs: ProviderOutput[];
}

interface Downloaded {
  bytes: Buffer;
  extension: string;
  url?: string;
}

const EXTENSIONS: Record<Media, readonly string[]> = {
  image: ["png", "jpg", "jpeg", "webp"],
  video: ["mp4", "mov", "webm"],
  audio: ["mp3", "wav", "ogg", "opus", "flac", "m4a", "aac"],
};

const FALLBACK_EXTENSION: Record<Media, string> = { image: "png", video: "mp4", audio: "mp3" };

function mediaOf(meta: Record<string, unknown>): Media {
  const media = meta.media;
  if (media === "image" || media === "video" || media === "audio") return media;
  throw new Error(`Media generation task is missing meta.media`);
}

function extensionFromUrl(url: string, media: Media): string | null {
  try {
    const match = /\.([a-z0-9]{2,5})$/i.exec(new URL(url).pathname);
    const extension = match?.[1]?.toLowerCase();
    return extension && EXTENSIONS[media].includes(extension) ? extension : null;
  } catch {
    return null;
  }
}

function extensionFromContentType(contentType: string | null, media: Media): string | null {
  const subtype = contentType?.split(";")[0]?.split("/")[1]?.toLowerCase();
  if (!subtype) return null;
  const normalized = subtype === "mpeg" ? "mp3" : subtype === "quicktime" ? "mov" : subtype === "x-wav" ? "wav" : subtype;
  return EXTENSIONS[media].includes(normalized) ? normalized : null;
}

async function download(output: ProviderOutput, media: Media): Promise<Downloaded> {
  if ("bytes" in output) return { bytes: output.bytes, extension: output.extension, ...(output.url ? { url: output.url } : {}) };
  const response = await fetch(output.url);
  if (!response.ok) throw new Error(`Failed to download generated ${media}: ${response.status} ${response.statusText}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0) throw new Error(`Generated ${media} download was empty`);
  const extension = extensionFromUrl(output.url, media)
    ?? extensionFromContentType(response.headers.get("content-type"), media)
    ?? FALLBACK_EXTENSION[media];
  return { bytes, extension, url: output.url };
}

function provenance(meta: Record<string, unknown>, file: Downloaded): Record<string, unknown> {
  return {
    model: meta.model,
    prompt: meta.prompt,
    source_images: meta.sourceImageIds,
    source_videos: meta.sourceVideoIds,
    source_audios: meta.sourceAudioIds,
    ...(file.url ? { download_url: file.url } : {}),
    download_url_content_hash: contentHash(file.bytes),
    generated_at: new Date().toISOString(),
  };
}

async function writeOriginal(engine: Engine, assetId: string, filename: string, bytes: Buffer): Promise<void> {
  const written = await engine.files.write(assetId, filename, bytes);
  if (!written.ok) throw new Error(`Failed to write ${filename}: ${written.error.message}`);
}

async function completeImage(completion: MediaCompletion, file: Downloaded): Promise<void> {
  const extension = file.extension === "jpeg" ? "jpg" : file.extension;
  await writeOriginal(completion.engine, completion.assetId, `original.${extension}`, file.bytes);
  await queue.enqueue(`process-image-${completion.assetId}-${Date.now()}`, {
    type: "process_image",
    assetId: completion.assetId,
    bookId: completion.bookId,
    extension: `.${extension}`,
    provenance: provenance(completion.meta, file),
  });
}

async function enqueueReplaceAudio(completion: MediaCompletion, videoPath: string, origin: Record<string, unknown>): Promise<boolean> {
  const replace = record(completion.meta.replaceAudioWith);
  if (!replace || typeof replace.assetId !== "string" || typeof replace.filename !== "string") return false;
  const manifest = await completion.engine.files.manifest(replace.assetId);
  if (!manifest.ok) throw new Error(`replaceAudioWith asset not found: ${manifest.error.message}`);
  await queue.enqueue(`replace-audio-${completion.assetId}-${Date.now()}`, {
    type: "replace_video_audio",
    inputPath: videoPath,
    audioPath: join(manifest.value.path, replace.filename),
    outputPath: join(completion.assetDir, "original_audio_replaced.mp4"),
    assetId: completion.assetId,
    assetDir: completion.assetDir,
    audioAssetId: `${replace.assetId}/${replace.filename}`,
    bookId: completion.bookId,
    extraProvenance: origin,
  });
  return true;
}

async function completeVideo(completion: MediaCompletion, file: Downloaded): Promise<void> {
  const filename = `original.${file.extension}`;
  await writeOriginal(completion.engine, completion.assetId, filename, file.bytes);
  const videoPath = join(completion.assetDir, filename);
  const origin = provenance(completion.meta, file);
  if (await enqueueReplaceAudio(completion, videoPath, origin)) return;
  await queue.enqueue(`process-video-${completion.assetId}-${Date.now()}`, {
    type: "process_video",
    videoPath,
    assetId: completion.assetId,
    assetDir: completion.assetDir,
    bookId: completion.bookId,
    provenance: origin,
  });
}

async function toMp3(file: Downloaded): Promise<Buffer> {
  if (file.extension === "mp3") return file.bytes;
  const dir = await mkdtemp(join(tmpdir(), "videobook-media-audio-"));
  try {
    const input = join(dir, `input.${file.extension}`);
    const output = join(dir, "output.mp3");
    await writeFile(input, file.bytes);
    await runFfmpeg(["-y", "-i", input, "-c:a", "libmp3lame", "-q:a", "2", output]);
    return await readFile(output);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function probeDuration(path: string): Promise<number | undefined> {
  try {
    const probe = await probeVideo(path);
    return Number.isFinite(probe.duration) && probe.duration > 0 ? probe.duration : undefined;
  } catch {
    return undefined;
  }
}

async function completeAudio(completion: MediaCompletion, file: Downloaded): Promise<void> {
  await writeOriginal(completion.engine, completion.assetId, "original.mp3", await toMp3(file));
  const duration = await probeDuration(join(completion.assetDir, "original.mp3"));
  const metadata = {
    ...provenance(completion.meta, file),
    origin: "generate_audio",
    ...(duration !== undefined ? { duration } : {}),
  };
  const written = await completion.engine.metadata.artifacts.write(completion.assetId, "original", metadata);
  if (!written.ok) throw new Error(`Failed to write artifact metadata: ${written.error.message}`);
}

export async function completeMediaGeneration(completion: MediaCompletion): Promise<void> {
  const media = mediaOf(completion.meta);
  const output = completion.outputs[0];
  if (!output) throw new Error(`Provider returned no ${media}`);
  const file = await download(output, media);
  if (media === "image") return completeImage(completion, file);
  if (media === "video") return completeVideo(completion, file);
  return completeAudio(completion, file);
}

const URL_KEYS = ["video", "image", "audio", "audio_file", "images", "videos", "audios"];

function urlsIn(value: unknown): string[] {
  if (typeof value === "string") return /^https?:\/\//u.test(value) ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(urlsIn);
  const object = record(value);
  if (!object) return [];
  if (typeof object.url === "string") return [object.url];
  return URL_KEYS.flatMap((key) => urlsIn(object[key]));
}

export function providerResultUrls(resultUrls: readonly string[], resultObject: unknown): string[] {
  if (resultUrls.length > 0) return [...resultUrls];
  const object = record(resultObject);
  if (!object) return [];
  const direct = URL_KEYS.flatMap((key) => urlsIn(object[key]));
  if (direct.length > 0) return direct;
  for (const key of ["video_url", "image_url", "audio_url", "resultUrls"]) {
    const found = urlsIn(object[key]);
    if (found.length > 0) return found;
  }
  return [];
}
