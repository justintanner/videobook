import type { ElevenLabsSpeechToTextResponse } from "@apicity/elevenlabs";
import { findAudioFile, findVideoFile } from "videobook-engine";
import type { VideocityFs } from "videobook-engine";
import { basename, join } from "node:path";
import { hasTimedSpeechWords, resolveAudioCue } from "../audio-cue.js";
import type { RequestedAudioSyncAnchor } from "../audio-sync-request.js";
import {
  buildAudioSyncVideoFilter,
  createAudioSyncPlan,
  type AudioSyncAnchor,
  type AudioSyncPlan,
} from "../audio-sync.js";
import { AUDIO_OPTS, H264_MEDIUM, probeVideo, runFfmpeg } from "../ffmpeg.js";
import { registerJobHandler, queue } from "../queue.js";
import {
  requestElevenLabsTranscript,
  writeElevenLabsTranscript,
} from "./_transcribe.js";
import { claimLockedLease, withLockedLocalLease } from "./_lease.js";

const LOCK_DURATION_MS = 900_000;

const AUTO_TRANSCRIBE_OPTIONS = {
  tagAudioEvents: true,
  diarize: true,
};

const STALE_VISUAL_DERIVATIVES = [
  ".original.analysis.json",
  ".detect-scenes.json",
  ".suggest-cuts.json",
  ".suggest-sfx.json",
  ".analyze-jokes.json",
];

export type SyncVideoToAudioAudioMode = "copy" | "aac";

type SyncVideoToAudioPayload = {
  type: "sync_video_to_audio";
  inputPath: string;
  outputPath: string;
  anchors: RequestedAudioSyncAnchor[];
  assetId: string;
  assetDir: string;
  projectSlug: string;
};

type InstalledAudioSync = {
  videoPath: string;
  plan: AudioSyncPlan;
  requestedAnchors: RequestedAudioSyncAnchor[];
  resolvedAnchors: AudioSyncAnchor[];
  audioMode: SyncVideoToAudioAudioMode;
  restoreCommit: string;
};

export type PreparedAudioSyncTranscript = {
  transcript: unknown;
  replacement: ElevenLabsSpeechToTextResponse | null;
};

export function resolveSyncVideoToAudioAnchors(
  anchors: readonly RequestedAudioSyncAnchor[],
  transcript?: unknown,
): AudioSyncAnchor[] {
  return anchors.map((anchor) => ({
    videoSeconds: anchor.videoSeconds,
    audioSeconds: "audioSeconds" in anchor
      ? anchor.audioSeconds
      : resolveAudioCue(transcript, anchor.audioCue),
  }));
}

function outputArgs(
  inputPath: string,
  outputPath: string,
  plan: AudioSyncPlan,
  audioMode: SyncVideoToAudioAudioMode,
): string[] {
  return [
    "-y",
    "-i", inputPath,
    "-filter_complex", buildAudioSyncVideoFilter(plan),
    "-map", "[vout]",
    "-map", "0:a:0",
    ...H264_MEDIUM,
    "-pix_fmt", "yuv420p",
    ...(audioMode === "copy" ? ["-c:a", "copy"] : AUDIO_OPTS),
    "-t", plan.audioDuration.toFixed(9),
    "-movflags", "+faststart",
    "-f", "mp4",
    outputPath,
  ];
}

export async function renderAudioSyncedVideo(
  inputPath: string,
  outputPath: string,
  plan: AudioSyncPlan,
  signal?: AbortSignal,
): Promise<SyncVideoToAudioAudioMode> {
  try {
    await runFfmpeg(outputArgs(inputPath, outputPath, plan, "copy"), { signal });
    return "copy";
  } catch {
    await runFfmpeg(outputArgs(inputPath, outputPath, plan, "aac"), { signal });
    return "aac";
  }
}

