import { execFile } from "node:child_process";
import type { Engine } from "videobook-engine";
import { findPrimaryMediaFile } from "videobook-engine";
import { registerJobHandler } from "../queue.js";
import { FFMPEG } from "../ffmpeg.js";
import {
  MOMENTS_CHANGE_THRESHOLD,
  MOMENTS_EXTRACTOR_ID,
  MOMENTS_EXTRACTOR_VERSION,
  MOMENTS_MAX_SCAN_SECONDS,
  MOMENTS_MIN_MOMENT_SECONDS,
  MOMENTS_SHOT_THRESHOLD,
  editingMomentsCacheKey,
  editingMomentsId,
  rankedMoments,
  reuseContext,
  shotsFromScan,
  usableRanges,
  type EditingMoments,
  type SceneFrame,
} from "../editing-moments.js";
import { DOWNSTREAM_LEASE_WAIT_MS, withLocalLease } from "./_lease.js";

type MomentsPayload = {
  type: "analyze_editing_moments";
  assetId: string;
  bookId: string;
  startSeconds: number;
  endSeconds: number | null;
};

export function registerEditingMomentsJob(engine: Engine): void {
  registerJobHandler("analyze_editing_moments", async (payload, ctx) => {
    const { assetId, startSeconds, endSeconds } = payload as unknown as MomentsPayload;
    return withLocalLease(engine, assetId, ctx, "analyze", async () => {
      const artifact = engine.artifacts.get(assetId);
      if (!artifact.ok) throw new Error(artifact.error.message);
      if (!["video", "final"].includes(artifact.value.kind)) throw new Error("Choose a video source to analyze");
      const manifest = await engine.files.manifest(assetId);
      if (!manifest.ok) throw new Error(manifest.error.message);
      const file = findPrimaryMediaFile(manifest.value.files, artifact.value.kind);
      const streams = engine.streams.list(assetId);
      if (!streams.ok) throw new Error(streams.error.message);
      const stream = streams.value.find((item) => item.kind === "video" && item.sourcePath === file?.name
        && item.objectHash === file?.objectHash);
      if (!stream || !file) throw new Error("Wait for the current video source to finish processing");
      const durationSeconds = stream.durationTicks * stream.timeBase.numerator / stream.timeBase.denominator;
      if (!(durationSeconds > 0) || durationSeconds > MOMENTS_MAX_SCAN_SECONDS) {
        throw new Error(`Moment analysis supports video up to ${MOMENTS_MAX_SCAN_SECONDS / 60} minutes`);
      }
      const start = Math.min(Math.max(0, startSeconds), Math.max(0, durationSeconds - MOMENTS_MIN_MOMENT_SECONDS));
      const end = endSeconds === null ? durationSeconds : Math.min(Math.max(start + MOMENTS_MIN_MOMENT_SECONDS, endSeconds), durationSeconds);
      const momentsId = editingMomentsId({
        objectHash: stream.objectHash, streamIndex: stream.streamIndex, startSeconds: start, endSeconds: end,
      });
      const scan = await scanSceneScores(`${manifest.value.path}/${file.name}`, start, end, ctx.signal);
      const shots = shotsFromScan(scan, end - start).map((shot) => ({
        ...shot, startSeconds: shot.startSeconds + start, endSeconds: shot.endSeconds + start,
        change: shot.change ? { ...shot.change, timeSeconds: shot.change.timeSeconds + start } : null,
      }));
      const moments: EditingMoments = {
        schemaVersion: 1,
        momentsId,
        artifactId: assetId,
        objectHash: stream.objectHash,
        streamId: stream.streamId,
        durationSeconds,
        extractor: {
          id: MOMENTS_EXTRACTOR_ID,
          version: MOMENTS_EXTRACTOR_VERSION,
          params: {
            shotThreshold: MOMENTS_SHOT_THRESHOLD,
            changeThreshold: MOMENTS_CHANGE_THRESHOLD,
            minMomentSeconds: MOMENTS_MIN_MOMENT_SECONDS,
          },
        },
        analyzedRanges: [{ startSeconds: start, endSeconds: end }],
        createdAt: Date.now(),
        shots,
        usable: usableRanges([{ startSeconds: start, endSeconds: end }], shots),
        moments: rankedMoments(shots),
        reused: await reuseContext(engine, assetId),
      };
      const saved = await engine.metadata.artifacts.write(assetId, editingMomentsCacheKey(momentsId), moments);
      if (!saved.ok) throw new Error(saved.error.message);
      return { momentsId, shots: shots.length };
    }, { waitForActiveMs: DOWNSTREAM_LEASE_WAIT_MS });
  });
}

async function scanSceneScores(inputPath: string, startSeconds: number, endSeconds: number, signal: AbortSignal): Promise<SceneFrame[]> {
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(FFMPEG, [
      "-v", "error", "-i", inputPath,
      ...(startSeconds > 0 ? ["-ss", String(startSeconds)] : []),
      "-to", String(endSeconds),
      "-map", "0:v:0",
      "-vf", "select='gte(scene,0)',metadata=print:file=-",
      "-an", "-f", "null", "-",
    ], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, killSignal: "SIGKILL", signal }, (error, stdout) => {
      if (error) reject(new Error(`ffmpeg scene scan failed: ${error.message}`));
      else resolve(stdout);
    });
  });
  const frames: SceneFrame[] = [];
  let pendingTime: number | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    const time = /pts_time:([0-9]+(?:\.[0-9]+)?)/.exec(line);
    if (time) {
      pendingTime = Number.parseFloat(time[1]!);
      continue;
    }
    const score = /lavfi\.scene_score=([0-9]+(?:\.[0-9]+)?(?:e[+-][0-9]+)?)/.exec(line);
    if (score && pendingTime !== null) {
      frames.push({ timeSeconds: pendingTime, score: Number.parseFloat(score[1]!) });
      pendingTime = null;
    }
  }
  if (!frames.length) throw new Error("The scene scan returned no frames; check the video source");
  return frames;
}
