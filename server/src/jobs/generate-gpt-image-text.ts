import type { ClipfirstFs } from "vc-engine";
import { kie, submitMediaJob } from "@apicity/kie";
import { registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
import { buildGptImageTextPayload } from "../payload-builders.js";

type GenerateGptImageTextPayload = {
  type: "generate_gpt_image_text";
  prompt: string;
  imgAssetId: string;
  imgAssetDir: string;
  projectSlug: string;
  aspectRatio?: string;
  resolution?: string;
  nsfwChecker?: boolean;
};

export function registerGenerateGptImageTextJob(fs: ClipfirstFs): void {
  registerJobHandler("generate_gpt_image_text", async (payload, ctx) => {
    const {
      prompt, imgAssetId, imgAssetDir, projectSlug, aspectRatio, resolution, nsfwChecker,
    } = payload as GenerateGptImageTextPayload;

    const apiKey = requireApiKey("KIE_API_KEY");

    const provider = kie({ apiKey, timeout: 60_000 });

    const request = buildGptImageTextPayload({
      prompt,
      aspect_ratio: aspectRatio,
      resolution,
      nsfw_checker: nsfwChecker,
    });
    await fs.writeMetadata(imgAssetId, "generation-payload", request, projectSlug);
    const taskId = await submitMediaJob(provider, request);
    {
      const _ptResult = await fs.pendingTasks.write(projectSlug, {
        taskId,
        taskType: "gpt_image_text",
        assetId: imgAssetId,
        assetDir: imgAssetDir,
        meta: {
          sourceImageIds: [],
          prompt,
          ...(aspectRatio !== undefined ? { aspectRatio } : {}),
          ...(resolution !== undefined ? { resolution } : {}),
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
