import type { Engine } from "videobook-engine";
import { findVideoFile } from "videobook-engine";
import { join } from "node:path";
import { registerJobHandler } from "../queue.js";
import { withLocalLease } from "./_lease.js";
import { detectSceneCandidates } from "../scene-detect.js";
import { cachedSidecarAnalysis, fileObjectHash, recordSidecarAnalysis, STALE_ANALYSIS_INPUTS } from "../analysis-sidecars.js";
import { SCENE_DETECTION, sceneDetectionRecord } from "../vision-components.js";

type DetectScenesPayload = {
  type: "detect_scenes";
  assetId: string;
  assetDir: string;
  bookId: string;
  force?: boolean;
};

async function detectScenes(engine: Engine, payload: DetectScenesPayload) {
  const { assetId } = payload;
  const manifestResult = await engine.files.manifest(assetId);
  if (!manifestResult.ok) throw new Error(manifestResult.error.message);

  const videoFile = findVideoFile(manifestResult.value.files);
  if (!videoFile) throw new Error(`No video file found in asset ${assetId}`);
  const record = sceneDetectionRecord(assetId, videoFile.objectHash);
  if (!payload.force && await cachedSidecarAnalysis(engine, SCENE_DETECTION, record)) return { success: true, cached: true };

  const candidates = await detectSceneCandidates(join(manifestResult.value.path, videoFile.name));
  const shots = candidates.filter((c) => c.kind === "shot").length;
  const settles = candidates.filter((c) => c.kind === "settle").length;

  const final = {
    asset_id: assetId,
    count: candidates.length,
    shots,
    settles,
    candidates,
  };

  if (await fileObjectHash(engine, assetId, videoFile.name) !== videoFile.objectHash) throw new Error(STALE_ANALYSIS_INPUTS);
  const writeResult = await engine.files.write(assetId, SCENE_DETECTION.sidecar, JSON.stringify(final, null, 2)
  );
  if (!writeResult.ok) {
    throw new Error(`Scenes detected but failed to persist: ${writeResult.error.message}`);
  }
  await recordSidecarAnalysis(engine, SCENE_DETECTION, {
    ...record,
    provenance: { analyzer: "ffmpeg-scene-detect", provider: null, model: null },
  });

  return { success: true, count: candidates.length, shots, settles };
}

export function registerDetectScenesJob(engine: Engine): void {
  registerJobHandler("detect_scenes", async (payload, ctx) => {
    const request = payload as DetectScenesPayload;
    return withLocalLease(engine, request.assetId, ctx, "analyze", () => detectScenes(engine, request));
  });
}
