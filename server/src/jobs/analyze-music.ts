import type { Engine } from "videobook-engine";
import { registerJobHandler, queue } from "../queue.js";
import { analyzeMusicSource } from "../rhythm/music-analysis.js";

export function registerAnalyzeMusicJob(engine: Engine): void {
  registerJobHandler("analyze_music", async (payload, context) => {
    const result = await analyzeMusicSource(
      engine, String(payload.musicArtifactId), String(payload.analysisId), String(payload.streamId), context.signal,
    );
    if (payload.sections === true) {
      await queue.enqueue(`music-sections-${payload.musicArtifactId}-${payload.analysisId}`, {
        type: "label_music_sections", bookId: payload.bookId, artifactId: payload.musicArtifactId,
        analysisId: payload.analysisId, streamId: payload.streamId,
      });
    }
    return result;
  });
}
