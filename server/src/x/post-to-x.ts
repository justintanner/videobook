import type { Engine } from "videobook-engine";
import { findPrimaryMediaFile } from "videobook-engine";
import { createX } from "@apicity/x";
import type { XProvider } from "@apicity/x";
import { extname, join } from "node:path";
import { tmpdir } from "node:os";
import { readFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { getValidAccessToken } from "./x-tokens.js";
import {
  readXAccount,
  X_POST_MAX_CHARACTERS,
  xPostMaxCharacters,
} from "./account.js";
import type { ApplicationStateStore } from "../app-state.js";
import { createPublishedPostCell } from "./published-post-cell.js";
import { appendXPostMetadata } from "./post-metadata.js";
import { AUDIO_OPTS, H264_MEDIUM, probeVideo, runFfmpeg } from "../ffmpeg.js";
import { logger } from "../logger.js";
import type {
  PostToXResult,
  XPostFollowup,
  XPostFollowupError,
  XPostReplyResult,
} from "./post-contract.js";

export type { PostToXResult } from "./post-contract.js";

const APPEND_CHUNK_BYTES = 4 * 1024 * 1024;
const STATUS_POLL_TIMEOUT_MS = 5 * 60_000;
export const STATUS_POLL_MIN_INTERVAL_MS = 2_000;

type StatusPollSleepFn = (ms: number, signal?: AbortSignal) => Promise<void>;

async function defaultStatusPollSleep(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (!signal) return;
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error("Aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

let statusPollSleep: StatusPollSleepFn = defaultStatusPollSleep;

export function configureXStatusPollForTests(options: {
  sleep?: StatusPollSleepFn;
} | null): void {
  statusPollSleep = options?.sleep ?? defaultStatusPollSleep;
}

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

type PostOrientation = "portrait" | "landscape";

interface PostToXArgs {
  engine: Engine;
  assetId: string;
  bookId: string;
  text?: string;
  orientation?: PostOrientation;
  scheduleId?: string;
  scheduledFor?: string;
  followups?: XPostFollowup[];
  x?: XProvider;
  signal?: AbortSignal;
  /** Where the connected account's subscription tier is cached. */
  store?: ApplicationStateStore;
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

function tweetUrl(id: string): string {
  return `https://x.com/i/web/status/${id}`;
}

interface PreparedMedia {
  assetId: string;
  buffer: Buffer;
  info: MediaTypeInfo;
  tempPath: string | null;
}

async function prepareMedia(
  engine: Engine,
  assetId: string,
  orientation?: PostOrientation,
): Promise<PreparedMedia> {
  const artifactResult = engine.artifacts.get(assetId);
  if (!artifactResult.ok) {
    throw new Error(`Asset ${assetId} not found: ${artifactResult.error.message}`);
  }
  const manifestResult = await engine.files.manifest(assetId);
  if (!manifestResult.ok) {
    throw new Error(`Asset ${assetId} not found: ${manifestResult.error.message}`);
  }
  const manifest = manifestResult.value;
  const file = findPrimaryMediaFile(manifest.files, artifactResult.value.kind);
  if (!file) {
    throw new Error(`Asset ${assetId} has no primary media file to post`);
  }
  const info = inferMediaType(file.name);
  if (!info) {
    throw new Error(
      `Cannot post asset ${assetId}: unsupported media file ${file.name}`,
    );
  }

  if (orientation && info.mediaCategory === "tweet_video") {
    const transformed = await maybeReorientVideo(
      join(manifest.path, file.name),
      orientation,
    );
    if (transformed) {
      return {
        assetId,
        buffer: transformed.buffer,
        info: { mediaType: transformed.mediaType, mediaCategory: "tweet_video" },
        tempPath: transformed.tempPath,
      };
    }
  }

  const readResult = await engine.files.read(assetId, file.name);
  if (!readResult.ok) {
    throw new Error(`Failed to read ${file.name}: ${readResult.error.message}`);
  }
  return { assetId, buffer: readResult.value, info, tempPath: null };
}

interface PreparedFollowup {
  text?: string;
  media: PreparedMedia[];
}

/**
 * The post length the connected account allows. Text within the standard 280
 * needs no lookup; anything longer is checked against the cached tier, since
 * only X Premium accounts may post up to 25,000 characters.
 */
async function postCharacterLimit(
  text: string,
  followups: readonly XPostFollowup[],
  store?: ApplicationStateStore,
): Promise<number> {
  const longest = Math.max(
    text.length,
    ...followups.map((followup) => followup.text?.length ?? 0),
  );
  if (longest <= X_POST_MAX_CHARACTERS) return X_POST_MAX_CHARACTERS;
  const account = await readXAccount(store);
  return xPostMaxCharacters(account?.subscription_type ?? null);
}

function characterLimitError(label: string, maxCharacters: number): Error {
  const hint = maxCharacters === X_POST_MAX_CHARACTERS
    ? " (longer posts need an X Premium subscription)"
    : "";
  return new Error(`${label} exceeds ${maxCharacters} characters${hint}`);
}

async function prepareFollowups(
  engine: Engine,
  followups: readonly XPostFollowup[],
  maxCharacters: number,
): Promise<PreparedFollowup[]> {
  if (followups.length > 25) {
    throw new Error("X threads support at most 25 follow-up posts here");
  }
  const prepared: PreparedFollowup[] = [];
  for (const [index, followup] of followups.entries()) {
    const text = followup.text?.trim() ? followup.text : undefined;
    const assetIds = followup.image_asset_ids ?? [];
    if (!text && assetIds.length === 0) {
      throw new Error(`Follow-up ${index + 1} needs text or an image`);
    }
    if ((followup.text?.length ?? 0) > maxCharacters) {
      throw characterLimitError(`Follow-up ${index + 1}`, maxCharacters);
    }
    if (assetIds.length > 4) {
      throw new Error(`Follow-up ${index + 1} has more than 4 images`);
    }
    const media = await Promise.all(assetIds.map(async (sourceAssetId) =>
      await prepareMedia(engine, sourceAssetId)));
    if (media.some((item) => item.info.mediaCategory === "tweet_video")) {
      throw new Error(`Follow-up ${index + 1} attachments must be images`);
    }
    const gifs = media.filter((item) => item.info.mediaCategory === "tweet_gif");
    if (gifs.length > 0 && media.length > 1) {
      throw new Error(`Follow-up ${index + 1} can attach one GIF or up to four photos`);
    }
    prepared.push({ ...(text ? { text } : {}), media });
  }
  return prepared;
}

async function getXClient(
  _fs: Engine,
  injected?: XProvider,
): Promise<XProvider> {
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
    await statusPollSleep(waitSecs * 1000, signal);
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
    engine,
    assetId,
    text,
    orientation,
    scheduleId,
    scheduledFor,
    followups = [],
    signal,
  } = args;
  if (!text?.trim()) throw new Error("A post title is required");
  const maxCharacters = await postCharacterLimit(text, followups, args.store);
  if (text.length > maxCharacters) {
    throw characterLimitError("Post title", maxCharacters);
  }
  const rootMedia = await prepareMedia(engine, assetId, orientation);
  try {
    const preparedFollowups = await prepareFollowups(engine, followups, maxCharacters);
    const x = await getXClient(engine, args.x);
    const mediaId = await uploadMedia(
      x,
      rootMedia.buffer,
      rootMedia.info,
      signal,
    );
    const uploadedFollowups: Array<{
      text?: string;
      mediaIds: string[];
    }> = [];
    for (const followup of preparedFollowups) {
      const mediaIds: string[] = [];
      for (const media of followup.media) {
        mediaIds.push(await uploadMedia(x, media.buffer, media.info, signal));
      }
      uploadedFollowups.push({
        ...(followup.text ? { text: followup.text } : {}),
        mediaIds,
      });
    }

    const tweetRes = await x.post.v2.tweets(
      { text, media: { media_ids: [mediaId] } },
      signal,
    );

    const tweetId = tweetRes.data.id;
    const postedAt = new Date().toISOString();
    const replies: XPostReplyResult[] = [];
    let parentTweetId = tweetId;
    let followupError: XPostFollowupError | null = null;
    for (const [index, followup] of uploadedFollowups.entries()) {
      try {
        const replyRes = await x.post.v2.tweets(
          {
            ...(followup.text ? { text: followup.text } : {}),
            ...(followup.mediaIds.length > 0
              ? { media: { media_ids: followup.mediaIds } }
              : {}),
            reply: { in_reply_to_tweet_id: parentTweetId },
          },
          signal,
        );
        const replyId = replyRes.data.id;
        const replyResult: XPostReplyResult = {
          tweet_id: replyId,
          tweet_url: tweetUrl(replyId),
          media_ids: followup.mediaIds,
          text: followup.text ?? null,
          posted_at: new Date().toISOString(),
        };
        replies.push(replyResult);
        parentTweetId = replyId;
      } catch (cause) {
        followupError = {
          reply_number: index + 1,
          message: cause instanceof Error ? cause.message : String(cause),
        };
        break;
      }
    }
    const status = followupError ? "partially_posted" : "posted";

    try {
      await appendXPostMetadata({
        engine,
        assetId,
        entry: {
          tweet_id: tweetId,
          tweet_url: tweetUrl(tweetId),
          posted_at: postedAt,
          media_id: mediaId,
          text,
          scheduled_for: scheduledFor ?? null,
          schedule_id: scheduleId ?? null,
          status,
          replies,
          followup_error: followupError,
        },
      });
    } catch (err) {
      logger.error(
        `[post_to_x] tweet ${tweetId} succeeded but writing .post.x.json failed:`,
        err instanceof Error ? err.message : err,
      );
    }

    const posted: PostToXResult = {
      status,
      tweet_id: tweetId,
      tweet_url: tweetUrl(tweetId),
      media_id: mediaId,
      posted_at: postedAt,
      replies,
      followup_error: followupError,
    };
    try {
      const created = await createPublishedPostCell({
        engine,
        assetId,
        posted,
      });
      if (created) {
        posted.cell_id = created.cellId;
        posted.cell_address = created.cellAddress;
      }
    } catch (err) {
      posted.cell_error = err instanceof Error ? err.message : String(err);
      logger.error(
        `[post_to_x] tweet ${tweetId} succeeded but creating the published notebook cell failed:`,
        posted.cell_error,
      );
    }

    return posted;
  } finally {
    if (rootMedia.tempPath) {
      await unlink(rootMedia.tempPath).catch(() => undefined);
    }
  }
}
