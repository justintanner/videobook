import type { VideocityFs } from "videocity-engine";
import { findAudioFile } from "videocity-engine";
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
  Segment,
  SubtitleStyle,
  SubtitlePosition,
  FontSizePreset,
  OsgPosition,
  OsgSize,
  BackgroundMode,
  Chunk,
  RenderInputProps,
} from "../remotion/subtitles/types.js";
import { requireApiKey } from "../api-key.js";
import { claimLockedLease } from "./_lease.js";
import { transcribeAssetToElevenLabsJson } from "./_transcribe.js";
import { buildResponses } from "./describe-image.js";
import {
  iso1FromIso3,
  readLanguageCode,
  sidecarMatchesSource,
  translatedTranscriptFilename,
  translateTranscript,
} from "./_translate-transcript.js";
import {
  LANDSCAPE_WIDTH,
  LANDSCAPE_HEIGHT,
  PORTRAIT_WIDTH,
  PORTRAIT_HEIGHT,
  SQUARE_WIDTH,
  SQUARE_HEIGHT,
} from "../remotion/constants.js";

const LOCK_DURATION_MS = 1_800_000; // 30 min for renders
// How long a render job waits for another holder of the same asset before
// giving up. The render tool enqueues one job per orientation and the queue
// runs them concurrently, so same-asset jobs must queue behind each other.
const CLAIM_WAIT_MS = 900_000;
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
};

type RenderProjectPayload = {
  type: "render_project";
  projectSlug: string;
  orientation: Orientation;
  assets: AssetDescriptor[];
  subtitlesEnabled: boolean;
  subtitleLanguage?: string;
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
  osgSize: OsgSize;
  osgScale?: number;
  osgStartSeconds?: number | null;
  osgEndSeconds?: number | null;
  osgTailSeconds?: number | null;
  backgroundMode: BackgroundMode;
  strokeWidth: number;
  strokeColor: string;
  shadowBlur: number;
  shadowOpacity: number;
};

// Lazy subtitle-language resolution: serve the cached translated sidecar when
// it matches the current transcript, translate-and-cache when it doesn't, and
// fall back to the original-language transcript on any translation failure —
// a render must never fail because translation did.
async function resolveSubtitleSegments(
  fs: VideocityFs,
  projectSlug: string,
  assetId: string,
  raw: unknown,
  subtitleLanguage: string,
): Promise<Segment[]> {
  const sourceSegments = parseSegments(raw as Parameters<typeof parseSegments>[0]);
  const sourceIso1 = iso1FromIso3(readLanguageCode(raw));
  if (subtitleLanguage === "original" || subtitleLanguage === sourceIso1) {
    return sourceSegments;
  }

  const sidecarFilename = translatedTranscriptFilename(subtitleLanguage);
  const existing = await fs.readFile(assetId, sidecarFilename, projectSlug);
  if (existing.ok) {
    try {
      const sidecar = JSON.parse(existing.value.toString()) as unknown;
      if (sidecarMatchesSource(sidecar, sourceSegments)) {
        return parseSegments(sidecar as Parameters<typeof parseSegments>[0]);
      }
    } catch {
      // unreadable sidecar — re-translate below
    }
  }

  try {
    const responses = buildResponses(requireApiKey("OPENAI_API_KEY"));
    const sidecar = await translateTranscript(raw, subtitleLanguage, responses);
    const writeResult = await fs.writeFile(
      assetId,
      sidecarFilename,
      JSON.stringify(sidecar, null, 2),
      projectSlug,
    );
    if (!writeResult.ok) {
      console.warn(`[render] failed to cache ${sidecarFilename} for ${assetId}: ${writeResult.error.message}`);
    }
    return parseSegments(sidecar as unknown as Parameters<typeof parseSegments>[0]);
  } catch (err) {
    console.warn(
      `[render] subtitle translation to ${subtitleLanguage} failed for ${assetId}, falling back to original:`,
      err instanceof Error ? err.message : err,
    );
    return sourceSegments;
  }
}

