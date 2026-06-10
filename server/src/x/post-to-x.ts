import type { VideocityFs } from "videocity-engine";
import { findPrimaryMediaFile } from "videocity-engine";
import { createX } from "@apicity/x";
import type { XProvider } from "@apicity/x";
import { extname, join } from "node:path";
import { tmpdir } from "node:os";
import { readFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { getValidAccessToken } from "./x-tokens.js";
import { appendXPostMetadata } from "./post-metadata.js";
import { AUDIO_OPTS, H264_MEDIUM, probeVideo, runFfmpeg } from "../ffmpeg.js";

const APPEND_CHUNK_BYTES = 4 * 1024 * 1024;
const STATUS_POLL_TIMEOUT_MS = 5 * 60_000;
const STATUS_POLL_MIN_INTERVAL_MS = 2_000;

interface MediaTypeInfo {
  mediaType:
    | "video/mp4"
    | "video/quicktime"
    | "image/jpeg"
    | "image/png"
    | "image/webp"
    | "image/gif";
  mediaCategory: "tweet_video" | "tweet_image" | "tweet_gif";
}

function inferMediaType(filename: string): MediaTypeInfo | null {
  const ext = extname(filename).toLowerCase();
  switch (ext) {
    case ".mp4":
      return { mediaType: "video/mp4", mediaCategory: "tweet_video" };
    case ".mov":
      return { mediaType: "video/quicktime", mediaCategory: "tweet_video" };
    case ".jpg":
    case ".jpeg":
      return { mediaType: "image/jpeg", mediaCategory: "tweet_image" };
    case ".png":
      return { mediaType: "image/png", mediaCategory: "tweet_image" };
    case ".webp":
      return { mediaType: "image/webp", mediaCategory: "tweet_image" };
    case ".gif":
      return { mediaType: "image/gif", mediaCategory: "tweet_gif" };
    default:
      return null;
  }
}

export type PostOrientation = "portrait" | "landscape";

export interface PostToXArgs {
  fs: VideocityFs;
  assetId: string;
  projectSlug: string;
  text?: string;
  orientation?: PostOrientation;
  scheduleId?: string;
  scheduledFor?: string;
  x?: XProvider;
  signal?: AbortSignal;
}

interface OrientationOutput {
  buffer: Buffer;
  tempPath: string;
  mediaType: "video/mp4";
}

async function maybeReorientVideo(
  inputPath: string,
  orientation: PostOrientation | undefined,
): Promise<OrientationOutput | null> {
  if (!orientation) return null;
  const probe = await probeVideo(inputPath);
  if (!probe.width || !probe.height) return null;
  const sourceMatches
    = orientation === "portrait"
      ? probe.height >= probe.width
      : probe.width >= probe.height;
  if (sourceMatches) return null;

  const targetW = orientation === "portrait" ? 1080 : 1920;
  const targetH = orientation === "portrait" ? 1920 : 1080;
  const filter
    = `scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease,`
    + `pad=${targetW}:${targetH}:(ow-iw)/2:(oh-ih)/2:black,setsar=1`;
  const tempPath = join(tmpdir(), `videocity-orient-${randomUUID()}.mp4`);
  const args = [
    "-y",
    "-i",
    inputPath,
    "-vf",
    filter,
    ...H264_MEDIUM,
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
  ];
  if (probe.hasAudio) args.push(...AUDIO_OPTS);
  else args.push("-an");
  args.push(tempPath);

  await runFfmpeg(args);
  const buffer = await readFile(tempPath);
  return { buffer, tempPath, mediaType: "video/mp4" };
}

export interface PostToXResult {
  tweet_id: string;
  tweet_url: string;
  media_id: string;
  posted_at: string;
}

function tweetUrl(id: string): string {
  return `https://x.com/i/web/status/${id}`;
}

async function getXClient(injected?: XProvider): Promise<XProvider> {
  if (injected) return injected;
  const accessToken = await getValidAccessToken();
  return createX({ accessToken });
}

async function uploadMedia(
  x: XProvider,
  buffer: Buffer,
  info: MediaTypeInfo,
  signal?: AbortSignal,
): Promise<string> {
  const initRes = await x.post.v2.media.upload.initialize(
    {
      media_type: info.mediaType,
      total_bytes: buffer.byteLength,
      media_category: info.mediaCategory,
    },
    signal,
  );
  const mediaId = initRes.data.id;

  const totalChunks = Math.max(1, Math.ceil(buffer.byteLength / APPEND_CHUNK_BYTES));
  for (let i = 0; i < totalChunks; i++) {
    const start = i * APPEND_CHUNK_BYTES;
    const end = Math.min(buffer.byteLength, start + APPEND_CHUNK_BYTES);
    const chunk = buffer.subarray(start, end);
    const blob = new Blob([Uint8Array.from(chunk)], { type: info.mediaType });
    await x.post.v2.media.upload.append(
      mediaId,
      { media: blob, segment_index: i },
      signal,
    );
  }

  const finalizeRes = await x.post.v2.media.upload.finalize(mediaId, signal);
  await waitForProcessing(x, mediaId, finalizeRes.data.processing_info, signal);
  return mediaId;
}

async function waitForProcessing(
  x: XProvider,
  mediaId: string,
  initial: { state: string; check_after_secs?: number; error?: { message?: string } } | undefined,
  signal?: AbortSignal,
): Promise<void> {
  if (!initial) return;
  if (initial.state === "succeeded") return;
  if (initial.state === "failed") {
    throw new Error(
      `X media processing failed: ${initial.error?.message ?? "unknown"}`,
    );
  }

  const deadline = Date.now() + STATUS_POLL_TIMEOUT_MS;
  let next = initial;
  while (next.state === "pending" || next.state === "in_progress") {
    if (Date.now() > deadline) {
      throw new Error(
        `X media processing timed out after ${STATUS_POLL_TIMEOUT_MS}ms`,
      );
    }
    const waitSecs = Math.max(
      STATUS_POLL_MIN_INTERVAL_MS / 1000,
      next.check_after_secs ?? 2,
    );
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, waitSecs * 1000);
      if (signal) {
        const onAbort = () => {
          clearTimeout(t);
          reject(new Error("Aborted"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
    const status = await x.get.v2.media.upload(mediaId, signal);
    const info = status.data.processing_info;
    if (!info) return;
    next = info;
  }

  if (next.state !== "succeeded") {
    throw new Error(
      `X media processing failed: ${next.error?.message ?? next.state}`,
    );
  }
}

export async function postToX(args: PostToXArgs): Promise<PostToXResult> {
  const {
    fs,
    assetId,
    projectSlug,
    text,
    orientation,
    scheduleId,
    scheduledFor,
    signal,
  } = args;

  const manifestResult = await fs.getManifest(assetId, projectSlug);
  if (!manifestResult.ok) {
    throw new Error(`Asset ${assetId} not found: ${manifestResult.error.message}`);
  }
  const manifest = manifestResult.value;
  const file = findPrimaryMediaFile(manifest.files, assetId);
  if (!file) {
    throw new Error(`Asset ${assetId} has no primary media file to post`);
  }
  let info = inferMediaType(file.name);
  if (!info) {
    throw new Error(
      `Cannot post asset ${assetId}: unsupported media file ${file.name}`,
    );
  }

  let buffer: Buffer;
  let tempPath: string | null = null;
  if (orientation && info.mediaCategory === "tweet_video") {
    const inputPath = join(manifest.path, file.name);
    const transformed = await maybeReorientVideo(inputPath, orientation);
    if (transformed) {
      buffer = transformed.buffer;
      tempPath = transformed.tempPath;
      info = { mediaType: transformed.mediaType, mediaCategory: "tweet_video" };
    } else {
      const readResult = await fs.readFile(assetId, file.name, projectSlug);
      if (!readResult.ok) {
        throw new Error(`Failed to read ${file.name}: ${readResult.error.message}`);
      }
      buffer = readResult.value;
    }
  } else {
    const readResult = await fs.readFile(assetId, file.name, projectSlug);
    if (!readResult.ok) {
      throw new Error(`Failed to read ${file.name}: ${readResult.error.message}`);
    }
    buffer = readResult.value;
  }

  let mediaId: string;
  try {
    const x = await getXClient(args.x);
    mediaId = await uploadMedia(x, buffer, info, signal);

    const tweetRes = await x.post.v2.tweets(
      {
        ...(text !== undefined && text.length > 0 ? { text } : {}),
        media: { media_ids: [mediaId] },
      },
      signal,
    );

    const tweetId = tweetRes.data.id;
    const postedAt = new Date().toISOString();

    try {
      await appendXPostMetadata({
        fs,
        assetId,
        projectSlug,
        entry: {
          tweet_id: tweetId,
          tweet_url: tweetUrl(tweetId),
          posted_at: postedAt,
          media_id: mediaId,
          text: text !== undefined && text.length > 0 ? text : null,
          scheduled_for: scheduledFor ?? null,
          schedule_id: scheduleId ?? null,
        },
      });
    } catch (err) {
      console.error(
        `[post_to_x] tweet ${tweetId} succeeded but writing .post.x.json failed:`,
        err instanceof Error ? err.message : err,
      );
    }

    return {
      tweet_id: tweetId,
      tweet_url: tweetUrl(tweetId),
      media_id: mediaId,
      posted_at: postedAt,
    };
  } finally {
    if (tempPath) {
      await unlink(tempPath).catch(() => {
        /* best-effort cleanup */
      });
    }
  }
}
