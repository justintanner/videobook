import type { ClipfirstFs } from "clipfirst-fs";
import { join } from "node:path";
import { YtDlp } from "ytdlp-nodejs";
import type { IOGResult } from "@devmehq/open-graph-extractor";
import { queue, registerJobHandler } from "../queue.js";
import { runFfmpeg, H264_MEDIUM, AUDIO_OPTS } from "../ffmpeg.js";

const LOCK_DURATION_MS = 600_000;

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
};

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
          const entryName = `${sourcePrefix} ${entry.title ?? `video ${i + 1}`}`;

          const assetResult = await fs.createAsset("vid", entryName, projectSlug ?? "");
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
      await fs.releaseLock(assetDir);
    }
  });
}
