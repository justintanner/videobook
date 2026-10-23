import { findVideoFile, type Engine } from "videobook-engine";
import { copyFile, mkdir, stat, unlink } from "node:fs/promises";
import { join, resolve, basename } from "node:path";
import { renderMedia, selectComposition } from "@remotion/renderer";
import { logger } from "../logger.js";
import { registerJobHandler } from "../queue.js";
import { probeVideo, runFfmpeg } from "../ffmpeg.js";
import { withRemotionCancellation } from "../remotion-cancellation.js";
import { renderBrowserExecutable } from "../remotion/browser.js";
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
import { buildIntelligenceResponses } from "../openai-intelligence.js";
import { resolveOsgImagePath } from "../osg-assets.js";
import { claimLockedLease } from "./_lease.js";
import { ensureElevenLabsTranscript } from "./_transcribe.js";
import { ingestWorkspaceOutputs } from "./_persist-output.js";
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
import { getSharedBundleLocation } from "../remotion/shared-bundle.js";
import {
  DEFAULT_KEYWORD_GRAPHICS_LINGER_SECONDS,
  DEFAULT_KEYWORD_GRAPHICS_MAX_COUNT,
  parseKeywordTranscript,
  selectKeywordGraphics,
  selectRequestedKeywordGraphics,
} from "../remotion/keyword-graphics.js";
import {
  isKeywordPlacementCacheValid,
  keywordPlacementFingerprint,
  readKeywordPlacementAnalysis,
} from "../keyword-placement-cache.js";
import { resolveKeywordPlacements } from "../remotion/keyword-placement.js";
import { aliveRenderTrack, type AliveRenderTrack } from "../alive-captions/track.js";

const LOCK_DURATION_MS = 1_800_000; // 30 min for renders
// All three orientations lock the same source workspace. A subtitle render
// of one orientation outlives the old 30s wait, so the others failed and the
// queue then marked the playable source as media-failed.
const CLAIM_WAIT_MS = 15 * 60_000;

type AssetDescriptor = {
  assetId: string;
  assetDir: string;
  videoPath: string;
  videoFilename: string;
};

type RenderProjectPayload = {
  type: "render_project";
  bookId: string;
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
  osgOpacity?: number;
  osgStartSeconds?: number | null;
  osgEndSeconds?: number | null;
  osgTailSeconds?: number | null;
  keywordGraphicsEnabled?: boolean;
  keywordGraphicsMaxCount?: number;
  keywordGraphicsLingerSeconds?: number;
  keywordGraphicsKeywords?: string[] | null;
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
  engine: Engine,
  assetId: string,
  raw: unknown,
  subtitleLanguage: string,
  signal?: AbortSignal,
): Promise<Segment[]> {
  const sourceSegments = parseSegments(raw as Parameters<typeof parseSegments>[0]);
  const sourceIso1 = iso1FromIso3(readLanguageCode(raw));
  if (subtitleLanguage === "original" || subtitleLanguage === sourceIso1) {
    return sourceSegments;
  }

  const sidecarFilename = translatedTranscriptFilename(subtitleLanguage);
  const existing = await engine.files.read(assetId, sidecarFilename);
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
    const responses = buildIntelligenceResponses(requireApiKey("OPENAI_API_KEY"));
    const sidecar = await translateTranscript(raw, subtitleLanguage, responses, signal);
    const writeResult = await engine.files.write(assetId, sidecarFilename, JSON.stringify(sidecar, null, 2)
    );
    if (!writeResult.ok) {
      logger.warn("subtitle-cache-failed", { assetId, error: writeResult.error });
    }
    return parseSegments(sidecar as unknown as Parameters<typeof parseSegments>[0]);
  } catch (err) {
    logger.warn("subtitle-translation-failed", { assetId, error: err });
    return sourceSegments;
  }
}

function preserveArtifactState(error: unknown): Error {
  const preserved = error instanceof Error ? error : new Error(String(error));
  Object.assign(preserved, { preserveArtifactState: true });
  return preserved;
}

