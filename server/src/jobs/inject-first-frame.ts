import type { Engine } from "videobook-engine";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { H264_MEDIUM, probeVideo, runFfmpeg } from "../ffmpeg.js";
import { queue, registerJobHandler } from "../queue.js";
import { withLockedLocalLease } from "./_lease.js";
import { replaceArtifactFileFromPath } from "./_persist-output.js";
import { registerMediaStreams } from "./process-video.js";
import { PICTURE_SIDECARS } from "../stale-sidecars.js";

const LOCK_DURATION_MS = 900_000;

type InjectFirstFramePayload = {
  type: "inject_first_frame";
  assetId: string;
  assetDir: string;
  targetFilename: string;
  inputPath: string;
  outputPath: string;
  imageAssetId: string;
  imagePath: string;
  bookId: string;
  orientation: "landscape" | "portrait" | "square" | null;
};

function outputContainer(path: string): "mov" | "mp4" {
  return extname(path).toLowerCase() === ".mov" ? "mov" : "mp4";
}

function buildInjectFirstFrameFilter(width: number, height: number): string {
  return `[1:v:0]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1[still];[0:v:0][still]overlay=0:0:eof_action=repeat:repeatlast=1:enable='eq(n\\,0)'[video]`;
}

async function renderInjectedFirstFrame(
  inputPath: string,
  imagePath: string,
  outputPath: string,
  width: number,
  height: number,
  signal?: AbortSignal,
): Promise<void> {
  await runFfmpeg([
    "-y",
    "-i", inputPath,
    "-i", imagePath,
    "-filter_complex", buildInjectFirstFrameFilter(width, height),
    "-map", "[video]",
    "-map", "0:a?",
    ...H264_MEDIUM,
    "-pix_fmt", "yuv420p",
    "-c:a", "copy",
    "-map_metadata", "0",
    "-map_chapters", "0",
    "-fps_mode", "passthrough",
    "-movflags", "+faststart",
    "-f", outputContainer(outputPath),
    outputPath,
  ], { signal });
}

async function validateInjectedFirstFrame(
  inputPath: string,
  outputPath: string,
  signal?: AbortSignal,
): Promise<void> {
  const [input, output] = await Promise.all([
    probeVideo(inputPath, { signal }),
    probeVideo(outputPath, { signal }),
  ]);
  if (output.videoCodec === null || output.width <= 0 || output.height <= 0) {
    throw new Error("First-frame output has no usable video stream");
  }
  if (output.width !== input.width || output.height !== input.height) {
    throw new Error(
      `First-frame output dimensions ${output.width}x${output.height} do not match source ${input.width}x${input.height}`,
    );
  }
  if (output.hasAudio !== input.hasAudio || output.audioCodec !== input.audioCodec) {
    throw new Error("First-frame output audio stream layout or codec does not match the source");
  }
  const tolerance = Math.max(0.08, 2 / input.fps);
  if (Math.abs(output.duration - input.duration) > tolerance) {
    throw new Error(
      `First-frame output duration ${output.duration.toFixed(3)}s does not match source ${input.duration.toFixed(3)}s`,
    );
  }
  if (Math.abs(output.videoDuration - input.videoDuration) > tolerance) {
    throw new Error("First-frame output video timing does not match the source");
  }
  if (input.audioDuration !== null && output.audioDuration !== null
    && Math.abs(output.audioDuration - input.audioDuration) > tolerance) {
    throw new Error("First-frame output audio timing does not match the source");
  }
  if (Math.abs(output.fps - input.fps) > 0.01) {
    throw new Error(`First-frame output frame rate ${output.fps} does not match source ${input.fps}`);
  }
}

async function deleteIfPresent(
  engine: Engine,
  assetId: string,
  filename: string,
): Promise<void> {
  const result = await engine.files.delete(assetId, filename);
  if (!result.ok && result.error.code !== "NOT_FOUND") {
    throw new Error(`Failed to delete ${filename}: ${result.error.message}`);
  }
}

async function discardTemp(
  outputPath: string,
): Promise<void> {
  await rm(outputPath, { force: true });
}

async function replaceAssetFile(
  engine: Engine,
  assetId: string,
  targetFilename: string,
  outputPath: string,
): Promise<void> {
  await replaceArtifactFileFromPath(
    engine,
    assetId,
    targetFilename,
    outputPath,
  );
}

