import type { VideocityFs } from "vc-engine";
import { submitKieTask } from "./kie-paygate.js";
import { uploadAssetToKie } from "./_kie-upload.js";
import { registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
import { buildHappyHorseRefPayload } from "../payload-builders.js";

type RefInput = { assetId: string; filename: string };

type GenerateHappyhorseRefVideoPayload = {
  type: "generate_happyhorse_ref_video";
  vidAssetId: string;
  vidAssetDir: string;
  projectSlug: string;
  prompt: string;
  imageInputs: RefInput[];
  sourceImageIds: string[];
  resolution?: "720p" | "1080p";
  aspect_ratio?: "16:9" | "9:16" | "1:1" | "4:3" | "3:4";
  duration?: string;
  seed?: number;
};

export function registerGenerateHappyhorseRefVideoJob(fs: VideocityFs): void {
  registerJobHandler("generate_happyhorse_ref_video", async (payload, ctx) => {
    const {
      vidAssetId, vidAssetDir, projectSlug, prompt,
      imageInputs, sourceImageIds,
      resolution, aspect_ratio, duration, seed,
    } = payload as GenerateHappyhorseRefVideoPayload;

    requireApiKey("KIE_API_KEY");

    const referenceImages: string[] = [];
    for (const { assetId, filename } of imageInputs) {
      referenceImages.push(await uploadAssetToKie(fs, assetId, filename, projectSlug));
    }

    const request = buildHappyHorseRefPayload({ prompt, resolution, aspect_ratio, duration, seed }, referenceImages);
    const taskId = await submitKieTask(fs, ctx, {
      request,
      taskType: "happyhorse_ref_video",
      assetId: vidAssetId,
      assetDir: vidAssetDir,
      projectSlug,
      meta: { prompt, mode: "ref", sourceImageIds },
    });

    return { success: true, taskId };
  });
}
