import type { Engine } from "videobook-engine";
import { findVideoFile } from "videobook-engine";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerJobHandler } from "../queue.js";
import { withLocalLease } from "./_lease.js";
import { probeVideo } from "../ffmpeg.js";
import { detectSceneCuts } from "../scene-detect.js";
import type { SceneFilmstrip } from "../scene-filmstrip.js";
import { filmstripLayout, renderSceneFilmstrip, SCENE_FILMSTRIP_FILE } from "../scene-filmstrip.js";
import { cachedSidecarAnalysis, fileObjectHash, recordSidecarAnalysis, STALE_ANALYSIS_INPUTS } from "../analysis-sidecars.js";
import { SCENE_DETECTION, sceneDetectionRecord } from "../vision-components.js";

type DetectScenesPayload = {
  type: "detect_scenes";
  assetId: string;
  assetDir: string;
  bookId: string;
  force?: boolean;
};

async function persistFilmstrip(
  engine: Engine,
  assetId: string,
  videoPath: string,
  layout: Omit<SceneFilmstrip, "file">,
): Promise<SceneFilmstrip | null> {
  const scratch = await mkdtemp(join(tmpdir(), "videobook-scene-filmstrip-"));
  try {
    const outputPath = join(scratch, "filmstrip.jpg");
    await renderSceneFilmstrip(videoPath, outputPath, layout);
    const written = await engine.files.writeFromPath(assetId, SCENE_FILMSTRIP_FILE, outputPath);
    return written.ok ? { file: SCENE_FILMSTRIP_FILE, ...layout } : null;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function detectScenes(engine: Engine, payload: DetectScenesPayload) {
  const { assetId } = payload;
  const manifestResult = await engine.files.manifest(assetId);
  if (!manifestResult.ok) throw new Error(manifestResult.error.message);

  const videoFile = findVideoFile(manifestResult.value.files);
  if (!videoFile) throw new Error(`No video file found in asset ${assetId}`);
  const record = sceneDetectionRecord(assetId, videoFile.objectHash);
  if (!payload.force && await cachedSidecarAnalysis(engine, SCENE_DETECTION, record)) return { success: true, cached: true };

  const videoPath = join(manifestResult.value.path, videoFile.name);
  const probe = await probeVideo(videoPath);
  const { cuts, settles } = await detectSceneCuts(videoPath);
  const filmstrip = await persistFilmstrip(
    engine,
    assetId,
    videoPath,
    filmstripLayout(probe.videoDuration, probe.width, probe.height),
  );

  const final = {
    asset_id: assetId,
    duration: probe.videoDuration,
    fps: probe.fps,
    count: cuts.length + settles.length,
    shots: cuts.length,
    settles: settles.length,
    cuts,
    settle_points: settles,
    filmstrip,
  };

  if (await fileObjectHash(engine, assetId, videoFile.name) !== videoFile.objectHash) throw new Error(STALE_ANALYSIS_INPUTS);
  const writeResult = await engine.files.write(assetId, SCENE_DETECTION.sidecar, JSON.stringify(final, null, 2));
  if (!writeResult.ok) {
    throw new Error(`Scenes detected but failed to persist: ${writeResult.error.message}`);
  }
  await recordSidecarAnalysis(engine, SCENE_DETECTION, {
    ...record,
    provenance: { analyzer: "ffmpeg-scene-detect", provider: null, model: null },
  });

  return { success: true, count: final.count, shots: final.shots, settles: final.settles };
}

export function registerDetectScenesJob(engine: Engine): void {
  registerJobHandler("detect_scenes", async (payload, ctx) => {
    const request = payload as DetectScenesPayload;
    return withLocalLease(engine, request.assetId, ctx, "analyze", () => detectScenes(engine, request));
  });
}
