import type { ClipfirstFs } from "clipfirst-fs";
import { kie, submitMediaJob } from "@apicity/kie";
import { registerJobHandler } from "../queue.js";
import { writePendingTask } from "./pending-task.js";
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
    await writePendingTask(fs, imgAssetId, projectSlug, {
      taskId,
      taskType: "gpt_image_text",
      assetId: imgAssetId,
      assetDir: imgAssetDir,
      projectSlug,
      createdAt: new Date().toISOString(),
      meta: {
        sourceImageIds: [],
        prompt,
        ...(aspectRatio !== undefined ? { aspectRatio } : {}),
        ...(nsfwChecker !== undefined ? { nsfwChecker } : {}),
      },
    });

    return { success: true, taskId };
  });
}
