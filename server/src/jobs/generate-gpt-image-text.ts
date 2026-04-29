import type { ClipfirstFs } from "clipfirst-engine";
import { kie, submitMediaJob } from "@apicity/kie";
import { registerJobHandler } from "../queue.js";
import { buildGptImageTextPayload } from "../payload-builders.js";

type GenerateGptImageTextPayload = {
  type: "generate_gpt_image_text";
  prompt: string;
  imgAssetId: string;
  imgAssetDir: string;
  projectSlug: string;
  aspectRatio?: string;
  nsfwChecker?: boolean;
};

export function registerGenerateGptImageTextJob(fs: ClipfirstFs): void {
  registerJobHandler("generate_gpt_image_text", async (payload) => {
    const {
      prompt, imgAssetId, imgAssetDir, projectSlug, aspectRatio, nsfwChecker,
    } = payload as GenerateGptImageTextPayload;

    const apiKey = process.env.KIE_API_KEY;
    if (!apiKey) throw new Error("KIE_API_KEY environment variable is not set");

    const provider = kie({ apiKey, timeout: 60_000 });

    const request = buildGptImageTextPayload({
      prompt,
      aspect_ratio: aspectRatio,
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
          ...(nsfwChecker !== undefined ? { nsfwChecker } : {}),
        },
    });
      if (!_ptResult.ok) throw new Error(`Failed to write pending-task for ${imgAssetId}: ${_ptResult.error.message}`);
    }

    return { success: true, taskId };
  });
}