async function refreshFinalThumbnail(
  engine: Engine,
  assetId: string,
  assetDir: string,
  targetFilename: string,
  signal: AbortSignal,
): Promise<void> {
  const tempDir = await mkdtemp(join(tmpdir(), "videocity-inject-first-frame-"));
  const thumbnailPath = join(tempDir, "thumbnail.jpg");
  try {
    await runFfmpeg([
      "-y",
      "-i", join(assetDir, targetFilename),
      "-frames:v", "1",
      "-q:v", "2",
      thumbnailPath,
    ], { signal });
    const thumbnailStat = await stat(thumbnailPath).catch(() => null);
    if (!thumbnailStat || thumbnailStat.size === 0) {
      throw new Error("Failed to generate final thumbnail");
    }
    const written = await engine.files.write(assetId, "original.jpg", await readFile(thumbnailPath)
    );
    if (!written.ok) throw new Error(`Failed to refresh final thumbnail: ${written.error.message}`);
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function registerInjectFirstFrameJob(engine: Engine): void {
  registerJobHandler("inject_first_frame", async (payload, ctx) => {
    const {
      assetId,
      assetDir,
      targetFilename,
      inputPath,
      outputPath,
      imageAssetId,
      imagePath,
      bookId,
      orientation,
    } = payload as InjectFirstFramePayload;

    const artifact = engine.artifacts.get(assetId);
    const isFinalAsset = artifact.ok && artifact.value.kind === "final";

    const result = await withLockedLocalLease(
      engine,
      assetId,
      assetDir,
      ctx,
      "process",
      { durationMs: LOCK_DURATION_MS, data: { state: "injecting-first-frame" } },
      async () => {
        const source = await probeVideo(inputPath, { signal: ctx.signal });
        if (source.videoCodec === null || source.width <= 0 || source.height <= 0 || source.fps <= 0) {
          throw new Error(`No usable video stream found in ${targetFilename}`);
        }
        const history = engine.history.artifact(assetId);
        const restoreCommit = history[0]?.hash;
        try {
          await renderInjectedFirstFrame(
            inputPath,
            imagePath,
            outputPath,
            source.width,
            source.height,
            ctx.signal,
          );
          await validateInjectedFirstFrame(inputPath, outputPath, ctx.signal);
          await replaceAssetFile(engine, assetId, targetFilename, outputPath);

          if (isFinalAsset) {
            await registerMediaStreams(engine, assetId, targetFilename, await probeVideo(join(assetDir, targetFilename), { signal: ctx.signal }));
            await refreshFinalThumbnail(
              engine,
              assetId,
              assetDir,
              targetFilename,
              ctx.signal,
            );
          } else {
            for (const filename of PICTURE_SIDECARS) {
              await deleteIfPresent(engine, assetId, filename);
            }
          }
          await engine.history.recordOperation("inject_first_frame", assetId, {
            image_asset_id: imageAssetId,
            target_filename: targetFilename,
            orientation,
            audio_preserved: true,
            timing_preserved: true,
          });
        } catch (error) {
          await discardTemp(outputPath).catch(() => undefined);
          if (restoreCommit) await engine.history.restoreArtifact(assetId, restoreCommit);
          throw error;
        }
        return { videoPath: join(assetDir, targetFilename) };
      },
      { durationMs: LOCK_DURATION_MS, waitForActiveMs: 30_000 },
    );

    if (!isFinalAsset) {
      await queue.enqueue(`process-video-${assetId}-${Date.now()}`, {
        type: "process_video",
        videoPath: result.videoPath,
        assetId,
        assetDir,
        bookId,
        provenance: {
          origin: "inject_first_frame",
          image_asset_id: imageAssetId,
          injected_at: new Date().toISOString(),
        },
        force: true,
        skipDownstreamJobs: true,
        preserveAudioArtifacts: true,
        reviveVisualAnalysis: true,
      });
    }

    return {
      success: true,
      target_asset_id: assetId,
      image_asset_id: imageAssetId,
      target_filename: targetFilename,
      orientation,
      audio_preserved: true,
      timing_preserved: true,
    };
  });
}