export async function validateAudioSyncOutput(
  inputPath: string,
  outputPath: string,
  plan: AudioSyncPlan,
  signal?: AbortSignal,
): Promise<void> {
  const [input, output] = await Promise.all([
    probeVideo(inputPath, { signal }),
    probeVideo(outputPath, { signal }),
  ]);
  if (output.videoCodec === null || output.width <= 0 || output.height <= 0) {
    throw new Error("Audio-sync output has no usable video stream");
  }
  if (!output.hasAudio || output.audioDuration === null) {
    throw new Error("Audio-sync output does not contain the original audio stream");
  }
  if (output.width !== input.width || output.height !== input.height) {
    throw new Error(
      `Audio-sync output dimensions ${output.width}x${output.height} do not match source ${input.width}x${input.height}`,
    );
  }
  const tolerance = Math.max(0.08, 2 / plan.sourceFps);
  if (Math.abs(output.videoDuration - plan.audioDuration) > tolerance) {
    throw new Error(
      `Audio-sync video duration ${output.videoDuration.toFixed(3)}s does not match audio ${plan.audioDuration.toFixed(3)}s`,
    );
  }
  if (Math.abs(output.audioDuration - plan.audioDuration) > tolerance) {
    throw new Error(
      `Audio-sync output audio duration ${output.audioDuration.toFixed(3)}s does not match source audio ${plan.audioDuration.toFixed(3)}s`,
    );
  }
}

async function readUsableTimedTranscript(
  fs: VideocityFs,
  assetId: string,
  projectSlug: string,
): Promise<unknown | null> {
  const result = await fs.readFile(assetId, "elevenlabs.json", projectSlug);
  if (!result.ok) {
    if (result.error.code === "NOT_FOUND") return null;
    throw new Error(`Failed to read elevenlabs.json: ${result.error.message}`);
  }
  try {
    const transcript: unknown = JSON.parse(result.value.toString("utf8"));
    return hasTimedSpeechWords(transcript) ? transcript : null;
  } catch {
    return null;
  }
}