async function sourceVideoIsPlayable(engine: Engine, assetId: string): Promise<boolean> {
  const manifest = await engine.files.manifest(assetId);
  if (!manifest.ok) return false;
  return findVideoFile(manifest.value.files) !== null;
}

async function clearRenderError(engine: Engine, assetId: string): Promise<void> {
  const cleared = await engine.jobs.failures.clear(assetId);
  if (cleared.ok && cleared.value) return;
  // A reaped render lease marks the view failed without writing a
  // generation-error row, and clear() then no-ops. Write a row so the same
  // clear can restore the playable source.
  const view = engine.jobs.artifactWork.read(assetId);
  if (!view.ok || view.value?.status !== "error") return;
  const written = await engine.jobs.failures.write(assetId, {
    message: "Retrying subtitle render",
  });
  if (!written.ok) return;
  await engine.jobs.failures.clear(assetId);
}

/** A failed subtitle render must not leave a playable source stuck in error. */
export async function clearRenderErrorIfPlayable(engine: Engine, assetId: string): Promise<boolean> {
  if (!(await sourceVideoIsPlayable(engine, assetId))) return false;
  const view = engine.jobs.artifactWork.read(assetId);
  if (view.ok && view.value?.status === "error") {
    await clearRenderError(engine, assetId);
  }
  return true;
}

/** Drop a queued render view when this attempt never took the lease. */
export async function releaseQueuedRenderIfPlayable(engine: Engine, assetId: string): Promise<void> {
  if (!(await sourceVideoIsPlayable(engine, assetId))) return;
  const view = engine.jobs.artifactWork.read(assetId);
  if (!view.ok || view.value?.status !== "pending") return;
  const owner = engine.jobs.artifactWork.begin(assetId, {
    kind: "render",
    ownerKind: "job",
    durationMs: 5_000,
  });
  if (!owner) return;
  engine.jobs.artifactWork.complete(assetId, owner.ownerId);
  // complete() does not remove a generation-error row, and that row alone
  // still reports the playable source as failed.
  await clearRenderError(engine, assetId);
}

export async function preservePlayableRenderSources(
  engine: Engine,
  assetIds: readonly string[],
  markAssetFailureHandled: () => void,
  error: unknown,
): Promise<never> {
  const playable = await Promise.all(assetIds.map(async (assetId) => {
    const kept = await clearRenderErrorIfPlayable(engine, assetId);
    if (kept) await releaseQueuedRenderIfPlayable(engine, assetId);
    return kept;
  }));
  if (playable.some(Boolean)) {
    markAssetFailureHandled();
    throw preserveArtifactState(error);
  }
  throw error instanceof Error ? error : new Error(String(error));
}

function abortRace(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const fail = () => {
      reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
    };
    if (signal.aborted) {
      fail();
      return;
    }
    signal.addEventListener("abort", fail, { once: true });
  });
}

