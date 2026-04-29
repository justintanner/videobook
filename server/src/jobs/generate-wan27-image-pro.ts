import type { ClipfirstFs } from "clipfirst-engine";
import { kie, submitMediaJob } from "@apicity/kie";
import { uploadAssetToKie } from "./_kie-upload.js";
import { registerJobHandler } from "../queue.js";
import { buildWan27ImageProPayload } from "../payload-builders.js";
import type { ImageInput } from "../tools/_image-inputs.js";

type GenerateWan27ImageProPayload = {
  type: "generate_wan27_image_pro";
  prompt: string;
  imageInputs: ImageInput[];
  imgAssetId: string;
  imgAssetDir: string;
  sourceImageIds: string[];
  projectSlug: string;
  aspectRatio?: string;
  resolution?: string;
  seed?: number;
  nsfwChecker?: boolean;
};

export function registerGenerateWan27ImageProJob(fs: ClipfirstFs): void {
  registerJobHandler("generate_wan27_image_pro", async (payload) => {
    const {
      prompt, imageInputs, imgAssetId, imgAssetDir,
      sourceImageIds, projectSlug, aspectRatio, resolution, seed, nsfwChecker,
    } = payload as GenerateWan27ImageProPayload;

    const apiKey = process.env.KIE_API_KEY;
    if (!apiKey) throw new Error("KIE_API_KEY environment variable is not set");

    const provider = kie({ apiKey, timeout: 60_000 });

    const uploadedUrls: string[] = [];
    for (const input of imageInputs) {
      uploadedUrls.push(
        "url" in input
          ? input.url
          : await uploadAssetToKie(fs, input.assetId, input.filename, projectSlug),
      );
    }

    const request = buildWan27ImageProPayload(
      { prompt, aspect_ratio: aspectRatio, resolution, seed, nsfw_checker: nsfwChecker },
      uploadedUrls,
    );
    await fs.writeMetadata(imgAssetId, "generation-payload", request, projectSlug);
    const taskId = await submitMediaJob(provider, request);
    {
      const _ptResult = await fs.pendingTasks.write(projectSlug, {
        taskId,
        taskType: "wan27_image_pro",
        assetId: imgAssetId,
        assetDir: imgAssetDir,
        meta: {
          sourceImageIds,
          prompt,
          ...(aspectRatio !== undefined ? { aspectRatio } : {}),
          ...(resolution !== undefined ? { resolution } : {}),
          ...(seed !== undefined ? { seed } : {}),
          ...(nsfwChecker !== undefined ? { nsfwChecker } : {}),
        },
    });
      if (!_ptResult.ok) throw new Error(`Failed to write pending-task for ${imgAssetId}: ${_ptResult.error.message}`);
    }

    return { success: true, taskId };
  });
}