export async function prepareAudioSyncTranscript(
  fs: VideocityFs,
  assetId: string,
  projectSlug: string,
): Promise<PreparedAudioSyncTranscript> {
  const existing = await readUsableTimedTranscript(fs, assetId, projectSlug);
  if (existing !== null) return { transcript: existing, replacement: null };

  const manifest = await fs.getManifest(assetId, projectSlug, { includeDotfiles: true });
  if (!manifest.ok) throw new Error(`auto-transcribe failed: ${manifest.error.message}`);
  const audioFile = findAudioFile(manifest.value.files, assetId)
    ?? findVideoFile(manifest.value.files);
  if (!audioFile) throw new Error(`auto-transcribe failed: no audio file found in asset ${assetId}`);
  const replacement = await requestElevenLabsTranscript(
    fs,
    projectSlug,
    assetId,
    audioFile.name,
    AUTO_TRANSCRIBE_OPTIONS,
  );
  if (!hasTimedSpeechWords(replacement)) {
    throw new Error(`Auto-transcription for ${assetId} did not return timed speech words`);
  }
  return { transcript: replacement, replacement };
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function restoreAudioSyncSnapshot(
  fs: VideocityFs,
  assetId: string,
  projectSlug: string,
  restoreCommit: string,
): Promise<string> {
  let restored: string | null;
  try {
    restored = await fs.restoreAsset(assetId, restoreCommit, projectSlug);
  } catch (error) {
    throw new Error(`Failed to restore ${assetId} to ${restoreCommit}: ${errorMessage(error)}`);
  }
  if (restored === null) {
    throw new Error(`Failed to restore ${assetId} to ${restoreCommit}: engine returned no commit`);
  }
  return restored;
}

function rollbackError(original: unknown, failures: readonly unknown[]): Error {
  return new Error(
    `Audio-sync failed: ${errorMessage(original)}. Rollback failed: ${failures.map(errorMessage).join("; ")}`,
  );
}

async function clearAudioSyncFailure(
  fs: VideocityFs,
  assetId: string,
  projectSlug: string,
): Promise<void> {
  const cleared = await fs.generationErrors.clear(projectSlug, assetId);
  if (!cleared.ok) {
    throw new Error(`Failed to clear audio-sync error for ${assetId}: ${cleared.error.message}`);
  }
}

async function rollbackAudioSyncFailure(
  fs: VideocityFs,
  assetId: string,
  outputPath: string,
  projectSlug: string,
  restoreCommit: string,
  original: unknown,
): Promise<never> {
  const failures: unknown[] = [];
  try {
    await discardTemp(fs, assetId, outputPath, projectSlug);
  } catch (error) {
    failures.push(error);
  }
  try {
    await clearAudioSyncFailure(fs, assetId, projectSlug);
  } catch (error) {
    failures.push(error);
  }
  try {
    await restoreAudioSyncSnapshot(fs, assetId, projectSlug, restoreCommit);
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) throw rollbackError(original, failures);
  throw original;
}

async function restoreAfterEnqueueFailure(
  fs: VideocityFs,
  assetId: string,
  assetDir: string,
  projectSlug: string,
  restoreCommit: string,
): Promise<void> {
  const claim = await claimLockedLease(
    fs,
    projectSlug,
    assetId,
    assetDir,
    "change_speed",
    { durationMs: LOCK_DURATION_MS, data: { state: "rolling_back_audio_sync" } },
    { durationMs: LOCK_DURATION_MS, waitForActiveMs: 30_000 },
  );
  if (!claim.ok) throw new Error(`Could not claim ${assetId} for rollback: ${claim.reason}`);

  const released = await fs.releaseLock(assetDir);
  if (!released.ok) {
    await fs.assetWork.fail(projectSlug, assetId, claim.ownerId, {
      message: released.error.message,
    }).catch(() => undefined);
    throw new Error(`Failed to release ${assetId} lock before rollback: ${released.error.message}`);
  }

  let restored = false;
  try {
    await clearAudioSyncFailure(fs, assetId, projectSlug);
    await restoreAudioSyncSnapshot(fs, assetId, projectSlug, restoreCommit);
    restored = true;
  } catch (error) {
    await fs.assetWork.fail(projectSlug, assetId, claim.ownerId, {
      message: errorMessage(error),
    }).catch(() => undefined);
    throw error;
  } finally {
    if (restored) {
      await fs.assetWork.complete(projectSlug, assetId, claim.ownerId).catch(() => undefined);
    }
  }
}

function requestedAnchorMetadata(anchor: RequestedAudioSyncAnchor): Record<string, unknown> {
  return "audioSeconds" in anchor
    ? { video_seconds: anchor.videoSeconds, audio_seconds: anchor.audioSeconds }
    : { video_seconds: anchor.videoSeconds, audio_cue: anchor.audioCue };
}

export function registerSyncVideoToAudioJob(fs: VideocityFs): void {
  registerJobHandler("sync_video_to_audio", async (payload, ctx) => {
    const {
      inputPath,
      outputPath,
      anchors,
      assetId,
      assetDir,
      projectSlug,
    } = payload as SyncVideoToAudioPayload;

    const rollbackState: { enteredLease: boolean; restoreCommit: string | null } = {
      enteredLease: false,
      restoreCommit: null,
    };
    let result: InstalledAudioSync;
    try {
      result = await withLockedLocalLease(
        fs,
        projectSlug,
        assetId,
        assetDir,
        ctx,
        "change_speed",
        { durationMs: LOCK_DURATION_MS, data: { state: "syncing_audio" } },
        async () => {
          rollbackState.enteredLease = true;
          const history = await fs.getAssetHistory(assetId, projectSlug, 1);
          rollbackState.restoreCommit = history[0]?.hash ?? null;
          if (!rollbackState.restoreCommit) {
            throw new Error(`sync_video_to_audio requires revision history for ${assetId}`);
          }

          const source = await probeVideo(inputPath, { signal: ctx.signal });
          if (source.videoCodec === null || source.videoDuration <= 0) {
            throw new Error(`sync_video_to_audio requires a usable video stream in ${assetId}`);
          }
          if (!source.hasAudio || source.audioDuration === null || source.audioDuration <= 0) {
            throw new Error(`sync_video_to_audio requires an audio stream in ${assetId}`);
          }

          const preparedTranscript = anchors.some((anchor) => "audioCue" in anchor)
            ? await prepareAudioSyncTranscript(fs, assetId, projectSlug)
            : null;
          const resolvedAnchors = resolveSyncVideoToAudioAnchors(
            anchors,
            preparedTranscript?.transcript,
          );
          const plan = createAudioSyncPlan({
            videoDuration: source.videoDuration,
            audioDuration: source.audioDuration,
            sourceFps: source.fps,
            anchors: resolvedAnchors,
          });

          const audioMode = await renderAudioSyncedVideo(inputPath, outputPath, plan, ctx.signal);
          await validateAudioSyncOutput(inputPath, outputPath, plan, ctx.signal);

          const inputFilename = basename(inputPath);
          const outputFilename = basename(outputPath);
          const rendered = await fs.readFile(assetId, outputFilename, projectSlug);
          if (!rendered.ok) {
            throw new Error(`Failed to read rendered audio-sync video: ${rendered.error.message}`);
          }
          const written = await fs.writeFile(assetId, inputFilename, rendered.value, projectSlug);
          if (!written.ok) {
            throw new Error(`Failed to replace ${inputFilename}: ${written.error.message}`);
          }
          if (preparedTranscript?.replacement) {
            await writeElevenLabsTranscript(
              fs,
              projectSlug,
              assetId,
              preparedTranscript.replacement,
              AUTO_TRANSCRIBE_OPTIONS,
            );
          }
          await discardTemp(fs, assetId, outputPath, projectSlug);
          for (const filename of STALE_VISUAL_DERIVATIVES) {
            await deleteIfPresent(fs, assetId, filename, projectSlug);
          }

          return {
            videoPath: join(assetDir, basename(inputPath)),
            plan,
            requestedAnchors: anchors,
            resolvedAnchors,
            audioMode,
            restoreCommit: rollbackState.restoreCommit,
          };
        },
        { durationMs: LOCK_DURATION_MS, waitForActiveMs: 30_000 },
      );
    } catch (error) {
      if (!rollbackState.enteredLease) throw error;
      if (rollbackState.restoreCommit === null) {
        try {
          await clearAudioSyncFailure(fs, assetId, projectSlug);
        } catch (clearError) {
          throw rollbackError(error, [clearError]);
        }
        throw error;
      }
      return rollbackAudioSyncFailure(
        fs,
        assetId,
        outputPath,
        projectSlug,
        rollbackState.restoreCommit,
        error,
      );
    }

    try {
      await queue.enqueue(`process-video-${assetId}-${Date.now()}`, {
        type: "process_video",
        videoPath: result.videoPath,
        assetId,
        assetDir,
        projectSlug,
        provenance: {
          origin: "audio_sync",
          requested_anchors: result.requestedAnchors.map(requestedAnchorMetadata),
          resolved_anchors: result.plan.anchors.map((anchor) => ({
            video_seconds: anchor.videoSeconds,
            audio_seconds: anchor.audioSeconds,
          })),
          video_duration: result.plan.videoDuration,
          audio_duration: result.plan.audioDuration,
          mapping_method: "monotone_cubic_hermite",
          audio_preserved: true,
          audio_mode: result.audioMode,
          audio_synced_at: new Date().toISOString(),
        },
        force: true,
        skipDownstreamJobs: true,
        preserveAudioArtifacts: true,
        reviveVisualAnalysis: true,
      } as unknown as Record<string, unknown>);
    } catch (error) {
      try {
        await restoreAfterEnqueueFailure(
          fs,
          assetId,
          assetDir,
          projectSlug,
          result.restoreCommit,
        );
      } catch (restoreError) {
        throw rollbackError(error, [restoreError]);
      }
      throw error;
    }

    return {
      success: true,
      video_duration: result.plan.videoDuration,
      audio_duration: result.plan.audioDuration,
      resolved_anchors: result.resolvedAnchors.map((anchor) => ({
        video_seconds: anchor.videoSeconds,
        audio_seconds: anchor.audioSeconds,
      })),
      audio_mode: result.audioMode,
    };
  });
}
