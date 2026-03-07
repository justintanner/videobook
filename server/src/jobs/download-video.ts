import type { ClipfirstFs } from "clipfirst-fs";
import { writeFile as fsWriteFile } from "node:fs/promises";
import { join } from "node:path";
import { YtDlp } from "ytdlp-nodejs";
import { registerJobHandler } from "../queue.js";
import { probeVideo, runFfmpeg, H264_MEDIUM, AUDIO_OPTS, type ProbeResult } from "../ffmpeg.js";

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

type DownloadVideoPayload = {
  type: "download_video";
  url: string;
  outputPath: string;
  downloadSections?: string;
  playlistItem?: number;
  assetId: string;
  assetDir: string;
  projectSlug?: string;
  exportVideos: boolean;
  full: boolean;
  title: string;
  uploader: string;
  description: string;
  webpageUrl: string;
  platform: string;
  thumbnail: string;
};

export function registerDownloadVideoJob(fs: ClipfirstFs): void {
  const ytdlp = new YtDlp();

  registerJobHandler("download_video", async (payload) => {
    const {
      url, outputPath, downloadSections, playlistItem,
      assetId, assetDir, projectSlug, exportVideos, full,
      title, uploader, description, webpageUrl, platform, thumbnail,
    } = payload as DownloadVideoPayload;

    const lockResult = await fs.acquireLock(assetDir, { durationMs: LOCK_DURATION_MS });
    if (!lockResult.ok) throw new Error(`Asset is locked: ${lockResult.error.message}`);

    try {
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

      let probe: ProbeResult = { width: 0, height: 0, duration: 0, fps: 0 };
      try {
        probe = await probeVideo(outputPath);
      } catch {
        // probe failure is non-fatal
      }

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

      const origin = {
        origin: "download",
        source_url: url,
        title,
        uploader,
        description,
        webpage_url: webpageUrl,
        platform,
        thumbnail,
        width: probe.width,
        height: probe.height,
        duration: probe.duration,
        full,
        downloaded_at: new Date().toISOString(),
      };
      await fsWriteFile(join(assetDir, ".origin.json"), JSON.stringify(origin, null, 2));

      await fs.commitOperation("download", assetId, { source_url: url }, projectSlug);

      return { success: true, exports };
    } finally {
      await fs.releaseLock(assetDir);
    }
  });
}
