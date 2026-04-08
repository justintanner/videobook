import type { ClipfirstFs } from "clipfirst-fs";
import { kie, uploadFile, submitMediaJob } from "@nakedapi/kie";
import { registerJobHandler } from "../queue.js";
import { writePendingTask } from "./pending-task.js";
import { buildWan27ImagePayload } from "../payload-builders.js";

type GenerateWan27ImagePayload = {
  type: "generate_wan27_image";
  prompt: string;
  imageInputs: Array<{ assetId: string; filename: string }>;
  imgAssetId: string;
  imgAssetDir: string;
  sourceImageIds: string[];
  projectSlug: string;
  aspectRatio?: string;
  resolution?: string;
  seed?: number;
  nsfwChecker?: boolean;
};

export function registerGenerateWan27ImageJob(fs: ClipfirstFs): void {
  registerJobHandler("generate_wan27_image", async (payload) => {
    const {
      prompt, imageInputs, imgAssetId, imgAssetDir,
      sourceImageIds, projectSlug, aspectRatio, resolution, seed, nsfwChecker,
    } = payload as GenerateWan27ImagePayload;

    const apiKey = process.env.KIE_API_KEY;
    if (!apiKey) throw new Error("KIE_API_KEY environment variable is not set");

    const provider = kie({ apiKey, timeout: 60_000 });

    const uploadedUrls: string[] = [];
    for (const { assetId: srcAssetId, filename } of imageInputs) {
      const readResult = await fs.readFile(srcAssetId, filename, projectSlug);
      if (!readResult.ok) throw new Error(readResult.error.message);
      const blob = new Blob([new Uint8Array(readResult.value)]);
      uploadedUrls.push(await uploadFile(provider, blob, filename));
    }

    const request = buildWan27ImagePayload(
      { prompt, aspect_ratio: aspectRatio, resolution, seed, nsfw_checker: nsfwChecker },
      uploadedUrls,
    );
    await fs.writeMetadata(imgAssetId, "generation-payload", request, projectSlug);
    const taskId = await submitMediaJob(provider, request);
    await writePendingTask(fs, imgAssetId, projectSlug, {
      taskId,
      taskType: "wan27_image",
      assetId: imgAssetId,
      assetDir: imgAssetDir,
      projectSlug,
      createdAt: new Date().toISOString(),
      meta: {
        sourceImageIds,
        prompt,
        ...(aspectRatio !== undefined ? { aspectRatio } : {}),
        ...(resolution !== undefined ? { resolution } : {}),
        ...(seed !== undefined ? { seed } : {}),
        ...(nsfwChecker !== undefined ? { nsfwChecker } : {}),
      },
    });

    return { success: true, taskId };
  });
}
