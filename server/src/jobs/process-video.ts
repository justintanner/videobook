import type { Engine } from "videobook-engine";
import { basename, dirname, extname, join } from "node:path";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile as fsReadFile,
  rm,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { registerJobHandler, queue } from "../queue.js";
import { withLocalLease } from "./_lease.js";
import { enqueueLazyAnalysisIfSlotted } from "../lazy-render.js";
import {
  probeVideo,
  runFfmpeg,
  extractWaveform,
  isThumbnailBlank,
  H264_MEDIUM,
  AUDIO_OPTS,
  type ProbeResult,
} from "../ffmpeg.js";
import { formatTimestamp, generateTimestamps } from "../frame-utils.js";
import { ingestWorkspaceOutputs } from "./_persist-output.js";
import { getApiKey } from "../api-key.js";
import { withTransientStorageRetry } from "./_storage-retry.js";
import {
  videoProxyMetadata,
  videoProxyValidationError,
} from "../video-proxy.js";

type ProcessVideoPayload = {
  type: "process_video";
  videoPath: string;
  assetId: string;
  assetDir: string;
  bookId: string;
  provenance: Record<string, unknown>;
  force?: boolean;
  skipDownstreamJobs?: boolean;
  preserveAudioArtifacts?: boolean;
  reviveVisualAnalysis?: boolean;
};

type ProcessVideoResult = {
  success: true;
  width: number;
  height: number;
  duration: number;
  frame_count: number;
};

// Write a derived binary file, skipping the write when the bytes are unchanged.
//
// The engine commits each write scoped to that file's path. A scoped
// `git commit -- <path>` with no diff exits non-zero ("nothing to commit" on
// stdout, empty stderr) whenever the rest of the tree is dirty — which it is
// on a force re-process, since we just deleted original.jpg + frames. Audio is
// stream-copied during watermarking, so re-extracting original.mp3 yields bytes
// identical to the already-committed file; the scoped commit then finds nothing
// and the engine surfaces a bare "Failed to commit file write:". Skipping the
// no-op write lets idempotent re-processing succeed. Mirrors
// writePlanFileIfChanged in plan-notebook.ts.
async function writeBinaryIfChanged(
  engine: Engine,
  assetId: string,
  filename: string,
  data: Buffer,
): Promise<void> {
  const existing = await engine.files.read(assetId, filename);
  if (existing.ok && existing.value.equals(data)) return;
  const written = await engine.files.write(assetId, filename, data);
  if (!written.ok) {
    throw new Error(`writeFile ${filename} failed for ${assetId}: ${written.error.message}`);
  }
}

export async function registerMediaStreams(
  engine: Engine,
  assetId: string,
  sourcePath: string,
  probe: ProbeResult,
): Promise<void> {
  const manifest = await engine.files.manifest(assetId);
  if (!manifest.ok) {
    throw new Error(`Failed to read media manifest for ${assetId}: ${manifest.error.message}`);
  }
  const objectHash = manifest.value.files.find((file) => file.name === sourcePath)?.objectHash;
  if (!objectHash) throw new Error(`Media source is missing from the manifest: ${sourcePath}`);
  for (const stream of [probe.videoStream, probe.audioStream]) {
    if (!stream) continue;
    const registered = await engine.streams.register({
      artifactId: assetId,
      sourcePath,
      objectHash,
      streamIndex: stream.index,
      kind: stream.video ? "video" : "audio",
      timeBase: stream.timeBase,
      durationTicks: stream.durationTicks,
      codec: stream.codec,
      ...(stream.video ? { video: stream.video } : {}),
      ...(stream.audio ? { audio: stream.audio } : {}),
    });
    if (!registered.ok) {
      throw new Error(`Failed to register media stream for ${assetId}: ${registered.error.message}`);
    }
  }
}

async function snapshotAssetFile(
  engine: Engine,
  assetId: string,
  filename: string,
  targetPath: string,
): Promise<boolean> {
  const manifest = await engine.files.manifest(assetId);
  if (!manifest.ok) {
    throw new Error(`Failed to read media manifest for ${assetId}: ${manifest.error.message}`);
  }
  if (!manifest.value.files.some((file) => file.name === filename)) return false;
  const snapshot = await engine.files.readAtRevision(
    manifest.value.artifactId,
    filename,
    engine.head,
  );
  if (!snapshot.ok) {
    throw new Error(`Failed to read immutable ${filename} for ${assetId}: ${snapshot.error.message}`);
  }
  await fsWriteFile(targetPath, snapshot.value);
  return true;
}

