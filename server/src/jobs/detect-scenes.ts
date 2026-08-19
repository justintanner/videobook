import type { Engine } from "videobook-engine";
import { findVideoFile } from "videobook-engine";
import { join } from "node:path";
import { registerJobHandler } from "../queue.js";
import { withLocalLease } from "./_lease.js";
import { detectSceneCandidates } from "../scene-detect.js";

type DetectScenesPayload = {
  type: "detect_scenes";
  assetId: string;
  assetDir: string;
  bookId: string;
};

export function registerDetectScenesJob(engine: Engine): void {
  registerJobHandler("detect_scenes", async (payload, ctx) => {
    const { assetId } = payload as DetectScenesPayload;

    return withLocalLease(engine, assetId, ctx, "analyze", async () => {
      const manifestResult = await engine.files.manifest(assetId);
      if (!manifestResult.ok) throw new Error(manifestResult.error.message);

      const videoFile = findVideoFile(manifestResult.value.files);
      if (!videoFile) throw new Error(`No video file found in asset ${assetId}`);

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

      const writeResult = await engine.files.write(assetId, ".detect-scenes.json", JSON.stringify(final, null, 2)
      );
      if (!writeResult.ok) {
        throw new Error(`Scenes detected but failed to persist: ${writeResult.error.message}`);
      }

      return { success: true, count: candidates.length, shots, settles };
    });
  });
}
