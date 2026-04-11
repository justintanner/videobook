import type { ClipfirstFs } from "clipfirst-fs";
import { join } from "node:path";
import { stat, unlink } from "node:fs/promises";
import { YtDlp } from "ytdlp-nodejs";
import type { IOGResult } from "@devmehq/open-graph-extractor";
import { queue, registerJobHandler } from "../queue.js";
import { runFfmpeg, H264_MEDIUM, AUDIO_OPTS } from "../ffmpeg.js";
import { WHITELISTED_AT_FILE } from "../tools/whitelist-asset.js";

const LOCK_DURATION_MS = 600_000;

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
    return; // file exists with content — success
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

type DownloadVideoPayload = {
  type: "download_video";
  url: string;
  outputPath: string;
  downloadSections?: string;
  assetId: string;
  assetDir: string;
  projectSlug?: string;
  exportVideos: boolean;
  full: boolean;
  sourcePrefix: string;
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

export function registerDownloadVideoJob(fs: ClipfirstFs): void {
  const ytdlp = new YtDlp();

  registerJobHandler("download_video", async (payload) => {
    const {
      url, outputPath, downloadSections,
      assetId, assetDir, projectSlug, exportVideos, full,
      sourcePrefix,
    } = payload as DownloadVideoPayload;

    const lockResult = await fs.acquireLock(assetDir, { durationMs: LOCK_DURATION_MS, data: { state: "downloading" } });
    if (!lockResult.ok) throw new Error(`Asset is locked: ${lockResult.error.message}`);

    try {
      // (a) Download OG image as original.jpg
      try {
        const ogFileResult = await fs.readFile(assetId, ".opengraph.json", projectSlug ?? "");
        if (ogFileResult.ok) {
          const ogData = JSON.parse(ogFileResult.value.toString()) as IOGResult;
          const imageUrl = extractOgImageUrl(ogData.ogImage);
          if (imageUrl) {
            const imgResponse = await fetch(imageUrl, {
              signal: AbortSignal.timeout(15_000),
              redirect: "follow",
            });
            const buffer = Buffer.from(await imgResponse.arrayBuffer());
            await fs.writeFile(assetId, "original.jpg", buffer, projectSlug ?? "");
          }
        }
      } catch {
        // non-fatal
      }

      // (b) Fetch ytdlp metadata
      let info: InfoResult;
      try {
        info = await ytdlp.getInfoAsync(url) as unknown as InfoResult;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);

        // (b2) yt-dlp found no video — fall back to OG image as an image asset
        if (/no video/i.test(msg)) {
          const ogImageResult = await fs.readFile(assetId, "original.jpg", projectSlug ?? "");
          if (!ogImageResult.ok) throw new Error(`No video found and no OG image available: ${msg}`);

          const slug = projectSlug ?? "";

          // Read OG metadata for asset naming and provenance
          let ogTitle = "image";
          let ogData: IOGResult | null = null;
          try {
            const ogFileResult = await fs.readFile(assetId, ".opengraph.json", slug);
            if (ogFileResult.ok) {
              ogData = JSON.parse(ogFileResult.value.toString()) as IOGResult;
              if (ogData.ogTitle) ogTitle = ogData.ogTitle;
            }
          } catch { /* non-fatal */ }

          const assetName = [sourcePrefix, ogTitle].join(" ");
          const imgResult = await fs.createAsset("img", assetName, slug);
          if (!imgResult.ok) throw new Error(`Failed to create image asset: ${imgResult.error.message}`);

          const imgAssetId = imgResult.value.assetId;

          // Copy OG image and metadata to new img- asset
          await fs.writeFile(imgAssetId, "original.jpg", ogImageResult.value, slug);
          try {
            await fs.copyFile(assetId, ".opengraph.json", imgAssetId, ".opengraph.json", slug);
          } catch { /* non-fatal */ }

          // Release lock and delete the old vid- asset
          await fs.releaseLock(assetDir);
          await fs.deleteAsset(assetId, slug);

          const provenance = {
            origin: "download",
            source_url: url,
            title: ogData?.ogTitle ?? "",
            uploader: "",
            description: ogData?.ogDescription ?? "",
            webpage_url: url,
            platform: sourcePrefix,
            thumbnail: "",
            downloaded_at: new Date().toISOString(),
          };

          const processJobId = `process-image-${imgAssetId}-${Date.now()}`;
          await queue.enqueue(processJobId, {
            type: "process_image",
            assetId: imgAssetId,
            projectSlug: slug,
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
          const entryPrefix = isImageContent(entry) ? "img" : "vid";
          const entryName = `${sourcePrefix} ${entry.title ?? `${entryPrefix === "img" ? "image" : "video"} ${i + 1}`}`;

          const assetResult = await fs.createAsset(entryPrefix, entryName, projectSlug ?? "");
          if (!assetResult.ok) continue;

          const { assetId: newAssetId, path: newAssetDir } = assetResult.value;
          const newFilename = full ? "original_full.mp4" : "original.mp4";
          const newOutputPath = join(newAssetDir, newFilename);
          const newJobId = `download-${newAssetId}-${Date.now()}`;

          await queue.enqueue(newJobId, {
            type: "download_video",
            url,
            outputPath: newOutputPath,
            downloadSections,
            assetId: newAssetId,
            assetDir: newAssetDir,
            projectSlug,
            exportVideos,
            full,
            sourcePrefix,
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
        const slug = projectSlug ?? "";

        // Retype vid- asset to img- if needed
        if (assetId.startsWith("vid-")) {
          const assetName = [sourcePrefix, itemInfo.title ?? "image"].join(" ");
          const imgResult = await fs.createAsset("img", assetName, slug);
          if (!imgResult.ok) throw new Error(`Failed to create image asset: ${imgResult.error.message}`);

          effectiveAssetId = imgResult.value.assetId;

          // Copy .opengraph.json to new asset
          try {
            await fs.copyFile(assetId, ".opengraph.json", effectiveAssetId, ".opengraph.json", slug);
          } catch {
            // non-fatal — OG data may not exist
          }

          // Release lock and delete the old vid- asset
          await fs.releaseLock(assetDir);
          const delResult = await fs.deleteAsset(assetId, slug);
          if (!delResult.ok) {
            // non-fatal — orphan vid- asset is acceptable
          }
        }

        // Download image directly from yt-dlp's resolved URL
        const imageUrl = itemInfo.url ?? itemInfo.thumbnail ?? "";
        if (!imageUrl) throw new Error("No image URL found in content info");

        const ext = imageExtension(itemInfo);
        const imgResponse = await fetch(imageUrl, {
          signal: AbortSignal.timeout(30_000),
          redirect: "follow",
        });
        if (!imgResponse.ok) throw new Error(`Image download failed: ${imgResponse.status}`);
        const buffer = Buffer.from(await imgResponse.arrayBuffer());
        await fs.writeFile(effectiveAssetId, `original${ext}`, buffer, slug);

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
          projectSlug: slug,
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

      if (downloadSections) {
        builder.addArgs("--download-sections", downloadSections);
        builder.addArgs("--force-keyframes-at-cuts");
      }
      if (playlistItem !== undefined) {
        builder.addArgs("--playlist-items", String(playlistItem));
      } else {
        builder.addArgs("--no-playlist");
      }

      await builder.run();

      // (d2) Validate download output
      await validateDownloadOutput(outputPath);

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
        full,
        downloaded_at: new Date().toISOString(),
      };

      // Auto-whitelist downloaded videos — the user explicitly requested the URL
      // so they skip manual review and the full sync pipeline (ElevenLabs + render)
      // can proceed once analysis completes.
      await fs.writeFile(assetId, WHITELISTED_AT_FILE, String(Date.now() / 1000), projectSlug ?? "");

      // (g) Enqueue process_video
      const processJobId = `process-video-${assetId}-${Date.now()}`;
      await queue.enqueue(processJobId, {
        type: "process_video",
        videoPath: outputPath,
        assetId,
        assetDir,
        projectSlug,
        provenance,
      } as unknown as Record<string, unknown>);

      return { success: true, exports };
    } finally {
      try { await fs.releaseLock(assetDir); } catch { /* asset may have been retyped/deleted */ }
    }
  });
}
