import type { Engine } from "videobook-engine";
import { dirname, join } from "node:path";
import { chmod, copyFile, mkdtemp, rm, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { setTimeout as sleepFor } from "node:timers/promises";
import { YtDlp } from "ytdlp-nodejs";
import { ytdlpCookiesSetting, ytdlpImpersonateTargets, ytdlpRunOptions } from "../ytdlp-binary.js";
import { extractOpenGraph } from "@devmehq/open-graph-extractor";
import type { IOGResult } from "@devmehq/open-graph-extractor";
import { queue, registerJobHandler } from "../queue.js";
import { runFfmpeg, probeVideo, H264_MEDIUM, AUDIO_OPTS } from "../ffmpeg.js";
import { downloadUrlIntoAsset } from "./_download-into-asset.js";
import { withLockedLocalLease } from "./_lease.js";
import {
  ingestWorkspaceOutputs,
  replaceArtifactFileFromPath,
} from "./_persist-output.js";
import {
  assertSaneTrimOutput,
  trimRange,
  trimRangeExact,
} from "./trim-video.js";

const LOCK_DURATION_MS = 600_000;
const TIKTOK_DOWNLOAD_SPACING_MS = 5_000;
const YTDLP_RETRY_DELAYS_MS = [2_000, 4_000, 8_000];
const FAILURE_TAIL_CHARS = 240;

export const DOWNLOAD_FAILURE_METADATA_KEY = "download-failure";

export type DownloadFailureClass =
  | "private"
  | "removed"
  | "geo-blocked"
  | "login-required"
  | "unavailable"
  | "rate-limited"
  | "forbidden"
  | "server-error"
  | "network"
  | "error";

export interface DownloadFailure {
  class: DownloadFailureClass;
  reason: string;
  transient: boolean;
}

export interface YtdlpSession {
  readonly args: readonly string[];
  readonly attempts: number;
  run<T>(step: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

type DownloadSleep = (ms: number, signal?: AbortSignal) => Promise<void>;

const FAILURE_PATTERNS: ReadonlyArray<readonly [DownloadFailureClass, RegExp]> = [
  ["private", /\bprivate\b|permission to view/iu],
  ["removed", /\b(?:removed|deleted)\b|no longer available|HTTP Error 410/iu],
  ["geo-blocked", /geo[- ]?(?:restrict|block)|available (?:in|from) your (?:country|location|region)|IP address is blocked/iu],
  ["login-required", /\blog ?in\b|\bsign in\b|cookies/iu],
  ["unavailable", /(?:video|post|content|media)(?: is)? (?:not |un)available|not available|HTTP Error 404|Unsupported URL|No video formats found/iu],
  ["rate-limited", /HTTP Error 429|Too Many Requests|rate[- ]?limit/iu],
  ["forbidden", /HTTP Error 403|403 Forbidden/iu],
  ["server-error", /HTTP Error 5\d\d/iu],
  ["network", /timed out|timeout|connection (?:reset|refused|aborted)|remote end closed|name resolution|name or service not known|network is unreachable|no route to host|temporary failure|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|IncompleteRead|TransportError|curl: \(\d+\)/iu],
];

const TRANSIENT_FAILURES: ReadonlySet<DownloadFailureClass> = new Set(["rate-limited", "forbidden", "server-error", "network"]);

const tiktokTurns = new Map<string, number>();

function defaultDownloadSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return sleepFor(ms, undefined, { signal });
}

let downloadNow: () => number = Date.now;
let downloadSleep: DownloadSleep = defaultDownloadSleep;

export function configureDownloadClockForTests(options: {
  now?: () => number;
  sleep?: DownloadSleep;
} | null): void {
  downloadNow = options?.now ?? Date.now;
  downloadSleep = options?.sleep ?? defaultDownloadSleep;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failureTail(message: string): string {
  const text = message
    .replace(/^[\s\S]*yt-dlp exited with code -?\d+:\s*/u, "")
    .replace(/;?\s*please report this issue[\s\S]*$/iu, "")
    .replace(/\s+/gu, " ")
    .trim();
  return text.length > FAILURE_TAIL_CHARS ? `…${text.slice(1 - FAILURE_TAIL_CHARS)}` : text;
}

export function classifyDownloadFailure(message: string): DownloadFailure {
  const failureClass = FAILURE_PATTERNS.find(([, pattern]) => pattern.test(message))?.[0] ?? "error";
  return {
    class: failureClass,
    reason: `${failureClass}: ${failureTail(message)}`,
    transient: TRANSIENT_FAILURES.has(failureClass),
  };
}

export function isTikTokUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "tiktok.com" || host.endsWith(".tiktok.com");
  } catch {
    return false;
  }
}

async function waitForTikTokTurn(bookId: string, signal?: AbortSignal): Promise<void> {
  const now = downloadNow();
  const start = Math.max(now, tiktokTurns.get(bookId) ?? now);
  tiktokTurns.set(bookId, start + TIKTOK_DOWNLOAD_SPACING_MS);
  if (start > now) await downloadSleep(start - now, signal);
}

async function stageCookiesCopy(): Promise<string | null> {
  const cookies = ytdlpCookiesSetting();
  if (!cookies?.readable) return null;
  const directory = await mkdtemp(join(tmpdir(), "videobook-ytdlp-"));
  const copy = join(directory, "cookies.txt");
  try {
    await copyFile(cookies.path, copy);
    await chmod(copy, 0o600);
    return copy;
  } catch {
    await rm(directory, { recursive: true, force: true });
    return null;
  }
}

export async function openYtdlpSession(input: {
  url: string;
  bookId: string;
  binaryPath: string;
  signal?: AbortSignal;
}): Promise<YtdlpSession> {
  const tiktok = isTikTokUrl(input.url);
  if (tiktok) await waitForTikTokTurn(input.bookId, input.signal);
  const impersonate = tiktok && (await ytdlpImpersonateTargets(input.binaryPath)).includes("chrome");
  const cookies = tiktok ? await stageCookiesCopy() : null;
  let attempts = 0;
  return {
    args: [
      ...(impersonate ? ["--impersonate", "chrome"] : []),
      ...(cookies ? ["--cookies", cookies] : []),
    ],
    get attempts() {
      return attempts;
    },
    async run<T>(step: () => Promise<T>): Promise<T> {
      attempts = 0;
      for (;;) {
        attempts += 1;
        try {
          return await step();
        } catch (error) {
          const delayMs = tiktok ? YTDLP_RETRY_DELAYS_MS[attempts - 1] : undefined;
          if (delayMs === undefined || !classifyDownloadFailure(errorMessage(error)).transient) throw error;
          await downloadSleep(delayMs, input.signal);
        }
      }
    },
    async close() {
      if (cookies) await rm(dirname(cookies), { recursive: true, force: true });
    },
  };
}

export async function fetchVideoInfo(ytdlp: YtDlp, url: string, session: YtdlpSession): Promise<InfoResult> {
  const result = await session.run(() => ytdlp
    .execBuilder(url)
    .options({ dumpSingleJson: true, flatPlaylist: true })
    .addArgs(...session.args)
    .exec());
  return JSON.parse(result.output) as InfoResult;
}

export async function downloadVideoFile(
  ytdlp: YtDlp,
  url: string,
  outputPath: string,
  playlistItem: number | undefined,
  session: YtdlpSession,
): Promise<void> {
  await session.run(() => ytdlp
    .download(url)
    .setOutputTemplate(outputPath)
    .addArgs("--merge-output-format", "mp4")
    .addArgs(...(playlistItem === undefined ? ["--no-playlist"] : ["--playlist-items", String(playlistItem)]))
    .addArgs(...session.args)
    .run());
}

async function recordDownloadFailure(
  engine: Engine,
  input: { assetId: string; url: string },
  error: unknown,
  attempts: number,
): Promise<Error> {
  const failure = classifyDownloadFailure(errorMessage(error));
  await engine.metadata.artifacts.write(input.assetId, DOWNLOAD_FAILURE_METADATA_KEY, {
    ...failure,
    attempts,
    url: input.url,
    failedAt: new Date().toISOString(),
  });
  return new Error(failure.reason, { cause: error });
}

async function clearDownloadFailure(engine: Engine, assetId: string): Promise<void> {
  const recorded = await engine.metadata.artifacts.read(assetId, DOWNLOAD_FAILURE_METADATA_KEY);
  if (recorded.ok) await engine.metadata.artifacts.delete(assetId, DOWNLOAD_FAILURE_METADATA_KEY);
}

async function withDownloadSession<T>(
  engine: Engine,
  input: { url: string; assetId: string; bookId: string; binaryPath: string; signal: AbortSignal },
  run: (session: YtdlpSession) => Promise<T>,
): Promise<T> {
  const session = await openYtdlpSession(input);
  try {
    const result = await run(session);
    await clearDownloadFailure(engine, input.assetId);
    return result;
  } catch (error) {
    if (input.signal.aborted) throw error;
    throw await recordDownloadFailure(engine, input, error, session.attempts);
  } finally {
    await session.close();
  }
}

// Hidden filename so a failed video download doesn't leave behind an
// `original.jpg` that sync's `findUnprocessedUploads` would pick up and
// process as if the asset were a successful image upload (origin "external").
const OG_IMAGE_FILENAME = ".opengraph.jpg";
const OG_PLATFORM_SUFFIX = / on (?:X|Twitter|Instagram|Facebook|YouTube|TikTok|Vimeo|Reddit|Twitch|Dailymotion)$/i;
const OG_HANDLE_PAREN = / \(@?\w+\)/g;

function cleanOgTitle(raw: string): string {
  return raw.replace(OG_PLATFORM_SUFFIX, "").replace(OG_HANDLE_PAREN, "").trim();
}

export async function validateDownloadOutput(outputPath: string): Promise<void> {
  const partPath = outputPath + ".part";

  let fileStat: { size: number } | null = null;
  try {
    fileStat = await stat(outputPath);
  } catch {
    // output file doesn't exist — check for leftover .part
  }

  if (fileStat) {
    if (fileStat.size === 0) {
      try { await unlink(outputPath); } catch { /* best-effort cleanup */ }
      throw new Error("Download produced an empty file");
    }
    // yt-dlp can finalize a non-empty mp4 that is structurally broken.
    // Probe the container so process_video doesn't get a non-decodable file.
    try {
      await probeVideo(outputPath);
    } catch (error) {
      try { await unlink(outputPath); } catch { /* best-effort cleanup */ }
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Download produced an unreadable video: ${msg}`);
    }
    return;
  }

  // Output file missing — check for .part file
  let hasPartFile = false;
  try {
    await stat(partPath);
    hasPartFile = true;
  } catch {
    // no .part file either
  }

  if (hasPartFile) {
    try { await unlink(partPath); } catch { /* best-effort cleanup */ }
    throw new Error("Download incomplete: only a partial .part file was found");
  }

  throw new Error("Download failed: output file was not created");
}

async function blurFillExport(
  inputPath: string,
  outputPath: string,
  targetWidth: number,
  targetHeight: number,
): Promise<void> {
  const filterComplex = [
    `[0:v]scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=increase,crop=${targetWidth}:${targetHeight},boxblur=20:5[bg]`,
    `[0:v]scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease[fg]`,
    `[bg][fg]overlay=(W-w)/2:(H-h)/2`,
  ].join(";");

  await runFfmpeg([
    "-y", "-i", inputPath,
    "-filter_complex", filterComplex,
    ...H264_MEDIUM, ...AUDIO_OPTS,
    outputPath,
  ]);
}

function extractOgImageUrl(ogImage: IOGResult["ogImage"]): string | null {
  if (!ogImage) return null;
  if (typeof ogImage === "string") return ogImage;
  if (Array.isArray(ogImage)) {
    const first = ogImage[0];
    if (!first) return null;
    if (typeof first === "string") return first;
    return typeof first === "object" && "url" in first ? (first.url as string) : null;
  }
  return typeof ogImage === "object" && "url" in ogImage ? (ogImage.url as string) : null;
}

async function readOpenGraphData(engine: Engine, assetId: string): Promise<IOGResult | null> {
  const result = await engine.files.read(assetId, ".opengraph.json");
  if (!result.ok) return null;
  try {
    return JSON.parse(result.value.toString()) as IOGResult;
  } catch {
    return null;
  }
}

async function loadOpenGraphData(
  engine: Engine,
  url: string,
  assetId: string,
): Promise<IOGResult | null> {
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; VideobookBot/1.0)" },
      signal: AbortSignal.timeout(10_000),
      redirect: "follow",
    });
    const ogData = extractOpenGraph(await response.text());
    await engine.files.write(assetId, ".opengraph.json", Buffer.from(JSON.stringify(ogData, null, 2)));
    return ogData;
  } catch {
    return readOpenGraphData(engine, assetId);
  }
}

async function stageOpenGraphImage(
  engine: Engine,
  ogData: IOGResult,
  assetId: string,
): Promise<void> {
  const imageUrl = extractOgImageUrl(ogData.ogImage);
  if (!imageUrl) return;
  try {
    await downloadUrlIntoAsset(engine, imageUrl, assetId, OG_IMAGE_FILENAME, {
      kind: "OG image",
      fetchInit: { signal: AbortSignal.timeout(15_000), redirect: "follow" },
    });
  } catch (error) {
    void error;
  }
}

type DownloadVideoPayload = {
  type: "download_video";
  url: string;
  outputPath?: string;
  assetId: string;
  assetDir: string;
  bookId?: string;
  exportVideos: boolean;
  full: boolean;
  sourcePrefix: string;
  requestedRange?: { start?: number; end?: number };
};

type InfoResult = {
  _type?: string;
  title?: string;
  uploader?: string;
  description?: string;
  thumbnail?: string;
  webpage_url?: string;
  extractor?: string;
  entries?: InfoResult[];
  duration?: number;
  vcodec?: string;
  ext?: string;
  url?: string;
};

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif"]);

export async function applyRequestedDownloadRange(
  engine: Engine,
  assetId: string,
  assetDir: string,
  outputPath: string,
  requestedRange: { start?: number; end?: number },
): Promise<boolean> {
  const start = requestedRange.start ?? 0;
  const end = requestedRange.end;
  if (!Number.isFinite(start) || start < 0
    || (end !== undefined && (!Number.isFinite(end) || end <= start))) {
    throw new Error("Requested download range is invalid");
  }
  if (start === 0 && end === undefined) return false;
  const rangeFilename = ".requested-range.mp4";
  const rangePath = join(assetDir, rangeFilename);
  try {
    if (end !== undefined) {
      await trimRangeExact(
        outputPath,
        rangePath,
        start,
        end - start,
      );
    } else {
      await trimRange(outputPath, rangePath, start, undefined);
    }
    await assertSaneTrimOutput(outputPath, rangePath);
    await replaceArtifactFileFromPath(
      engine,
      assetId,
      "original.mp4",
      rangePath,
    );
    return true;
  } catch (error) {
    await engine.files.delete(assetId, rangeFilename);
    throw error;
  }
}

export function isImageContent(info: InfoResult): boolean {
  if (!info.ext) return false;
  if (!IMAGE_EXTENSIONS.has(info.ext.toLowerCase())) return false;
  if (info.vcodec && info.vcodec !== "none") return false;
  return true;
}

export function imageExtension(info: InfoResult): string {
  const ext = info.ext?.toLowerCase() ?? "jpg";
  return IMAGE_EXTENSIONS.has(ext) ? `.${ext}` : ".jpg";
}

export function registerDownloadVideoJob(engine: Engine): void {
  registerJobHandler("download_video", async (payload, ctx) => {
    const ytdlp = new YtDlp(ytdlpRunOptions());
    const {
      url,
      assetId, assetDir, exportVideos,
      sourcePrefix, requestedRange,
    } = payload as DownloadVideoPayload;
    const bookId = (payload as DownloadVideoPayload).bookId ?? "";
    const outputPath = join(assetDir, "original.mp4");

    return withLockedLocalLease(
      engine,
      assetId,
      assetDir,
      ctx,
      "download",
      { durationMs: LOCK_DURATION_MS, data: { state: "downloading" } },
      () => withDownloadSession(engine, { url, assetId, bookId, binaryPath: ytdlp.binaryPath, signal: ctx.signal }, async (session) => {
      // (a) Pre-stage OG image as a hidden file. The b2 fallback (yt-dlp
      // returns "no video") promotes this to original.jpg on a fresh image
      // asset; a successful video download promotes it after step (d).
      const ogData = await loadOpenGraphData(engine, url, assetId);
      if (ogData) {
        await stageOpenGraphImage(engine, ogData, assetId);
      }

      // (b) Fetch ytdlp metadata
      let info: InfoResult;
      try {
        info = await fetchVideoInfo(ytdlp, url, session);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);

        // (b2) yt-dlp found no video — fall back to OG image as an image asset
        if (/no video/i.test(msg)) {
          const ogImageResult = await engine.files.read(assetId, OG_IMAGE_FILENAME);
          if (!ogImageResult.ok) throw new Error(`No video found and no OG image available: ${msg}`);

          // Read OG metadata for asset naming and provenance
          let ogTitle = "image";
          const fallbackOgData = ogData ?? await readOpenGraphData(engine, assetId);
          if (fallbackOgData?.ogTitle) ogTitle = cleanOgTitle(fallbackOgData.ogTitle);

          const assetName = [sourcePrefix, ogTitle].join(" ");
          const imgResult = await engine.artifacts.create("image", assetName);
          if (!imgResult.ok) throw new Error(`Failed to create image asset: ${imgResult.error.message}`);

          const imgAssetId = imgResult.value.artifactId;

          // Copy OG image and metadata to new image asset
          await engine.files.write(imgAssetId, "original.jpg", ogImageResult.value);
          try {
            await engine.files.copy(assetId, ".opengraph.json", imgAssetId, ".opengraph.json");
          } catch { /* non-fatal */ }

          // Release lock and delete the old video asset
          await engine.jobs.locks.release(assetDir);
          await engine.artifacts.delete(assetId);

          const provenance = {
            origin: "download",
            source_url: url,
            title: fallbackOgData?.ogTitle ?? "",
            uploader: "",
            description: fallbackOgData?.ogDescription ?? "",
            webpage_url: url,
            platform: sourcePrefix,
            thumbnail: "",
            downloaded_at: new Date().toISOString(),
          };

          const processJobId = `process-image-${imgAssetId}-${Date.now()}`;
          await queue.enqueue(processJobId, {
            type: "process_image",
            assetId: imgAssetId,
            bookId,
            extension: ".jpg",
            provenance,
          } as unknown as Record<string, unknown>);

          return { success: true, retyped: true, assetId: imgAssetId };
        }

        throw new Error(`Failed to fetch video info: ${msg}`);
      }

      // (c) Handle playlists — if multiple entries, create additional assets + jobs for entries 2+
      let playlistItem: number | undefined;
      if (info._type === "playlist" && Array.isArray(info.entries) && info.entries.length > 1) {
        // Current job handles entry 1
        playlistItem = 1;

        // Enqueue separate jobs for entries 2+
        for (let i = 1; i < info.entries.length; i++) {
          const entry = info.entries[i];
          const entryKind = isImageContent(entry) ? "image" : "video";
          const entryName = `${sourcePrefix} ${entry.title ?? `${entryKind} ${i + 1}`}`;

          const assetResult = await engine.artifacts.create(entryKind, entryName);
          if (!assetResult.ok) continue;

          const { artifactId: newAssetId, path: newAssetDir } = assetResult.value;
          const newFilename = "original.mp4";
          const newOutputPath = join(newAssetDir, newFilename);
          const newJobId = `download-${newAssetId}-${Date.now()}`;

          await queue.enqueue(newJobId, {
            type: "download_video",
            url,
            outputPath: newOutputPath,
            assetId: newAssetId,
            assetDir: newAssetDir,
            bookId,
            exportVideos,
            full: true,
            sourcePrefix,
            ...(requestedRange ? { requestedRange } : {}),
            _playlistItem: i + 1,
          } as unknown as Record<string, unknown>);
        }
      } else if (info._type === "playlist" && Array.isArray(info.entries) && info.entries.length === 1) {
        playlistItem = 1;
      }

      // Check for internal _playlistItem (set when this job was spawned for a playlist entry)
      const internalPlaylistItem = (payload as Record<string, unknown>)._playlistItem as number | undefined;
      if (internalPlaylistItem !== undefined) {
        playlistItem = internalPlaylistItem;
      }

      // (d0) Detect image-only content — retype asset and route to process_image
      const itemInfo = (playlistItem !== undefined && info._type === "playlist" && info.entries?.length)
        ? (info.entries[playlistItem - 1] ?? info)
        : info;

      if (isImageContent(itemInfo)) {
        let effectiveAssetId = assetId;

        // Retype video asset to image if needed
        const sourceArtifact = engine.artifacts.get(assetId);
        if (sourceArtifact.ok && sourceArtifact.value.kind === "video") {
          const assetName = [sourcePrefix, itemInfo.title ?? "image"].join(" ");
          const imgResult = await engine.artifacts.create("image", assetName);
          if (!imgResult.ok) throw new Error(`Failed to create image asset: ${imgResult.error.message}`);

          effectiveAssetId = imgResult.value.artifactId;

          // Copy .opengraph.json to new asset
          try {
            await engine.files.copy(assetId, ".opengraph.json", effectiveAssetId, ".opengraph.json");
          } catch {
            // non-fatal — OG data may not exist
          }

          // Release lock and delete the old video asset
          await engine.jobs.locks.release(assetDir);
          const delResult = await engine.artifacts.delete(assetId);
          if (!delResult.ok) {
            // non-fatal — an orphaned video asset is acceptable
          }
        }

        // Download image directly from yt-dlp's resolved URL
        const imageUrl = itemInfo.url ?? itemInfo.thumbnail ?? "";
        if (!imageUrl) throw new Error("No image URL found in content info");

        const ext = imageExtension(itemInfo);
        await downloadUrlIntoAsset(engine, imageUrl, effectiveAssetId, `original${ext}`, {
          kind: "image",
          fetchInit: { signal: AbortSignal.timeout(30_000), redirect: "follow" },
        });

        // Build provenance
        const provenance = {
          origin: "download",
          source_url: url,
          title: itemInfo.title ?? info.title ?? "",
          uploader: itemInfo.uploader ?? info.uploader ?? "",
          description: itemInfo.description ?? info.description ?? "",
          webpage_url: itemInfo.webpage_url ?? info.webpage_url ?? "",
          platform: itemInfo.extractor ?? info.extractor ?? "",
          thumbnail: itemInfo.thumbnail ?? info.thumbnail ?? "",
          downloaded_at: new Date().toISOString(),
        };

        // Enqueue process_image instead of process_video
        const processJobId = `process-image-${effectiveAssetId}-${Date.now()}`;
        await queue.enqueue(processJobId, {
          type: "process_image",
          assetId: effectiveAssetId,
          bookId,
          extension: ext,
          provenance,
        } as unknown as Record<string, unknown>);

        return { success: true, retyped: assetId !== effectiveAssetId, assetId: effectiveAssetId };
      }

      // (d) Regular ytdlp download
      await downloadVideoFile(ytdlp, url, outputPath, playlistItem, session);

      // (d2) Validate download output
      await validateDownloadOutput(outputPath);

      const rangeApplied = requestedRange
          ? await applyRequestedDownloadRange(
            engine,
            assetId,
            assetDir,
            outputPath,
            requestedRange,
          )
        : false;
      if (rangeApplied) await validateDownloadOutput(outputPath);

      // (d3) Promote staged OG image to original.jpg so process_video uses
      // the curated platform thumbnail (e.g. YouTube maxres) rather than a
      // first-frame extraction. Best-effort — process_video falls back to a
      // first-frame thumbnail when original.jpg is absent.
      try {
        const ogImageResult = await engine.files.read(assetId, OG_IMAGE_FILENAME);
        if (ogImageResult.ok) {
          await engine.files.write(assetId, "original.jpg", ogImageResult.value);
        }
      } catch { /* non-fatal */ }

      // (e) Optional exports
      const exports: string[] = [];
      if (exportVideos) {
        try {
          const landscape = join(assetDir, "original_16x9.mp4");
          await blurFillExport(outputPath, landscape, 1920, 1080);
          exports.push("original_16x9.mp4");
        } catch {
          // export failure is non-fatal
        }
        try {
          const portrait = join(assetDir, "original_9x16.mp4");
          await blurFillExport(outputPath, portrait, 1080, 1920);
          exports.push("original_9x16.mp4");
        } catch {
          // export failure is non-fatal
        }
      }

      // (f) Build provenance from ytdlp metadata
      const provenance = {
        origin: "download",
        source_url: url,
        title: info.title ?? "",
        uploader: info.uploader ?? "",
        description: info.description ?? "",
        webpage_url: info.webpage_url ?? "",
        platform: info.extractor ?? "",
        thumbnail: info.thumbnail ?? "",
        full: !rangeApplied,
        ...(requestedRange ? { requested_range: requestedRange } : {}),
        downloaded_at: new Date().toISOString(),
      };

      await ingestWorkspaceOutputs(
        engine,
        assetId,
        ["original.mp4", ...exports],
        "download_video",
        { sourceUrl: url, exports },
      );

      // (g) Enqueue process_video
      const processJobId = `process-video-${assetId}-${Date.now()}`;
      await queue.enqueue(processJobId, {
        type: "process_video",
        videoPath: outputPath,
        assetId,
        assetDir,
        bookId,
        provenance,
      } as unknown as Record<string, unknown>);

      return { success: true, exports };
      }),
      { durationMs: LOCK_DURATION_MS },
    );
  });
}
