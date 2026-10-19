import type { Engine } from "videobook-engine";
import { join } from "node:path";
import { stat, unlink } from "node:fs/promises";
import { YtDlp } from "ytdlp-nodejs";
import { ytdlpRunOptions } from "../ytdlp-binary.js";
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
      async () => {
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
        info = await ytdlp.getInfoAsync(url) as unknown as InfoResult;
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
      const builder = ytdlp
        .download(url)
        .setOutputTemplate(outputPath)
        .addArgs("--merge-output-format", "mp4");

      if (playlistItem !== undefined) {
        builder.addArgs("--playlist-items", String(playlistItem));
      } else {
        builder.addArgs("--no-playlist");
      }

      await builder.run();

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
      },
      { durationMs: LOCK_DURATION_MS },
    );
  });
}
