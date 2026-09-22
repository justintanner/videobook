import type { Engine } from "videobook-engine";
import { registerJobHandler } from "../queue.js";
import { analyzeMusicSource } from "../rhythm/music-analysis.js";

export function registerAnalyzeMusicJob(engine: Engine): void {
  registerJobHandler("analyze_music", async (payload, context) => analyzeMusicSource(
    engine, String(payload.musicArtifactId), String(payload.analysisId), String(payload.streamId), context.signal,
  ));
}
