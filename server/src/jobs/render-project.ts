import type { VideocityFs } from "vc-engine";
import { copyFile, mkdir, unlink } from "node:fs/promises";
import { join, resolve, basename } from "node:path";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import { registerJobHandler } from "../queue.js";
import { probeVideo, runFfmpeg } from "../ffmpeg.js";
import { formatTimestamp, generateTimestamps } from "../frame-utils.js";
import { parseSegments } from "../remotion/subtitles/segments.js";
import { chunkSegments } from "../remotion/subtitles/chunker.js";
import type {
  Orientation,
  SubtitleStyle,
  SubtitlePosition,
  FontSizePreset,
  OsgPosition,
  BackgroundMode,
  Chunk,
  RenderInputProps,
} from "../remotion/subtitles/types.js";
import {
  LANDSCAPE_WIDTH,
  LANDSCAPE_HEIGHT,
  PORTRAIT_WIDTH,
  PORTRAIT_HEIGHT,
  SQUARE_WIDTH,
  SQUARE_HEIGHT,
} from "../remotion/constants.js";

const LOCK_DURATION_MS = 1_800_000; // 30 min for renders
const REMOTION_ENTRY = new URL("../remotion/index.tsx", import.meta.url).pathname;

let bundleLocation: string | null = null;

async function getBundleLocation(): Promise<string> {
  if (bundleLocation) return bundleLocation;
  bundleLocation = await bundle({
    entryPoint: REMOTION_ENTRY,
    webpackOverride: (config) => ({
      ...config,
      resolve: {
        ...config.resolve,
        extensions: [".tsx", ".ts", ".js", ".jsx", ".mjs", ".cjs", ".json"],
        extensionAlias: {
          ".js": [".tsx", ".ts", ".js"],
        },
      },
    }),
  });
  return bundleLocation;
}

type AssetDescriptor = {
  assetId: string;
  assetDir: string;
  videoPath: string;
  videoFilename: string;
  hasElevenlabs: boolean;
};

type RenderProjectPayload = {
  type: "render_project";
  projectSlug: string;
  orientation: Orientation;
  assets: AssetDescriptor[];
  subtitlesEnabled: boolean;
  highlightStyle: SubtitleStyle;
  position: SubtitlePosition;
  fontSize: FontSizePreset;
  textColor: string;
  highlightColor: string;
  audioFadeIn: number;
  audioFadeOut: number;
  audioVolume: number;
  osgImagePath: string | null;
  osgAssetId?: string | null;
  osgPosition: OsgPosition;
  backgroundMode: BackgroundMode;
  strokeWidth: number;
  strokeColor: string;
  shadowBlur: number;
  shadowOpacity: number;
};