// Auto-transcribe so a subtitled render is never blocked on a missing
// transcript. The caller holds the asset's render lease, so concurrent
// per-orientation render jobs serialize: the first transcribes and writes
// elevenlabs.json, the rest find it already present and skip. Throws on
// failure (missing audio, API error) so the asset render surfaces the cause.
async function ensureTranscript(
  fs: VideocityFs,
  projectSlug: string,
  assetId: string,
): Promise<void> {
  const manifest = await fs.getManifest(assetId, projectSlug, { includeDotfiles: true });
  if (!manifest.ok) {
    throw new Error(`auto-transcribe failed: ${manifest.error.message}`);
  }
  const audioFile = findAudioFile(manifest.value.files, assetId);
  if (!audioFile) {
    throw new Error(`auto-transcribe failed: no audio file found in asset ${assetId}`);
  }
  await transcribeAssetToElevenLabsJson(fs, projectSlug, assetId, audioFile.name, {
    tagAudioEvents: true,
    diarize: true,
  });
}

export function registerRenderProjectJob(fs: VideocityFs): void {
  registerJobHandler("render_project", async (payload, _ctx) => {
    void _ctx;
    const {
      projectSlug,
      orientation,
      assets,
      subtitlesEnabled,
      subtitleLanguage = "original",
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
      osgSize,
      osgScale,
      osgStartSeconds,
      osgEndSeconds,
      osgTailSeconds,
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
          // Per-asset lock + lease: render is a single-asset transition for
          // each entry in the loop; the wrapper's catch CAS-fails this exact
          // owner (other assets in the batch keep their leases). Waiting
          // serializes concurrent renders of the same asset (one job per
          // orientation) instead of failing the latecomers.
          const claim = await claimLockedLease(
            fs,
            projectSlug,
            asset.assetId,
            asset.assetDir,
            "render",
            { durationMs: LOCK_DURATION_MS, data: { state: `rendering-${orientation}` } },
            { durationMs: LOCK_DURATION_MS, waitForActiveMs: CLAIM_WAIT_MS, meta: { orientation } },
          );
          if (!claim.ok) {
            failed.push({ assetId: asset.assetId, error: claim.reason });
            continue;
          }
          const lease = { ownerId: claim.ownerId };
          const heartbeat = setInterval(() => {
            void fs.assetWork
              .renew(projectSlug, asset.assetId, lease.ownerId, 60_000)
              .catch((e) =>
                console.warn(`[heartbeat] renew failed for ${asset.assetId}:`, e),
              );
          }, 20_000);
          let renderSucceeded = false;

          try {
            const probe = await probeVideo(asset.videoPath);
            const durationInSeconds = probe.duration;
            const fps = Math.round(probe.fps) || 30;
            const durationInFrames = Math.max(1, Math.round(durationInSeconds * fps));

            // Detect the transcript at render time rather than trusting the
            // payload flag (captured at enqueue, before any auto-transcribe).
            // When subtitles are requested but no transcript exists yet,
            // transcribe inline under this asset's render lease.
            let allSegments = null;
            if (subtitlesEnabled && !(await fs.readFile(asset.assetId, "elevenlabs.json", projectSlug)).ok) {
              await ensureTranscript(fs, projectSlug, asset.assetId);
            }
            const elevenlabsResult = await fs.readFile(asset.assetId, "elevenlabs.json", projectSlug);
            if (elevenlabsResult.ok) {
              const raw = JSON.parse(elevenlabsResult.value.toString()) as unknown;
              allSegments = await resolveSubtitleSegments(fs, projectSlug, asset.assetId, raw, subtitleLanguage);
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
                osgSize: osgSize ?? "medium",
                osgScale: osgScale ?? 1,
                osgStartSeconds: osgStartSeconds ?? null,
                osgEndSeconds: osgEndSeconds ?? null,
                osgTailSeconds: osgTailSeconds ?? null,
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
                subtitleLanguage,
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
                osgSize,
                osgScale: osgScale ?? 1,
                osgStartSeconds: osgStartSeconds ?? null,
                osgEndSeconds: osgEndSeconds ?? null,
                osgTailSeconds: osgTailSeconds ?? null,
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