async function persistProxyMetadata(
  engine: Engine,
  assetId: string,
  sourceFilename: string,
  proxy: ProbeResult,
): Promise<void> {
  const manifest = await engine.files.manifest(assetId);
  if (!manifest.ok) {
    throw new Error(`Failed to read media manifest for ${assetId}: ${manifest.error.message}`);
  }
  const sourceFile = manifest.value.files.find((file) => file.name === sourceFilename);
  const proxyFile = manifest.value.files.find((file) => file.name === "proxy.mp4");
  if (!sourceFile || !proxyFile) {
    throw new Error(`Failed to record video proxy metadata for ${assetId}`);
  }
  const written = await engine.metadata.artifacts.write(
    assetId,
    "proxy",
    videoProxyMetadata(sourceFile, proxyFile, proxy),
  );
  if (!written.ok) {
    throw new Error(`Failed to record video proxy metadata for ${assetId}: ${written.error.message}`);
  }
}

export async function processVideoFiles(
  engine: Engine,
  payload: ProcessVideoPayload,
  signal?: AbortSignal,
): Promise<ProcessVideoResult> {
  const sourceWorkspace = await mkdtemp(join(tmpdir(), "videobook-source-"));
  const sourceFilename = basename(payload.videoPath);
  const sourcePath = join(sourceWorkspace, sourceFilename);
  try {
    if (!await snapshotAssetFile(engine, payload.assetId, sourceFilename, sourcePath)) {
      await copyFile(payload.videoPath, sourcePath);
    }
    return await processVideoSnapshot(
      engine,
      { ...payload, videoPath: sourcePath },
      signal,
    );
  } finally {
    await rm(sourceWorkspace, { recursive: true, force: true });
  }
}

