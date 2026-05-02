import type { ClipfirstFs } from "clipfirst-engine";
import { kie, submitMediaJob } from "@apicity/kie";
import { uploadAssetToKie } from "./_kie-upload.js";
import { registerJobHandler } from "../queue.js";
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

export function registerGenerateHappyhorseRefVideoJob(fs: ClipfirstFs): void {
  registerJobHandler("generate_happyhorse_ref_video", async (payload, ctx) => {
    const {
      vidAssetId, vidAssetDir, projectSlug, prompt,
      imageInputs, sourceImageIds,
      resolution, aspect_ratio, duration, seed,
    } = payload as GenerateHappyhorseRefVideoPayload;

    const apiKey = process.env.KIE_API_KEY;
    if (!apiKey) throw new Error("KIE_API_KEY environment variable is not set");

    const provider = kie({ apiKey, timeout: 60_000 });

    const referenceImages: string[] = [];
    for (const { assetId, filename } of imageInputs) {
      referenceImages.push(await uploadAssetToKie(fs, assetId, filename, projectSlug));
    }

    const request = buildHappyHorseRefPayload({ prompt, resolution, aspect_ratio, duration, seed }, referenceImages);
    await fs.writeMetadata(vidAssetId, "generation-payload", request, projectSlug);
    const taskId = await submitMediaJob(provider, request);
    {
      const _ptResult = await fs.pendingTasks.write(projectSlug, {
        taskId,
        taskType: "happyhorse_ref_video",
        assetId: vidAssetId,
        assetDir: vidAssetDir,
        meta: { prompt, mode: "ref", sourceImageIds },
    }, ctx.getOwnerId());
      if (!_ptResult.ok) throw new Error(`Failed to write pending-task for ${vidAssetId}: ${_ptResult.error.message}`);
      if (_ptResult.value === null) throw new Error(`Lost local lease while writing pending-task`);
    }
    ctx.setLease({ kind: "task", taskId });

    return { success: true, taskId };
  });
}
