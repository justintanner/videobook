import type { VideocityFs } from "vc-engine";
import { kie, submitMediaJob } from "@apicity/kie";
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

    const apiKey = requireApiKey("KIE_API_KEY");

    const provider = kie({ apiKey, timeout: 60_000 });

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
    await fs.writeMetadata(vidAssetId, "generation-payload", request, projectSlug);
    const taskId = await submitMediaJob(provider, request);
    {
      const _ptResult = await fs.pendingTasks.write(projectSlug, {
        taskId,
        taskType: "happyhorse_videoedit_video",
        assetId: vidAssetId,
        assetDir: vidAssetDir,
        meta: { prompt, mode: "videoedit", sourceVideoIds, sourceImageIds },
    }, ctx.getOwnerId());
      if (!_ptResult.ok) throw new Error(`Failed to write pending-task for ${vidAssetId}: ${_ptResult.error.message}`);
      if (_ptResult.value === null) throw new Error(`Lost local lease while writing pending-task`);
    }
    ctx.setLease({ kind: "task", taskId });

    return { success: true, taskId };
  });
}
