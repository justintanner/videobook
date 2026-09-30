import type { Engine } from "videobook-engine";
import { registerJobHandler } from "../queue.js";
import { labelMusicSections } from "../rhythm/section-labels.js";

export function registerLabelMusicSectionsJob(engine: Engine): void {
  registerJobHandler("label_music_sections", async (payload, context) => labelMusicSections(
    engine, String(payload.artifactId), String(payload.analysisId), String(payload.streamId), context.signal,
  ));
}
