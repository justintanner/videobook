import type { ClipfirstFs } from "clipfirst-fs";
import { readFile, writeFile, copyFile, unlink } from "node:fs/promises";
import { join, resolve, basename } from "node:path";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import { registerJobHandler } from "../queue.js";
import { probeVideo } from "../ffmpeg.js";
import { parseSegments } from "../remotion/subtitles/segments.js";
import { chunkSegments } from "../remotion/subtitles/chunker.js";
import type {
  Orientation,
  SubtitleStyle,
  SubtitlePosition,
  FontSizePreset,
  OsgPosition,
  Chunk,
  RenderInputProps,
} from "../remotion/subtitles/types.js";
import {
  LANDSCAPE_WIDTH,
  LANDSCAPE_HEIGHT,
  PORTRAIT_WIDTH,
  PORTRAIT_HEIGHT,
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

type RenderVideoPayload = {
  type: "render_video";
  assetId: string;
  assetDir: string;
  videoPath: string;
  videoFilename: string;
  projectSlug: string;
  orientations: Orientation[];
  subtitlesEnabled?: boolean;
  highlightStyle: SubtitleStyle;
  position: SubtitlePosition;
  fontSize: FontSizePreset;
  textColor: string;
  highlightColor: string;
  audioFadeIn: number;
  audioFadeOut: number;
  audioVolume: number;
  hasElevenlabs: boolean;
  osgImagePath: string | null;
  osgPosition: OsgPosition;
};

export function registerRenderVideoJob(fs: ClipfirstFs): void {
  registerJobHandler("render_video", async (payload) => {
    const {
      assetId,
      assetDir,
      videoPath,
      projectSlug,
      orientations,
      subtitlesEnabled,
      highlightStyle,
      position,
      fontSize,
      textColor,
      highlightColor,
      audioFadeIn,
      audioFadeOut,
      audioVolume,
      hasElevenlabs,
      osgImagePath,
      osgPosition,
    } = payload as RenderVideoPayload;

    const lockResult = await fs.acquireLock(assetDir, { durationMs: LOCK_DURATION_MS });
    if (!lockResult.ok) throw new Error(`Asset is locked: ${lockResult.error.message}`);

    try {
      const probe = await probeVideo(videoPath);
      const durationInSeconds = probe.duration;
      const fps = Math.round(probe.fps) || 30;
      const durationInFrames = Math.max(1, Math.round(durationInSeconds * fps));

      let allSegments = null;
      if (hasElevenlabs) {
        const elevenlabsPath = join(assetDir, "elevenlabs.json");
        const raw = await readFile(elevenlabsPath, "utf-8");
        allSegments = parseSegments(JSON.parse(raw));
      }

      const bundleDir = await getBundleLocation();
      const outputs: string[] = [];

      // Copy video into bundle dir so Remotion's server can serve it
      const videoCopyName = `source-${assetId}-${Date.now()}${basename(videoPath).replace(/^[^.]*/, "")}`;
      const videoCopyPath = join(bundleDir, videoCopyName);
      await copyFile(resolve(videoPath), videoCopyPath);

      // Copy OSG image into bundle dir if provided
      let osgCopyName: string | null = null;
      let osgCopyPath: string | null = null;
      if (osgImagePath) {
        osgCopyName = `osg-${assetId}-${Date.now()}${basename(osgImagePath).replace(/^[^.]*/, "")}`;
        osgCopyPath = join(bundleDir, osgCopyName);
        await copyFile(resolve(osgImagePath), osgCopyPath);
      }

      try {
        for (const orient of orientations) {
          const isPortrait = orient === "portrait";
          const targetWidth = isPortrait ? PORTRAIT_WIDTH : LANDSCAPE_WIDTH;
          const targetHeight = isPortrait ? PORTRAIT_HEIGHT : LANDSCAPE_HEIGHT;

          const subsEnabled =
            subtitlesEnabled !== undefined
              ? subtitlesEnabled
              : isPortrait;

          let chunks: Chunk[] = [];
          if (subsEnabled && allSegments) {
            chunks = chunkSegments(allSegments, orient, highlightStyle);
          }

          const outputFilename = isPortrait ? "render_9x16.mp4" : "render_16x9.mp4";
          const outputPath = join(assetDir, outputFilename);

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
          };

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

          outputs.push(outputFilename);
        }
      } finally {
        await unlink(videoCopyPath).catch(() => {});
        if (osgCopyPath) await unlink(osgCopyPath).catch(() => {});
      }

      const renderSettings = {
        orientations,
        subtitlesEnabled,
        highlightStyle,
        position,
        fontSize,
        textColor,
        highlightColor,
        audioFadeIn,
        audioFadeOut,
        audioVolume,
        renderedAt: new Date().toISOString(),
        outputs,
      };
      await writeFile(join(assetDir, ".render.json"), JSON.stringify(renderSettings, null, 2));

      await fs.commitOperation("render", assetId, renderSettings, projectSlug);

      return { success: true, outputs };
    } finally {
      await fs.releaseLock(assetDir);
    }
  });
}