export function registerRenderProjectJob(fs: VideocityFs): void {
  registerJobHandler("render_project", async (payload, _ctx) => {
    void _ctx;
    const {
      projectSlug,
      orientation,
      assets,
      subtitlesEnabled,
      highlightStyle,
      position,
      fontSize,
      textColor,
      highlightColor,
      audioFadeIn,
      audioFadeOut,
      audioVolume,
      osgImagePath,
      osgAssetId,
      osgPosition,
      backgroundMode,
      strokeWidth,
      strokeColor,
      shadowBlur,
      shadowOpacity,
    } = payload as RenderProjectPayload;

    const bundleDir = await getBundleLocation();

    const targetWidth = orientation === "portrait" ? PORTRAIT_WIDTH : orientation === "square" ? SQUARE_WIDTH : LANDSCAPE_WIDTH;
    const targetHeight = orientation === "portrait" ? PORTRAIT_HEIGHT : orientation === "square" ? SQUARE_HEIGHT : LANDSCAPE_HEIGHT;
    const outputFilename = orientation === "portrait"
      ? "portrait.mp4"
      : orientation === "square"
        ? "square.mp4"
        : "landscape.mp4";

    // Copy OSG image into bundle dir once if provided
    let osgCopyName: string | null = null;
    let osgCopyPath: string | null = null;
    if (osgImagePath) {
      osgCopyName = `osg-project-${Date.now()}${basename(osgImagePath).replace(/^[^.]*/, "")}`;
      osgCopyPath = join(bundleDir, osgCopyName);
      await copyFile(resolve(osgImagePath), osgCopyPath);
    }

    const rendered: string[] = [];
    const failed: Array<{ assetId: string; error: string }> = [];

    try {
      for (const asset of assets) {
        try {
          const lockResult = await fs.acquireLock(asset.assetDir, { durationMs: LOCK_DURATION_MS, data: { state: `rendering-${orientation}` } });
          if (!lockResult.ok) {
            failed.push({ assetId: asset.assetId, error: `Asset is locked: ${lockResult.error.message}` });
            continue;
          }

          // Per-asset lease: render is a single-asset transition for each
          // entry in the loop; the wrapper's catch CAS-fails this exact owner
          // (other assets in the batch keep their leases).
          const lease = await fs.assetWork.begin(projectSlug, asset.assetId, {
            kind: "render",
            ownerKind: "job",
            durationMs: LOCK_DURATION_MS,
            meta: { orientation },
          });
          if (!lease) {
            await fs.releaseLock(asset.assetDir);
            failed.push({ assetId: asset.assetId, error: "active owner already holds asset lease" });
            continue;
          }
          const heartbeat = setInterval(() => {
            void fs.assetWork.renew(projectSlug, asset.assetId, lease.ownerId, 60_000);
          }, 20_000);
          let renderSucceeded = false;

          try {
            const probe = await probeVideo(asset.videoPath);
            const durationInSeconds = probe.duration;
            const fps = Math.round(probe.fps) || 30;
            const durationInFrames = Math.max(1, Math.round(durationInSeconds * fps));

            let allSegments = null;
            if (asset.hasElevenlabs) {
              const elevenlabsResult = await fs.readFile(asset.assetId, "elevenlabs.json", projectSlug);
              if (elevenlabsResult.ok) {
                allSegments = parseSegments(JSON.parse(elevenlabsResult.value.toString()));
              }
            }

            let chunks: Chunk[] = [];
            if (subtitlesEnabled && allSegments) {
              chunks = chunkSegments(allSegments, orientation, highlightStyle);
            }

            // Copy video into bundle dir
            const videoCopyName = `source-${asset.assetId}-${Date.now()}${basename(asset.videoPath).replace(/^[^.]*/, "")}`;
            const videoCopyPath = join(bundleDir, videoCopyName);
            await copyFile(resolve(asset.videoPath), videoCopyPath);

            try {
              const inputProps: RenderInputProps = {
                videoSrc: videoCopyName,
                targetWidth,
                targetHeight,
                sourceWidth: probe.width,
                sourceHeight: probe.height,
                durationInFrames,
                fps,
                subtitlesEnabled,
                chunks,
                style: highlightStyle,
                position,
                fontSize,
                textColor,
                highlightColor,
                audioFadeIn,
                audioFadeOut,
                audioVolume,
                osgSrc: osgCopyName,
                osgPosition: osgPosition ?? "top-right",
                backgroundMode,
                strokeWidth,
                strokeColor,
                shadowBlur,
                shadowOpacity,
              };

              const outputPath = join(asset.assetDir, outputFilename);

              const composition = await selectComposition({
                serveUrl: bundleDir,
                id: "render",
                inputProps: inputProps as unknown as Record<string, unknown>,
              });

              await renderMedia({
                composition,
                serveUrl: bundleDir,
                codec: "h264",
                outputLocation: outputPath,
                inputProps: inputProps as unknown as Record<string, unknown>,
                videoBitrate: "8M",
                concurrency: 1,
                hardwareAcceleration: "if-possible",
              });

              // Extract first frame as {orientation}.jpg
              const jpgFilename = outputFilename.replace(".mp4", ".jpg");
              const jpgPath = join(asset.assetDir, jpgFilename);
              try {
                await runFfmpeg(["-y", "-i", outputPath, "-frames:v", "1", "-q:v", "2", jpgPath]);
              } catch {
                // non-fatal
              }

              // Extract orientation frames at timestamps
              const orientFramesDirName = `${orientation}_frames`;
              const orientFramesDir = join(asset.assetDir, orientFramesDirName);
              try {
                await mkdir(orientFramesDir, { recursive: true });
                const timestamps = generateTimestamps(durationInSeconds);
                for (const ts of timestamps) {
                  const framePath = join(orientFramesDir, `${formatTimestamp(ts)}.jpg`);
                  try {
                    await runFfmpeg([
                      "-y", "-i", outputPath,
                      "-ss", String(ts),
                      "-frames:v", "1",
                      "-q:v", "2",
                      "-strict", "unofficial",
                      framePath,
                    ]);
                  } catch {
                    // frame extraction failure is non-fatal
                  }
                }
              } catch {
                // non-fatal
              }

              const renderSettings = {
                subtitlesEnabled,
                highlightStyle,
                position,
                fontSize,
                textColor,
                highlightColor,
                audioFadeIn,
                audioFadeOut,
                audioVolume,
                backgroundMode,
                strokeWidth,
                strokeColor,
                shadowBlur,
                shadowOpacity,
                osgImagePath: osgImagePath ?? undefined,
                osgAssetId: osgAssetId ?? undefined,
                osgPosition,
                renderedAt: new Date().toISOString(),
                outputs: [outputFilename, jpgFilename, orientFramesDirName],
              };
              await fs.writeMetadata(asset.assetId, `${orientation}.render`, renderSettings, projectSlug);

              await fs.commitOperation("render", asset.assetId, { orientation }, projectSlug);

              rendered.push(asset.assetId);
              renderSucceeded = true;
            } finally {
              await unlink(videoCopyPath).catch(() => {});
            }
          } finally {
            clearInterval(heartbeat);
            if (renderSucceeded) {
              await fs.assetWork.complete(projectSlug, asset.assetId, lease.ownerId);
            } else {
              await fs.assetWork.fail(projectSlug, asset.assetId, lease.ownerId, {
                message: "render failed",
              });
            }
            await fs.releaseLock(asset.assetDir);
          }
        } catch (err) {
          failed.push({ assetId: asset.assetId, error: err instanceof Error ? err.message : String(err) });
        }
      }
    } finally {
      if (osgCopyPath) await unlink(osgCopyPath).catch(() => {});
    }

    if (rendered.length === 0 && failed.length > 0) {
      throw new Error(`Render failed: ${failed.map((f) => `${f.assetId}: ${f.error}`).join("; ")}`);
    }

    return { success: failed.length === 0, rendered, failed };
  });
}
