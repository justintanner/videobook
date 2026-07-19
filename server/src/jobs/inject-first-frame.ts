import type { VideocityFs } from "videocity-engine";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { H264_MEDIUM, probeVideo, runFfmpeg } from "../ffmpeg.js";
import { queue, registerJobHandler } from "../queue.js";
import { withLockedLocalLease } from "./_lease.js";

const LOCK_DURATION_MS = 900_000;

const STALE_VISUAL_DERIVATIVES = [
  ".original.analysis.json",
  ".detect-scenes.json",
  ".suggest-cuts.json",
  ".suggest-sfx.json",
  ".analyze-jokes.json",
];

type InjectFirstFramePayload = {
  type: "inject_first_frame";
  assetId: string;
  assetDir: string;
  targetFilename: string;
  inputPath: string;
  outputPath: string;
  imageAssetId: string;
  imagePath: string;
  projectSlug: string;
  orientation: "landscape" | "portrait" | "square" | null;
};

function outputContainer(path: string): "mov" | "mp4" {
  return extname(path).toLowerCase() === ".mov" ? "mov" : "mp4";
}

export function buildInjectFirstFrameFilter(width: number, height: number): string {
  return `[1:v:0]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1[still];[0:v:0][still]overlay=0:0:eof_action=repeat:repeatlast=1:enable='eq(n\\,0)'[video]`;
}

export async function renderInjectedFirstFrame(
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

export async function validateInjectedFirstFrame(
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
  fs: VideocityFs,
  assetId: string,
  filename: string,
  projectSlug: string,
): Promise<void> {
  const result = await fs.deleteFile(assetId, filename, projectSlug);
  if (!result.ok && result.error.code !== "NOT_FOUND") {
    throw new Error(`Failed to delete ${filename}: ${result.error.message}`);
  }
}

async function discardTemp(
  fs: VideocityFs,
  assetId: string,
  outputPath: string,
  projectSlug: string,
): Promise<void> {
  const filename = basename(outputPath);
  await fs.deleteFile(assetId, filename, projectSlug).catch(() => undefined);
  const remaining = await fs.readFile(assetId, filename, projectSlug);
  if (remaining.ok) throw new Error(`Failed to discard temporary file ${filename}`);
}

async function replaceAssetFile(
  fs: VideocityFs,
  assetId: string,
  targetFilename: string,
  outputPath: string,
  projectSlug: string,
): Promise<void> {
  const rendered = await fs.readFile(assetId, basename(outputPath), projectSlug);
  if (!rendered.ok) throw new Error(`Failed to read first-frame output: ${rendered.error.message}`);
  const written = await fs.writeFile(assetId, targetFilename, rendered.value, projectSlug);
  if (!written.ok) throw new Error(`Failed to replace ${targetFilename}: ${written.error.message}`);
}

async function refreshFinalThumbnail(
  fs: VideocityFs,
  assetId: string,
  assetDir: string,
  targetFilename: string,
  projectSlug: string,
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
    const written = await fs.writeFile(
      assetId,
      "original.jpg",
      await readFile(thumbnailPath),
      projectSlug,
    );
    if (!written.ok) throw new Error(`Failed to refresh final thumbnail: ${written.error.message}`);
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function registerInjectFirstFrameJob(fs: VideocityFs): void {
  registerJobHandler("inject_first_frame", async (payload, ctx) => {
    const {
      assetId,
      assetDir,
      targetFilename,
      inputPath,
      outputPath,
      imageAssetId,
      imagePath,
      projectSlug,
      orientation,
    } = payload as InjectFirstFramePayload;

    const result = await withLockedLocalLease(
      fs,
      projectSlug,
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
        const history = await fs.getAssetHistory(assetId, projectSlug, 1);
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
          await replaceAssetFile(fs, assetId, targetFilename, outputPath, projectSlug);
          await discardTemp(fs, assetId, outputPath, projectSlug);

          if (assetId === "final") {
            await refreshFinalThumbnail(
              fs,
              assetId,
              assetDir,
              targetFilename,
              projectSlug,
              ctx.signal,
            );
          } else {
            for (const filename of STALE_VISUAL_DERIVATIVES) {
              await deleteIfPresent(fs, assetId, filename, projectSlug);
            }
          }
          await fs.commitOperation("inject_first_frame", assetId, {
            image_asset_id: imageAssetId,
            target_filename: targetFilename,
            orientation,
            audio_preserved: true,
            timing_preserved: true,
          }, projectSlug);
        } catch (error) {
          await discardTemp(fs, assetId, outputPath, projectSlug).catch(() => undefined);
          if (restoreCommit) await fs.restoreAsset(assetId, restoreCommit, projectSlug);
          throw error;
        }
        return { videoPath: join(assetDir, targetFilename) };
      },
      { durationMs: LOCK_DURATION_MS, waitForActiveMs: 30_000 },
    );

    if (assetId !== "final") {
      await queue.enqueue(`process-video-${assetId}-${Date.now()}`, {
        type: "process_video",
        videoPath: result.videoPath,
        assetId,
        assetDir,
        projectSlug,
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
