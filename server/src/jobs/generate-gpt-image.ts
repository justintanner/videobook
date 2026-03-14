import type { ClipfirstFs } from "clipfirst-fs";
import { kie } from "@nakedapi/kie";
import { registerJobHandler } from "../queue.js";
import { writePendingTask } from "./pending-task.js";

type GenerateGptImagePayload = {
  type: "generate_gpt_image";
  prompt: string;
  imageInputs: Array<{ assetId: string; filename: string }>;
  imgAssetId: string;
  imgAssetDir: string;
  sourceImageIds: string[];
  projectSlug: string;
  aspectRatio?: string;
  quality?: string;
};

export function registerGenerateGptImageJob(fs: ClipfirstFs): void {
  registerJobHandler("generate_gpt_image", async (payload) => {
    const {
      prompt, imageInputs, imgAssetId, imgAssetDir,
      sourceImageIds, projectSlug, aspectRatio, quality,
    } = payload as GenerateGptImagePayload;

    const apiKey = process.env.KIE_API_KEY;
    if (!apiKey) throw new Error("KIE_API_KEY environment variable is not set");

    const provider = kie({ apiKey, timeout: 60_000 });

    const uploadedUrls: string[] = [];
    for (const { assetId: srcAssetId, filename } of imageInputs) {
      const readResult = await fs.readFile(srcAssetId, filename, projectSlug);
      if (!readResult.ok) throw new Error(readResult.error.message);
      const blob = new Blob([new Uint8Array(readResult.value)]);
      const { downloadUrl } = await provider.api.fileStreamUpload({ file: blob, filename });
      uploadedUrls.push(downloadUrl);
    }

    const { taskId } = await provider.api.v1.jobs.createTask({
      model: "gpt-image/1.5-image-to-image",
      input: {
        prompt,
        input_urls: uploadedUrls,
        ...(aspectRatio !== undefined ? { aspect_ratio: aspectRatio } : {}),
        ...(quality !== undefined ? { quality } : {}),
      },
    });

    await writePendingTask(fs, imgAssetId, projectSlug, {
      taskId,
      taskType: "gpt_image",
      assetId: imgAssetId,
      assetDir: imgAssetDir,
      projectSlug,
      createdAt: new Date().toISOString(),
      meta: {
        sourceImageIds,
        prompt,
        ...(aspectRatio !== undefined ? { aspectRatio } : {}),
        ...(quality !== undefined ? { quality } : {}),
      },
    });

    return { success: true, taskId };
  });
}
