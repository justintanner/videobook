import type { VideocityFs } from "videocity-engine";
import { submitKieTask } from "./kie-paygate.js";
import { uploadAssetToKie } from "./_kie-upload.js";
import { registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
import { buildHappyHorseVideoEditPayload } from "../payload-builders.js";

type RefInput = { assetId: string; filename: string };

type GenerateHappyhorseVideoeditPayload = {
  type: "generate_happyhorse_videoedit_video";
  vidAssetId: string;
  vidAssetDir: string;
  projectSlug: string;
  prompt: string;
  sourceVideo: RefInput;
  imageInputs: RefInput[];
  sourceVideoIds: string[];
  sourceImageIds: string[];
  resolution?: "720p" | "1080p";
  audio_setting?: "auto" | "origin";
  seed?: number;
};

export function registerGenerateHappyhorseVideoeditVideoJob(fs: VideocityFs): void {
  registerJobHandler("generate_happyhorse_videoedit_video", async (payload, ctx) => {
    const {
      vidAssetId, vidAssetDir, projectSlug, prompt,
      sourceVideo, imageInputs, sourceVideoIds, sourceImageIds,
      resolution, audio_setting, seed,
    } = payload as GenerateHappyhorseVideoeditPayload;

    requireApiKey("KIE_API_KEY");

    const videoUrl = await uploadAssetToKie(fs, sourceVideo.assetId, sourceVideo.filename, projectSlug);
    const referenceImages: string[] = [];
    for (const { assetId, filename } of imageInputs) {
      referenceImages.push(await uploadAssetToKie(fs, assetId, filename, projectSlug));
    }

    const request = buildHappyHorseVideoEditPayload(
      { prompt, resolution, audio_setting, seed },
      videoUrl,
      referenceImages,
    );
    const taskId = await submitKieTask(fs, ctx, {
      request,
      taskType: "happyhorse_videoedit_video",
      assetId: vidAssetId,
      assetDir: vidAssetDir,
      projectSlug,
      meta: { prompt, mode: "videoedit", sourceVideoIds, sourceImageIds },
    });

    return { success: true, taskId };
  });
}
