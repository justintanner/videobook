import type { VideocityFs } from "videocity-engine";
import { findVideoFile } from "videocity-engine";
import { join } from "node:path";
import { registerJobHandler } from "../queue.js";
import { withLocalLease } from "./_lease.js";
import { detectSceneCandidates } from "../scene-detect.js";

type DetectScenesPayload = {
  type: "detect_scenes";
  assetId: string;
  assetDir: string;
  projectSlug: string;
};

export function registerDetectScenesJob(fs: VideocityFs): void {
  registerJobHandler("detect_scenes", async (payload, ctx) => {
    const { assetId, projectSlug } = payload as DetectScenesPayload;

    return withLocalLease(fs, projectSlug, assetId, ctx, "analyze", async () => {
      const manifestResult = await fs.getManifest(assetId, projectSlug, { includeDotfiles: false });
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

      const writeResult = await fs.writeFile(
        assetId,
        ".detect-scenes.json",
        JSON.stringify(final, null, 2),
        projectSlug,
      );
      if (!writeResult.ok) {
        throw new Error(`Scenes detected but failed to persist: ${writeResult.error.message}`);
      }

      return { success: true, count: candidates.length, shots, settles };
    });
  });
}