async function processVideoSnapshot(
  engine: Engine,
  payload: ProcessVideoPayload,
  signal?: AbortSignal,
): Promise<ProcessVideoResult> {
    const {
      videoPath, assetId, assetDir, bookId, provenance,
      force, skipDownstreamJobs, preserveAudioArtifacts, reviveVisualAnalysis,
    } = payload;

    signal?.throwIfAborted();
    const probe = await probeVideo(videoPath, { signal });
    if (probe.videoCodec === null || probe.width <= 0 || probe.height <= 0) {
      throw new Error(`process_video requires a video stream: ${assetId}`);
    }
    const { width, height, duration } = probe;
    const sourceFilename = basename(videoPath);
    const importedSource = await engine.files.writeFromPath(assetId, sourceFilename, videoPath
    );
    if (!importedSource.ok) {
      throw new Error(
        `Failed to persist source video ${sourceFilename}: ${importedSource.error.message}`,
      );
    }

    // Generate original.mp4 alongside non-mp4 uploads so downstream consumers
    // (browser <video>, ffmpeg jobs, transcribe) get a canonical container.
    // The source file (original.mkv / .mov / etc.) stays on disk as the
    // archival truth — only the derived mp4 is fresh work.
    let activeVideoPath = videoPath;
    const sourceExt = extname(videoPath).toLowerCase();
    if (sourceExt !== ".mp4") {
      const tempPath = join(dirname(videoPath), "canonical.mp4");
      // Explicit -map drops subtitle/data/attachment streams that the mp4
      // muxer can't handle (e.g. subrip from MKV rips), which would otherwise
      // fail the whole transcode. Also pin to the first audio track so files
      // with multiple language tracks pick a deterministic stream.
      //
      // Stream-copy when the source codec is already mp4-compatible (h264
      // video, aac audio). For a 10-min h264 mkv this turns a multi-minute
      // re-encode into a few-second remux. Fall back to libx264 / aac for
      // anything else (hevc, vp9, dts, opus, etc).
      const canCopyVideo = probe.videoCodec === "h264";
      const canCopyAudio = probe.audioCodec === "aac";
      const videoArgs = canCopyVideo ? ["-c:v", "copy"] : H264_MEDIUM;
      const audioArgs = !probe.hasAudio
        ? ["-an"]
        : canCopyAudio
          ? ["-c:a", "copy"]
          : AUDIO_OPTS;
      const transcodeArgs = [
        "-y",
        "-i", videoPath,
        "-map", "0:v:0",
        ...(probe.hasAudio ? ["-map", "0:a:0"] : []),
        ...videoArgs,
        ...audioArgs,
        "-movflags", "+faststart",
        "-f", "mp4",
        tempPath,
      ];
      await runFfmpeg(transcodeArgs, { signal });
      const mp4Buf = await fsReadFile(tempPath);
      await writeBinaryIfChanged(engine, assetId, "original.mp4", mp4Buf);
      activeVideoPath = tempPath;
    }
    const activeSourcePath = sourceExt === ".mp4" ? sourceFilename : "original.mp4";
    const activeProbe = sourceExt === ".mp4" ? probe : await probeVideo(activeVideoPath, { signal });
    await registerMediaStreams(engine, assetId, activeSourcePath, activeProbe);
    let frameCount = 0;
    {

    await engine.metadata.artifacts.write(assetId, "original", { ...provenance, width, height, duration, hasAudio: probe.hasAudio });

    if (duration <= 0) return { success: true, width, height, duration, frame_count: 0 };

    if (force) {
      const currentManifest = await engine.files.manifest(assetId);
      if (currentManifest.ok) {
        const staleFiles = currentManifest.value.files
          .map((file) => file.name)
          .filter((filename) =>
            filename === "original.jpg" ||
            filename === "proxy.mp4" ||
            filename.startsWith("original_frames/") ||
            ["landscape", "portrait", "square"].some(
              (orientation) =>
                filename === `${orientation}.mp4` ||
                filename === `${orientation}.jpg` ||
                filename.startsWith(`${orientation}_frames/`),
            ),
          );
        for (const filename of staleFiles) {
          await engine.files.delete(assetId, filename);
        }
      }
      await rm(join(assetDir, "original_frames"), { recursive: true, force: true });
      await rm(join(assetDir, "original.jpg"), { force: true }).catch(() => {});
      // Renders are derived from the old source video — drop them so the UI
      // falls back to original.mp4 and prompts a re-render.
      for (const orient of ["landscape", "portrait", "square"] as const) {
        await rm(join(assetDir, `${orient}.mp4`), { force: true }).catch(() => {});
        await rm(join(assetDir, `${orient}.jpg`), { force: true }).catch(() => {});
        await rm(join(assetDir, `${orient}_frames`), { recursive: true, force: true }).catch(() => {});
        await engine.metadata.artifacts.delete(assetId, `${orient}.render`);
      }
      await engine.metadata.artifacts.delete(assetId, "proxy");
    }

    const proxyWorkspace = await mkdtemp(join(tmpdir(), "videobook-proxy-"));
    const proxyPath = join(proxyWorkspace, "proxy.mp4");
    try {
      let proxyProbe: ProbeResult | null = null;
      if (await snapshotAssetFile(engine, assetId, "proxy.mp4", proxyPath)) {
        try {
          const candidate = await probeVideo(proxyPath, { signal });
          if (videoProxyValidationError(activeProbe, candidate) === null) {
            proxyProbe = candidate;
          }
        } catch {
          proxyProbe = null;
        }
      }
      if (!proxyProbe) {
        const currentManifest = await engine.files.manifest(assetId);
        if (!currentManifest.ok) {
          throw new Error(
            `Failed to read media manifest for ${assetId}: ${currentManifest.error.message}`,
          );
        }
        if (currentManifest.value.files.some((file) => file.name === "proxy.mp4")) {
          const deleted = await engine.files.delete(assetId, "proxy.mp4");
          if (!deleted.ok) throw new Error(deleted.error.message);
        }
        await engine.metadata.artifacts.delete(assetId, "proxy");
        const proxySourcePath = join(proxyWorkspace, `source${extname(activeSourcePath)}`);
        if (!await snapshotAssetFile(engine, assetId, activeSourcePath, proxySourcePath)) {
          throw new Error(`Media source is missing from the manifest: ${activeSourcePath}`);
        }
        await runFfmpeg([
          "-y",
          "-i", proxySourcePath,
          "-map", "0:v:0",
          ...(activeProbe.hasAudio ? ["-map", "0:a:0"] : []),
          "-vf",
          "scale=1280:720:force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2",
          "-c:v", "libx264",
          "-preset", "veryfast",
          "-crf", "28",
          "-pix_fmt", "yuv420p",
          ...(activeProbe.hasAudio ? AUDIO_OPTS : ["-an"]),
          "-movflags", "+faststart",
          proxyPath,
        ], { signal });
        const candidate = await probeVideo(proxyPath, { signal });
        const validationError = videoProxyValidationError(activeProbe, candidate);
        if (validationError) {
          throw new Error(`Invalid video proxy for ${assetId}: ${validationError}`);
        }
        const proxy = await engine.files.writeFromPath(assetId, "proxy.mp4", proxyPath);
        if (!proxy.ok) throw new Error(proxy.error.message);
        proxyProbe = candidate;
      }
      await persistProxyMetadata(engine, assetId, activeSourcePath, proxyProbe);
    } finally {
      await rm(proxyWorkspace, { recursive: true, force: true });
    }

    const timestamps = generateTimestamps(duration);
    frameCount = timestamps.length;

    const framesDir = join(assetDir, "original_frames");
    await mkdir(framesDir, { recursive: true });

    for (const ts of timestamps) {
      const framePath = join(framesDir, `${formatTimestamp(ts)}.jpg`);
      try {
        await runFfmpeg([
          "-y",
          "-ss", String(ts),
          "-i", activeVideoPath,
          "-frames:v", "1",
          "-q:v", "2",
          "-strict", "unofficial",
          framePath,
        ], { signal });
      } catch {
        // frame extraction failure is non-fatal
      }
    }

    // Extract original.mp3 from the video (kept in sync with original.mp4 so
    // standalone audio reads — timeline, transcription — match the source).
    const existingMp3 = preserveAudioArtifacts
      ? await engine.files.read(assetId, "original.mp3")
      : null;
    if (probe.hasAudio && (!existingMp3 || !existingMp3.ok)) {
      const mp3TempPath = join(assetDir, "original.mp3.tmp");
      await runFfmpeg(["-y", "-i", activeVideoPath, "-vn", "-acodec", "libmp3lame", "-q:a", "2", "-f", "mp3", mp3TempPath], { signal });
      try {
        const mp3Buf = await fsReadFile(mp3TempPath);
        await writeBinaryIfChanged(engine, assetId, "original.mp3", mp3Buf);
      } finally {
        await rm(mp3TempPath, { force: true });
      }
    }

    const existingWaveform = preserveAudioArtifacts
      ? await engine.metadata.waveforms.read(assetId)
      : null;
    if (!existingWaveform || !existingWaveform.ok) {
      const waveform = await extractWaveform(activeVideoPath);
      if (waveform.length > 0) {
        const wavResult = await engine.metadata.waveforms.write(assetId, waveform);
        if (!wavResult.ok) {
          console.warn(
            `[process_video] writeAudioWaveform soft-failed for ${assetId}: ${wavResult.error.message}`,
          );
        }
      }
    }

    // Create original.jpg from first frame if not already set (e.g., from OG image)
    const thumbResult = await engine.files.read(assetId, "original.jpg");
    if (!thumbResult.ok) {
      try {
        const firstFrameBuf = await fsReadFile(join(framesDir, "0.00.jpg"));
        await engine.files.write(assetId, "original.jpg", firstFrameBuf);
      } catch { /* frame not available */ }
    }

    // If thumbnail is blank (all black/grey), replace with a mid-video frame
    const thumbPath = join(assetDir, "original.jpg");
    if (await isThumbnailBlank(thumbPath) && timestamps.length > 1) {
      const midTs = timestamps[Math.floor(timestamps.length / 2)];
      try {
        const midFrameBuf = await fsReadFile(join(framesDir, `${formatTimestamp(midTs)}.jpg`));
        await engine.files.write(assetId, "original.jpg", midFrameBuf);
      } catch { /* mid-frame not available */ }
    }

    await ingestWorkspaceOutputs(
      engine,
      assetId,
      ["original_frames"],
      "process_video",
      { width, height, duration, frame_count: frameCount },
    );

    }

    // Speech-to-text stays eager: cheap and useful as
    // a standalone artifact even if the asset never lands in a slot. Vision
    // analysis (Gemini) is gated to slot drop in tools/assign-slot.ts — plus
    // the slot-gated revival below for re-processed (trimmed/re-downloaded)
    // videos, whose analysis sidecar was just invalidated.
    if (process.env.NODE_ENV !== "test") {
      await queue.enqueue(`semantic-index-${assetId}-${Date.now()}`, {
        type: "semantic_index",
        assetId,
        bookId,
      } as unknown as Record<string, unknown>);
      if (!skipDownstreamJobs && probe.hasAudio) {
        const transcribeJobId = `transcribe-video-audio-${assetId}-${Date.now()}`;
        if (getApiKey("ELEVENLABS_API_KEY")) {
          await queue.enqueue(transcribeJobId, {
            type: "transcribe",
            audioPath: join(assetDir, "original.mp3"),
            audioFilename: "original.mp3",
            tagAudioEvents: true,
            diarize: true,
            assetId,
            assetDir,
            bookId,
          } as unknown as Record<string, unknown>);
        } else if (getApiKey("OPENAI_API_KEY")) {
          await queue.enqueue(transcribeJobId, {
            type: "transcribe_video_audio",
            videoPath: activeVideoPath, assetId, assetDir, bookId,
          } as unknown as Record<string, unknown>);
        }
      } else if (!skipDownstreamJobs || reviveVisualAnalysis) {
        // Silent video: no transcribe job will run, so revive the slot-drop
        // vision analysis here; transcribe_video_audio's tail owns it for
        // videos with audio (after the fresh transcript lands).
        try {
          await enqueueLazyAnalysisIfSlotted(engine, bookId, assetId);
        } catch {
          // best-effort — analysis revival must not fail processing
        }
      }
    }

    return { success: true, width, height, duration, frame_count: frameCount };
}

export function registerProcessVideoJob(engine: Engine): void {
  registerJobHandler("process_video", async (payload, ctx) => {
    const processPayload = payload as ProcessVideoPayload;
    return withLocalLease(
      engine,
      processPayload.assetId,
      ctx,
      "process",
      async () => withTransientStorageRetry(
        () => processVideoFiles(engine, processPayload, ctx.signal),
        ctx.signal,
      ),
    );
  });
}
