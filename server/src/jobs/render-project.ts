import type { ClipfirstFs } from "clipfirst-fs";
import { copyFile, unlink } from "node:fs/promises";
import { join, resolve, basename } from "node:path";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import { registerJobHandler } from "../queue.js";
import { probeVideo, runFfmpeg } from "../ffmpeg.js";
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

const LOCK_DURATION_MS = 900_000; // 15 min for renders
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
  subtitlesEnabled?: boolean;
  highlightStyle: SubtitleStyle;
  position: SubtitlePosition;
  fontSize: FontSizePreset;
  textColor: string;
  highlightColor: string;
  audioFadeIn: number;
  audioFadeOut: number;
  audioVolume: number;
  osgImagePath: string | null;
  osgPosition: OsgPosition;
  backgroundMode: BackgroundMode;
};

export function registerRenderProjectJob(fs: ClipfirstFs): void {
  registerJobHandler("render_project", async (payload) => {
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
      osgPosition,
      backgroundMode,
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
          const lockResult = await fs.acquireLock(asset.assetDir, { durationMs: LOCK_DURATION_MS, data: { state: "rendering" } });
          if (!lockResult.ok) {
            failed.push({ assetId: asset.assetId, error: `Asset is locked: ${lockResult.error.message}` });
            continue;
          }

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

            const subsEnabled =
              subtitlesEnabled !== undefined
                ? subtitlesEnabled
                : orientation === "portrait";

            let chunks: Chunk[] = [];
            if (subsEnabled && allSegments) {
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
                subtitlesEnabled: subsEnabled,
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
                crf: 18,
              });

              // Extract first frame as {orientation}.jpg
              const jpgFilename = outputFilename.replace(".mp4", ".jpg");
              const jpgPath = join(asset.assetDir, jpgFilename);
              try {
                await runFfmpeg(["-y", "-i", outputPath, "-frames:v", "1", "-q:v", "2", jpgPath]);
              } catch {
                // non-fatal
              }

              const renderSettings = {
                orientation,
                subtitlesEnabled: subsEnabled,
                highlightStyle,
                position,
                fontSize,
                textColor,
                highlightColor,
                audioFadeIn,
                audioFadeOut,
                audioVolume,
                backgroundMode,
                renderedAt: new Date().toISOString(),
                outputs: [outputFilename, jpgFilename],
              };
              await fs.writeMetadata(asset.assetId, "render", renderSettings, projectSlug);

              rendered.push(asset.assetId);
            } finally {
              await unlink(videoCopyPath).catch(() => {});
            }
          } finally {
            await fs.releaseLock(asset.assetDir);
          }
        } catch (err) {
          failed.push({ assetId: asset.assetId, error: err instanceof Error ? err.message : String(err) });
        }
      }
    } finally {
      if (osgCopyPath) await unlink(osgCopyPath).catch(() => {});
    }

    return { success: true, rendered, failed };
  });
}
