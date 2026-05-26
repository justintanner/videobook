import type { VideocityFs } from "vc-engine";
import { kie, submitMediaJob } from "@apicity/kie";
import { uploadAssetToKie } from "./_kie-upload.js";
import { registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
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

export function registerGenerateWan27ImageProJob(fs: VideocityFs): void {
  registerJobHandler("generate_wan27_image_pro", async (payload, ctx) => {
    const {
      prompt, imageInputs, imgAssetId, imgAssetDir,
      sourceImageIds, projectSlug, aspectRatio, resolution, seed, nsfwChecker,
    } = payload as GenerateWan27ImageProPayload;

    const apiKey = requireApiKey("KIE_API_KEY");

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
    }, ctx.getOwnerId());
      if (!_ptResult.ok) throw new Error(`Failed to write pending-task for ${imgAssetId}: ${_ptResult.error.message}`);
      if (_ptResult.value === null) throw new Error(`Lost local lease while writing pending-task`);
    }
    ctx.setLease({ kind: "task", taskId });

    return { success: true, taskId };
  });
}