export function registerRenderProjectJob(engine: Engine): void {
  registerJobHandler("render_project", async (payload, ctx) => {
    const {
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
      osgImagePath: payloadOsgImagePath,
      osgAssetId,
      osgPosition,
      osgSize,
      osgScale,
      osgOpacity,
      osgStartSeconds,
      osgEndSeconds,
      osgTailSeconds,
      keywordGraphicsEnabled = false,
      keywordGraphicsMaxCount = DEFAULT_KEYWORD_GRAPHICS_MAX_COUNT,
      keywordGraphicsLingerSeconds = DEFAULT_KEYWORD_GRAPHICS_LINGER_SECONDS,
      keywordGraphicsKeywords = null,
      backgroundMode,
      strokeWidth,
      strokeColor,
      shadowBlur,
      shadowOpacity,
    } = payload as RenderProjectPayload;

    let bundleDir: string;
    let osgImagePath = payloadOsgImagePath;
    let osgCopyName: string | null = null;
    let osgCopyPath: string | null = null;
    try {
      ctx.signal.throwIfAborted();
      bundleDir = await Promise.race([
        getSharedBundleLocation(),
        abortRace(ctx.signal),
      ]);
      ctx.signal.throwIfAborted();
      if (!osgImagePath && osgAssetId) {
        const resolved = await resolveOsgImagePath(engine, osgAssetId);
        if (resolved.ok) {
          osgImagePath = resolved.path;
        } else {
          logger.warn("overlay-skipped", { assetId: osgAssetId, error: resolved.error });
        }
      }
      if (osgImagePath) {
        osgCopyName = `osg-project-${Date.now()}${basename(osgImagePath).replace(/^[^.]*/, "")}`;
        osgCopyPath = join(bundleDir, osgCopyName);
        await copyFile(resolve(osgImagePath), osgCopyPath);
      }
    } catch (error) {
      const assetIds = Array.isArray(assets)
        ? assets.flatMap((asset) => (asset && typeof asset.assetId === "string" ? [asset.assetId] : []))
        : [];
      return preservePlayableRenderSources(
        engine,
        assetIds,
        () => ctx.markAssetFailureHandled(),
        error,
      );
    }

    const targetWidth = orientation === "portrait" ? PORTRAIT_WIDTH : orientation === "square" ? SQUARE_WIDTH : LANDSCAPE_WIDTH;
    const targetHeight = orientation === "portrait" ? PORTRAIT_HEIGHT : orientation === "square" ? SQUARE_HEIGHT : LANDSCAPE_HEIGHT;
    const outputFilename = orientation === "portrait"
      ? "portrait.mp4"
      : orientation === "square"
        ? "square.mp4"
        : "landscape.mp4";

    const rendered: string[] = [];
    const failed: Array<{ assetId: string; error: string }> = [];

    try {
      for (const asset of assets) {
        const playable = await clearRenderErrorIfPlayable(engine, asset.assetId);
        try {
          ctx.signal.throwIfAborted();
          const claim = await claimLockedLease(
            engine,
            asset.assetId,
            asset.assetDir,
            "render",
            { durationMs: LOCK_DURATION_MS, data: { state: `rendering-${orientation}` } },
            { durationMs: LOCK_DURATION_MS, waitForActiveMs: CLAIM_WAIT_MS, meta: { orientation } },
          );
          if (!claim.ok) {
            failed.push({ assetId: asset.assetId, error: claim.reason });
            if (playable) await releaseQueuedRenderIfPlayable(engine, asset.assetId);
            continue;
          }
          const lease = { ownerId: claim.ownerId };
          const heartbeat = setInterval(() => {
            try {
              engine.jobs.artifactWork.renew(asset.assetId, lease.ownerId, 60_000
              );
            } catch (error) {
              logger.warn("heartbeat-failed", { assetId: asset.assetId, error });
            }
          }, 20_000);
          let renderSucceeded = false;

          try {
            const probe = await probeVideo(asset.videoPath, { signal: ctx.signal });
            const durationInSeconds = probe.duration;
            const fps = Math.round(probe.fps) || 30;
            const durationInFrames = Math.max(1, Math.round(durationInSeconds * fps));

            // Detect the transcript at render time rather than trusting the
            // payload flag (captured at enqueue, before any auto-transcribe).
            // When subtitles are requested but no transcript exists yet,
            // transcribe inline under this asset's render lease.
            let allSegments = null;
            let rawTranscript: unknown = null;
            if ((subtitlesEnabled || keywordGraphicsEnabled) && !(await engine.files.read(asset.assetId, "elevenlabs.json")).ok) {
              await ensureElevenLabsTranscript(engine, asset.assetId);
            }
            const elevenlabsResult = await engine.files.read(asset.assetId, "elevenlabs.json");
            if (elevenlabsResult.ok) {
              rawTranscript = JSON.parse(elevenlabsResult.value.toString()) as unknown;
              allSegments = await resolveSubtitleSegments(engine, asset.assetId, rawTranscript, subtitleLanguage, ctx.signal);
            }

            let chunks: Chunk[] = [];
            if (subtitlesEnabled && allSegments && highlightStyle !== "alive") {
              chunks = chunkSegments(allSegments, orientation, highlightStyle);
            }
            const alive: AliveRenderTrack | null = subtitlesEnabled && highlightStyle === "alive" && rawTranscript
              ? await aliveRenderTrack(engine, asset.assetId, {
                  sourceWidth: probe.width,
                  sourceHeight: probe.height,
                  targetWidth,
                  targetHeight,
                }, ctx.signal)
              : null;
            const keywordSegments = rawTranscript ? parseKeywordTranscript(rawTranscript) : [];
            const selectedKeywordGraphics = keywordGraphicsEnabled && rawTranscript
              ? keywordGraphicsKeywords?.length
                ? selectRequestedKeywordGraphics(keywordSegments, keywordGraphicsKeywords, {
                    lingerSeconds: keywordGraphicsLingerSeconds,
                  }).graphics
                : selectKeywordGraphics(keywordSegments, {
                    maxCount: keywordGraphicsMaxCount,
                    lingerSeconds: keywordGraphicsLingerSeconds,
                  })
              : [];
            let keywordGraphics = selectedKeywordGraphics;
            let keywordGraphicsSkipped: string[] = [];
            let keywordGraphicsPlacementFingerprint: string | null = null;
            if (keywordGraphicsEnabled && rawTranscript && elevenlabsResult.ok) {
              const manifestResult = await engine.files.manifest(asset.assetId);
              if (!manifestResult.ok) throw new Error(manifestResult.error.message);
              const sourceVideoFile = findVideoFile(manifestResult.value.files);
              if (!sourceVideoFile) throw new Error(`No source video found for ${asset.assetId}`);
              const fingerprint = keywordPlacementFingerprint(
                sourceVideoFile,
                elevenlabsResult.value,
                selectedKeywordGraphics,
              );
              const analysis = await readKeywordPlacementAnalysis(engine, asset.assetId);
              const valid = await isKeywordPlacementCacheValid(
                engine,
                asset.assetId,
                analysis,
                fingerprint,
                selectedKeywordGraphics,
              );
              if (!analysis || !valid) {
                throw new Error(
                  `Face-safe keyword placement is missing or stale for ${asset.assetId}. Run /keywords @${asset.assetId} again.`,
                );
              }
              const resolved = resolveKeywordPlacements(
                selectedKeywordGraphics,
                analysis,
                orientation,
                {
                  subtitlesEnabled,
                  subtitlePosition: position,
                  subtitleStyle: highlightStyle,
                  subtitleFontSize: fontSize,
                },
              );
              keywordGraphics = resolved.graphics;
              keywordGraphicsSkipped = resolved.skipped;
              keywordGraphicsPlacementFingerprint = analysis.fingerprint;
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
                osgOpacity: osgOpacity ?? 1,
                osgStartSeconds: osgStartSeconds ?? null,
                osgEndSeconds: osgEndSeconds ?? null,
                osgTailSeconds: osgTailSeconds ?? null,
                keywordGraphics,
                backgroundMode,
                strokeWidth,
                strokeColor,
                shadowBlur,
                shadowOpacity,
                aliveCues: alive?.cues ?? [],
                aliveSettings: alive?.settings ?? null,
              };

              const outputPath = join(asset.assetDir, outputFilename);

              const browserExecutable = await renderBrowserExecutable();
              const composition = await selectComposition({
                serveUrl: bundleDir,
                id: "render",
                inputProps: inputProps as unknown as Record<string, unknown>,
                timeoutInMilliseconds: 60_000,
                ...(browserExecutable ? { browserExecutable } : {}),
              });
              ctx.signal.throwIfAborted();

              await withRemotionCancellation(ctx.signal, (cancelSignal) =>
                renderMedia({
                  composition,
                  serveUrl: bundleDir,
                  codec: "h264",
                  outputLocation: outputPath,
                  inputProps: inputProps as unknown as Record<string, unknown>,
                  videoBitrate: "8M",
                  concurrency: 1,
                  hardwareAcceleration: "if-possible",
                  cancelSignal,
                  ...(browserExecutable ? { browserExecutable } : {}),
                }),
              );

              // Extract first frame as {orientation}.jpg
              const jpgFilename = outputFilename.replace(".mp4", ".jpg");
              const jpgPath = join(asset.assetDir, jpgFilename);
              try {
                await runFfmpeg(["-y", "-i", outputPath, "-frames:v", "1", "-q:v", "2", jpgPath], { signal: ctx.signal });
              } catch {
                ctx.signal.throwIfAborted();
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
                    ], { signal: ctx.signal });
                  } catch {
                    ctx.signal.throwIfAborted();
                  }
                }
              } catch {
                ctx.signal.throwIfAborted();
              }

              const renderedPaths = [outputFilename];
              if ((await stat(jpgPath).catch(() => null))?.isFile()) {
                renderedPaths.push(jpgFilename);
              }
              if (
                (await stat(orientFramesDir).catch(() => null))?.isDirectory()
              ) {
                renderedPaths.push(orientFramesDirName);
              }
              await ingestWorkspaceOutputs(
                engine,
                asset.assetId,
                renderedPaths,
                "render",
                { orientation },
              );

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
                aliveSettings: alive?.settings ?? null,
                osgImagePath: osgImagePath ?? undefined,
                osgAssetId: osgAssetId ?? undefined,
                osgPosition,
                osgSize,
                osgScale: osgScale ?? 1,
                osgOpacity: osgOpacity ?? 1,
                osgStartSeconds: osgStartSeconds ?? null,
                osgEndSeconds: osgEndSeconds ?? null,
                osgTailSeconds: osgTailSeconds ?? null,
                keywordGraphicsEnabled,
                keywordGraphicsMaxCount,
                keywordGraphicsLingerSeconds,
                keywordGraphicsKeywords,
                keywordGraphicsPlacementFingerprint,
                keywordGraphicsSkipped,
                renderedAt: new Date().toISOString(),
                outputs: [outputFilename, jpgFilename, orientFramesDirName],
              };
              await engine.metadata.artifacts.write(asset.assetId, `${orientation}.render`, renderSettings);

              rendered.push(asset.assetId);
              renderSucceeded = true;
            } finally {
              await unlink(videoCopyPath).catch(() => {});
            }
          } finally {
            clearInterval(heartbeat);
            if (renderSucceeded || playable) {
              await engine.jobs.artifactWork.complete(asset.assetId, lease.ownerId);
              await clearRenderError(engine, asset.assetId);
            } else {
              await engine.jobs.artifactWork.fail(asset.assetId, lease.ownerId, {
                message: "render failed",
              });
            }
            await engine.jobs.locks.release(asset.assetDir);
          }
        } catch (err) {
          if (ctx.signal.aborted) {
            if (playable) {
              ctx.markAssetFailureHandled();
              throw preserveArtifactState(err);
            }
            throw err;
          }
          failed.push({ assetId: asset.assetId, error: err instanceof Error ? err.message : String(err) });
        }
      }
    } finally {
      if (osgCopyPath) await unlink(osgCopyPath).catch(() => {});
    }

    if (rendered.length === 0 && failed.length > 0) {
      const error = new Error(`Render failed: ${failed.map((f) => `${f.assetId}: ${f.error}`).join("; ")}`);
      const playable = await Promise.all(failed.map((entry) => clearRenderErrorIfPlayable(engine, entry.assetId)));
      if (playable.some(Boolean)) {
        ctx.markAssetFailureHandled();
        throw preserveArtifactState(error);
      }
      throw error;
    }

    return { success: failed.length === 0, rendered, failed };
  });
}
